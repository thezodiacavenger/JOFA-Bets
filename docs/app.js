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
  const goalieOverride = {}; // card key -> { home: goalieId, away: goalieId }
  const cardKey = (g, home, away) => (g ? String(g.id) : `m-${away}-${home}`);
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
    Parlay.init();
  }

  // ---------- tabs ----------
  function setupTabs() {
    const buttons = document.querySelectorAll(".tabs button");
    const show = (name) => {
      buttons.forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
      document.querySelectorAll(".tab").forEach((s) => (s.hidden = s.id !== "tab-" + name));
      store.set("tab", name);
      if (name === "parlay" && DATA) Parlay.render();
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
      const c = M.analyze(DATA, g.home, g.away, { date: g.date, neutral: g.neutral, game: g, goalies: goalieOverride[cardKey(g)] });
      if (onlyAngles && !c.angles.length) continue;
      html.push(card(c, g));
    }
    $("#slate").innerHTML = html.join("") || `<div class="empty">No games match.</div>`;
    wireCheckers($("#slate"));
  }

  // Goalie picker: re-run the model for just that game, keeping the breakdown open
  document.addEventListener("change", (e) => {
    const sel = e.target.closest(".goalie-pick");
    if (!sel) return;
    const art = sel.closest("article.card");
    const key = art.dataset.key;
    (goalieOverride[key] ||= {})[sel.dataset.side] = sel.value;
    const g = DATA.games.find((x) => String(x.id) === key);
    const home = art.dataset.home, away = art.dataset.away;
    const opts = g ? { date: g.date, neutral: g.neutral, game: g }
      : { date: new Date().toLocaleDateString("en-CA"), neutral: $("#mNeutral").checked, noRest: true };
    const c = M.analyze(DATA, home, away, { ...opts, goalies: goalieOverride[key] });
    const wasOpen = art.querySelector("details.more")?.open;
    const tmp = document.createElement("div");
    tmp.innerHTML = card(c, g);
    const fresh = tmp.firstElementChild;
    if (wasOpen) fresh.querySelector("details.more").open = true;
    art.replaceWith(fresh);
    wireCheckers(fresh);
  });

  // How sure the starter projection is, from the 5-season backtest (model.js)
  function certaintyTag(ch) {
    const word = ch.conf >= 0.7 ? "Likely" : ch.conf >= 0.55 ? "Lean" : "Toss-up";
    const cls = ch.conf >= 0.7 ? "" : ch.conf >= 0.55 ? "b2b" : "live";
    const b2b = ch.why.startsWith("backup") ? " · B2B backup" : "";
    return `<span class="tag ${cls}" title="Projections like this were right ${pct(ch.conf)} of the time">${word} ${pct(ch.conf)}${b2b}</span>`;
  }

  // For each team whose starter is a lean or toss-up (and not picked by you), re-run the
  // game with the other goalie so you can see how much it matters.
  function goalieAlts(c) {
    const out = [];
    for (const side of ["away", "home"]) {
      const ch = side === "home" ? c.gH : c.gA;
      if (!ch || ch.why === "selected" || ch.conf >= 0.7 || !ch.alt) continue;
      const goalies = { ...(c.opts.goalies || {}), [side]: ch.alt.id };
      const c2 = M.analyze(DATA, c.H.abbrev, c.A.abbrev, { ...c.opts, goalies });
      out.push({ side, team: side === "home" ? c.H : c.A, alt: ch.alt, c2 });
    }
    return out;
  }

  function goalieRow(c) {
    const pickFor = (t, chosen, side) => {
      const G = (t.goalies || []).filter((g) => g.gs > 0 || (chosen && chosen.goalie.id === g.id));
      if (!G.length) return `<span class="small">–</span>`;
      const tag = chosen && chosen.why !== "selected" ? certaintyTag(chosen) : `<span class="tag">Your pick</span>`;
      return `<label class="gp"><b>${esc(t.abbrev)}</b><select class="goalie-pick" data-side="${side}" aria-label="${esc(t.abbrev)} starting goalie">${
        G.map((g) => `<option value="${g.id}" ${chosen && chosen.goalie.id === g.id ? "selected" : ""}>${esc(g.name)} · ${g.sv.toFixed(3)} · ${g.gs} GS</option>`).join("")}</select> ${tag}</label>`;
    };
    const alts = c._alts || [];
    const altLine = alts.map((x) => `<div class="galt">If <b>${esc(x.alt.name)}</b> starts for ${esc(x.team.abbrev)} instead: ${esc(c.A.abbrev)} ${pct(x.c2.p.away)} · ${esc(c.H.abbrev)} ${pct(x.c2.p.home)}
      <span class="small">(${(x.c2.p.home - c.p.home) >= 0 ? "+" : "−"}${Math.abs((x.c2.p.home - c.p.home) * 100).toFixed(1)} pts ${esc(c.H.abbrev)})</span></div>`).join("");
    return `<div class="goalies-row"><span class="l">Starting goalies</span>${pickFor(c.A, c.gA, "away")}${pickFor(c.H, c.gH, "home")}
      <a class="small" href="https://www.dailyfaceoff.com/starting-goalies" target="_blank" rel="noopener">Confirm ↗</a></div>${altLine}`;
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

    const key = cardKey(g, H.abbrev, A.abbrev);
    if (!g || g.state === "FUT" || g.state === "PRE") {
      c._alts = goalieAlts(c);
      for (const a of c.angles) {
        const gone = c._alts.find((x) => !x.c2.angles.some((b) => b.pick === a.pick));
        if (gone) a.fragile = `${gone.alt.name} (${gone.team.abbrev})`;
      }
    }
    return `<article class="card" data-key="${esc(key)}" data-home="${esc(H.abbrev)}" data-away="${esc(A.abbrev)}">
      <div class="card-head">${teamBlock(A, "away", c.restA)}<div class="mid">${mid}</div>${teamBlock(H, "home", c.restH)}</div>
      <div class="bar" title="Model win chance"><div class="a" style="width:${(p.away * 100).toFixed(1)}%"></div><div class="h" style="width:${(p.home * 100).toFixed(1)}%"></div></div>
      <div class="bar-labels"><span><b>${pct(p.away)}</b> ${esc(A.abbrev)}</span><span class="small">model win %</span><span>${esc(H.abbrev)} <b>${pct(p.home)}</b></span></div>
      ${!g || g.state === "FUT" || g.state === "PRE" ? goalieRow(c) : ""}
      <div class="kpis">${kpis.map(([l, v]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join("")}</div>
      ${anglesHtml}
      <details class="more"><summary>Full breakdown & price checker</summary>${breakdown(c, g)}</details>
    </article>`;
  }

  function angleHtml(a, c, g) {
    const logData = esc(JSON.stringify({ date: g ? g.date : new Date().toLocaleDateString("en-CA"),
      game: `${c.A.abbrev} @ ${c.H.abbrev}`, market: a.market, pick: a.pick, model: +a.model.toFixed(3),
      odds: a.best ? a.best.price : "", gameId: g ? g.id : null,
      side: a.market === "Moneyline" ? a.side : null }));
    const nums = [`Model ${pct(a.model)}`, `Fair ${fair(a.model)}`];
    if (a.marketP != null) nums.push(`Market ${pct(a.marketP)}`);
    if (a.best) nums.push(`Best ${price(a.best.price)} at ${esc(a.best.book)}`);
    if (a.ev != null) nums.push(`EV ${a.ev >= 0 ? "+" : ""}$${(a.ev * 100).toFixed(0)} per $100`);
    return `<div class="angle">
      <div class="row"><span class="mk">${esc(a.market)}</span><span class="pick">${esc(a.pick)}</span>
      <span class="num">${nums.join(" · ")}</span><button class="ghost log-btn" type="button" data-log="${logData}">+ Log bet</button></div>
      <ul>${a.why.map((r) => `<li><b>${esc(r.title)}:</b> ${esc(r.text)}</li>`).join("")}</ul>
      ${a.fragile ? `<p class="caution">Depends on the goalie: this edge disappears if ${esc(a.fragile)} starts. Confirm starters first.</p>` : ""}
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
    const c = M.analyze(DATA, home, away, { date: g ? g.date : today, neutral: $("#mNeutral").checked || (g && g.neutral), game: g, noRest: !g, goalies: goalieOverride[cardKey(g, home, away)] });
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
        xgd: t.xg && t.xg.gp ? (t.xg.xgf - t.xg.xga) / t.xg.gp : null, pdo: t.pdo5 ?? null,
      };
    });
    const cols = [
      ["abbrev", "Team", null], ["gp", "GP", null], ["ptsPct", "Pts %", "hi", pct],
      ["home", "Home pts %", "hi", pct], ["road", "Road pts %", "hi", pct],
      ["roadEdge", "Road − Home", "hi", (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(0)],
      ["gfpg", "GF/G", "hi", (v) => v.toFixed(2)], ["gapg", "GA/G", "lo", (v) => v.toFixed(2)],
      ["ratio", "Goal ratio", "hi", (v) => v.toFixed(2)],
      ["xgd", "xG diff/G", "hi", (v) => (v == null ? "–" : (v >= 0 ? "+" : "") + v.toFixed(2))],
      ["pdo", "PDO", null, (v) => (v == null ? "–" : v.toFixed(3))], ["l10", "L10 pts", "hi", String],
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

  // ---------- parlays ----------
  // A parlay pays the leg prices multiplied together and wins only if every leg wins,
  // so each leg's edge (good or bad) compounds. Legs from different games are treated
  // as independent; legs from the same game are not, and are flagged.
  const Parlay = {
    ticket: [],
    boost: 0,
    legsFor(date) {
      const out = [];
      for (const g of DATA.games.filter((x) => x.date === date && (x.state === "FUT" || x.state === "PRE"))) {
        if (!DATA.teams[g.home] || !DATA.teams[g.away]) continue;
        const c = M.analyze(DATA, g.home, g.away, { date: g.date, neutral: g.neutral, game: g, goalies: goalieOverride[cardKey(g)] });
        const { H, A, p, mkt } = c;
        const game = `${A.abbrev} @ ${H.abbrev}`;
        const typical = (side) => {
          if (!mkt) return null;
          const decs = mkt.books.map((b) => (side === "home" ? b.decHome : b.decAway));
          return decs.reduce((a, b) => a + b, 0) / decs.length;
        };
        const gl = (ch) => (ch ? ch.goalie.name.split(" ").slice(-1)[0] + (ch.why !== "selected" && ch.conf < 0.7 ? "?" : "") : "?");
        const goalies = `${gl(c.gA)} vs ${gl(c.gH)}`;
        const alts = goalieAlts(c);
        const add = (key, label, market, prob, dec) => {
          // fragile = a moneyline whose value turns negative if an uncertain starter is swapped
          let fragile = null;
          if (dec && prob * dec > 1) {
            for (const x of alts) {
              const p2 = key === "ml-h" ? x.c2.p.home : key === "ml-a" ? x.c2.p.away : null;
              if (p2 != null && p2 * dec <= 1) fragile = `${x.alt.name} (${x.team.abbrev})`;
            }
          }
          out.push({ key: `${g.id}|${key}`, gameId: g.id, game, label, market, p: prob, dec, goalies, fragile });
        };
        add("ml-a", `${A.abbrev} ML`, "Moneyline", p.away, typical("away"));
        add("ml-h", `${H.abbrev} ML`, "Moneyline", p.home, typical("home"));
        add("pl-a+", `${A.abbrev} +1.5`, "Puck line", 1 - p.homeBy2, null);
        add("pl-h+", `${H.abbrev} +1.5`, "Puck line", 1 - p.awayBy2, null);
        add("pl-a-", `${A.abbrev} -1.5`, "Puck line", p.awayBy2, null);
        add("pl-h-", `${H.abbrev} -1.5`, "Puck line", p.homeBy2, null);
        for (const l of [5.5, 6.5]) {
          add(`o${l}`, `Over ${l} (${game})`, "Total", p.totals[l], null);
          add(`u${l}`, `Under ${l} (${game})`, "Total", 1 - p.totals[l], null);
        }
      }
      return out;
    },
    combine(legs, boost = 0) {
      const P = legs.reduce((a, l) => a * l.p, 1);
      const decs = legs.map((l) => l.dec);
      if (decs.some((d) => !d)) return { P, dec: null, ev: null };
      const raw = decs.reduce((a, d) => a * d, 1);
      const dec = 1 + (raw - 1) * (1 + boost);
      return { P, dec, ev: P * dec - 1 };
    },
    autoPicks(legs) {
      const ml = legs.filter((l) => l.market === "Moneyline" && l.dec);
      const byGame = (arr) => { const seen = new Set(); return arr.filter((l) => !seen.has(l.gameId) && seen.add(l.gameId)); };
      const withEv = ml.map((l) => ({ ...l, ev: l.p * l.dec - 1 }));
      const value = byGame(withEv.filter((l) => l.ev > 0 && l.p >= 0.4 && !l.fragile).sort((a, b) => b.ev - a.ev)).slice(0, 4);
      this.skipped = withEv.filter((l) => l.ev > 0 && l.p >= 0.4 && l.fragile);
      const likely = byGame([...withEv].sort((a, b) => b.p - a.p)).slice(0, 3);
      return { value, likely, ml: withEv };
    },
    american(dec) { return price(String(dec.toFixed(4))); },
    ticketCard(title, sub, legs, note) {
      if (!legs.length) return "";
      const r = this.combine(legs);
      const verdict = r.ev == null ? "" : r.ev > 0.03 ? `<span class="badge good">VALUE</span>` : r.ev > -0.05 ? `<span class="badge meh">ROUGHLY FAIR</span>` : `<span class="badge bad">BOOK'S EDGE</span>`;
      return `<div class="pcard">
        <div class="phead"><div><h3>${title}</h3><p class="small">${sub}</p></div>
          <button class="ghost padd" type="button" data-keys="${esc(legs.map((l) => l.key).join(","))}">Copy to builder</button></div>
        <table class="lines"><thead><tr><th>Leg</th><th class="n">Model</th><th class="n">Price</th><th class="n">Leg value</th></tr></thead><tbody>
        ${legs.map((l) => `<tr><td><b>${esc(l.label)}</b> <span class="small">${esc(l.game)} · ${esc(l.goalies)}</span></td><td class="n">${pct(l.p)}</td>
          <td class="n">${l.dec ? this.american(l.dec) : "–"}</td><td class="n ${l.ev > 0 ? "pos" : "neg"}">${l.ev >= 0 ? "+" : "−"}$${Math.abs(l.ev * 100).toFixed(1)}</td></tr>`).join("")}
        </tbody></table>
        <div class="psum">
          <div><span class="l">Hits</span><b>${pct(r.P, 1)}</b><span class="small">about 1 in ${(1 / r.P).toFixed(1)}</span></div>
          <div><span class="l">Pays</span><b>${r.dec ? this.american(r.dec) : "–"}</b><span class="small">${r.dec ? `$10 returns $${(10 * r.dec).toFixed(2)}` : ""}</span></div>
          <div><span class="l">Value per $100</span><b class="${r.ev > 0 ? "pos" : "neg"}">${r.ev == null ? "–" : (r.ev >= 0 ? "+" : "−") + "$" + Math.abs(r.ev * 100).toFixed(2)}</b>${verdict}</div>
        </div>
        ${note ? `<p class="small">${note}</p>` : ""}
      </div>`;
    },
    render() {
      const date = activeDate;
      const legs = this.legsFor(date);
      this.legs = legs;
      const { value, likely, ml } = this.autoPicks(legs);
      $("#parlayDate").textContent = date ? localDay(date) : "";
      let auto = "";
      if (!ml.length) {
        auto = `<div class="empty">No upcoming games with prices for this date. Pick another date on the Slate tab.</div>`;
      } else {
        auto += value.length >= 2
          ? this.ticketCard("Tonight's optimistic parlay", "Every leg is one the model rates as better than its price. The highest-value legs, one per game.", value,
              "Prices are the average across the books in the NHL feed; check your book's prices in the builder. Each leg's edge is the model's opinion against the market. If the model is a couple of points too confident on every leg, a 4-leg parlay magnifies that, so the value shown is optimistic by design. Stake it like a long shot.")
          : `<div class="pcard"><h3>Tonight's optimistic parlay</h3><p>Only ${value.length} moneyline${value.length === 1 ? "" : "s"} tonight rate${value.length === 1 ? "s" : ""} as better than the price, which isn't enough for a value parlay. ${value.length ? `The one to look at as a single: <b>${esc(value[0].label)}</b> (${pct(value[0].p)}, ${this.american(value[0].dec)}).` : "Sitting out is the value play."} Puck lines and totals can add legs: price them in the builder below.</p></div>`;
        auto += this.ticketCard("Most likely to hit", "The three biggest model favourites, one per game. Wins most often, but check the value line.", likely,
          "Favourites are usually priced to the book's advantage, and stacking them stacks that edge.");
      }
      if (this.skipped && this.skipped.length)
        auto += `<div class="pcard"><h3>Left out: depends on the goalie</h3><p class="small">These rate as value only if the projected starter plays. Confirm starters, set them on the Slate, and they'll be reconsidered.</p><ul class="reasons-all">${
          this.skipped.map((l) => `<li><b>${esc(l.label)}</b> ${esc(l.game)}: no value if ${esc(l.fragile)} starts</li>`).join("")}</ul></div>`;
      $("#parlayAuto").innerHTML = auto;
      // builder list
      const games = [...new Set(legs.map((l) => l.game))];
      $("#parlayLegs").innerHTML = games.map((gm) => `<div class="pgame"><div class="pgame-h">${esc(gm)} <span class="small">${esc(legs.find((l) => l.game === gm).goalies)}</span></div>
        <div class="pchips">${legs.filter((l) => l.game === gm).map((l) => `<button type="button" class="chip pleg" data-key="${esc(l.key)}" aria-pressed="${this.ticket.some((t) => t.key === l.key)}">${esc(l.label.replace(` (${gm})`, ""))} <span class="small">${pct(l.p)} · fair ${fair(l.p)}</span></button>`).join("")}</div></div>`).join("")
        || `<p class="small">No upcoming games for this date.</p>`;
      this.renderTicket();
    },
    renderTicket() {
      const T = this.ticket;
      if (!T.length) { $("#parlayTicket").innerHTML = `<p class="small">Tap legs below to build a ticket. Then type the prices your book shows.</p>`; return; }
      const legs = T.map((t) => ({ ...t, dec: M.toDecimal(t.price) }));
      const games = legs.map((l) => l.gameId);
      const sameGame = games.length !== new Set(games).size;
      const r = this.combine(legs, this.boost / 100);
      const legVal = (l) => (l.dec ? l.p * l.dec - 1 : null);
      $("#parlayTicket").innerHTML = `<table class="lines"><thead><tr><th>Leg</th><th class="n">Model</th><th class="n">Fair</th><th class="n">Book price</th><th class="n">Leg value</th><th></th></tr></thead><tbody>
        ${legs.map((l, i) => { const v = legVal(l); return `<tr><td><b>${esc(l.label)}</b> <span class="small">${esc(l.game)}</span></td><td class="n">${pct(l.p)}</td><td class="n">${fair(l.p)}</td>
          <td class="n"><input class="pprice" data-i="${i}" value="${esc(l.price)}" size="6" placeholder="${fmt === "decimal" ? "2.10" : "+110"}" aria-label="Book price"></td>
          <td class="n ${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${v == null ? "–" : (v >= 0 ? "+" : "−") + "$" + Math.abs(v * 100).toFixed(1)}</td>
          <td><button class="ghost pdel" data-i="${i}" type="button" aria-label="Remove">✕</button></td></tr>`; }).join("")}</tbody></table>
        <div class="toolbar" style="margin-top:10px"><label class="check">Parlay boost % <input id="pboost" value="${this.boost || ""}" size="4" inputmode="decimal" placeholder="0"></label>
          <button class="ghost" id="plog" type="button" ${r.dec ? "" : "disabled"}>+ Log parlay</button><button class="ghost" id="pclear" type="button">Clear</button></div>
        ${sameGame ? `<p class="caution">Two legs from the same game: those results are linked (e.g. a favourite -1.5 and the over), so the hit chance shown here isn't reliable. Books price same-game parlays differently.</p>` : ""}
        <div class="psum">
          <div><span class="l">Hits</span><b>${pct(r.P, 1)}</b><span class="small">about 1 in ${(1 / r.P).toFixed(1)}</span></div>
          <div><span class="l">Pays</span><b>${r.dec ? this.american(r.dec) : "–"}</b><span class="small">${r.dec ? `$10 returns $${(10 * r.dec).toFixed(2)}` : "enter every price"}</span></div>
          <div><span class="l">Value per $100</span><b class="${r.ev > 0 ? "pos" : r.ev < 0 ? "neg" : ""}">${r.ev == null ? "–" : (r.ev >= 0 ? "+" : "−") + "$" + Math.abs(r.ev * 100).toFixed(2)}</b>
            ${r.ev == null ? "" : r.ev > 0.03 ? `<span class="badge good">VALUE</span>` : r.ev > -0.05 ? `<span class="badge meh">ROUGHLY FAIR</span>` : `<span class="badge bad">BOOK'S EDGE</span>`}</div>
        </div>
        ${legs.some((l) => legVal(l) != null && legVal(l) < 0) && r.ev != null ? `<p class="small">Legs in red cost you value. Dropping them usually improves the ticket more than adding another leg.</p>` : ""}`;
    },
    toggle(key) {
      const i = this.ticket.findIndex((t) => t.key === key);
      if (i >= 0) this.ticket.splice(i, 1);
      else {
        const l = this.legs.find((x) => x.key === key);
        if (l) this.ticket.push({ ...l, price: l.dec ? this.american(l.dec) : "" });
      }
      this.render();
    },
    init() {
      $("#tab-parlay").addEventListener("click", (e) => {
        const leg = e.target.closest(".pleg"); if (leg) return this.toggle(leg.dataset.key);
        const cp = e.target.closest(".padd");
        if (cp) {
          this.ticket = [];
          for (const k of cp.dataset.keys.split(",")) { const l = this.legs.find((x) => x.key === k); if (l) this.ticket.push({ ...l, price: l.dec ? this.american(l.dec) : "" }); }
          this.render();
          $("#parlayTicket").scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        const del = e.target.closest(".pdel"); if (del) { this.ticket.splice(+del.dataset.i, 1); return this.render(); }
        if (e.target.id === "pclear") { this.ticket = []; return this.render(); }
        if (e.target.id === "plog") {
          const legs = this.ticket.map((t) => ({ ...t, dec: M.toDecimal(t.price) }));
          const r = this.combine(legs, this.boost / 100);
          BetLog.add({ date: activeDate, game: legs.map((l) => l.game).join(" / "), market: `Parlay (${legs.length})`,
                       pick: legs.map((l) => l.label).join(" + "), odds: r.dec.toFixed(2), model: +r.P.toFixed(3) });
          e.target.textContent = "✓ Logged"; e.target.disabled = true;
        }
      });
      $("#tab-parlay").addEventListener("input", (e) => {
        if (e.target.classList.contains("pprice")) { this.ticket[+e.target.dataset.i].price = e.target.value; }
        else if (e.target.id === "pboost") { this.boost = parseFloat(e.target.value) || 0; }
        else return;
        const el = e.target, pos = el.selectionStart, id = el.id, idx = el.dataset.i;
        this.renderTicket();
        const again = id ? $("#" + id) : $(`.pprice[data-i="${idx}"]`);
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch { /* ok */ } }
      });
    },
  };

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
    // Closing line value: how the price you took compares with the final pre-game price.
    // Moneylines logged from the slate use the no-vig consensus close from several books;
    // anything else uses the "Close" price you type in.
    clv(b) {
      const taken = M.toDecimal(b.odds);
      if (!taken) return null;
      const snap = b.gameId && DATA && DATA.closing && DATA.closing[String(b.gameId)];
      if (snap && b.side && !b.close) {
        const m = M.market(snap);
        if (m) return { value: (b.side === "home" ? m.pHome : m.pAway) * taken - 1, auto: true,
                        closeProb: b.side === "home" ? m.pHome : m.pAway };
      }
      const close = M.toDecimal(b.close);
      return close ? { value: taken / close - 1, auto: false } : null;
    },
    render() {
      const list = this.all();
      const clvs = list.map((b) => this.clv(b)).filter(Boolean);
      const avgClv = clvs.length ? clvs.reduce((s, c) => s + c.value, 0) / clvs.length : null;
      const beat = clvs.filter((c) => c.value > 0).length;
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
        <div class="kpi"><div class="l">Beat the close</div><div class="v">${clvs.length ? `${beat} of ${clvs.length}` : "–"}</div></div>
        <div class="kpi"><div class="l">Avg closing value</div><div class="v ${avgClv > 0 ? "pos" : avgClv < 0 ? "neg" : ""}">${avgClv == null ? "–" : (avgClv >= 0 ? "+" : "") + (avgClv * 100).toFixed(1) + "%"}</div></div>
        <div class="kpi"><div class="l">Pending</div><div class="v">${list.length - done.length}</div></div>
        ${Object.entries(byMarket).map(([m, r]) => `<div class="kpi"><div class="l">${esc(m)}</div><div class="v">${r.w}-${r.l}${r.p ? "-" + r.p : ""}</div></div>`).join("")}`;
      const opt = (v, cur) => `<option value="${v}" ${v === cur ? "selected" : ""}>${v || "Pending"}</option>`;
      $("#logTable").innerHTML = list.length ? `<thead><tr><th>Date</th><th>Game</th><th>Bet</th><th>Odds</th><th>Close</th><th>CLV</th><th>Stake</th><th>Result</th><th>Profit</th><th></th></tr></thead><tbody>${
        list.map((b) => `<tr data-id="${b.id}"><td>${esc(b.date)}</td><td>${esc(b.game)}</td>
          <td><span class="small">${esc(b.market)}</span><br><b>${esc(b.pick)}</b></td>
          <td><input name="odds" value="${esc(b.odds)}" size="6" aria-label="Odds"></td>
          <td><input name="close" value="${esc(b.close || "")}" size="6" placeholder="${b.gameId && b.side ? "auto" : ""}" aria-label="Closing odds"></td>
          <td>${(() => { const c = this.clv(b); return c ? `<span class="${c.value > 0 ? "pos" : "neg"}">${c.value >= 0 ? "+" : ""}${(c.value * 100).toFixed(1)}%</span>${c.auto ? ` <span class="small">auto</span>` : ""}` : `<span class="small">${b.gameId && b.side ? "after puck drop" : "–"}</span>`; })()}</td>
          <td><input name="stake" value="${esc(b.stake)}" size="5" inputmode="decimal" aria-label="Stake"></td>
          <td><select name="result" aria-label="Result">${["", "W", "L", "P"].map((v) => opt(v, b.result)).join("")}</select></td>
          <td class="${this.profit(b) > 0 ? "pos" : this.profit(b) < 0 ? "neg" : ""}">${b.result ? money(this.profit(b)) : ""}</td>
          <td><button class="ghost del" type="button" aria-label="Delete">✕</button></td></tr>`).join("")}</tbody>`
        : `<tbody><tr><td class="small" style="padding:16px">No bets logged yet. Tap "+ Log bet" on any angle, or add one above.</td></tr></tbody>`;
    },
  };

  load();
})();
