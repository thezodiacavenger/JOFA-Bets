#!/usr/bin/env python3
"""Download every regular-season NHL game result for past seasons.

Writes data/history.json, used by scripts/research.py.
Run:  python3 scripts/fetch_history.py
"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fetch_data import WEB, get

SEASONS = [20212022, 20222023, 20232024, 20242025, 20252026, 20262027]
TEAMS = ["ANA", "ARI", "BOS", "BUF", "CAR", "CBJ", "CGY", "CHI", "COL", "DAL", "DET", "EDM",
         "FLA", "LAK", "MIN", "MTL", "NJD", "NSH", "NYI", "NYR", "OTT", "PHI", "PIT", "SEA",
         "SJS", "STL", "TBL", "TOR", "UTA", "VAN", "VGK", "WPG", "WSH"]
OUT = Path(__file__).resolve().parent.parent / "data" / "history.json"


def pull(args):
    team, season = args
    try:
        return get(f"{WEB}/club-schedule-season/{team}/{season}", retries=2)["games"]
    except RuntimeError:
        return []


def main():
    jobs = [(t, s) for s in SEASONS for t in TEAMS]
    games = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for result in ex.map(pull, jobs):
            for g in result:
                if g.get("gameType") != 2 or g.get("gameState") not in ("FINAL", "OFF"):
                    continue
                games[g["id"]] = {
                    "id": g["id"],
                    "season": g["season"],
                    "date": g["gameDate"],
                    "home": g["homeTeam"]["abbrev"],
                    "away": g["awayTeam"]["abbrev"],
                    "hg": g["homeTeam"].get("score", 0),
                    "ag": g["awayTeam"].get("score", 0),
                    "end": (g.get("gameOutcome") or {}).get("lastPeriodType", "REG"),
                    "neutral": bool(g.get("neutralSite")),
                }
    rows = sorted(games.values(), key=lambda g: (g["date"], g["id"]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rows, separators=(",", ":")))
    print(f"Wrote {OUT} — {len(rows)} games")


if __name__ == "__main__":
    main()
