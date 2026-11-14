#!/usr/bin/env python3
"""Research round 2: shot quality (xG), luck (PDO), last season's ratings,
schedule spots and starting goalies.

Uses data/history.json + data/extra.json (fetch_history.py, fetch_history_extra.py).
Every feature uses only information available before puck drop (the starting
goalie is assumed confirmed, as it usually is ~1-2 hours before games).
Writes data/research2.json and prints a summary.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
GAMES = json.loads((ROOT / "data" / "history.json").read_text())
EXTRA = json.loads((ROOT / "data" / "extra.json").read_text())
XG, STARTERS = EXTRA["xg"], EXTRA["starters"]
FULL = {20212022, 20222023, 20232024, 20242025, 20252026}

# UTC offset of each team's home rink (standard time) for travel tests
TZ = {"BOS": -5, "BUF": -5, "DET": -5, "FLA": -5, "MTL": -5, "OTT": -5, "TBL": -5, "TOR": -5,
      "CAR": -5, "CBJ": -5, "NJD": -5, "NYI": -5, "NYR": -5, "PHI": -5, "PIT": -5, "WSH": -5,
      "CHI": -6, "DAL": -6, "MIN": -6, "NSH": -6, "STL": -6, "WPG": -6,
      "COL": -7, "ARI": -7, "UTA": -7, "CGY": -7, "EDM": -7,
      "ANA": -8, "LAK": -8, "SJS": -8, "SEA": -8, "VAN": -8, "VGK": -8}

SV_PRIOR_SHOTS = 1500   # league-average shots mixed into each goalie's save % (it's a noisy stat)
R: dict = {}


def d(s):
    return date.fromisoformat(s)


def new_team():
    return defaultdict(float, dates=[], venues=[])


# ---------- walk every game in order, snapshotting pre-game state ----------
rows = []
final_by_season: dict[int, dict] = {}
goalie = defaultdict(lambda: [0.0, 0.0])  # pid -> [shots, goals] across all seasons so far
lg_sv = [0.0, 0.0]                         # league shots, goals so far (all seasons)

season_games = defaultdict(list)
for g in GAMES:
    season_games[g["season"]].append(g)

for season in sorted(season_games):
    T = defaultdict(new_team)
    team_goalie_mix = defaultdict(lambda: [0.0, 0.0])  # team -> [shots, expected goals at starters' sv]
    for g in season_games[season]:
        hk, ak = f"{g['id']}-{g['home']}", f"{g['id']}-{g['away']}"
        H, A = T[g["home"]], T[g["away"]]
        lgsv = 1 - lg_sv[1] / lg_sv[0] if lg_sv[0] else 0.905

        def gsv(pid):
            s, ga = goalie[pid]
            return 1 - (ga + SV_PRIOR_SHOTS * (1 - lgsv)) / (s + SV_PRIOR_SHOTS)

        def snap(t, team, key, is_home):
            gp = t["gp"]
            st = STARTERS.get(key)
            out = {"gp": gp}
            if gp:
                out.update({
                    "gd": (t["gf"] - t["ga"]) / gp, "gf": t["gf"] / gp, "ga": t["ga"] / gp,
                    "xgd": (t["xgf"] - t["xga"]) / gp, "xgf": t["xgf"] / gp, "xga": t["xga"] / gp,
                    "xgd5": (t["xgf5"] - t["xga5"]) / gp,
                    "sogd": (t["sf"] - t["sa"]) / gp, "cfd": (t["cf"] - t["ca"]) / gp,
                    "pdo5": (t["gf5"] / max(t["sf5"], 1)) + (1 - t["ga5"] / max(t["sa5"], 1)),
                    "pts": t["pts"] / (2 * gp),
                })
            prev = final_by_season.get(season - 10001, {}).get(team)
            out["prior"] = prev
            # schedule
            last = t["dates"][-1] if t["dates"] else None
            today = d(g["date"])
            out["rest"] = (today - d(last)).days if last else None
            out["in4"] = sum(1 for x in t["dates"] if 0 < (today - d(x)).days <= 3)
            trip = 0
            for v in reversed(t["venues"]):
                if v == "A":
                    trip += 1
                else:
                    break
            out["roadStreak"] = trip  # consecutive road games before this one
            out["tzShift"] = TZ.get(g["home"], -5) - TZ.get(team, -5)  # negative = travelled west
            # goalie: starter vs the mix of goalies who produced the team's GA so far
            if st and team_goalie_mix[team][0] > 0:
                mix_sv = 1 - team_goalie_mix[team][1] / team_goalie_mix[team][0]
                out["goalieEdge"] = (gsv(st["pid"]) - mix_sv) * 30  # goals saved per game vs usual
                out["starterSv"] = gsv(st["pid"])
                out["starterShare"] = t["starts_" + str(st["pid"])] / gp if gp else None
            return out

        if not g["neutral"]:
            rows.append({"season": season, "g": g, "h": snap(H, g["home"], hk, True), "a": snap(A, g["away"], ak, False)})

        # ---- update after the game ----
        hw = g["hg"] > g["ag"]
        reg = g["end"] == "REG"
        for t, team, key, gf, ga, won, venue in ((H, g["home"], hk, g["hg"], g["ag"], hw, "H"),
                                                  (A, g["away"], ak, g["ag"], g["hg"], not hw, "A")):
            t["gp"] += 1; t["gf"] += gf; t["ga"] += ga
            t["pts"] += 2 if won else (0 if reg else 1)
            x = XG.get(key, {})
            al, f5 = x.get("all", {}), x.get("5on5", {})
            t["xgf"] += al.get("xgf", 0); t["xga"] += al.get("xga", 0)
            t["sf"] += al.get("sf", 0); t["sa"] += al.get("sa", 0)
            t["cf"] += al.get("cf", 0); t["ca"] += al.get("ca", 0)
            t["xgf5"] += f5.get("xgf", 0); t["xga5"] += f5.get("xga", 0)
            t["gf5"] += f5.get("gf", 0); t["ga5"] += f5.get("ga", 0)
            t["sf5"] += f5.get("sf", 0); t["sa5"] += f5.get("sa", 0)
            t["dates"].append(g["date"]); t["venues"].append(venue)
            st = STARTERS.get(key)
            if st and st["sa"]:
                lgsv_now = 1 - lg_sv[1] / lg_sv[0] if lg_sv[0] else 0.905
                s0, g0 = goalie[st["pid"]]
                sv_pre = 1 - (g0 + SV_PRIOR_SHOTS * (1 - lgsv_now)) / (s0 + SV_PRIOR_SHOTS)
                team_goalie_mix[team][0] += st["sa"]
                team_goalie_mix[team][1] += st["sa"] * (1 - sv_pre)
                goalie[st["pid"]][0] += st["sa"]; goalie[st["pid"]][1] += st["ga"]
                lg_sv[0] += st["sa"]; lg_sv[1] += st["ga"]
                t["starts_" + str(st["pid"])] += 1
    final_by_season[season] = {k: (v["gf"] - v["ga"]) / v["gp"] for k, v in T.items() if v["gp"]}

print(f"Pre-game snapshots: {len(rows)}")


# ---------- helpers ----------
def logit(X, y, iters=60):
    X = np.column_stack([np.ones(len(X)), X])
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        H = X.T @ (X * (p * (1 - p))[:, None]) + 1e-6 * np.eye(X.shape[1])
        w += np.linalg.solve(H, X.T @ (y - p))
    p = 1 / (1 + np.exp(-X @ w))
    cov = np.linalg.inv(X.T @ (X * (p * (1 - p))[:, None]) + 1e-9 * np.eye(X.shape[1]))
    se = np.sqrt(np.diag(cov))
    ll = float(np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
    return w, se, ll


def predict_ll(w, X, y):
    X = np.column_stack([np.ones(len(X)), X])
    p = 1 / (1 + np.exp(-X @ w))
    return float(np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def pick(rs, min_gp=15, max_gp=99, need=()):
    out = []
    for r in rs:
        if r["season"] not in FULL:
            continue
        h, a = r["h"], r["a"]
        if not (min_gp <= h["gp"] <= max_gp and min_gp <= a["gp"] <= max_gp):
            continue
        if any(h.get(k) is None or a.get(k) is None for k in need):
            continue
        out.append(r)
    return out


def diff(rs, k):
    return np.array([r["h"][k] - r["a"][k] for r in rs])


def yv(rs):
    return np.array([1.0 if r["g"]["hg"] > r["g"]["ag"] else 0.0 for r in rs])


def compare(label, rs, base_feats, extra_feats, out_key):
    """Fit base vs base+extra; also check out-of-sample on the most recent season."""
    y = yv(rs)
    Xb = np.column_stack([f(rs) for f in base_feats.values()])
    Xe = np.column_stack([Xb] + [f(rs) for f in extra_feats.values()])
    wb, _, llb = logit(Xb, y)
    we, se, lle = logit(Xe, y)
    names = list(base_feats) + list(extra_feats)
    # out of sample: train on earlier seasons, test on 2025-26
    tr = np.array([r["season"] != 20252026 for r in rs]); te = ~tr
    oos = None
    if te.sum() > 200:
        wb2, _, _ = logit(Xb[tr], y[tr]); we2, _, _ = logit(Xe[tr], y[tr])
        oos = predict_ll(we2, Xe[te], y[te]) - predict_ll(wb2, Xb[te], y[te])
    res = {"n": len(rs), "gainInSample": lle - llb, "gainOutOfSample": oos,
           "coefs": {n: {"coef": float(we[i + 1]), "z": float(we[i + 1] / se[i + 1])} for i, n in enumerate(names)}}
    R[out_key] = res
    print(f"\n{label}  (n={len(rs)})  in-sample gain {res['gainInSample'] * 1000:+.2f}  "
          f"2025-26 out-of-sample gain {'' if oos is None else f'{oos * 1000:+.2f}'}  (x1000 log-loss; >0 = better)")
    for n, c in res["coefs"].items():
        print(f"   {n:22s} coef {c['coef']:+.3f}  z {c['z']:+.1f}")
    return res


# ---------- 1. Shot quality: xG vs goals ----------
need = ("gd", "xgd", "xgd5", "sogd", "cfd", "pdo5")
for lo, hi, tag in ((15, 30, "early"), (31, 55, "mid"), (56, 99, "late"), (15, 99, "all")):
    rs = pick(rows, lo, hi, need)
    y = yv(rs)
    res = {}
    for name in ("gd", "xgd", "xgd5", "sogd", "cfd"):
        _, _, ll = logit(diff(rs, name)[:, None], y)
        res[name] = ll
    # best blend of goals and xG
    best = max(((a, logit((a * diff(rs, "gd") + (1 - a) * diff(rs, "xgd"))[:, None], y)[2]) for a in np.linspace(0, 1, 11)),
               key=lambda t: t[1])
    R.setdefault("shotQuality", {})[tag] = {"n": len(rs), "logLoss": res, "bestGoalsWeight": float(best[0]), "bestBlendLL": best[1]}
    print(f"\n1. [{tag} season, GP {lo}-{hi}, n={len(rs)}] log-loss (higher better): " +
          "  ".join(f"{k} {v:.4f}" for k, v in res.items()) + f"  | best blend: {best[0]:.1f} goals / {1 - best[0]:.1f} xG -> {best[1]:.4f}")

# ---------- 2. PDO (luck) on top of goal differential ----------
rs = pick(rows, 15, 99, need)
compare("2. PDO on top of goal diff", rs, {"gd": lambda r: diff(r, "gd")}, {"pdo5": lambda r: diff(r, "pdo5")}, "pdo")
compare("2b. PDO on top of xG blend", rs, {"blend": lambda r: 0.5 * diff(r, "gd") + 0.5 * diff(r, "xgd")},
        {"pdo5": lambda r: diff(r, "pdo5")}, "pdoBlend")

# ---------- 3. Last season's rating early in the year ----------
rs = [r for r in pick(rows, 3, 40, ("gd", "prior"))]
y = yv(rs)
R["prior"] = {}
for k in (0, 5, 10, 15, 20, 30, 40):
    def blended(side, k=k):
        out = []
        for r in rs:
            t = r[side]
            prior = t["prior"] * (2 / 3)  # regress last season a third toward average
            out.append((t["gd"] * t["gp"] + prior * k) / (t["gp"] + k))
        return np.array(out)
    x = blended("h") - blended("a")
    _, _, ll = logit(x[:, None], y)
    R["prior"][k] = ll
print("\n3. LAST SEASON AS A PRIOR (games 3-40, n=%d): log-loss by games-worth of prior" % len(rs))
print("   " + "  ".join(f"k={k}: {v:.4f}" for k, v in R["prior"].items()))
for lo, hi in ((3, 10), (11, 20), (21, 40)):
    sub = [r for r in rs if lo <= min(r["h"]["gp"], r["a"]["gp"]) <= hi]
    yy = yv(sub)
    a = logit(diff(sub, "gd")[:, None], yy)[2]
    b = logit(np.array([r["h"]["prior"] - r["a"]["prior"] for r in sub])[:, None], yy)[2]
    R.setdefault("priorByStage", {})[f"{lo}-{hi}"] = {"n": len(sub), "thisSeasonLL": a, "lastSeasonLL": b}
    print(f"   GP {lo}-{hi} (n={len(sub)}): this season GD {a:.4f}  vs  last season GD {b:.4f}")

# ---------- 4. Schedule spots ----------
rs = pick(rows, 15, 99, ("gd", "rest"))
def flag(rs, side, f):
    return np.array([1.0 if f(r[side]) else 0.0 for r in rs])
sched = {
    "homeB2B": lambda r: flag(r, "h", lambda t: t["rest"] == 1),
    "awayB2B": lambda r: flag(r, "a", lambda t: t["rest"] == 1),
    "home3in4": lambda r: flag(r, "h", lambda t: t["in4"] >= 2),
    "away3in4": lambda r: flag(r, "a", lambda t: t["in4"] >= 2),
    "awayLongTrip(4+)": lambda r: flag(r, "a", lambda t: t["roadStreak"] >= 3),
    "homeBackFromTrip(4+)": lambda r: flag(r, "h", lambda t: t["roadStreak"] >= 4),
    "awayWentWest2+tz": lambda r: flag(r, "a", lambda t: t["tzShift"] <= -2),
    "awayWentEast2+tz": lambda r: flag(r, "a", lambda t: t["tzShift"] >= 2),
}
compare("4. SCHEDULE SPOTS (on top of goal diff)", rs, {"gd": lambda r: diff(r, "gd")}, sched, "schedule")
R["scheduleCounts"] = {k: int(f(rs).sum()) for k, f in sched.items()}
print("   counts:", R["scheduleCounts"])

# ---------- 5. Starting goalie ----------
rs = pick(rows, 15, 99, ("gd", "goalieEdge"))
compare("5. STARTING GOALIE vs team's usual goaltending (on top of goal diff)", rs,
        {"gd": lambda r: diff(r, "gd")}, {"goalieEdge": lambda r: diff(r, "goalieEdge")}, "goalie")
# backups: starter has started < 40% of team's games
y = yv(rs)
bk_h = [r for r in rs if (r["h"].get("starterShare") or 1) < 0.4 and (r["a"].get("starterShare") or 0) >= 0.5]
bk_a = [r for r in rs if (r["a"].get("starterShare") or 1) < 0.4 and (r["h"].get("starterShare") or 0) >= 0.5]
w, _, _ = logit(diff(rs, "gd")[:, None], y)
def expected(sub):
    x = np.column_stack([np.ones(len(sub)), diff(sub, "gd")])
    return float((1 / (1 + np.exp(-x @ w))).mean())
R["backups"] = {
    "homeBackup": {"n": len(bk_h), "homeWin": float(yv(bk_h).mean()), "expected": expected(bk_h)},
    "awayBackup": {"n": len(bk_a), "homeWin": float(yv(bk_a).mean()), "expected": expected(bk_a)},
}
print("   backup in net:", json.dumps(R["backups"]))

# ---------- 6. Everything together, judged on 2025-26 only ----------
rs = pick(rows, 15, 99, ("gd", "xgd", "pdo5", "goalieEdge", "rest"))
compare("6. COMBINED: blend + goalie + B2B", rs,
        {"gd": lambda r: diff(r, "gd")},
        {"xgd": lambda r: diff(r, "xgd"), "goalieEdge": lambda r: diff(r, "goalieEdge"),
         "homeB2B": sched["homeB2B"], "awayB2B": sched["awayB2B"]}, "combined")

# goalie effect on totals
tot = np.array([r["g"]["hg"] + r["g"]["ag"] for r in rs], dtype=float)
ge = np.array([r["h"]["goalieEdge"] + r["a"]["goalieEdge"] for r in rs])
base = np.array([r["h"]["gf"] + r["a"]["gf"] + r["h"]["ga"] + r["a"]["ga"] for r in rs]) / 2
X = np.column_stack([np.ones(len(rs)), base, ge])
b = np.linalg.lstsq(X, tot, rcond=None)[0]
resid = tot - X @ b
se = math.sqrt(float(resid @ resid) / (len(rs) - 3) * np.linalg.inv(X.T @ X)[2, 2])
R["goalieTotals"] = {"goalsPerGoalieEdge": float(b[2]), "z": float(b[2] / se)}
print("\n7. GOALIE EFFECT ON TOTALS: each +1 goal/game of combined goalie edge changes total by %.2f (z %.1f)" % (b[2], b[2] / se))

(ROOT / "data" / "research2.json").write_text(json.dumps(R, indent=1))
print("\nWrote data/research2.json")
