#!/usr/bin/env python3
"""Collect NHL data for the JOFA Bets dashboard.

Pulls from the NHL's public APIs (no key needed) and writes one JSON file the
website reads: docs/data/latest.json. Uses only the Python standard library.

Run:  python3 scripts/fetch_data.py
"""
from __future__ import annotations

import csv
import io
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

WEB = "https://api-web.nhle.com/v1"
STATS = "https://api.nhle.com/stats/rest/en"
OUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "latest.json"
DAYS_AHEAD = 3  # how many days of upcoming games to include
MP_SUMMARY = "https://moneypuck.com/moneypuck/playerData/seasonSummary/{}/regular/teams.csv"
SV_PRIOR_SHOTS = 1500  # league-average shots mixed into each goalie's save % (tuned in research2.py)


def get_text(url: str) -> str | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "jofa-bets/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read().decode("utf-8")
    except Exception:  # noqa: BLE001
        return None


def moneypuck_summary(start_year: int) -> dict:
    """Expected goals per team for a season (MoneyPuck.com, free public data)."""
    text = get_text(MP_SUMMARY.format(start_year))
    out = {}
    if not text:
        return out
    for r in csv.DictReader(io.StringIO(text)):
        if r["situation"] not in ("all", "5on5"):
            continue
        t = out.setdefault(r["team"], {})
        t[r["situation"]] = {k: float(r[k] or 0) for k in (
            "games_played", "xGoalsFor", "xGoalsAgainst", "goalsFor", "goalsAgainst",
            "shotsOnGoalFor", "shotsOnGoalAgainst")}
    return out


def get(url: str, retries: int = 3):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "jofa-bets/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last}")


def name(obj, default=""):
    if isinstance(obj, dict):
        return obj.get("default", default)
    return obj or default


def split(prefix: str, s: dict) -> dict:
    p = prefix
    return {
        "gp": s.get(f"{p}GamesPlayed", 0),
        "w": s.get(f"{p}Wins", 0),
        "l": s.get(f"{p}Losses", 0),
        "otl": s.get(f"{p}OtLosses", 0),
        "pts": s.get(f"{p}Points", 0),
        "gf": s.get(f"{p}GoalsFor", 0),
        "ga": s.get(f"{p}GoalsAgainst", 0),
    }


def main() -> int:
    standings = get(f"{WEB}/standings/now")["standings"]
    season_id = standings[0]["seasonId"]

    summary = get(
        f"{STATS}/team/summary?cayenneExp=seasonId={season_id}%20and%20gameTypeId=2"
    )["data"]
    summary_by_id = {row["teamId"]: row for row in summary}

    teams: dict[str, dict] = {}
    for s in standings:
        ab = name(s["teamAbbrev"])
        teams[ab] = {
            "abbrev": ab,
            "name": name(s.get("teamName")),
            "common": name(s.get("teamCommonName")),
            "logo": s.get("teamLogo"),
            "conference": s.get("conferenceName"),
            "division": s.get("divisionName"),
            "gp": s["gamesPlayed"],
            "w": s["wins"],
            "l": s["losses"],
            "otl": s["otLosses"],
            "pts": s["points"],
            "ptsPct": s["pointPctg"],
            "rw": s.get("regulationWins", 0),
            "gf": s["goalFor"],
            "ga": s["goalAgainst"],
            "home": split("home", s),
            "road": split("road", s),
            "l10": split("l10", s),
            "streak": f"{s.get('streakCode', '')}{s.get('streakCount', '')}",
            "leagueRank": s.get("leagueSequence"),
        }

    # Team ids (for joining the stats summary) come from the schedule payloads.
    abbrevs = sorted(teams)

    def club(ab):
        return ab, get(f"{WEB}/club-schedule-season/{ab}/{season_id}")["games"]

    with ThreadPoolExecutor(max_workers=8) as ex:
        club_sched = dict(ex.map(club, abbrevs))

    id_by_abbrev: dict[str, int] = {}
    for ab, games in club_sched.items():
        log = []
        for g in games:
            for side in ("homeTeam", "awayTeam"):
                if g[side]["abbrev"] == ab:
                    id_by_abbrev[ab] = g[side]["id"]
            if g.get("gameType") != 2 or g.get("gameState") not in ("FINAL", "OFF"):
                continue
            is_home = g["homeTeam"]["abbrev"] == ab
            me, opp = (g["homeTeam"], g["awayTeam"]) if is_home else (g["awayTeam"], g["homeTeam"])
            log.append({
                "date": g["gameDate"],
                "opp": opp["abbrev"],
                "home": is_home,
                "neutral": bool(g.get("neutralSite")),
                "gf": me.get("score", 0),
                "ga": opp.get("score", 0),
                "end": (g.get("gameOutcome") or {}).get("lastPeriodType", "REG"),
            })
        # Upcoming dates too, so the site can spot back-to-backs and rest.
        sched_dates = sorted({g["gameDate"] for g in games if g.get("gameType") == 2})
        teams[ab]["games"] = log
        teams[ab]["schedule"] = sched_dates

    for ab, t in teams.items():
        row = summary_by_id.get(id_by_abbrev.get(ab))
        if row:
            t.update({
                "ppPct": row.get("powerPlayPct"),
                "pkPct": row.get("penaltyKillPct"),
                "shotsFor": row.get("shotsForPerGame"),
                "shotsAgainst": row.get("shotsAgainstPerGame"),
                "faceoffPct": row.get("faceoffWinPct"),
            })
            sa = (row.get("shotsAgainstPerGame") or 0) * (row.get("gamesPlayed") or 0)
            t["svPct"] = round(1 - row["goalsAgainst"] / sa, 4) if sa else None

    # Expected goals (this season) and last season's final numbers, for the early-season prior
    start_year = season_id // 10000
    mp_now, mp_prev = moneypuck_summary(start_year), moneypuck_summary(start_year - 1)
    for ab, t in teams.items():
        now = mp_now.get(ab, {})
        a, f5 = now.get("all"), now.get("5on5")
        if a and a["games_played"]:
            t["xg"] = {"gp": a["games_played"], "xgf": a["xGoalsFor"], "xga": a["xGoalsAgainst"]}
        if f5 and f5["shotsOnGoalFor"] and f5["shotsOnGoalAgainst"]:
            t["pdo5"] = round(f5["goalsFor"] / f5["shotsOnGoalFor"] + 1 - f5["goalsAgainst"] / f5["shotsOnGoalAgainst"], 4)
        prev = (mp_prev.get(ab) or {}).get("all")
        if prev and prev["games_played"]:
            gp = prev["games_played"]
            t["prev"] = {"gp": gp, "gfpg": prev["goalsFor"] / gp, "gapg": prev["goalsAgainst"] / gp,
                         "xgfpg": prev["xGoalsFor"] / gp, "xgapg": prev["xGoalsAgainst"] / gp}

    # Goalies: save % over this + last season, pulled toward league average
    def goalie_rows(sid):
        return get(f"{STATS}/goalie/summary?limit=300&cayenneExp=seasonId={sid}%20and%20gameTypeId=2")["data"]
    g_now, g_prev = goalie_rows(season_id), goalie_rows(season_id - 10001)
    shots = sum(r["shotsAgainst"] for r in g_now + g_prev) or 1
    lg_sv = 1 - sum(r["goalsAgainst"] for r in g_now + g_prev) / shots
    prev_by_id = {r["playerId"]: r for r in g_prev}

    def goalie_log(pid):
        try:
            return pid, get(f"{WEB}/player/{pid}/game-log/{season_id}/2", retries=2).get("gameLog", [])
        except RuntimeError:
            return pid, []

    with ThreadPoolExecutor(max_workers=8) as ex:
        logs = dict(ex.map(goalie_log, [r["playerId"] for r in g_now]))

    for ab, t in teams.items():
        t["goalies"] = []
        mix_shots = mix_goals = 0.0
        recent_ids = [g for g in t["games"]][-10:]
        recent_dates = {g["date"] for g in recent_ids}
        for r in g_now:
            pid = r["playerId"]
            starts = [x for x in logs.get(pid, []) if x.get("gamesStarted") and x.get("teamAbbrev") == ab]
            if not starts and ab not in (r.get("teamAbbrevs") or "").split(","):
                continue
            pv = prev_by_id.get(pid, {})
            sa = r["shotsAgainst"] + pv.get("shotsAgainst", 0)
            ga = r["goalsAgainst"] + pv.get("goalsAgainst", 0)
            sv = 1 - (ga + SV_PRIOR_SHOTS * (1 - lg_sv)) / (sa + SV_PRIOR_SHOTS)
            team_sa = sum(x.get("shotsAgainst", 0) for x in starts)
            mix_shots += team_sa
            mix_goals += team_sa * (1 - sv)
            t["goalies"].append({
                "id": pid, "name": r["goalieFullName"], "gs": len(starts),
                "sv": round(sv, 4), "svSeason": r.get("savePct"), "gaa": r.get("goalsAgainstAverage"),
                "record": f"{r['wins']}-{r['losses']}-{r['otLosses']}",
                "lastStart": max((x["gameDate"] for x in starts), default=None),
                "recent": sum(1 for x in starts if x["gameDate"] in recent_dates),
            })
        t["goalies"].sort(key=lambda x: (-x["recent"], -x["gs"]))
        t["goalieMixSv"] = round(1 - mix_goals / mix_shots, 4) if mix_shots else None
    league_sv = round(lg_sv, 4)

    # Upcoming games + odds
    today = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=-5))).date()
    sched = get(f"{WEB}/schedule/{today.isoformat()}")
    partners = {p["partnerId"]: p for p in sched.get("oddsPartners", [])}
    games = []
    for day in sched["gameWeek"][: DAYS_AHEAD + 1]:
        for g in day["games"]:
            if g.get("gameType") not in (2, 3):
                continue

            def odds(side):
                out = []
                for o in g[side].get("odds") or []:
                    p = partners.get(o["providerId"], {})
                    out.append({"book": p.get("name", str(o["providerId"])),
                                "country": p.get("country"), "value": o["value"]})
                return out

            games.append({
                "id": g["id"],
                "date": day["date"],
                "startUTC": g["startTimeUTC"],
                "state": g["gameState"],
                "venue": name(g.get("venue")),
                "neutral": bool(g.get("neutralSite")),
                "away": g["awayTeam"]["abbrev"],
                "home": g["homeTeam"]["abbrev"],
                "awayScore": g["awayTeam"].get("score"),
                "homeScore": g["homeTeam"].get("score"),
                "awayOdds": odds("awayTeam"),
                "homeOdds": odds("homeTeam"),
            })

    # Goalies and hot skaters for games that haven't started
    def landing(game):
        if game["state"] not in ("FUT", "PRE"):
            return game["id"], None
        try:
            m = get(f"{WEB}/gamecenter/{game['id']}/landing").get("matchup") or {}
        except RuntimeError:
            return game["id"], None
        out = {"goalies": {}, "hot": {}}
        gc = m.get("goalieComparison") or {}
        for side, key in (("home", "homeTeam"), ("away", "awayTeam")):
            out["goalies"][side] = [
                {"name": name(x.get("name")), "gp": x.get("gamesPlayed"),
                 "record": x.get("record"), "gaa": x.get("gaa"), "sv": x.get("savePctg")}
                for x in (gc.get(key) or {}).get("leaders", [])
            ]
        for cat in (m.get("skaterComparison") or {}).get("leaders", []):
            for side in ("home", "away"):
                ldr = cat.get(f"{side}Leader") or {}
                out["hot"].setdefault(side, []).append(
                    {"cat": cat["category"], "name": name(ldr.get("name")), "value": ldr.get("value")}
                )
        return game["id"], out

    with ThreadPoolExecutor(max_workers=6) as ex:
        details = dict(ex.map(landing, games))
    for g in games:
        g["matchup"] = details.get(g["id"])

    # Closing-line snapshot: the last pre-game consensus we saw for each game.
    closing = {}
    try:
        closing = json.loads(OUT.read_text()).get("closing", {})
    except Exception:  # noqa: BLE001
        pass
    for g in games:
        if g["state"] in ("FUT", "PRE"):
            closing[str(g["id"])] = {"date": g["date"], "home": g["home"], "away": g["away"],
                                     "homeOdds": g["homeOdds"], "awayOdds": g["awayOdds"]}
    cutoff = (today - timedelta(days=21)).isoformat()
    closing = {k: v for k, v in closing.items() if v["date"] >= cutoff}

    payload = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "season": season_id,
        "teams": teams,
        "games": games,
        "leagueSv": league_sv,
        "closing": closing,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"Wrote {OUT} — {len(teams)} teams, {len(games)} games")
    return 0


if __name__ == "__main__":
    sys.exit(main())
