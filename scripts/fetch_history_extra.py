#!/usr/bin/env python3
"""Extra history for research: expected goals/shots per game and starting goalies.

- Expected goals (xG) and shot attempts per team-game: MoneyPuck (moneypuck.com),
  free public data, used here with attribution.
- Starting goalie per team-game: NHL goalie game logs.

Writes data/extra.json. Run after fetch_history.py.
"""
from __future__ import annotations

import csv
import io
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fetch_data import STATS, WEB, get
from fetch_history import SEASONS, TEAMS

OUT = Path(__file__).resolve().parent.parent / "data" / "extra.json"
MP = "https://moneypuck.com/moneypuck/playerData/careers/gameByGame/regular/teams/{}.csv"

MP_CODE: dict[str, str] = {}  # MoneyPuck switched to standard codes (LAK, NJD...) from 2021
FIRST_SEASON = SEASONS[0] // 10000


def moneypuck(team):
    code = MP_CODE.get(team, team)
    try:
        req = urllib.request.Request(MP.format(code), headers={"User-Agent": "jofa-bets/1.0"})
        text = urllib.request.urlopen(req, timeout=60).read().decode("utf-8")
    except Exception:  # noqa: BLE001
        return team, {}
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        if int(r["season"]) < FIRST_SEASON or r["situation"] not in ("all", "5on5"):
            continue
        g = out.setdefault(r["gameId"], {})
        f = lambda k: float(r[k] or 0)  # noqa: E731
        g[r["situation"]] = {"xgf": f("xGoalsFor"), "xga": f("xGoalsAgainst"),
                             "gf": f("goalsFor"), "ga": f("goalsAgainst"),
                             "sf": f("shotsOnGoalFor"), "sa": f("shotsOnGoalAgainst"),
                             "cf": f("shotAttemptsFor"), "ca": f("shotAttemptsAgainst")}
    return team, out


def goalie_ids(season):
    rows = get(f"{STATS}/goalie/summary?limit=300&cayenneExp=seasonId={season}%20and%20gameTypeId=2")["data"]
    return [(season, r["playerId"], r["goalieFullName"]) for r in rows]


def goalie_log(args):
    season, pid, name = args
    try:
        log = get(f"{WEB}/player/{pid}/game-log/{season}/2", retries=2).get("gameLog", [])
    except RuntimeError:
        return []
    return [{"gameId": g["gameId"], "team": g["teamAbbrev"], "pid": pid, "name": name,
             "sa": g.get("shotsAgainst", 0), "ga": g.get("goalsAgainst", 0)}
            for g in log if g.get("gamesStarted")]


def main():
    with ThreadPoolExecutor(max_workers=6) as ex:
        mp = dict(ex.map(moneypuck, TEAMS))
        ids = [x for s in ex.map(goalie_ids, SEASONS) for x in s]
        starts = [x for lst in ex.map(goalie_log, ids) for x in lst]
    xg = {}
    for team, games in mp.items():
        for gid, sit in games.items():
            xg[f"{gid}-{team}"] = sit
    starters = {f"{s['gameId']}-{s['team']}": s for s in starts}
    OUT.write_text(json.dumps({"xg": xg, "starters": starters}, separators=(",", ":")))
    print(f"Wrote {OUT}: {len(xg)} team-games with xG, {len(starters)} goalie starts, "
          f"{sum(1 for v in mp.values() if not v)} teams missing xG")


if __name__ == "__main__":
    main()
