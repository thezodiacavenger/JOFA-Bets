#!/usr/bin/env python3
"""Score after each period for every regular-season game in data/history.json.

Writes data/periods.json: {gameId: {"p2": [away, home], "goals3": [[secondsInto3rd, "home"|"away"], ...]}}
Used for comeback research (e.g. trailing by 2 entering the third period).
"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fetch_data import WEB, get

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "periods.json"


def day(d):
    try:
        games = get(f"{WEB}/score/{d}", retries=3).get("games", [])
    except RuntimeError:
        return d, None
    out = {}
    for g in games:
        if g.get("gameType") != 2:
            continue
        a = h = 0
        third = []
        home = g["homeTeam"]["abbrev"]
        for goal in g.get("goals") or []:
            per = (goal.get("periodDescriptor") or {}).get("number", goal.get("period"))
            side = "home" if goal.get("teamAbbrev") == home or (isinstance(goal.get("teamAbbrev"), dict) and goal["teamAbbrev"].get("default") == home) else "away"
            if per <= 2:
                if side == "home":
                    h += 1
                else:
                    a += 1
            elif per == 3:
                mm, ss = (goal.get("timeInPeriod") or "0:0").split(":")
                third.append([int(mm) * 60 + int(ss), side])
        out[str(g["id"])] = {"p2": [a, h], "goals3": third}
    return d, out


def main():
    hist = json.loads((ROOT / "data" / "history.json").read_text())
    dates = sorted({g["date"] for g in hist})
    data, missing = {}, []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for d, res in ex.map(day, dates):
            if res is None:
                missing.append(d)
            else:
                data.update(res)
    OUT.write_text(json.dumps(data, separators=(",", ":")))
    print(f"Wrote {OUT}: {len(data)} games, {len(missing)} dates failed")


if __name__ == "__main__":
    main()
