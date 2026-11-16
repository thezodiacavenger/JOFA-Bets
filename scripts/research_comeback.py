#!/usr/bin/env python3
"""How often do NHL teams come back from 2 goals down entering the 3rd period?
And how does it depend on team strength and home ice?

Uses data/history.json, data/periods.json and the pre-game team snapshots from
research2.py (only information available before the game).
"""
from __future__ import annotations

import contextlib
import io
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
PER = json.loads((ROOT / "data" / "periods.json").read_text())

src = (ROOT / "scripts" / "research2.py").read_text().split("# ---------- 1. Shot quality")[0]
ns = {"__name__": "x", "__file__": str(ROOT / "scripts" / "research2.py")}
with contextlib.redirect_stdout(io.StringIO()):
    exec(compile(src, "research2", "exec"), ns)
rows, logit = ns["rows"], ns["logit"]


def ci(p, n):
    return 1.96 * math.sqrt(max(p * (1 - p), 1e-9) / max(n, 1))


# ---------- every game where a team trailed by exactly 2 after two periods ----------
cases = []
bad = 0
for r in rows:
    g = r["g"]
    pr = PER.get(str(g["id"]))
    if not pr:
        continue
    a2, h2 = pr["p2"]
    # sanity check: period-2 score + 3rd-period goals should match regulation final
    a3 = sum(1 for _, s in pr["goals3"] if s == "away")
    h3 = sum(1 for _, s in pr["goals3"] if s == "home")
    if g["end"] == "REG" and (a2 + a3 != g["ag"] or h2 + h3 != g["hg"]):
        bad += 1
        continue
    if abs(h2 - a2) != 2:
        continue
    trail = "home" if h2 < a2 else "away"
    tr, ld = (r["h"], r["a"]) if trail == "home" else (r["a"], r["h"])
    t_reg = (h2 + h3) if trail == "home" else (a2 + a3)
    l_reg = (a2 + a3) if trail == "home" else (h2 + h3)
    tied = t_reg >= l_reg  # regulation ended level (or trailing team won in regulation)
    won = (g["hg"] > g["ag"]) == (trail == "home")
    cases.append({"season": g["season"], "id": g["id"], "trail": trail,
                  "trailTeam": g["home"] if trail == "home" else g["away"],
                  "leadTeam": g["away"] if trail == "home" else g["home"],
                  "tied": tied, "won": won, "wonReg": won and g["end"] == "REG",
                  "trGp": tr["gp"], "ldGp": ld["gp"],
                  "trGd": tr.get("gd"), "ldGd": ld.get("gd"), "trXgd": tr.get("xgd"), "ldXgd": ld.get("xgd")})

n = len(cases)
print(f"Score mismatches skipped: {bad}")
print(f"\nGames with a team down exactly 2 after two periods: {n}")
for lab, sub in (("all", cases), ("trailing team at home", [c for c in cases if c["trail"] == "home"]),
                 ("trailing team on road", [c for c in cases if c["trail"] == "away"])):
    k = len(sub)
    t = sum(c["tied"] for c in sub) / k
    w = sum(c["won"] for c in sub) / k
    wr = sum(c["wonReg"] for c in sub) / k
    print(f"  {lab:24s} n={k:5d}  forced OT/tied: {t:.3f} ±{ci(t, k):.3f}  won: {w:.3f} ±{ci(w, k):.3f}  won in regulation: {wr:.3f}")

# ---------- strength: blended rating diff (trailing minus leading), games 15+ ----------
sub = [c for c in cases if c["trGp"] >= 15 and c["ldGp"] >= 15 and c["trXgd"] is not None and c["ldXgd"] is not None]
blend = lambda gd, xgd: 0.2 * gd + 0.8 * xgd  # noqa: E731  (best mix in research2 for most of the season)
x = np.array([blend(c["trGd"], c["trXgd"]) - blend(c["ldGd"], c["ldXgd"]) for c in sub])
home = np.array([1.0 if c["trail"] == "home" else 0.0 for c in sub])
yt = np.array([1.0 if c["tied"] else 0.0 for c in sub])
yw = np.array([1.0 if c["won"] else 0.0 for c in sub])
wt, set_, _ = logit(np.column_stack([x, home]), yt)
ww, sew, _ = logit(np.column_stack([x, home]), yw)
print(f"\nStrength model (n={len(sub)}): tie-up coef per goal/game of rating gap {wt[1]:+.3f} (z {wt[1] / set_[1]:.1f}), home {wt[2]:+.3f} (z {wt[2] / set_[2]:.1f})")
print(f"                         win     coef {ww[1]:+.3f} (z {ww[1] / sew[1]:.1f}), home {ww[2]:+.3f} (z {ww[2] / sew[2]:.1f})")
for lo, hi, lab in ((-9, -0.5, "trailing team much weaker (gap < -0.5)"), (-0.5, -0.15, "somewhat weaker"), (-0.15, 0.15, "even"),
                    (0.15, 0.5, "somewhat stronger"), (0.5, 9, "trailing team much stronger (gap > +0.5)")):
    idx = (x >= lo) & (x < hi)
    k = int(idx.sum())
    if k:
        print(f"  {lab:42s} n={k:4d}  tied: {yt[idx].mean():.3f}  won: {yw[idx].mean():.3f}")

def predict(w, gap, is_home):
    z = w[0] + w[1] * gap + w[2] * is_home
    return 1 / (1 + math.exp(-z))

R = {"n": n, "coefTie": wt.tolist(), "coefWin": ww.tolist()}

# ---------- VGK vs VAN (current ratings) ----------
cur = json.loads((ROOT / "docs" / "data" / "latest.json").read_text())["teams"]
def rating(t):
    gd = (t["gf"] - t["ga"]) / t["gp"]
    xgd = (t["xg"]["xgf"] - t["xg"]["xga"]) / t["xg"]["gp"]
    return blend(gd, xgd), gd, xgd
lg = [rating(t)[0] for t in cur.values() if t.get("xg")]
avg = sum(lg) / len(lg)
vgk, van = rating(cur["VGK"]), rating(cur["VAN"])
print(f"\nCurrent ratings (0.2 goals + 0.8 expected goals, per game): VGK {vgk[0]:+.2f} (GD {vgk[1]:+.2f}, xGD {vgk[2]:+.2f}), "
      f"VAN {van[0]:+.2f} (GD {van[1]:+.2f}, xGD {van[2]:+.2f}), league avg {avg:+.2f}")
for lab, gap in (("VGK vs an average team", vgk[0] - avg), ("VGK vs VAN", vgk[0] - van[0]), ("average team vs average team", 0.0)):
    for h in (1, 0):
        print(f"  {lab:30s} {'home' if h else 'road'}: tie it {predict(wt, gap, h):.3f}   win it {predict(ww, gap, h):.3f}   (rating gap {gap:+.2f})")
R["vgk"] = {"rating": vgk, "vanRating": van, "leagueAvg": avg}

# ---------- what VGK and VAN have actually done ----------
for team, role in (("VGK", "trailTeam"), ("VAN", "leadTeam"), ("VAN", "trailTeam"), ("VGK", "leadTeam")):
    s = [c for c in cases if c[role] == team]
    by = {}
    for c in s:
        b = by.setdefault(c["season"], [0, 0, 0]); b[0] += 1; b[1] += c["tied"]; b[2] += c["won"]
    what = "came back from 2 down (tied / won)" if role == "trailTeam" else "opponent came back from 2 down vs them (tied / won)"
    print(f"\n{team} {what}: total {len(s)} games, tied {sum(c['tied'] for c in s)}, won {sum(c['won'] for c in s)}")
    for season in sorted(by):
        b = by[season]
        print(f"   {season}: {b[0]} games, tied {b[1]}, won {b[2]}")
h2h = [c for c in cases if {c["trailTeam"], c["leadTeam"]} == {"VGK", "VAN"}]
print(f"\nVGK–VAN games with a 2-goal lead after two: {[(c['season'], c['trailTeam'], 'tied' if c['tied'] else 'no', 'won' if c['won'] else '') for c in h2h]}")
(ROOT / "data" / "research_comeback.json").write_text(json.dumps(R, indent=1))
