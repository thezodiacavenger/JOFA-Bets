#!/usr/bin/env python3
"""Research: does home ice, road form, or scoring style predict NHL results?

Uses data/history.json (run fetch_history.py first). Every test uses only what
each team had done BEFORE that game, so nothing peeks at the future.
Writes docs/data/research.json and prints a summary.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
GAMES = json.loads((ROOT / "data" / "history.json").read_text())
FULL = {20212022, 20222023, 20232024, 20242025, 20252026}
MIN_GP = 15  # ignore games until both teams have this many games played

R: dict = {}


def ci(p, n):
    return 1.96 * math.sqrt(max(p * (1 - p), 1e-9) / max(n, 1))


def blank():
    return {"gp": 0, "gf": 0, "ga": 0, "pts": 0,
            "hgp": 0, "hpts": 0, "hgf": 0, "hga": 0,
            "rgp": 0, "rpts": 0, "rgf": 0, "rga": 0}


# ---------- build pre-game snapshots ----------
rows = []
by_season = defaultdict(list)
for g in GAMES:
    by_season[g["season"]].append(g)

league_by_season = {}
for season, games in by_season.items():
    tot = defaultdict(blank)
    lg_goals = lg_games = 0
    for g in games:
        H, A = tot[g["home"]], tot[g["away"]]
        if H["gp"] >= MIN_GP and A["gp"] >= MIN_GP and lg_games > 0 and not g["neutral"]:
            lg = lg_goals / (2 * lg_games)  # goals per team-game to date
            def snap(t):
                return {
                    "gfpg": t["gf"] / t["gp"], "gapg": t["ga"] / t["gp"],
                    "gdpg": (t["gf"] - t["ga"]) / t["gp"], "ptsPct": t["pts"] / (2 * t["gp"]),
                    "homePct": t["hpts"] / (2 * t["hgp"]) if t["hgp"] else None,
                    "roadPct": t["rpts"] / (2 * t["rgp"]) if t["rgp"] else None,
                    "hgp": t["hgp"], "rgp": t["rgp"],
                }
            rows.append({"season": season, "lg": lg, "h": snap(H), "a": snap(A), "g": g})
        # update after the game
        hw = g["hg"] > g["ag"]
        reg = g["end"] == "REG"
        hp = 2 if hw else (0 if reg else 1)
        ap = 2 if not hw else (0 if reg else 1)
        for t, gf, ga, p, home in ((H, g["hg"], g["ag"], hp, True), (A, g["ag"], g["hg"], ap, False)):
            t["gp"] += 1; t["gf"] += gf; t["ga"] += ga; t["pts"] += p
            k = "h" if home else "r"
            t[k + "gp"] += 1; t[k + "pts"] += p; t[k + "gf"] += gf; t[k + "ga"] += ga
        lg_goals += g["hg"] + g["ag"]; lg_games += 1
    league_by_season[season] = tot

full_rows = [r for r in rows if r["season"] in FULL]
print(f"Games analysed (both teams {MIN_GP}+ GP, full seasons): {len(full_rows)}")
R["n"] = len(full_rows)

# ---------- 1. Home ice ----------
all_full = [g for g in GAMES if g["season"] in FULL and not g["neutral"]]
hw = sum(g["hg"] > g["ag"] for g in all_full) / len(all_full)
reg_games = [g for g in all_full if g["end"] == "REG"]
ot_games = [g for g in all_full if g["end"] != "REG"]
R["homeIce"] = {
    "games": len(all_full),
    "homeWin": hw,
    "homeWinReg": sum(g["hg"] > g["ag"] for g in reg_games) / len(reg_games),
    "homeWinOT": sum(g["hg"] > g["ag"] for g in ot_games) / len(ot_games),
    "otShare": len(ot_games) / len(all_full),
    "homeGoals": sum(g["hg"] for g in all_full) / len(all_full),
    "awayGoals": sum(g["ag"] for g in all_full) / len(all_full),
    "bySeason": {str(s): sum(g["hg"] > g["ag"] for g in all_full if g["season"] == s)
                 / sum(1 for g in all_full if g["season"] == s) for s in sorted(FULL)},
}
print("\n1. HOME ICE", json.dumps(R["homeIce"], indent=1))

# ---------- 2. Are team home/road splits real? (first half vs second half) ----------
pairs_gap, pairs_home, pairs_road = [], [], []
for season in FULL:
    games = by_season[season]
    teams = {g["home"] for g in games} | {g["away"] for g in games}
    for t in teams:
        tg = [g for g in games if t in (g["home"], g["away"]) and not g["neutral"]]
        half = len(tg) // 2
        def split(gs):
            h = [g for g in gs if g["home"] == t]; r = [g for g in gs if g["away"] == t]
            def pp(lst, home):
                pts = 0
                for g in lst:
                    gf, ga = (g["hg"], g["ag"]) if home else (g["ag"], g["hg"])
                    pts += 2 if gf > ga else (1 if g["end"] != "REG" else 0)
                return pts / (2 * len(lst)) if lst else 0
            return pp(h, True), pp(r, False)
        h1, r1 = split(tg[:half]); h2, r2 = split(tg[half:])
        pairs_gap.append((h1 - r1, h2 - r2))
        pairs_home.append((h1, h2)); pairs_road.append((r1, r2))


def corr(pairs):
    x = np.array([p[0] for p in pairs]); y = np.array([p[1] for p in pairs])
    return float(np.corrcoef(x, y)[0, 1])


R["splitPersistence"] = {
    "teamSeasons": len(pairs_gap),
    "homeMinusRoadGapCorr": corr(pairs_gap),
    "homePctCorr": corr(pairs_home),
    "roadPctCorr": corr(pairs_road),
}
print("\n2. SPLIT PERSISTENCE (1st half vs 2nd half)", json.dumps(R["splitPersistence"], indent=1))


# ---------- logistic regression helper ----------
def logit(X, y, iters=50):
    X = np.column_stack([np.ones(len(X)), X])
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        W = p * (1 - p)
        H = X.T @ (X * W[:, None]) + 1e-6 * np.eye(X.shape[1])
        w += np.linalg.solve(H, X.T @ (y - p))
    p = 1 / (1 + np.exp(-X @ w))
    cov = np.linalg.inv(X.T @ (X * (p * (1 - p))[:, None]))
    se = np.sqrt(np.diag(cov))
    ll = float(np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
    acc = float(np.mean((p > 0.5) == (y == 1)))
    return w, se, ll, acc


y = np.array([1.0 if r["g"]["hg"] > r["g"]["ag"] else 0.0 for r in full_rows])

# ---------- 3. What predicts the winner best? ----------
def feat(name):
    if name == "ptsPct":
        return np.array([r["h"]["ptsPct"] - r["a"]["ptsPct"] for r in full_rows])
    if name == "goalDiff":
        return np.array([r["h"]["gdpg"] - r["a"]["gdpg"] for r in full_rows])
    if name == "venueSplit":
        return np.array([(r["h"]["homePct"] or 0.5) - (r["a"]["roadPct"] or 0.5) for r in full_rows])
    if name == "venueExtra":  # how much better at home / on road than their overall
        return np.array([((r["h"]["homePct"] or 0.5) - r["h"]["ptsPct"]) - ((r["a"]["roadPct"] or 0.5) - r["a"]["ptsPct"]) for r in full_rows])
    if name == "eventDiff":  # home team's GF+GA per game minus away team's
        return np.array([(r["h"]["gfpg"] + r["h"]["gapg"]) - (r["a"]["gfpg"] + r["a"]["gapg"]) for r in full_rows])
    if name == "offDiff":
        return np.array([r["h"]["gfpg"] - r["a"]["gfpg"] for r in full_rows])
    if name == "defDiff":
        return np.array([r["a"]["gapg"] - r["h"]["gapg"] for r in full_rows])


base_ll = float(np.mean(y * math.log(y.mean()) + (1 - y) * math.log(1 - y.mean())))
models = {
    "Home ice only": [],
    "Standings (points %)": ["ptsPct"],
    "Goal differential": ["goalDiff"],
    "Home pts% vs road pts% (splits only)": ["venueSplit"],
    "Goal diff + standings": ["goalDiff", "ptsPct"],
    "Goal diff + home/road extra": ["goalDiff", "venueExtra"],
    "Goal diff + style (event level)": ["goalDiff", "eventDiff"],
    "Offence and defence separately": ["offDiff", "defDiff"],
}
R["predictors"] = []
print("\n3. WHAT PREDICTS THE WINNER (log-loss, higher is better; accuracy)")
for label, feats in models.items():
    if feats:
        X = np.column_stack([feat(f) for f in feats])
        w, se, ll, acc = logit(X, y)
    else:
        w, se, ll, acc = np.array([math.log(y.mean() / (1 - y.mean()))]), np.array([0.0]), base_ll, float(y.mean())
    coefs = {f: {"coef": float(w[i + 1]), "z": float(w[i + 1] / se[i + 1])} for i, f in enumerate(feats)}
    R["predictors"].append({"model": label, "logLoss": ll, "accuracy": acc, "coefs": coefs,
                            "gainVsHomeOnly": ll - base_ll})
    print(f"  {label:42s} acc {acc:.3f}  ll {ll:.4f}  gain {ll - base_ll:+.4f}  " +
          "  ".join(f"{k} z={v['z']:.1f}" for k, v in coefs.items()))

# ---------- 4. Standings vs goal differential disagreements ----------
dis = []
for r in full_rows:
    h, a = r["h"], r["a"]
    if (h["ptsPct"] - a["ptsPct"]) * (h["gdpg"] - a["gdpg"]) < 0 and abs(h["ptsPct"] - a["ptsPct"]) >= 0.05 and abs(h["gdpg"] - a["gdpg"]) >= 0.2:
        gd_team_home = h["gdpg"] > a["gdpg"]
        home_won = r["g"]["hg"] > r["g"]["ag"]
        dis.append((gd_team_home, home_won == gd_team_home))
n = len(dis)
gd_win = sum(x[1] for x in dis) / n
gd_home = [x for x in dis if x[0]]; gd_road = [x for x in dis if not x[0]]
R["standingsVsGoalDiff"] = {
    "games": n, "betterGoalDiffWins": gd_win, "ci": ci(gd_win, n),
    "whenBetterGDTeamHome": sum(x[1] for x in gd_home) / len(gd_home), "nHome": len(gd_home),
    "whenBetterGDTeamAway": sum(x[1] for x in gd_road) / len(gd_road), "nAway": len(gd_road),
}
print("\n4. STANDINGS SAY ONE THING, GOAL DIFF SAYS ANOTHER", json.dumps(R["standingsVsGoalDiff"], indent=1))

# ---------- 5. Scoring-style matchups ----------
def tier(v, lo, hi):
    return "Low" if v < lo else ("High" if v > hi else "Mid")


def tercile_cuts(vals):
    s = sorted(vals)
    return s[len(s) // 3], s[2 * len(s) // 3]


# Relative to that season's league average at the time
for r in full_rows:
    for k in ("h", "a"):
        t = r[k]
        t["offRel"] = t["gfpg"] - r["lg"]
        t["defRel"] = t["gapg"] - r["lg"]
        t["eventRel"] = t["gfpg"] + t["gapg"] - 2 * r["lg"]

off_lo, off_hi = tercile_cuts([r[k]["offRel"] for r in full_rows for k in "ha"])
ev_lo, ev_hi = tercile_cuts([r[k]["eventRel"] for r in full_rows for k in "ha"])


def cell(rs):
    n = len(rs)
    if not n:
        return None
    hw = sum(r["g"]["hg"] > r["g"]["ag"] for r in rs) / n
    tot = sum(r["g"]["hg"] + r["g"]["ag"] for r in rs) / n
    over = sum(r["g"]["hg"] + r["g"]["ag"] > 6.5 for r in rs) / n
    return {"n": n, "homeWin": hw, "ci": ci(hw, n), "avgTotal": tot, "over65": over}


# 5a: offence tier, home x away
R["offenceMatrix"] = {}
for ht in ("Low", "Mid", "High"):
    for at in ("Low", "Mid", "High"):
        rs = [r for r in full_rows if tier(r["h"]["offRel"], off_lo, off_hi) == ht and tier(r["a"]["offRel"], off_lo, off_hi) == at]
        R["offenceMatrix"][f"{ht}|{at}"] = cell(rs)

# 5b: style at EQUAL quality: "tight" (low event) vs "wild" (high event), goal diff within 0.25/game
style = {"tight_home_vs_wild_away": [], "wild_home_vs_tight_away": [], "tight_vs_tight": [], "wild_vs_wild": []}
for r in full_rows:
    if abs(r["h"]["gdpg"] - r["a"]["gdpg"]) > 0.25:
        continue
    hs = tier(r["h"]["eventRel"], ev_lo, ev_hi); as_ = tier(r["a"]["eventRel"], ev_lo, ev_hi)
    if hs == "Low" and as_ == "High": style["tight_home_vs_wild_away"].append(r)
    if hs == "High" and as_ == "Low": style["wild_home_vs_tight_away"].append(r)
    if hs == "Low" and as_ == "Low": style["tight_vs_tight"].append(r)
    if hs == "High" and as_ == "High": style["wild_vs_wild"].append(r)
R["styleEqualQuality"] = {k: cell(v) for k, v in style.items()}

# 5c: good-offence vs good-defence: home team strong O / weak D vs away strong D / weak O, and reverse
od = {"homeOffence_vs_awayDefence": [], "homeDefence_vs_awayOffence": []}
for r in full_rows:
    h, a = r["h"], r["a"]
    if abs(h["gdpg"] - a["gdpg"]) > 0.3:
        continue
    h_off = h["offRel"] > 0.15 and h["defRel"] > -0.05   # scores a lot, doesn't defend
    h_def = h["defRel"] < -0.15 and h["offRel"] < 0.05   # defends, doesn't score
    a_off = a["offRel"] > 0.15 and a["defRel"] > -0.05
    a_def = a["defRel"] < -0.15 and a["offRel"] < 0.05
    if h_off and a_def: od["homeOffence_vs_awayDefence"].append(r)
    if h_def and a_off: od["homeDefence_vs_awayOffence"].append(r)
R["offenceVsDefence"] = {k: cell(v) for k, v in od.items()}

# 5d: does style matter for the WINNER once quality is known? (from regression in section 3)
print("\n5a. HOME WIN % BY OFFENCE TIER (rows = home team, cols = away team)")
for ht in ("Low", "Mid", "High"):
    print(f"  home {ht:4s}", "  ".join(f"{at}: {R['offenceMatrix'][f'{ht}|{at}']['homeWin']:.3f} (n={R['offenceMatrix'][f'{ht}|{at}']['n']}, tot {R['offenceMatrix'][f'{ht}|{at}']['avgTotal']:.2f})" for at in ("Low", "Mid", "High")))
print("\n5b. STYLE AT EQUAL QUALITY", json.dumps(R["styleEqualQuality"], indent=1))
print("\n5c. OFFENCE TEAM vs DEFENCE TEAM (similar goal diff)", json.dumps(R["offenceVsDefence"], indent=1))

# ---------- 6. Totals: who sets the pace? ----------
tot = np.array([r["g"]["hg"] + r["g"]["ag"] for r in full_rows], dtype=float)
Xn = np.column_stack([
    [r["h"]["gfpg"] + r["a"]["gapg"] for r in full_rows],  # home scoring expectation
    [r["a"]["gfpg"] + r["h"]["gapg"] for r in full_rows],  # away scoring expectation
])
naive = Xn.sum(axis=1) / 2  # average of the two teams' event rates
X1 = np.column_stack([np.ones(len(tot)), naive])
b1 = np.linalg.lstsq(X1, tot, rcond=None)[0]
lowev = np.array([min(r["h"]["eventRel"], r["a"]["eventRel"]) for r in full_rows])
highev = np.array([max(r["h"]["eventRel"], r["a"]["eventRel"]) for r in full_rows])
X2 = np.column_stack([np.ones(len(tot)), lowev, highev])
b2 = np.linalg.lstsq(X2, tot, rcond=None)[0]
# mismatched-pace games: one tight team, one wild team
mm = [i for i, r in enumerate(full_rows) if {tier(r["h"]["eventRel"], ev_lo, ev_hi), tier(r["a"]["eventRel"], ev_lo, ev_hi)} == {"Low", "High"}]
R["totals"] = {
    "naiveSlope": float(b1[1]),
    "naiveIntercept": float(b1[0]),
    "lowerEventTeamWeight": float(b2[1]),
    "higherEventTeamWeight": float(b2[2]),
    "mismatchGames": len(mm),
    "mismatchActual": float(tot[mm].mean()),
    "mismatchNaive": float(naive[mm].mean()),
    "mismatchOver65": float((tot[mm] > 6.5).mean()),
    "leagueOver65": float((tot > 6.5).mean()),
    "leagueAvg": float(tot.mean()),
}
print("\n6. TOTALS: WHO SETS THE PACE?", json.dumps(R["totals"], indent=1))

# ---------- 7. Home edge by team type ----------
# Does home ice matter more for good or bad teams, high- or low-event teams?
R["homeEdgeByType"] = {}
for label, key, lo, hi in (("offence", "offRel", off_lo, off_hi), ("event", "eventRel", ev_lo, ev_hi)):
    for t in ("Low", "Mid", "High"):
        # same-tier vs same-tier games isolate the venue effect
        rs = [r for r in full_rows if tier(r["h"][key], lo, hi) == t and tier(r["a"][key], lo, hi) == t]
        R["homeEdgeByType"][f"{label}:{t}"] = cell(rs)
print("\n7. HOME WIN % WHEN BOTH TEAMS ARE THE SAME TYPE", json.dumps({k: (round(v['homeWin'], 3), v['n']) for k, v in R["homeEdgeByType"].items()}, indent=1))

R["cuts"] = {"offence": [off_lo, off_hi], "event": [ev_lo, ev_hi]}
out = ROOT / "data" / "research.json"
out.write_text(json.dumps(R, indent=1))
print(f"\nWrote {out}")
