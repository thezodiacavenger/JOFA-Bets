# JOFA Bets

An NHL game-betting research aid. Built for traditional bets on Bet365 and similar books: **moneyline, puck line, over/under and game props**. It does not cover fantasy or player props.

**Live site:** https://thezodiacavenger.github.io/JOFA-Bets/ (after the one-time setup below)

## What it does

- **Slate:** every game for today and the next few days, with:
  - model win % for each side and the **fair odds** (the break-even price)
  - the market's view: consensus moneyline from several books with the bookmaker margin removed, and the best price available
  - expected goals, over 6.5 / 5.5 chance, chance of overtime
  - **Angles:** up to two betting ideas per game, each with the one or two stat reasons behind it
  - full breakdown: side-by-side stats, every model line, goalies, hot players, season series
- **Check a Bet365 price:** pick a market, type the price Bet365 shows, and get the model's chance, what the price implies, and expected return per $100 (VALUE / FAIR / PASS).
- **Head-to-head:** any two teams in seconds, scheduled or not, with a neutral-site option.
- **Research:** a 5-season study (6,533 games) of whether home ice, road form and scoring style predict results. Short version: home ice is worth about 3–4 points, team home/road records don't persist, goal differential is the best guide, and scoring style doesn't decide winners or move totals much.
- **Starting goalie picker** on every upcoming game: projected from recent starts (switching to the other goalie when the usual starter played the night before). Change it once starters are confirmed and every number updates.
- **Bet log:** tap "+ Log bet" on any angle (or add one by hand), mark W/L/P, and see record, profit, return and **closing line value** (auto-filled for moneylines logged from the slate). Stored on the device you use; export to CSV.
- **Teams:** sortable table of home vs road form, road-minus-home gap (road warriors), goal ratio, last 10, special teams, save %, over/OT rates.

## What it looks at

| Factor | Where it shows up |
|---|---|
| Home-ice advantage | League-wide home edge built into the model; team home/road records shown but marked weak (see Research) |
| Teams better on the road | *Road − Home* column in Teams; marked weak signal (doesn't persist) |
| Goal ratios / differential | 80% of each rating is the full season, blending expected goals (shot quality) with actual goals: all xG early, 70% goals late |
| Shot quality and luck | Expected goals from MoneyPuck; PDO "running hot/cold" reasons |
| Last season | Counts for ~8 games early in the season, regressed a third toward average |
| Starting goalie | Starter's adjusted save % vs the team's goaltending so far scales the opponent's expected goals |
| Recent form | Last 10 and last 5 results, streak (10% weight; weak signal) |
| Rest | Back-to-back: about −7 points of win chance (other schedule spots tested and rejected) |
| Special teams | Power play vs opponent's penalty kill |
| Goaltending | Team save %, each goalie's season line |
| Season series | Results of earlier meetings |
| Market | Consensus no-vig moneyline vs model |

The model's tuning constants were checked against the 2026-27 season's real results (309 games: OT rate, 2+ goal margins, home win %, over 6.5 rate all within about 1%). It is worth re-checking these every month or so as the season matures. See the **How it works** tab on the site for the details and the known limits.

## One-time setup (2 minutes)

1. In this repo on GitHub, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab, open **Refresh NHL data and publish site**, and click **Run workflow**.

After that the site rebuilds itself every hour from 10 am to midnight Eastern. You can hit **Run workflow** any time for an instant refresh (e.g. right before betting).

## Running locally

```bash
python3 scripts/fetch_data.py
```

```bash
python3 -m http.server 8000 --directory docs
```

Then open http://localhost:8000.

## Files

- `scripts/fetch_data.py` pulls standings, splits, special teams, schedules, goalies and odds from the NHL's public API into `docs/data/latest.json` (standard library only, no keys).
- `docs/model.js` holds the rating model, score grid, market comparison and reason/angle finder. Tuning constants are at the top.
- `docs/app.js`, `docs/index.html` and `docs/style.css` are the website.
- `scripts/fetch_history.py`, `scripts/fetch_history_extra.py`, `scripts/research.py` and `scripts/research2.py` rebuild the 5-season studies (outputs in `data/`).

Expected-goals data courtesy of [MoneyPuck.com](https://moneypuck.com).
- `.github/workflows/refresh.yml` runs the hourly refresh and publish.

---

Research aid only. No model is a guarantee. Bet what you can afford to lose. 19+.
