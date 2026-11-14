/* JOFA Bets — matchup model and "angle" finder.
 *
 * How it works (plain English):
 *  1. Each team gets an attack and defence rating relative to league average,
 *     built mostly from the full season (80%), with a little from its home-or-road
 *     split (10%) and last 10 games (10%). The full-season part blends shot
 *     quality (expected goals) with actual goals: all xG early in the season,
 *     shifting to 70% goals by the last third. Early on it also leans on last
 *     season's rating (worth ~8 games), pulled a third of the way to average.
 *  2. Expected goals for each side = league average at that venue x attack x
 *     opponent's defence, adjusted for the starting goalie and back-to-backs.
 *  3. A Poisson score grid (tuned to real NHL tie and empty-net rates) gives
 *     win %, puck line %, totals % and simple game props.
 *  4. Model % is compared with the bookmakers' prices to find gaps, and the
 *     stats are scanned for the strongest reasons supporting each side.
 */
(function (global) {
  "use strict";

  // Weights set from 5 seasons of history (scripts/research.py): team-specific home/road
  // splits and last-10 form add almost nothing once full-season goals are known.
  const W_SPLIT = 0.1, W_SEASON = 0.8, W_L10 = 0.1;
  const SHRINK_GAMES = 6;      // games of league-average "prior" mixed in
  const SHRINK_SPLIT = 10;     // home/road splits are noisier, so pull them harder
  // Round 2 research (scripts/research2.py):
  const B2B_ATTACK = 0.93;     // back-to-back costs ~7 pts of win chance, beyond the backup goalie
  const B2B_DEFENCE = 1 / 0.93;
  const PRIOR_GAMES = 8;       // last season's rating counts as ~8 games early in the year
  const PRIOR_KEEP = 2 / 3;    // ...after pulling it a third of the way back to average
  // Actual goals' share of the full-season rating (the rest is expected goals):
  const goalsWeight = (gp) => Math.min(0.7, Math.max(0, (gp - 25) / 50));
  const TIE_BOOST = 1.6;      // NHL games tie in regulation more than Poisson says
  const EMPTY_NET = 0.28;       // share of 1-goal regulation leads that become 2 (empty net)
  const MAX_GOALS = 11;
  const GOAL_SCALE = 0.97;    // trims scoring so totals match this season's results
  const HOME_EDGE = 1.03;     // small extra home lift (last change, crowd, matchups)

  // ---------- helpers ----------
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const pct = (x, d = 0) => (x == null || isNaN(x) ? "–" : (x * 100).toFixed(d) + "%");
  const ptsPct = (s) => (s && s.gp ? s.pts / (2 * s.gp) : null);
  const perGame = (s, k) => (s && s.gp ? s[k] / s.gp : null);

  function poisson(lambda, k) {
    let p = Math.exp(-lambda);
    for (let i = 1; i <= k; i++) p *= lambda / i;
    return p;
  }

  // ---------- odds ----------
  function toDecimal(v) {
    if (v == null || v === "") return null;
    const s = String(v).trim();
    const n = parseFloat(s);
    if (isNaN(n)) return null;
    if (s.startsWith("+") || s.startsWith("-") || Math.abs(n) >= 100) {
      return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
    }
    return n > 1 ? n : null;
  }
  const implied = (v) => { const d = toDecimal(v); return d ? 1 / d : null; };
  function fairAmerican(p) {
    if (!p || p <= 0 || p >= 1) return "–";
    const v = p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
    return (v > 0 ? "+" : "") + Math.round(v);
  }
  const fairDecimal = (p) => (!p || p <= 0 ? "–" : (1 / p).toFixed(2));

  // Consensus no-vig market probability from the books in the NHL feed.
  // 3-way (regulation-only) books are dropped: their prices add up to < 100%.
  function market(game) {
    const rows = [];
    for (const a of game.awayOdds || []) {
      const h = (game.homeOdds || []).find((x) => x.book === a.book);
      if (!h) continue;
      const ia = implied(a.value), ih = implied(h.value);
      if (!ia || !ih) continue;
      const total = ia + ih;
      if (total < 0.98 || total > 1.15) continue;
      rows.push({ book: a.book, away: a.value, home: h.value, pAway: ia / total, pHome: ih / total,
                  decAway: toDecimal(a.value), decHome: toDecimal(h.value) });
    }
    if (!rows.length) return null;
    const sorted = rows.map((r) => r.pHome).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const good = rows.filter((r) => Math.abs(r.pHome - median) <= 0.06);
    rows.length = 0; rows.push(...good);
    const pHome = sum(rows, (r) => r.pHome) / rows.length;
    const bestHome = rows.reduce((b, r) => (r.decHome > b.decHome ? r : b));
    const bestAway = rows.reduce((b, r) => (r.decAway > b.decAway ? r : b));
    return { books: rows, pHome, pAway: 1 - pHome, bestHome, bestAway };
  }

  // ---------- league context ----------
  function league(teams) {
    const T = Object.values(teams);
    const gp = sum(T, (t) => t.gp) || 1;
    const homeGp = sum(T, (t) => t.home.gp) || 1;
    const roadGp = sum(T, (t) => t.road.gp) || 1;
    const games = [];
    for (const t of T) for (const g of t.games) if (g.home) games.push(g);
    const n = games.length || 1;
    return {
      all: sum(T, (t) => t.gf) / gp,
      home: sum(T, (t) => t.home.gf) / homeGp,
      road: sum(T, (t) => t.road.gf) / roadGp,
      pp: sum(T, (t) => t.ppPct || 0) / T.length,
      pk: sum(T, (t) => t.pkPct || 0) / T.length,
      sv: sum(T, (t) => t.svPct || 0) / T.length,
      homeWin: games.filter((g) => g.gf > g.ga).length / n,
      otRate: games.filter((g) => g.end !== "REG").length / n,
      avgTotal: sum(games, (g) => g.gf + g.ga) / n,
      // expected goals are rescaled so their league total matches actual goals
      xgScale: (() => { const X = T.filter((t) => t.xg && t.xg.gp);
        const xg = sum(X, (t) => t.xg.xgf / t.xg.gp * t.gp); return xg ? sum(X, (t) => t.gf) / xg : 1; })(),
      prevAvg: (() => { const P = T.filter((t) => t.prev); return P.length ? sum(P, (t) => t.prev.gfpg) / P.length : null; })(),
      prevXgScale: (() => { const P = T.filter((t) => t.prev); const x = sum(P, (t) => t.prev.xgfpg); return x ? sum(P, (t) => t.prev.gfpg) / x : 1; })(),
      sv: null,
    };
  }

  // ---------- team form from the game log ----------
  function teamForm(t, beforeDate) {
    const games = t.games.filter((g) => !beforeDate || g.date < beforeDate);
    const n = games.length || 1;
    const over = (line) => games.filter((g) => g.gf + g.ga > line).length / n;
    const last5 = games.slice(-5);
    return {
      n: games.length,
      over55: over(5.5), over65: over(6.5),
      otRate: games.filter((g) => g.end !== "REG").length / n,
      winBy2: games.filter((g) => g.gf - g.ga >= 2).length / n,
      coverPlus: games.filter((g) => g.gf - g.ga >= -1).length / n,
      scored3: games.filter((g) => g.gf >= 3).length / n,
      shutOut: games.filter((g) => g.gf === 0).length / n,
      last5: last5.map((g) => (g.gf > g.ga ? "W" : g.end === "REG" ? "L" : "O")).join(""),
      last5Goals: last5.length ? sum(last5, (g) => g.gf) / last5.length : null,
      last5Against: last5.length ? sum(last5, (g) => g.ga) / last5.length : null,
    };
  }

  function rest(t, date) {
    const prev = (t.schedule || []).filter((d) => d < date).pop();
    if (!prev) return { days: null, b2b: false };
    const days = Math.round((new Date(date) - new Date(prev)) / 86400000);
    return { days, b2b: days === 1, prev };
  }

  // Projected starter: whoever has started most of the last 10 games, unless the team
  // played yesterday and he started that one — then the other regular usually goes.
  // How often this rule picked the actual starter in 5 seasons (11,035 team-games),
  // by how many of the team's last 10 starts the projected goalie made.
  // No rule tested beat it (last game's starter: 55%; most of last 5: 66%; season leader: 64%).
  const STARTER_HIT = { 10: 0.82, 9: 0.77, 8: 0.73, 7: 0.71, 6: 0.6, 5: 0.52, 4: 0.45, 3: 0.4 };
  const B2B_FLIP_HIT = 0.79;

  function projectStarter(t, date, b2b) {
    const G = (t.goalies || []).filter((g) => g.gs > 0);
    if (!G.length) return null;
    const main = G[0];
    if (b2b && main.lastStart && G[1]) {
      const yesterday = new Date(new Date(date) - 86400000).toISOString().slice(0, 10);
      if (main.lastStart === yesterday)
        return { goalie: G[1], why: "backup likely on a back-to-back", conf: B2B_FLIP_HIT, alt: main };
    }
    const conf = G[1] ? STARTER_HIT[Math.max(3, Math.min(10, main.recent || 0))] ?? 0.6 : 0.95;
    return { goalie: main, why: "projected", conf, alt: G[1] || null };
  }

  // Goals-against multiplier vs the goaltending that produced the team's numbers so far
  function goalieFactor(t, g) {
    if (!g || !t.goalieMixSv) return 1;
    return Math.min(1.2, Math.max(0.8, (1 - g.sv) / (1 - t.goalieMixSv)));
  }

  function headToHead(home, away) {
    return home.games.filter((g) => g.opp === away.abbrev);
  }

  // ---------- ratings ----------
  function shrunk(goals, gp, lgRate, k = SHRINK_GAMES) {
    return (goals + k * lgRate) / (gp + k) / lgRate;
  }

  // Full-season goals for/against with expected goals blended in (same units as goals)
  function seasonTotals(t, L) {
    if (!t.xg || !t.xg.gp) return { gf: t.gf, ga: t.ga, wGoals: 1 };
    const w = goalsWeight(t.gp);
    const xgf = (t.xg.xgf / t.xg.gp) * t.gp * L.xgScale, xga = (t.xg.xga / t.xg.gp) * t.gp * L.xgScale;
    return { gf: w * t.gf + (1 - w) * xgf, ga: w * t.ga + (1 - w) * xga, wGoals: w };
  }

  // Season component pulled toward last season's (regressed) rating instead of league average
  function seasonPart(t, L) {
    const s = seasonTotals(t, L);
    if (!t.prev || !L.prevAvg) return [shrunk(s.gf, t.gp, L.all), shrunk(s.ga, t.gp, L.all)];
    const prevF = 0.7 * t.prev.gfpg + 0.3 * t.prev.xgfpg * L.prevXgScale;
    const prevA = 0.7 * t.prev.gapg + 0.3 * t.prev.xgapg * L.prevXgScale;
    const pf = L.all * (1 + (prevF / L.prevAvg - 1) * PRIOR_KEEP);
    const pa = L.all * (1 + (prevA / L.prevAvg - 1) * PRIOR_KEEP);
    const k = PRIOR_GAMES;
    return [(s.gf + k * pf) / (t.gp + k) / L.all, (s.ga + k * pa) / (t.gp + k) / L.all];
  }

  function rating(t, venue, L) {
    const lgFor = venue === "home" ? L.home : venue === "road" ? L.road : L.all;
    const lgAgainst = venue === "home" ? L.road : venue === "road" ? L.home : L.all;
    const sp = seasonPart(t, L);
    const parts = [
      [W_SEASON, sp[0], sp[1]],
      [W_L10, shrunk(t.l10.gf, t.l10.gp, L.all), shrunk(t.l10.ga, t.l10.gp, L.all)],
    ];
    if (venue !== "neutral") {
      const s = t[venue];
      parts.push([W_SPLIT, shrunk(s.gf, s.gp, lgFor, SHRINK_SPLIT), shrunk(s.ga, s.gp, lgAgainst, SHRINK_SPLIT)]);
    }
    const w = sum(parts, (p) => p[0]);
    return {
      att: sum(parts, (p) => p[0] * p[1]) / w,
      def: sum(parts, (p) => p[0] * p[2]) / w,
    };
  }

  // ---------- score grid ----------
  function grid(lh, la) {
    const P = [];
    let tie = 0, total = 0;
    for (let h = 0; h <= MAX_GOALS; h++) {
      P[h] = [];
      for (let a = 0; a <= MAX_GOALS; a++) {
        let p = poisson(lh, h) * poisson(la, a);
        if (h === a) p *= TIE_BOOST;
        P[h][a] = p;
        total += p;
      }
    }
    for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) P[h][a] /= total;
    // Empty-net goals: some 1-goal leads become 2-goal wins.
    for (let h = 0; h < MAX_GOALS; h++) {
      for (let a = 0; a < MAX_GOALS; a++) {
        if (h - a === 1) { const m = P[h][a] * EMPTY_NET; P[h][a] -= m; P[h + 1][a] += m; }
        if (a - h === 1) { const m = P[h][a] * EMPTY_NET; P[h][a] -= m; P[h][a + 1] += m; }
      }
    }
    for (let h = 0; h <= MAX_GOALS; h++) tie += P[h][h];
    return { P, tie };
  }

  function probabilities(lh, la) {
    const { P, tie } = grid(lh, la);
    const otHome = 0.5 + 0.5 * (lh / (lh + la) - 0.5); // OT/shootout leans slightly to better side
    const out = { regHome: 0, regAway: 0, tie, homeBy2: 0, awayBy2: 0, totals: {}, homeTT: {}, awayTT: {}, btts: 0, expTotal: 0 };
    const lines = [4.5, 5.5, 6.5, 7.5];
    const tt = [1.5, 2.5, 3.5, 4.5];
    lines.forEach((l) => (out.totals[l] = 0));
    tt.forEach((l) => { out.homeTT[l] = 0; out.awayTT[l] = 0; });
    for (let h = 0; h <= MAX_GOALS; h++) {
      for (let a = 0; a <= MAX_GOALS; a++) {
        const p = P[h][a];
        if (h > a) out.regHome += p;
        if (a > h) out.regAway += p;
        if (h - a >= 2) out.homeBy2 += p;
        if (a - h >= 2) out.awayBy2 += p;
        // Final scores: a tied game gets one extra goal for the OT/shootout winner.
        const cases = h === a ? [[h + 1, a, otHome], [h, a + 1, 1 - otHome]] : [[h, a, 1]];
        for (const [fh, fa, w] of cases) {
          for (const l of lines) if (fh + fa > l) out.totals[l] += p * w;
          for (const l of tt) { if (fh > l) out.homeTT[l] += p * w; if (fa > l) out.awayTT[l] += p * w; }
          if (fh > 0 && fa > 0) out.btts += p * w;
          out.expTotal += p * w * (fh + fa);
        }
      }
    }
    out.home = out.regHome + tie * otHome;
    out.away = 1 - out.home;
    return out;
  }

  // ---------- full analysis of one matchup ----------
  function analyze(data, homeAb, awayAb, opts = {}) {
    const teams = data.teams;
    const H = teams[homeAb], A = teams[awayAb];
    const L = data._league || (data._league = league(teams));
    const date = opts.date || new Date().toISOString().slice(0, 10);
    const neutral = !!opts.neutral;

    const rh = rating(H, neutral ? "neutral" : "home", L);
    const ra = rating(A, neutral ? "neutral" : "road", L);
    const none = { days: null, b2b: false };
    const restH = opts.noRest ? none : rest(H, date), restA = opts.noRest ? none : rest(A, date);

    let lh = (neutral ? L.all : L.home * HOME_EDGE) * rh.att * ra.def * GOAL_SCALE;
    let la = (neutral ? L.all : L.road / HOME_EDGE) * ra.att * rh.def * GOAL_SCALE;
    if (restH.b2b) { lh *= B2B_ATTACK; la *= B2B_DEFENCE; }
    if (restA.b2b) { la *= B2B_ATTACK; lh *= B2B_DEFENCE; }

    // Starting goalies: chosen by the user, else projected
    const pickG = (t, id, r) => {
      const chosen = id && (t.goalies || []).find((g) => g.id === +id);
      return chosen ? { goalie: chosen, why: "selected" } : opts.noRest ? projectStarter(t, date, false) : projectStarter(t, date, r.b2b);
    };
    const gH = pickG(H, opts.goalies && opts.goalies.home, restH);
    const gA = pickG(A, opts.goalies && opts.goalies.away, restA);
    const fGH = goalieFactor(H, gH && gH.goalie), fGA = goalieFactor(A, gA && gA.goalie);
    la *= fGH; lh *= fGA;

    const p = probabilities(lh, la);
    const mkt = opts.game ? market(opts.game) : null;
    const fH = teamForm(H, date), fA = teamForm(A, date);
    const h2h = headToHead(H, A).filter((g) => g.date < date);

    const ctx = { H, A, L, p, mkt, fH, fA, restH, restA, h2h, lh, la, neutral, game: opts.game, gH, gA, fGH, fGA, opts };
    ctx.reasons = findReasons(ctx);
    ctx.angles = findAngles(ctx);
    return ctx;
  }

  // ---------- reasons: stat-based mismatches ----------
  function findReasons(c) {
    const { H, A, L, fH, fA, restH, restA, h2h, p, neutral } = c;
    const R = [];
    // weak = shown for context, but history says it doesn't predict results, so it never backs an angle
    const add = (side, score, title, text, weak = false) => R.push({ side, score: weak ? score * 0.3 : score, title, text, weak });
    const nm = (t) => t.common || t.abbrev;
    const poss = (n) => (n.endsWith("s") ? n + "'" : n + "'s");

    // Home ice vs road form
    const hHome = ptsPct(H.home), aRoad = ptsPct(A.road);
    if (!neutral && H.home.gp >= 3 && A.road.gp >= 3) {
      const gap = hHome - aRoad;
      if (gap >= 0.15)
        add("home", gap, "Home-ice edge",
          `${nm(H)} earn ${pct(hHome)} of points at home; ${nm(A)} only ${pct(aRoad)} on the road.`, true);
      if (gap <= -0.12)
        add("away", -gap, "Road team travels well",
          `${nm(A)} earn ${pct(aRoad)} of points on the road vs ${nm(H)}'s ${pct(hHome)} at home.`, true);
    }
    // Road warriors / home-weak
    if (A.road.gp >= 4 && aRoad >= 0.65 && aRoad > ptsPct(A.home) + 0.05)
      add("away", aRoad - 0.5, "Road warriors",
        `${nm(A)} are ${A.road.w}-${A.road.l}-${A.road.otl} away from home — better than at home (${pct(ptsPct(A.home))}).`, true);
    if (!neutral && H.home.gp >= 4 && hHome <= 0.4)
      add("away", 0.5 - hHome, "Weak at home",
        `${nm(H)} are just ${H.home.w}-${H.home.l}-${H.home.otl} at home (${pct(hHome)} of points).`, true);

    // Goal differential per game: the best single predictor in 5 seasons of history
    const gd = (t) => (t.gf - t.ga) / Math.max(t.gp, 1);
    const sgn = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);
    const dGD = gd(H) - gd(A);
    if (Math.abs(dGD) >= 0.4) {
      const better = dGD > 0 ? H : A, worse = dGD > 0 ? A : H;
      add(dGD > 0 ? "home" : "away", Math.abs(dGD) / 2, "Goal-differential gap",
        `${nm(better)} are ${sgn(gd(better))} goals per game (${better.gf} for, ${better.ga} against); ${nm(worse)} are ${sgn(gd(worse))}.`);
    }
    // Standings flatter one team: goal differential disagrees with points %
    const dPts = H.ptsPct - A.ptsPct;
    if (dPts * dGD < 0 && Math.abs(dPts) >= 0.05 && Math.abs(dGD) >= 0.2) {
      const real = dGD > 0 ? H : A, flat = dGD > 0 ? A : H;
      add(dGD > 0 ? "home" : "away", 0.2, "Standings flatter the other side",
        `${nm(flat)} have more points (${pct(flat.ptsPct)} vs ${pct(real.ptsPct)}) but a worse goal differential. Goal differential is the better guide.`);
    }

    // Recent form
    const l10 = (t) => `${t.l10.w}-${t.l10.l}-${t.l10.otl}`;
    const dForm = H.l10.pts - A.l10.pts;
    if (Math.abs(dForm) >= 5) {
      const hot = dForm > 0 ? H : A, cold = dForm > 0 ? A : H;
      add(dForm > 0 ? "home" : "away", Math.abs(dForm) / 20, "Form gap (last 10)",
        `${nm(hot)} are ${l10(hot)} in their last 10; ${nm(cold)} are ${l10(cold)}.`, true);
    }

    // Rest
    if (restH.b2b && !restA.b2b)
      add("away", 0.3, "Tired legs", `${nm(H)} played yesterday (back-to-back); ${nm(A)} ${restA.days ? `had ${restA.days - 1} day(s) off` : "are rested"}.`);
    if (restA.b2b && !restH.b2b)
      add("home", 0.3, "Tired legs", `${nm(A)} played yesterday (back-to-back); ${nm(H)} ${restH.days ? `had ${restH.days - 1} day(s) off` : "are rested"}.`);

    // Special teams
    const st = (x, y) => (x.ppPct - L.pp) + (L.pk - y.pkPct);
    const stH = st(H, A), stA = st(A, H);
    if (stH - stA >= 0.08 && H.ppPct != null)
      add("home", (stH - stA), "Special-teams mismatch",
        `${nm(H)} power play ${pct(H.ppPct, 1)} vs ${nm(A)} penalty kill ${pct(A.pkPct, 1)}.`);
    if (stA - stH >= 0.08 && A.ppPct != null)
      add("away", (stA - stH), "Special-teams mismatch",
        `${nm(A)} power play ${pct(A.ppPct, 1)} vs ${nm(H)} penalty kill ${pct(H.pkPct, 1)}.`);

    // Starting goalies (research: worth about as much per goal as goal differential)
    const gName = (g) => (g && g.goalie ? g.goalie.name.split(" ").slice(-1)[0] : "?");
    const edgeH = (1 - c.fGH) * c.la, edgeA = (1 - c.fGA) * c.lh; // goals saved vs usual
    if (Math.abs(edgeH - edgeA) >= 0.15 && c.gH && c.gA) {
      const better = edgeH > edgeA ? "home" : "away";
      const [bt, bg, wt, wg] = better === "home" ? [H, c.gH, A, c.gA] : [A, c.gA, H, c.gH];
      add(better, Math.abs(edgeH - edgeA) * 1.2, "Goalie matchup",
        `${gName(bg)} (${bg.goalie.sv.toFixed(3)} adj. sv%) for ${nm(bt)} vs ${gName(wg)} (${wg.goalie.sv.toFixed(3)}) for ${nm(wt)}${wg.why === "backup likely on a back-to-back" ? ", a likely back-to-back backup" : ""}. Confirm starters.`);
    }

    // Shot quality: expected goals per game (best predictor before ~game 55)
    const xgd = (t) => (t.xg && t.xg.gp ? (t.xg.xgf - t.xg.xga) / t.xg.gp : null);
    if (xgd(H) != null && xgd(A) != null) {
      const dX = xgd(H) - xgd(A);
      if (Math.abs(dX) >= 0.35) {
        const better = dX > 0 ? H : A, worse = dX > 0 ? A : H;
        add(dX > 0 ? "home" : "away", Math.abs(dX) / 1.6, "Shot-quality edge",
          `${nm(better)} create ${sgn(xgd(better))} expected goals per game more than they allow; ${nm(worse)} ${sgn(xgd(worse))}.`);
      }
    }

    // Luck: shooting % + save % at even strength (PDO) drifts back to ~1.000
    for (const [t, side, opp] of [[H, "home", "away"], [A, "away", "home"]]) {
      if (!t.pdo5 || t.gp < 10) continue;
      if (t.pdo5 >= 1.02)
        add(opp, (t.pdo5 - 1) * 8, "Running hot",
          `${poss(nm(t))} even-strength shooting % + save % is ${t.pdo5.toFixed(3)} (average 1.000). That usually cools off, so their record overstates them.`);
      if (t.pdo5 <= 0.98)
        add(side, (1 - t.pdo5) * 8, "Running cold",
          `${poss(nm(t))} even-strength shooting % + save % is ${t.pdo5.toFixed(3)} (average 1.000). Bad luck tends to even out, so they're better than their record.`);
    }

    // Season series
    if (h2h.length >= 2) {
      const hw = h2h.filter((g) => g.gf > g.ga).length;
      if (hw === h2h.length || hw === 0)
        add(hw ? "home" : "away", 0.15, "Season series",
          `${hw ? nm(H) : nm(A)} have won all ${h2h.length} meetings this season.`, true);
    }

    // Totals
    const expTotal = p.expTotal;
    const over65 = (fH.over65 + fA.over65) / 2;
    if (p.totals[6.5] >= 0.55 || (over65 >= 0.6 && expTotal > L.avgTotal))
      add("over", Math.max(p.totals[6.5] - 0.5, over65 - 0.5) + 0.05, "Goals expected",
        `Model expects ${expTotal.toFixed(1)} goals. ${nm(H)} games go over 6.5 ${pct(fH.over65)} of the time, ${nm(A)} ${pct(fA.over65)}.`);
    if (p.totals[5.5] <= 0.47 || (over65 <= 0.35 && expTotal < L.avgTotal))
      add("under", Math.max(0.5 - p.totals[5.5], 0.5 - over65) + 0.05, "Low-event matchup",
        `Model expects ${expTotal.toFixed(1)} goals. Overs on 6.5: ${nm(H)} ${pct(fH.over65)}, ${nm(A)} ${pct(fA.over65)}.`);

    return R.sort((a, b) => b.score - a.score);
  }

  // ---------- angles: ranked betting ideas ----------
  function findAngles(c) {
    const { H, A, p, mkt, reasons, fH, fA } = c;
    const ideas = [];
    const supporting = (side) => reasons.filter((r) => r.side === side && !r.weak).slice(0, 2);
    const nm = (t) => t.abbrev;

    // Moneyline: compare to market if we have it
    for (const side of ["home", "away"]) {
      const team = side === "home" ? H : A;
      const model = p[side];
      const why = supporting(side);
      if (mkt) {
        const mp = side === "home" ? mkt.pHome : mkt.pAway;
        const best = side === "home" ? mkt.bestHome : mkt.bestAway;
        const dec = side === "home" ? best.decHome : best.decAway;
        const ev = model * dec - 1;
        const edge = model - mp;
        if (edge >= 0.03 && why.length)
          ideas.push({ caution: edge >= 0.1, market: "Moneyline", pick: `${nm(team)} ML`, side, model, marketP: mp, ev, best: { book: best.book, price: side === "home" ? best.home : best.away },
            score: edge * 3 + why.length * 0.05, why });
      } else if (model >= 0.62 && why.length) {
        ideas.push({ market: "Moneyline", pick: `${nm(team)} ML`, side, model, score: (model - 0.55) + why.length * 0.05, why });
      }
    }

    // Puck line: favourite -1.5 when model says multi-goal win is likely
    const fav = p.home >= p.away ? "home" : "away";
    const favTeam = fav === "home" ? H : A, dogTeam = fav === "home" ? A : H;
    const by2 = fav === "home" ? p.homeBy2 : p.awayBy2;
    const favForm = fav === "home" ? fH : fA, dogForm = fav === "home" ? fA : fH;
    if (by2 >= 0.45 && favForm.winBy2 >= 0.45)
      ideas.push({ market: "Puck line", pick: `${nm(favTeam)} -1.5`, side: fav, model: by2,
        score: (by2 - 0.42) * 1.5, why: [...supporting(fav).slice(0, 1),
          { title: "Wins big", text: `${favTeam.common} win by 2+ in ${pct(favForm.winBy2)} of games; model ${pct(by2)}.` }] });
    const dogCover = 1 - by2;
    if (dogCover >= 0.74 && dogForm.coverPlus >= 0.75 && p[fav] < 0.6)
      ideas.push({ market: "Puck line", pick: `${nm(dogTeam)} +1.5`, side: fav === "home" ? "away" : "home", model: dogCover,
        score: (dogCover - 0.7), why: [{ title: "Stays close", text: `${dogTeam.common} win or lose by 1 in ${pct(dogForm.coverPlus)} of games; model ${pct(dogCover)}.` }] });

    // Totals
    for (const side of ["over", "under"]) {
      const r = reasons.find((x) => x.side === side);
      if (!r) continue;
      const line = side === "over" ? 6.5 : 5.5;
      const model = side === "over" ? p.totals[6.5] : 1 - p.totals[5.5];
      if (model < 0.56) continue;
      ideas.push({ market: "Total", pick: `${side === "over" ? "Over" : "Under"} ${line}`, side, model, score: r.score, why: [r] });
    }

    return ideas.sort((a, b) => b.score - a.score);
  }

  global.JofaModel = { analyze, projectStarter, league, market, toDecimal, implied, fairAmerican, fairDecimal, pct, ptsPct, perGame, teamForm, rest };
})(typeof window !== "undefined" ? window : globalThis);
