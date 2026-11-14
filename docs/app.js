/* JOFA Bets — UI */
(function () {
  "use strict";
  const M = window.JofaModel;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = M.pct;
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  let DATA = null;
  let fmt = store.get("oddsFmt", "american");
  let activeDate = null;
  const darkMode = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const logo = (t) => esc(darkMode ? (t.logo || "").replace("_light", "_dark") : t.logo);

  const fair = (p) => (fmt === "decimal" ? M.fairDecimal(p) : M.fairAmerican(p));
  const price = (v) => {
    const d = M.toDecimal(v);
    if (!d) return "–";
    if (fmt === "decimal") return d.toFixed(2);
    const am = d >= 2 ? (d - 1) * 100 : -100 / (d - 1);
    return (am > 0 ? "+" : "") + Math.round(am);
  };
  const rec = (t) => `${t.w}-${t.l}-${t.otl}`;
  const splitRec = (s) => `${s.w}-${s.l}-${s.otl}`;
  const localTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const localDay = (d) => new Date(d + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

  // ---------- load ----------
  async function load() {
    try {
      const r = await fetch("data/latest.json", { cache: "no-store" });
      DATA = await r.json();
    } catch (e) {
      $("#slate").innerHTML = `<div class="empty">Couldn't load data. Try refreshing in a minute.</div>`;
      return;
    }
    const upd = new Date(DATA.updated);
    $("#updated").textContent = "updated " + upd.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
    $("#oddsFmt").value = fmt;
    setupTabs();
    renderDates();
    renderSlate();
    setupMatchup();
    renderTeams();
    BetLog.init();
  }

  // ---------- tabs ----------
  function setupTabs() {
    const buttons = document.querySelectorAll(".tabs button");
    const show = (name) => {
      buttons.forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
      document.querySelectorAll(".tab").forEach((s) => (s.hidden = s.id !== "tab-" + name));
      store.set("tab", name);
    };
    buttons.forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
    show(store.get("tab", "slate"));
  }

  // ---------- slate ----------
  function renderDates() {
    const dates = [...new Set(DATA.games.map((g) => g.date))];
    const today = new Date().toLocaleDateString("en-CA");
    activeDate = dates.includes(today) ? today : dates[0];
    $("#dates").innerHTML = dates.map((d) =>
      `<button class="chip" data-date="${d}" aria-pressed="${d === activeDate}">${d === today ? "Today" : localDay(d)}</button>`).join("");
    $("#dates").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      activeDate = b.dataset.date;
      document.querySelectorAll("#dates .chip").forEach((c) => c.setAttribute("aria-pressed", c === b));
      renderSlate();
    });
    $("#filter").addEventListener("input", renderSlate);
    $("#onlyAngles").addEventListener("change", renderSlate);
    $("#oddsFmt").addEventListener("change", (e) => { fmt = e.target.value; store.set("oddsFmt", fmt); renderSlate(); renderMatchup(); });
  }

  function matchesFilter(g, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return [g.home, g.away].some((ab) => {
      const t = DATA.teams[ab];
      return [ab, t.name, t.common].some((s) => (s || "").toLowerCase().includes(q));
    });
  }

  function renderSlate() {
    const q = $("#filter").value.trim();
    const onlyAngles = $("#onlyAngles").checked;
    const games = DATA.games.filter((g) => g.date === activeDate && matchesFilter(g, q))
      .sort((a, b) => a.startUTC.localeCompare(b.startUTC));
    const html = [];
    for (const g of games) {
      if (!DATA.teams[g.home] || !DATA.teams[g.away]) continue;
      const c = M.analyze(DATA, g.home, g.away, { date: g.date, neutral: g.neutral, game: g });
      if (onlyAngles && !c.angles.length) continue;
      html.push(card(c, g));
    }
    $("#slate").innerHTML = html.join("") || `<div class="empty">No games match.</div>`;
    wireCheckers($("#slate"));
  }

  // ---------- card ----------
  function teamBlock(t, side, restInfo) {
    const s = side === "home" ? t.home : t.road;
    const b2b = restInfo.b2b ? ` <span class="tag b2b">B2B</span>` : "";
    return `<div class="team ${side}">
      ${side === "away" ? `<img src="${logo(t)}" alt="">` : ""}
      <div><div class="nm">${esc(t.abbrev)} <span class="small">${esc(t.common)}</span>${b2b}</div>
      <div class="rec">${rec(t)} · ${side === "home" ? "Home" : "Road"} ${splitRec(s)} · L10 ${splitRec(t.l10)}</div></div>
      ${side === "home" ? `<img src="${logo(t)}" alt="">` : ""}
    </div>`;
  }

  function card(c, g) {
    const { H, A, p, mkt } = c;
    let mid;
    if (g && (g.state === "LIVE" || g.state === "CRIT")) mid = `<span class="tag live">LIVE</span><div class="score">${g.awayScore ?? 0} – ${g.homeScore ?? 0}</div>`;
    else if (g && (g.state === "OFF" || g.state === "FINAL")) mid = `<span class="tag">FINAL</span><div class="score">${g.awayScore} – ${g.homeScore}</div>`;
    else if (g) mid = `<div class="time">${localTime(g.startUTC)}</div>`;
    else mid = `<div class="time">@</div>`;
    if (c.neutral) mid += `<div><span class="tag">Neutral${g ? ": " + esc(g.venue) : ""}</span></div>`;

    const kpis = [
      ["Fair ML", `${esc(A.abbrev)} ${fair(p.away)} · ${esc(H.abbrev)} ${fair(p.home)}`],
      mkt ? ["Market (no vig)", `${pct(mkt.pAway)} · ${pct(mkt.pHome)}`] : null,
      mkt ? ["Best price", `${esc(A.abbrev)} ${price(mkt.bestAway.away)} <span class="small">${esc(mkt.bestAway.book)}</span> · ${esc(H.abbrev)} ${price(mkt.bestHome.home)} <span class="small">${esc(mkt.bestHome.book)}</span>`] : null,
      ["Expected goals", `${p.expTotal.toFixed(1)} <span class="small">(${c.la.toFixed(1)}–${c.lh.toFixed(1)} reg.)</span>`],
      ["Over 6.5 / 5.5", `${pct(p.totals[6.5])} / ${pct(p.totals[5.5])}`],
      ["Goes to OT", pct(p.tie)],
    ].filter(Boolean);

    const angles = c.angles.slice(0, 2);
    const anglesHtml = angles.length
      ? `<div class="angles">${angles.map((a) => angleHtml(a, c, g)).join("")}</div>`
      : `<div class="noangle">No clear edge. The numbers and the price roughly agree — a pass is a fine bet.</div>`;

    return `<article class="card">
      <div class="card-head">${teamBlock(A, "away", c.restA)}<div class="mid">${mid}</div>${teamBlock(H, "home", c.restH)}</div>
      <div class="bar" title="Model win chance"><div class="a" style="width:${(p.away * 100).toFixed(1)}%"></div><div class="h" style="width:${(p.home * 100).toFixed(1)}%"></div></div>
      <div class="bar-labels"><span><b>${pct(p.away)}</b> ${esc(A.abbrev)}</span><span class="small">model win %</span><span>${esc(H.abbrev)} <b>${pct(p.home)}</b></span></div>
      <div class="kpis">${kpis.map(([l, v]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join("")}</div>
      ${anglesHtml}
      <details class="more"><summary>Full breakdown & price checker</summary>${breakdown(c, g)}</details>
    </article>`;
  }

  function angleHtml(a, c, g) {
    const logData = esc(JSON.stringify({ date: g ? g.date : new Date().toLocaleDateString("en-CA"),
      game: `${c.A.abbrev} @ ${c.H.abbrev}`, market: a.market, pick: a.pick, model: +a.model.toFixed(3),
      odds: a.best ? a.best.price : "" }));
    const nums = [`Model ${pct(a.model)}`, `Fair ${fair(a.model)}`];
    if (a.marketP != null) nums.push(`Market ${pct(a.marketP)}`);
    if (a.best) nums.push(`Best ${price(a.best.price)} at ${esc(a.best.book)}`);
    if (a.ev != null) nums.push(`EV ${a.ev >= 0 ? "+" : ""}$${(a.ev * 100).toFixed(0)} per $100`);
    return `<div class="angle">
      <div class="row"><span class="mk">${esc(a.market)}</span><span class="pick">${esc(a.pick)}</span>
      <span class="num">${nums.join(" · ")}</span><button class="ghost log-btn" type="button" data-log="${logData}">+ Log bet</button></div>
      <ul>${a.why.map((r) => `<li><b>${esc(r.title)}:</b> ${esc(r.text)}</li>`).join("")}</ul>
      ${a.caution ? `<p class="caution">Big gap vs the market (${((a.model - a.marketP) * 100).toFixed(0)} pts). Books are usually right about something: check goalie and injury news before betting.</p>` : ""}
    </div>`;
  }

  // ---------- breakdown ----------
  function breakdown(c, g) {
    const { H, A, p, fH, fA } = c;
    const gpg = (t, k) => (t[k] / Math.max(t.gp, 1)).toFixed(2);
    const rows = [
      ["Points %", pct(M.ptsPct({ pts: A.pts, gp: A.gp })), pct(M.ptsPct({ pts: H.pts, gp: H.gp })), "hi"],
      [c.neutral ? "Home pts % (H) / Road (A)" : "Road (A) vs Home (H) pts %", pct(M.ptsPct(A.road)), pct(M.ptsPct(H.home)), "hi"],
      ["Goals for / game", gpg(A, "gf"), gpg(H, "gf"), "hi"],
      ["Goals against / game", gpg(A, "ga"), gpg(H, "ga"), "lo"],
      ["Goal ratio (GF÷GA)", (A.gf / Math.max(A.ga, 1)).toFixed(2), (H.gf / Math.max(H.ga, 1)).toFixed(2), "hi"],
      ["Last 10", splitRec(A.l10), splitRec(H.l10), null, A.l10.pts, H.l10.pts],
      ["Last 5", fA.last5, fH.last5, null],
      ["Streak", A.streak, H.streak, null],
      ["Power play", pct(A.ppPct, 1), pct(H.ppPct, 1), "hi"],
      ["Penalty kill", pct(A.pkPct, 1), pct(H.pkPct, 1), "hi"],
      ["Team save %", A.svPct?.toFixed(3), H.svPct?.toFixed(3), "hi"],
      ["Shots for / against", `${A.shotsFor?.toFixed(1)} / ${A.shotsAgainst?.toFixed(1)}`, `${H.shotsFor?.toFixed(1)} / ${H.shotsAgainst?.toFixed(1)}`, null],
      ["Games over 6.5", pct(fA.over65), pct(fH.over65), null],
      ["Wins by 2+", pct(fA.winBy2), pct(fH.winBy2), "hi"],
      ["Win or lose by 1 (+1.5)", pct(fA.coverPlus), pct(fH.coverPlus), "hi"],
      ["Games to OT", pct(fA.otRate), pct(fH.otRate), null],
      ["Rest", restText(c.restA), restText(c.restH), null],
    ];
    const cmp = `<table class="cmp"><thead><tr><th>${esc(A.abbrev)}</th><th></th><th>${esc(H.abbrev)}</th></tr></thead><tbody>${
      rows.map(([label, a, h, dir, an, hn]) => {
        let ca = "", ch = "";
        const na = an ?? parseFloat(a), nh = hn ?? parseFloat(h);
        if ((dir || an != null) && !isNaN(na) && !isNaN(nh) && na !== nh) {
          const aBetter = dir === "lo" ? na < nh : na > nh;
          ca = aBetter ? "better" : ""; ch = aBetter ? "" : "better";
        }
        return `<tr><td class="${ca}">${esc(a ?? "–")}</td><td>${esc(label)}</td><td class="${ch}">${esc(h ?? "–")}</td></tr>`;
      }).join("")}</tbody></table>`;

    const L = (label, prob) => `<tr><td>${label}</td><td class="n">${pct(prob)}</td><td class="n">${fair(prob)}</td></tr>`;
    const lines = `<table class="lines"><thead><tr><th>Market</th><th class="n">Model</th><th class="n">Fair odds</th></tr></thead><tbody>
      ${L(`${esc(A.abbrev)} moneyline`, p.away)}${L(`${esc(H.abbrev)} moneyline`, p.home)}
      ${L(`${esc(A.abbrev)} -1.5`, p.awayBy2)}${L(`${esc(A.abbrev)} +1.5`, 1 - p.homeBy2)}
      ${L(`${esc(H.abbrev)} -1.5`, p.homeBy2)}${L(`${esc(H.abbrev)} +1.5`, 1 - p.awayBy2)}
      ${[5.5, 6.5].map((l) => L(`Over ${l}`, p.totals[l]) + L(`Under ${l}`, 1 - p.totals[l])).join("")}
      ${L(`${esc(A.abbrev)} team total over 2.5`, p.awayTT[2.5])}${L(`${esc(H.abbrev)} team total over 2.5`, p.homeTT[2.5])}
      ${L("Overtime — yes", p.tie)}${L("Overtime — no", 1 - p.tie)}
    </tbody></table>`;

    const reasons = c.reasons.length
      ? `<ul class="reasons-all">${c.reasons.map((r) => `<li>${sideLabel(r.side, c)} <b>${esc(r.title)}:</b> ${esc(r.text)}${r.weak ? ` <span class="weak">weak signal</span>` : ""}</li>`).join("")}</ul>`
      : `<p class="small">No strong stat mismatches.</p>`;

    const h2h = c.h2h.length
      ? `<ul class="reasons-all">${c.h2h.map((x) => `<li>${esc(x.date)} · ${x.home ? esc(H.abbrev) + " home" : "@ " + esc(A.abbrev)} · ${esc(H.abbrev)} ${x.gf}–${x.ga} ${x.end !== "REG" ? esc(x.end) : ""}</li>`).join("")}</ul>`
      : `<p class="small">No meetings yet this season.</p>`;

    const m = g && g.matchup;
    const goalieList = (arr) => (arr || []).map((x) => `${esc(x.name)} <span class="small">${esc(x.record)}, ${x.sv?.toFixed(3) ?? "–"} sv%, ${x.gaa?.toFixed(2) ?? "–"} GAA</span>`).join("<br>") || "–";
    const hotList = (arr) => (arr || []).filter((x) => x.cat !== "assists").map((x) => `${esc(x.name)} <span class="small">${x.value} ${esc(x.cat)}</span>`).join("<br>") || "–";
    const people = m ? `<div><h4>Goalies (season) — confirm the starter</h4>
        <table class="cmp"><tbody><tr><td>${goalieList(m.goalies.away)}</td><td>G</td><td>${goalieList(m.goalies.home)}</td></tr>
        <tr><td>${hotList(m.hot.away)}</td><td>Hot, last 5</td><td>${hotList(m.hot.home)}</td></tr></tbody></table>
        <p class="small"><a href="https://www.dailyfaceoff.com/starting-goalies" target="_blank" rel="noopener">Check confirmed starters ↗</a></p></div>` : "";

    return `<div class="more-body">
      <div><h4>Side by side</h4>${cmp}</div>
      <div><h4>Model lines</h4>${lines}<p class="small">Fair odds = break-even price. Better than this at Bet365 means value.</p></div>
      <div><h4>Check a Bet365 price</h4>${checker(c)}<h4 style="margin-top:16px">Every mismatch found</h4>${reasons}</div>
      <div><h4>Season series</h4>${h2h}</div>
      ${people}
    </div>`;
  }

  const restText = (r) => (r.days == null ? "–" : r.b2b ? "Back-to-back" : `${r.days - 1} day(s) off`);
  const sideLabel = (side, c) => side === "home" ? `<span class="side-home">${esc(c.H.abbrev)}</span>` : side === "away" ? `<span class="side-away">${esc(c.A.abbrev)}</span>` : `<span class="small">${side === "over" ? "OVER" : "UNDER"}</span>`;

  // ---------- price checker ----------
  function checkerMarkets(c) {
    const { H, A, p } = c;
    const out = [
      [`${A.abbrev} moneyline`, p.away], [`${H.abbrev} moneyline`, p.home],
      [`${A.abbrev} -1.5`, p.awayBy2], [`${A.abbrev} +1.5`, 1 - p.homeBy2],
      [`${H.abbrev} -1.5`, p.homeBy2], [`${H.abbrev} +1.5`, 1 - p.awayBy2],
    ];
    for (const l of [4.5, 5.5, 6.5, 7.5]) out.push([`Over ${l}`, p.totals[l]], [`Under ${l}`, 1 - p.totals[l]]);
    for (const [t, tt] of [[A, p.awayTT], [H, p.homeTT]])
      for (const l of [1.5, 2.5, 3.5]) out.push([`${t.abbrev} over ${l} goals`, tt[l]], [`${t.abbrev} under ${l} goals`, 1 - tt[l]]);
    out.push(["Overtime — yes", p.tie], ["Overtime — no", 1 - p.tie]);
    return out;
  }

  function checker(c) {
    const opts = checkerMarkets(c).map(([l, pr]) => `<option value="${pr}">${esc(l)}</option>`).join("");
    return `<div class="checker">
      <div class="inputs"><select aria-label="Market">${opts}</select>
      <input type="text" inputmode="decimal" placeholder="${fmt === "decimal" ? "e.g. 2.10" : "e.g. +110"}" aria-label="Bet365 price"></div>
      <div class="verdict small">Type the price Bet365 shows (American or decimal both work).</div>
    </div>`;
  }

  function wireCheckers(root) {
    root.querySelectorAll(".checker").forEach((el) => {
      const sel = $("select", el), inp = $("input", el), out = $(".verdict", el);
      const run = () => {
        const prob = parseFloat(sel.value);
        const dec = M.toDecimal(inp.value);
        if (!dec) { out.className = "verdict small"; out.textContent = "Type the price Bet365 shows (American or decimal both work)."; return; }
        const imp = 1 / dec, ev = prob * dec - 1, edge = prob - imp;
        const [cls, word] = ev >= 0.04 ? ["good", "VALUE"] : ev >= -0.02 ? ["meh", "FAIR"] : ["bad", "PASS"];
        out.className = "verdict";
        out.innerHTML = `<span class="badge ${cls}">${word}</span> Model ${pct(prob, 1)} vs price implies ${pct(imp, 1)} (${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)} pts). Expected return ${ev >= 0 ? "+" : "−"}$${Math.abs(ev * 100).toFixed(2)} per $100.`;
      };
      sel.addEventListener("change", run);
      inp.addEventListener("input", run);
    });
  }

  // ---------- head-to-head ----------
  function setupMatchup() {
    const ts = Object.values(DATA.teams).sort((a, b) => a.name.localeCompare(b.name));
    const opts = ts.map((t) => `<option value="${esc(t.abbrev)}">${esc(t.name)}</option>`).join("");
    $("#mAway").innerHTML = opts; $("#mHome").innerHTML = opts;
    const first = DATA.games.find((g) => g.date === activeDate) || DATA.games[0];
    $("#mAway").value = store.get("mAway", first ? first.away : ts[0].abbrev);
    $("#mHome").value = store.get("mHome", first ? first.home : ts[1].abbrev);
    ["#mAway", "#mHome", "#mNeutral"].forEach((s) => $(s).addEventListener("change", renderMatchup));
    $("#mSwap").addEventListener("click", () => { const a = $("#mAway").value; $("#mAway").value = $("#mHome").value; $("#mHome").value = a; renderMatchup(); });
    renderMatchup();
  }

  function renderMatchup() {
    if (!DATA) return;
    const away = $("#mAway").value, home = $("#mHome").value;
    store.set("mAway", away); store.set("mHome", home);
    if (away === home) { $("#matchup").innerHTML = `<div class="empty">Pick two different teams.</div>`; return; }
    // If this pairing is on the schedule, use the real game (odds, goalies, date).
    const g = DATA.games.find((x) => x.home === home && x.away === away && x.state !== "OFF" && x.state !== "FINAL");
    const today = new Date().toLocaleDateString("en-CA");
    const c = M.analyze(DATA, home, away, { date: g ? g.date : today, neutral: $("#mNeutral").checked || (g && g.neutral), game: g, noRest: !g });
    $("#matchup").innerHTML = (g ? "" : `<p class="hint">Not on the schedule in the next few days, so there's no market price. Use the fair odds and price checker against Bet365.</p>`) + card(c, g);
    const det = $("#matchup details"); if (det) det.open = true;
    wireCheckers($("#matchup"));
  }

  // ---------- teams table ----------
  function renderTeams() {
    const T = Object.values(DATA.teams).map((t) => {
      const f = M.teamForm(t);
      return {
        t, abbrev: t.abbrev, gp: t.gp, ptsPct: t.ptsPct,
        home: M.ptsPct(t.home), road: M.ptsPct(t.road),
        roadEdge: (M.ptsPct(t.road) ?? 0) - (M.ptsPct(t.home) ?? 0),
        gfpg: t.gf / t.gp, gapg: t.ga / t.gp, ratio: t.gf / Math.max(t.ga, 1),
        l10: t.l10.pts, pp: t.ppPct, pk: t.pkPct, sv: t.svPct,
        over65: f.over65, winBy2: f.winBy2, ot: f.otRate,
      };
    });
    const cols = [
      ["abbrev", "Team", null], ["gp", "GP", null], ["ptsPct", "Pts %", "hi", pct],
      ["home", "Home pts %", "hi", pct], ["road", "Road pts %", "hi", pct],
      ["roadEdge", "Road − Home", "hi", (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(0)],
      ["gfpg", "GF/G", "hi", (v) => v.toFixed(2)], ["gapg", "GA/G", "lo", (v) => v.toFixed(2)],
      ["ratio", "Goal ratio", "hi", (v) => v.toFixed(2)], ["l10", "L10 pts", "hi", String],
      ["pp", "PP %", "hi", (v) => pct(v, 1)], ["pk", "PK %", "hi", (v) => pct(v, 1)],
      ["sv", "Sv %", "hi", (v) => v?.toFixed(3) ?? "–"], ["over65", "Over 6.5", null, pct],
      ["winBy2", "Win by 2+", "hi", pct], ["ot", "To OT", null, pct],
    ];
    let sortKey = store.get("teamSort", "ratio"), dirDesc = true;
    const rank = {};
    for (const [k, , dir] of cols) {
      if (!dir) continue;
      const sorted = [...T].sort((a, b) => (dir === "hi" ? b[k] - a[k] : a[k] - b[k]));
      rank[k] = new Map(sorted.map((r, i) => [r.abbrev, i]));
    }
    const draw = () => {
      const rows = [...T].sort((a, b) => {
        const x = a[sortKey], y = b[sortKey];
        if (typeof x === "string") return dirDesc ? y.localeCompare(x) : x.localeCompare(y);
        return dirDesc ? (y ?? -1) - (x ?? -1) : (x ?? -1) - (y ?? -1);
      });
      $("#teamTable").innerHTML = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}">${l}${k === sortKey ? (dirDesc ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${cols.map(([k, , dir, f]) => {
          if (k === "abbrev") return `<td><img src="${logo(r.t)}" alt="">${esc(r.abbrev)}</td>`;
          const rk = rank[k] && rank[k].get(r.abbrev);
          const cls = rk == null ? "" : rk < 8 ? "rk-top" : rk >= T.length - 8 ? "rk-bot" : "";
          return `<td class="${cls}">${f ? f(r[k]) : r[k]}</td>`;
        }).join("")}</tr>`).join("")}</tbody>`;
    };
    $("#teamTable").addEventListener("click", (e) => {
      const th = e.target.closest("th"); if (!th) return;
      const k = th.dataset.k;
      if (k === sortKey) dirDesc = !dirDesc; else { sortKey = k; dirDesc = k !== "abbrev" && k !== "gapg"; }
      store.set("teamSort", sortKey);
      draw();
    });
    draw();
  }

  // ---------- bet log (stored on this device only) ----------
  const BetLog = {
    key: "betlog",
    all() { try { return JSON.parse(store.get(this.key, "[]")) || []; } catch { return []; } },
    save(list) { store.set(this.key, JSON.stringify(list)); this.render(); },
    add(b) {
      const list = this.all();
      list.unshift({ id: Date.now() + Math.random(), stake: 10, result: "", ...b });
      this.save(list);
    },
    init() {
      document.addEventListener("click", (e) => {
        const btn = e.target.closest(".log-btn");
        if (!btn) return;
        this.add(JSON.parse(btn.dataset.log));
        btn.textContent = "✓ Logged"; btn.disabled = true;
      });
      $("#logAdd").addEventListener("submit", (e) => {
        e.preventDefault();
        const f = e.target;
        if (!f.pick.value.trim()) return;
        this.add({ date: new Date().toLocaleDateString("en-CA"), game: f.game.value.trim(), market: f.market.value,
                   pick: f.pick.value.trim(), odds: f.odds.value.trim(), stake: parseFloat(f.stake.value) || 10 });
        f.reset();
      });
      $("#logTable").addEventListener("change", (e) => {
        const tr = e.target.closest("tr[data-id]"); if (!tr) return;
        const list = this.all(); const b = list.find((x) => String(x.id) === tr.dataset.id); if (!b) return;
        b[e.target.name] = e.target.name === "stake" ? parseFloat(e.target.value) || 0 : e.target.value;
        this.save(list);
      });
      $("#logTable").addEventListener("click", (e) => {
        const del = e.target.closest(".del"); if (!del) return;
        const id = del.closest("tr").dataset.id;
        if (confirm("Delete this bet?")) this.save(this.all().filter((x) => String(x.id) !== id));
      });
      $("#logExport").addEventListener("click", () => {
        const rows = [["date", "game", "market", "pick", "odds", "stake", "result", "profit"],
          ...this.all().map((b) => [b.date, b.game, b.market, b.pick, b.odds, b.stake, b.result, this.profit(b).toFixed(2)])];
        const csv = rows.map((r) => r.map((x) => `"${String(x ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        a.download = "jofa-bet-log.csv"; a.click();
      });
      this.render();
    },
    profit(b) {
      const d = M.toDecimal(b.odds);
      if (b.result === "W") return d ? b.stake * (d - 1) : 0;
      if (b.result === "L") return -b.stake;
      return 0;
    },
    render() {
      const list = this.all();
      const done = list.filter((b) => b.result === "W" || b.result === "L" || b.result === "P");
      const w = done.filter((b) => b.result === "W").length, l = done.filter((b) => b.result === "L").length, pu = done.filter((b) => b.result === "P").length;
      const staked = done.reduce((s, b) => s + (b.result === "P" ? 0 : b.stake), 0);
      const profit = done.reduce((s, b) => s + this.profit(b), 0);
      const byMarket = {};
      for (const b of done) { const m = (byMarket[b.market] ||= { w: 0, l: 0, p: 0 }); m[b.result === "W" ? "w" : b.result === "L" ? "l" : "p"]++; }
      const money = (x) => (x < 0 ? "−$" : "$") + Math.abs(x).toFixed(2);
      $("#logSummary").innerHTML = `
        <div class="kpi"><div class="l">Record</div><div class="v">${w}-${l}${pu ? "-" + pu : ""}</div></div>
        <div class="kpi"><div class="l">Win rate</div><div class="v">${w + l ? pct(w / (w + l)) : "–"}</div></div>
        <div class="kpi"><div class="l">Profit</div><div class="v ${profit >= 0 ? "pos" : "neg"}">${money(profit)}</div></div>
        <div class="kpi"><div class="l">Return on stake</div><div class="v">${staked ? pct(profit / staked, 1) : "–"}</div></div>
        <div class="kpi"><div class="l">Pending</div><div class="v">${list.length - done.length}</div></div>
        ${Object.entries(byMarket).map(([m, r]) => `<div class="kpi"><div class="l">${esc(m)}</div><div class="v">${r.w}-${r.l}${r.p ? "-" + r.p : ""}</div></div>`).join("")}`;
      const opt = (v, cur) => `<option value="${v}" ${v === cur ? "selected" : ""}>${v || "Pending"}</option>`;
      $("#logTable").innerHTML = list.length ? `<thead><tr><th>Date</th><th>Game</th><th>Bet</th><th>Odds</th><th>Stake</th><th>Result</th><th>Profit</th><th></th></tr></thead><tbody>${
        list.map((b) => `<tr data-id="${b.id}"><td>${esc(b.date)}</td><td>${esc(b.game)}</td>
          <td><span class="small">${esc(b.market)}</span><br><b>${esc(b.pick)}</b></td>
          <td><input name="odds" value="${esc(b.odds)}" size="6" aria-label="Odds"></td>
          <td><input name="stake" value="${esc(b.stake)}" size="5" inputmode="decimal" aria-label="Stake"></td>
          <td><select name="result" aria-label="Result">${["", "W", "L", "P"].map((v) => opt(v, b.result)).join("")}</select></td>
          <td class="${this.profit(b) > 0 ? "pos" : this.profit(b) < 0 ? "neg" : ""}">${b.result ? money(this.profit(b)) : ""}</td>
          <td><button class="ghost del" type="button" aria-label="Delete">✕</button></td></tr>`).join("")}</tbody>`
        : `<tbody><tr><td class="small" style="padding:16px">No bets logged yet. Tap "+ Log bet" on any angle, or add one above.</td></tr></tbody>`;
    },
  };

  load();
})();
