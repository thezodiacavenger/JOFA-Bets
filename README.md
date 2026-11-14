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
- **Teams:** sortable table of home vs road form, road-minus-home gap (road warriors), goal ratio, last 10, special teams, save %, over/OT rates.

## What it looks at

| Factor | Where it shows up |
|---|---|
| Home-ice advantage | Home team's home points % vs away team's road points %; venue-specific scoring in the model |
| Teams better on the road | "Road warriors" reason; *Road − Home* column in Teams |
| Goal ratios | Goals for ÷ goals against, plus GF/GA per game |
| Recent form | Last 10 and last 5 results, streak |
| Rest | Back-to-back flag, about −5% in the model |
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
- `.github/workflows/refresh.yml` runs the hourly refresh and publish.

---

Research aid only. No model is a guarantee. Bet what you can afford to lose. 19+.
