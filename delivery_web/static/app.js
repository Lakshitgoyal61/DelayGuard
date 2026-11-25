/* DelayGuard frontend: a small hash-routed single-page app talking to the FastAPI backend (/api). */
"use strict";

const CLASSES = ["On-Time", "At Risk", "Delayed"];
const S = {
  theme: localStorage.getItem("theme") || "dark",
  collapsed: localStorage.getItem("collapsed") === "1",
  threshold: parseFloat(localStorage.getItem("threshold") || "0.42"),
  history: JSON.parse(localStorage.getItem("history") || "[]"),
  status: null, options: null, overview: null, metrics: {}, mode: "notebook",
  lastResult: null, lastOrder: null, actual: null, batch: null,
};
let charts = [];

/* ---------------- helpers ---------------- */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x, d = 1) => x == null ? "-" : (x * 100).toFixed(d) + "%";
const num = (x, d = 2) => x == null ? "-" : Number(x).toLocaleString("en-IN", { maximumFractionDigits: d });
const nice = s => String(s).replace(/_/g, " ");
const clsKey = c => c.replace(" ", "-");
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const colorOf = c => css({ "On-Time": "--on-time", "At Risk": "--at-risk", "Delayed": "--delayed" }[c]);

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  let body = null;
  try { body = await r.json(); } catch (_) { /* no body */ }
  if (!r.ok) throw new Error((body && body.detail) || `Request failed (${r.status})`);
  return body;
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}
function saveHistory() { localStorage.setItem("history", JSON.stringify(S.history.slice(0, 50))); }
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
function newChart(el, cfg) {
  Chart.defaults.color = css("--text-muted");
  Chart.defaults.font.family = 'Inter, "Segoe UI", system-ui, sans-serif';
  Chart.defaults.borderColor = css("--grid");
  Chart.defaults.animation = { duration: 450 };
  const c = new Chart(el, cfg); charts.push(c); return c;
}
function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; }

/* ---------------- icons ---------------- */
const I = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  chart: '<path d="M4 20V10m6 10V4m6 16v-7m4 7H2"/>',
  gauge: '<path d="M12 14l4-4M4 18a9 9 0 1 1 16 0"/>',
  upload: '<path d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16"/>',
  bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V16h8v-1.3A7 7 0 0 0 12 2z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  truck: '<path d="M3 17h2m12 0h4V12l-3-4h-4v9M3 6h11v11M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/>',
  dl: '<path d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16"/>',
};
const icon = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;

/* ---------------- shell ---------------- */
const NAV = [
  ["dashboard", "Dashboard", "bolt"], ["analytics", "Analytics", "chart"], ["model", "Model Performance", "gauge"],
  ["batch", "Batch Upload", "upload"], ["insights", "AI Insights", "bulb"], ["about", "About", "info"],
];
const TITLES = Object.fromEntries(NAV.map(([k, t]) => [k, t]));

function applyTheme() { document.documentElement.classList.toggle("dark", S.theme === "dark"); }

function shell(route, inner) {
  return `
  <div class="app">
    <aside class="sidebar ${S.collapsed ? "collapsed" : ""}">
      <a class="brand" href="#/"><span class="logo">${icon("truck", 18)}</span><span class="brand-name">Delay<span class="accent-text">Guard</span></span></a>
      ${NAV.map(([k, t, ic]) => `<a class="nav-item ${route === k ? "active" : ""}" href="#/${k}">${icon(ic)}<span class="label">${t}</span></a>`).join("")}
      <div class="side-foot">Two-stage XGBoost · UML501<br>Group 3C25 · TIET Patiala</div>
    </aside>
    <div class="main ${S.collapsed ? "wide" : ""}">
      <div class="topbar">
        <button class="icon-btn" id="collapse" title="Collapse sidebar">${icon("menu")}</button>
        <h2>${esc(TITLES[route] || "")}</h2>
        <div class="spacer"></div>
        <span class="status-pill" id="status-pill"><span class="dot"></span>Connecting...</span>
        <button class="icon-btn" id="theme" title="Toggle theme">${icon(S.theme === "dark" ? "sun" : "moon")}</button>
      </div>
      <div class="content fade-in">${inner}</div>
    </div>
  </div>`;
}

function bindShell() {
  $("#collapse")?.addEventListener("click", () => { S.collapsed = !S.collapsed; localStorage.setItem("collapsed", S.collapsed ? "1" : "0"); render(); });
  $("#theme")?.addEventListener("click", () => { S.theme = S.theme === "dark" ? "light" : "dark"; localStorage.setItem("theme", S.theme); applyTheme(); render(); });
  paintStatus();
}

function paintStatus() {
  const el = $("#status-pill"); if (!el) return;
  const st = S.status;
  if (!st) { el.innerHTML = '<span class="dot bad"></span>Backend offline'; return; }
  if (st.error) el.innerHTML = '<span class="dot bad"></span>Training error';
  else if (!st.has_data) el.innerHTML = '<span class="dot bad"></span>No dataset';
  else if (st.ready.includes("deployable")) el.innerHTML = `<span class="dot ok"></span>Model ready · ${esc(st.dataset)}`;
  else el.innerHTML = '<span class="dot"></span>Training model...';
}

const ready = () => S.status && S.status.ready && S.status.ready.includes("deployable");

function waiting() {
  const st = S.status;
  if (st && !st.has_data) return `
    <div class="card" style="max-width:640px">
      <h3>Add the training data</h3>
      <p class="sub">Copy <b>multiclasss model.xlsx</b> into the ML folder and restart, or upload it here.</p>
      ${uploadDatasetBox()}
    </div>`;
  if (st && st.error) return `<div class="banner warn"><b>Training failed:</b> ${esc(st.error)}</div>`;
  return `
    <div class="card" style="max-width:640px">
      <h3>Loading the model...</h3>
      <p class="sub">This takes a few seconds. The page fills in by itself when it's ready. (The very first run on new data trains the model, about 30 seconds.)</p>
      <div class="skeleton" style="height:12px;margin:10px 0"></div><div class="skeleton" style="height:12px;width:70%"></div>
    </div>`;
}

function uploadDatasetBox() {
  return `<label class="drop" id="ds-drop"><input type="file" id="ds-file" accept=".xlsx,.xls,.csv" hidden>
    ${icon("upload", 26)}<div style="margin-top:8px;font-weight:600">Drop the training file or click to choose</div>
    <div class="muted small">.xlsx or .csv with a time_buffer_hours column</div></label>`;
}
function bindDatasetUpload() {
  const inp = $("#ds-file"); if (!inp) return;
  inp.addEventListener("change", async () => {
    const fd = new FormData(); fd.append("file", inp.files[0]);
    try { S.status = await api("/api/dataset", { method: "POST", body: fd }); S.options = S.overview = null; S.metrics = {}; toast("Dataset uploaded. Training..."); render(); }
    catch (e) { toast(e.message); }
  });
}

/* ---------------- landing ---------------- */
function landing() {
  const o = S.overview, m = S.metrics["notebook"] || S.metrics["deployable"];
  const stat = (v, l, c = "") => `<div class="card kpi"><div class="k-label">${l}</div><div class="k-value ${c}">${v}</div></div>`;
  return `
  <div class="landing fade-in">
    <div class="land-nav">
      <a class="brand" href="#/"><span class="logo">${icon("truck", 18)}</span><span>Delay<span class="accent-text">Guard</span></span></a>
      <div class="spacer"></div>
      <button class="icon-btn" id="theme">${icon(S.theme === "dark" ? "sun" : "moon")}</button>
      <a class="btn btn-primary btn-sm" href="#/dashboard">Open dashboard</a>
    </div>
    <div class="hero">
      <div>
        <span class="eyebrow">${icon("bolt", 14)} Amazon Supply Chain Intelligence · UML501 project</span>
        <h1>Know which deliveries will be <span class="accent-text">late</span> before they leave the hub.</h1>
        <p>A two-stage machine learning system that grades every last-mile order as <b>On-Time</b>, <b>At Risk</b> (up to 3 hours late) or <b>Delayed</b>, and explains why.</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <a class="btn btn-primary" href="#/dashboard">${icon("bolt", 16)} Predict an order</a>
          <a class="btn btn-ghost" href="#/analytics">Explore the data</a>
        </div>
      </div>
      <div class="hero-visual">
        <div class="card flow-card">
          <div class="muted small" style="font-weight:600;text-transform:uppercase;letter-spacing:.08em">How a prediction is made</div>
          <div class="flow-step"><span class="n">1</span>Order details: distance, traffic, partner, weather...</div>
          <div class="flow-step"><span class="n">2</span>Stage 1 XGBoost: will it be late?</div>
          <div class="flow-step"><span class="n">3</span>Stage 2 model: how late will it be?</div>
          <div class="flow-out">
            <div class="b-On-Time">On-Time</div><div class="b-At-Risk">At Risk</div><div class="b-Delayed">Delayed</div>
          </div>
        </div>
      </div>
    </div>
    <div class="grid g-4 stats-strip">
      ${stat(o ? num(o.rows, 0) : "25,000", "orders analysed")}
      ${stat(o ? pct(o.late_share, 0) : "-", "arrived late")}
      ${stat(m ? pct(m.stage1.accuracy, 1) : "-", "Stage 1 accuracy")}
      ${stat(m ? num(m.stage1.auc, 2) : "-", "Stage 1 ROC-AUC")}
    </div>
    <div class="how">
      <h2>What you can do</h2>
      <div class="grid g-3">
        <div class="card"><h3>${icon("bolt", 16)} Predict a single order</h3><p>Fill in an order and get the risk class, probabilities, a recommended action and the top reasons.</p></div>
        <div class="card"><h3>${icon("upload", 16)} Score a whole batch</h3><p>Upload a CSV or Excel file of orders and download predictions for every row.</p></div>
        <div class="card"><h3>${icon("gauge", 16)} Check the model</h3><p>Confusion matrices, ROC curves and a live threshold slider for the recall vs false-alarm trade-off.</p></div>
      </div>
    </div>
    <div class="foot">Shreshth Garg (1024030380) · Lakshit Goyal (1024030383) · Group 3C25 · Computer Science and Engineering Department, TIET Patiala</div>
  </div>`;
}

/* ---------------- dashboard ---------------- */
function dashboard() {
  if (!ready() || !S.options) return waiting();
  const h = S.history;
  const cnt = c => h.filter(x => x.prediction === c).length;
  const avg = h.length ? h.reduce((a, b) => a + b.late_probability, 0) / h.length : null;
  const m = S.metrics["deployable"];
  const kpi = (l, v, color, note = "") => `<div class="card kpi"><div class="k-label">${l}</div><div class="k-value" style="color:${color || "inherit"}">${v}</div><div class="k-note">${note}</div></div>`;
  return `
  <div class="page-head">
    <div><h1>Delivery <span class="accent-text">Intelligence</span></h1><p>Predict the delay risk of an order before dispatch · Stage 1 threshold ${S.threshold.toFixed(2)}</p></div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-ghost btn-sm" id="sample">${icon("dice", 15)} Load a real order</button>
      ${h.length ? '<button class="btn btn-ghost btn-sm" id="clear">Clear history</button>' : ""}
    </div>
  </div>
  <div class="grid g-5" style="margin-bottom:20px">
    ${kpi("Predictions", h.length, "", "this browser")}
    ${kpi("Delayed", cnt("Delayed"), colorOf("Delayed"), "more than 3 h late")}
    ${kpi("At Risk", cnt("At Risk"), colorOf("At Risk"), "0 to 3 h late")}
    ${kpi("Avg late risk", avg == null ? "-" : pct(avg), css("--accent"), "Stage 1 probability")}
    ${kpi("Model accuracy", S.metrics.notebook ? pct(S.metrics.notebook.stage1.accuracy) : "-", "", "Stage 1, as in the notebook")}
  </div>
  <div class="grid" style="grid-template-columns:minmax(300px,380px) minmax(0,1fr)">
    <form class="card" id="order-form">
      <h3>New delivery</h3><p class="sub">Defaults are the dataset's typical values.</p>
      <div class="section-label">Order</div>
      <div class="form-grid">${Object.entries(S.options.categorical).map(([c, opts]) => `
        <div class="field"><label>${nice(c)}</label><select name="${c}">${opts.map(o => `<option ${S.lastOrder && S.lastOrder[c] === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></div>`).join("")}
      </div>
      <div class="section-label">Conditions</div>
      <div class="form-grid">${Object.entries(S.options.numeric).map(([c, v]) => `
        <div class="field"><label>${nice(c)}</label><input name="${c}" type="number" step="any" required value="${S.lastOrder ? S.lastOrder[c] : v.median}"></div>`).join("")}
      </div>
      <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:16px" id="go">${icon("bolt", 16)} Predict risk</button>
      ${S.actual ? `<p class="small muted" style="margin:10px 0 0">Loaded a real order. What actually happened: <span class="badge b-${clsKey(S.actual.cls)}">${S.actual.cls}</span> (${num(S.actual.tb)} h vs promised)</p>` : ""}
    </form>
    <div style="display:grid;gap:20px;align-content:start;min-width:0">
      ${S.lastResult ? resultPanel(S.lastResult) : `<div class="card" style="display:grid;place-items:center;min-height:260px;text-align:center">
        <div><div class="logo" style="margin:0 auto 12px;width:48px;height:48px">${icon("bolt", 22)}</div><h3>No prediction yet</h3><p class="sub">Fill in the form or load a real order, then press <b>Predict risk</b>.</p></div></div>`}
      <div class="card">
        <h3>Recent predictions</h3><p class="sub">Stored in this browser only.</p>
        ${h.length ? `<div class="table-wrap" style="max-height:300px"><table class="tbl"><thead><tr><th>#</th><th>Time</th><th>Partner</th><th>Mode</th><th>Region</th><th>Weather</th><th class="num">Distance</th><th class="num">P(late)</th><th>Prediction</th></tr></thead><tbody>
          ${h.map((x, i) => `<tr><td>${h.length - i}</td><td>${esc(x.time)}</td><td>${esc(x.order.delivery_partner)}</td><td>${esc(x.order.delivery_mode)}</td><td>${esc(x.order.region)}</td><td>${esc(x.order.weather_condition)}</td><td class="num">${num(x.order.distance_km, 1)} km</td><td class="num">${pct(x.late_probability)}</td><td><span class="badge b-${clsKey(x.prediction)}">${x.prediction}</span></td></tr>`).join("")}
        </tbody></table></div>` : '<p class="muted small" style="margin:0">Nothing yet.</p>'}
      </div>
    </div>
  </div>`;
}

function resultPanel(r) {
  return `
  <div class="grid g-2 fade-in">
    <div class="card" style="padding:0;overflow:hidden">
      <div class="result ${clsKey(r.prediction)}" style="border-radius:0">
        <div class="r-label">Predicted outcome</div>
        <div class="r-class">${r.prediction}</div>
        <div style="font-size:13px;opacity:.95">${esc(r.recommendation)}</div>
      </div>
      <div style="padding:18px 20px">
        ${CLASSES.map(c => `<div class="prob-row"><span>${c}</span><div class="bar"><span style="width:${(r.probabilities[c] * 100).toFixed(1)}%;background:${colorOf(c)}"></span></div><b class="num">${pct(r.probabilities[c], 0)}</b></div>`).join("")}
        <p class="small muted" style="margin:10px 0 0">Stage 1 probability of being late: <b>${pct(r.late_probability)}</b> (threshold ${S.threshold.toFixed(2)})</p>
      </div>
    </div>
    <div class="card"><h3>Why this prediction?</h3><p class="sub">Top drivers of the late-risk score. <span style="color:${colorOf("Delayed")}">Red</span> pushes toward late, <span style="color:${colorOf("On-Time")}">green</span> toward on time.</p>
      <div style="height:250px"><canvas id="drivers"></canvas></div></div>
  </div>`;
}

function drawDrivers() {
  const r = S.lastResult, el = $("#drivers"); if (!r || !el) return;
  const d = r.drivers;
  newChart(el, { type: "bar", data: { labels: d.map(x => { const t = x.value == null ? nice(x.feature) : `${nice(x.feature)} = ${typeof x.value === "number" ? num(x.value) : x.value}`; return t.length > 28 ? t.slice(0, 27) + "…" : t; }),
      datasets: [{ data: d.map(x => x.effect), backgroundColor: d.map(x => x.effect > 0 ? colorOf("Delayed") : colorOf("On-Time")), borderRadius: 6 }] },
    options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `effect ${c.raw > 0 ? "+" : ""}${c.raw.toFixed(3)} log-odds` } } },
      scales: { x: { grid: { color: css("--grid") } }, y: { grid: { display: false }, ticks: { font: { size: 11 } } } } } });
}

function bindDashboard() {
  $("#sample")?.addEventListener("click", async () => {
    try { const s = await api("/api/sample"); S.lastOrder = s.order; S.actual = { cls: s.actual, tb: s.time_buffer_hours }; render(); toast("Loaded a real order from the dataset. Press Predict risk."); }
    catch (e) { toast(e.message); }
  });
  $("#clear")?.addEventListener("click", () => { S.history = []; saveHistory(); render(); });
  $("#order-form")?.addEventListener("submit", async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target), order = {};
    for (const [k, v] of fd.entries()) order[k] = k in S.options.numeric ? parseFloat(v) : v;
    const btn = $("#go"); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Analysing...';
    try {
      const r = await api("/api/predict", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order, threshold: S.threshold }) });
      S.lastResult = r; S.lastOrder = order;
      S.history.unshift({ time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), order, prediction: r.prediction, late_probability: r.late_probability });
      saveHistory(); render();
    } catch (e) { toast(e.message); btn.disabled = false; btn.innerHTML = `${icon("bolt", 16)} Predict risk`; }
  });
  drawDrivers();
}

/* ---------------- analytics ---------------- */
function analytics() {
  if (!ready() || !S.overview) return waiting();
  const o = S.overview, cats = Object.keys(o.breakdown);
  S.by = S.by && cats.includes(S.by) ? S.by : (cats.includes("weather_condition") ? "weather_condition" : cats[0]);
  const kpi = (l, v, c) => `<div class="card kpi"><div class="k-label">${l}</div><div class="k-value" style="color:${c || "inherit"}">${v}</div></div>`;
  return `
  <div class="page-head"><div><h1>Delivery <span class="accent-text">Analytics</span></h1><p>${num(o.rows, 0)} historical orders from ${esc(o.dataset)}</p></div></div>
  <div class="grid g-4" style="margin-bottom:20px">
    ${kpi("Orders", num(o.rows, 0))}
    ${kpi("On-Time", num(o.counts["On-Time"], 0), colorOf("On-Time"))}
    ${kpi("At Risk", num(o.counts["At Risk"], 0), colorOf("At Risk"))}
    ${kpi("Delayed", num(o.counts["Delayed"], 0), colorOf("Delayed"))}
  </div>
  <div class="grid" style="grid-template-columns:minmax(280px,1fr) 2fr">
    <div class="card"><h3>Class balance</h3><p class="sub">Share of all orders.</p><div style="height:280px"><canvas id="pie"></canvas></div></div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div><h3>Delay risk by ${nice(S.by)}</h3><p class="sub">Outcome share in each group, sorted by share delayed.</p></div>
        <div class="field" style="min-width:200px"><select id="by">${cats.map(c => `<option value="${c}" ${c === S.by ? "selected" : ""}>${nice(c)}</option>`).join("")}</select></div>
      </div>
      <div style="height:${Math.max(240, o.breakdown[S.by].labels.length * 34)}px"><canvas id="stack"></canvas></div>
    </div>
  </div>
  <div class="card" style="margin-top:20px"><h3>Time buffer distribution</h3><p class="sub">Actual minus promised delivery time, in hours. Left of 0 = early, 0 to 3 = At Risk, beyond 3 = Delayed.</p><div style="height:260px"><canvas id="hist"></canvas></div></div>`;
}
function bindAnalytics() {
  const o = S.overview; if (!o) return;
  $("#by")?.addEventListener("change", e => { S.by = e.target.value; render(); });
  newChart($("#pie"), { type: "doughnut", data: { labels: CLASSES, datasets: [{ data: CLASSES.map(c => o.counts[c]), backgroundColor: CLASSES.map(colorOf), borderWidth: 0 }] },
    options: { cutout: "62%", maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: c => `${c.label}: ${num(c.raw, 0)} (${pct(c.raw / o.rows)})` } } } } });
  const b = o.breakdown[S.by];
  newChart($("#stack"), { type: "bar", data: { labels: b.labels, datasets: CLASSES.map(c => ({ label: c, data: b[c], backgroundColor: colorOf(c), borderRadius: 4 })) },
    options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${pct(c.raw)}` } } },
      scales: { x: { stacked: true, max: 1, ticks: { callback: v => pct(v, 0) } }, y: { stacked: true, grid: { display: false } } } } });
  const e = o.buffer_hist.edges, mids = o.buffer_hist.counts.map((_, i) => (e[i] + e[i + 1]) / 2);
  newChart($("#hist"), { type: "bar", data: { labels: mids.map(x => x.toFixed(1)), datasets: [{ data: o.buffer_hist.counts, backgroundColor: mids.map(x => x < 0 ? colorOf("On-Time") : x <= 3 ? colorOf("At Risk") : colorOf("Delayed")), borderRadius: 3, barPercentage: 1, categoryPercentage: .92 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: "hours" }, grid: { display: false }, ticks: { maxTicksLimit: 12 } }, y: { title: { display: true, text: "orders" } } } } });
}

/* ---------------- model performance ---------------- */
function cmGrid(cm, labels, posColor) {
  const max = Math.max(...cm.flat()), n = labels.length;
  return `<div class="cm" style="grid-template-columns:70px repeat(${n},1fr)">
    <div></div>${labels.map(l => `<div class="cm-head">pred. ${l}</div>`).join("")}
    ${cm.map((row, i) => `<div class="cm-side">${labels[i]}</div>${row.map((v, j) => {
      const a = 0.12 + 0.78 * v / max, good = i === j;
      return `<div class="cm-cell" style="background:color-mix(in srgb, ${good ? posColor : css("--delayed")} ${Math.round(a * 100)}%, transparent);color:${a > .5 ? "#fff" : "var(--text-primary)"}">${num(v, 0)}<small>${good ? "correct" : "wrong"}</small></div>`;
    }).join("")}`).join("")}
  </div>`;
}
function modelPage() {
  if (!ready()) return waiting();
  const m = S.metrics[S.mode];
  const head = `
  <div class="page-head">
    <div><h1>Model <span class="accent-text">Performance</span></h1><p>Hold-out test set (30%, stratified, seed 42)</p></div>
    <div class="seg" id="mode">${Object.entries(S.status.modes).map(([k, v]) => `<button data-mode="${k}" class="${S.mode === k ? "on" : ""}">${esc(v)}</button>`).join("")}</div>
  </div>`;
  if (!m) return head + `<div class="card"><h3>Training the ${esc(S.status.modes[S.mode])} model...</h3><p class="sub">About 30 seconds the first time.</p><div class="skeleton" style="height:12px"></div></div>`;
  const s1 = m.stage1, x = m.stage2_xgb, r = m.stage2_rf, e = m.end_to_end;
  const kpi = (l, v, c, n = "") => `<div class="card kpi"><div class="k-label">${l}</div><div class="k-value" style="color:${c || "inherit"}">${v}</div><div class="k-note">${n}</div></div>`;
  return head + `
  ${S.mode === "notebook" ? `<div class="banner info"><b>Notebook mode:</b> the same pipeline and settings as the Jupyter notebook, so these results match the notebook and the report (tiny differences come from the XGBoost version on this PC). Note: SLA time uses the time buffer, so these scores are optimistic; Dashboard predictions use the deployable model.</div>`
    : `<div class="banner info"><b>Deployable mode:</b> no outcome information is used, so these are the realistic scores for new orders. ${esc(m.notes[m.notes.length - 1] || "")}</div>`}
  <div class="card" style="margin-bottom:20px">
    <div style="display:flex;justify-content:space-between;gap:20px;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:260px"><h3>Stage 1 decision threshold: <span class="accent-text mono">${S.threshold.toFixed(2)}</span></h3>
        <p class="sub" style="margin:0">Lower = catch more late orders but raise more false alarms. Applies to predictions on every page.</p></div>
      <div style="flex:1;min-width:260px"><input type="range" id="thr" min="0.1" max="0.9" step="0.01" value="${S.threshold}"></div>
    </div>
  </div>
  <h3 style="margin:6px 0 12px">Stage 1 · On-Time vs Late</h3>
  <div class="grid g-4" style="margin-bottom:20px">
    ${kpi("Accuracy", pct(s1.accuracy))}${kpi("Late orders caught", pct(s1.recall), colorOf("On-Time"), "recall")}
    ${kpi("Macro-F1", num(s1.macro_f1, 3))}${kpi("ROC-AUC", num(s1.auc, 3), css("--accent"))}
  </div>
  <div class="grid g-2" style="margin-bottom:28px">
    <div class="card"><h3>Confusion matrix</h3><p class="sub">${num(m.sizes.test, 0)} test orders</p>${cmGrid(s1.cm, ["On-Time", "Late"], colorOf("On-Time"))}</div>
    <div class="card"><h3>ROC curve</h3><p class="sub">AUC ${num(s1.auc, 3)}</p><div style="height:250px"><canvas id="roc1"></canvas></div></div>
  </div>
  <h3 style="margin:6px 0 12px">Stage 2 · At Risk vs Delayed <span class="muted small">(late orders only · in use: ${m.stage2_choice === "rf" ? "Random Forest" : "XGBoost"})</span></h3>
  <div class="grid g-2" style="margin-bottom:28px">
    <div class="card"><h3>XGBoost vs Random Forest</h3><p class="sub">${num(m.sizes.stage2_test, 0)} late test orders</p>
      <div class="tbl-box"><table class="tbl fit">
        <colgroup><col style="width:36%"><col style="width:16%"><col style="width:16%"><col style="width:16%"><col style="width:16%"></colgroup>
        <thead><tr><th>Model</th><th class="num">Accuracy</th><th class="num">Macro-F1</th><th class="num">Delayed recall</th><th class="num">ROC-AUC</th></tr></thead><tbody>
      ${[["XGBoost", "regularised, 220 trees", x, "xgb"], ["Random Forest", "650 trees", r, "rf"]].map(([n, sub, b, k]) => `<tr><td class="name-cell"><b>${n}</b><span class="muted small">${sub}</span>${m.stage2_choice === k ? '<br><span class="badge b-On-Time">in use</span>' : ""}</td><td class="num">${pct(b.accuracy)}</td><td class="num">${num(b.macro_f1, 3)}</td><td class="num">${pct(b.recall)}</td><td class="num">${num(b.auc, 3)}</td></tr>`).join("")}
      </tbody></table></div>
      <div style="margin-top:16px">${cmGrid((m.stage2_choice === "rf" ? r : x).cm, ["At Risk", "Delayed"], colorOf("At Risk"))}</div></div>
    <div class="card"><h3>ROC curves</h3><p class="sub">Both Stage 2 models</p><div style="height:300px"><canvas id="roc2"></canvas></div></div>
  </div>
  <h3 style="margin:6px 0 12px">End to end · all three classes</h3>
  <div class="grid g-2">
    <div class="card"><h3>${pct(e.accuracy)} accuracy · macro-F1 ${num(e.macro_f1, 3)}</h3><p class="sub">Both stages run together, so Stage 1 misses never reach Stage 2. This is the realistic score of the full system.</p>${cmGrid(e.cm, CLASSES, colorOf("On-Time"))}</div>
    <div class="card"><h3>Per-class results</h3><p class="sub">Three-class, hold-out set</p>
      <div class="tbl-box"><table class="tbl fit">
        <colgroup><col style="width:28%"><col style="width:18%"><col style="width:18%"><col style="width:18%"><col style="width:18%"></colgroup>
        <thead><tr><th>Class</th><th class="num">Precision</th><th class="num">Recall</th><th class="num">F1</th><th class="num">Orders</th></tr></thead><tbody>
      ${CLASSES.map(c => `<tr><td><span class="badge b-${clsKey(c)}">${c}</span></td><td class="num">${num(e.per_class[c].precision, 3)}</td><td class="num">${num(e.per_class[c].recall, 3)}</td><td class="num">${num(e.per_class[c]["f1-score"], 3)}</td><td class="num">${num(e.per_class[c].support, 0)}</td></tr>`).join("")}
      </tbody></table></div></div>
  </div>`;
}
function rocChart(el, series) {
  newChart(el, { type: "line", data: { datasets: [...series.map(([label, pts, color]) => ({ label, data: pts.map(([x, y]) => ({ x, y })), borderColor: color, borderWidth: 2.5, pointRadius: 0, tension: .1 })),
      { label: "random", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }], borderColor: css("--text-muted"), borderDash: [5, 5], borderWidth: 1.2, pointRadius: 0 }] },
    options: { maintainAspectRatio: false, parsing: false, plugins: { legend: { position: "bottom" } },
      scales: { x: { type: "linear", min: 0, max: 1, title: { display: true, text: "false positive rate" } }, y: { min: 0, max: 1, title: { display: true, text: "true positive rate" } } } } });
}
function bindModel() {
  document.querySelectorAll("#mode button").forEach(b => b.addEventListener("click", () => { S.mode = b.dataset.mode; render(); loadMetrics(S.mode); }));
  const thr = $("#thr");
  if (thr) {
    thr.addEventListener("input", () => { $("h3 .mono").textContent = parseFloat(thr.value).toFixed(2); });
    thr.addEventListener("change", () => { S.threshold = parseFloat(thr.value); localStorage.setItem("threshold", S.threshold); S.metrics = {}; loadMetrics(S.mode); });
  }
  const m = S.metrics[S.mode]; if (!m) return;
  rocChart($("#roc1"), [[`Stage 1 XGBoost (AUC ${num(m.stage1.auc, 3)})`, m.stage1.roc, colorOf("On-Time")]]);
  rocChart($("#roc2"), [[`XGBoost (AUC ${num(m.stage2_xgb.auc, 3)})`, m.stage2_xgb.roc, colorOf("Delayed")], [`Random Forest (AUC ${num(m.stage2_rf.auc, 3)})`, m.stage2_rf.roc, css("--accent")]]);
}

/* ---------------- batch ---------------- */
function batch() {
  if (!ready()) return waiting();
  const b = S.batch;
  return `
  <div class="page-head"><div><h1>Batch <span class="accent-text">Upload</span></h1><p>Score many orders at once. Use the same columns as the training data; missing values are filled the same way.</p></div>
    <button class="btn btn-ghost btn-sm" id="tmpl">${icon("dl", 15)} Download template CSV</button></div>
  <div class="card" style="margin-bottom:20px">
    <label class="drop" id="drop"><input type="file" id="file" accept=".csv,.xlsx,.xls" hidden>
      ${icon("upload", 28)}<div style="margin-top:8px;font-weight:600">Drop a CSV or Excel file here, or click to choose</div>
      <div class="muted small">Predictions use the current Stage 1 threshold (${S.threshold.toFixed(2)})</div></label>
  </div>
  ${b ? `
  <div class="grid g-4" style="margin-bottom:20px">
    <div class="card kpi"><div class="k-label">Orders scored</div><div class="k-value">${num(b.rows, 0)}</div><div class="k-note">${esc(b.name)}</div></div>
    ${CLASSES.map(c => `<div class="card kpi"><div class="k-label">${c}</div><div class="k-value" style="color:${colorOf(c)}">${num(b.counts[c], 0)}</div><div class="k-note">${pct(b.counts[c] / b.rows)}</div></div>`).join("")}
  </div>
  ${b.accuracy != null ? `<div class="banner info">This file includes actual outcomes: the model's accuracy on it is <b>${pct(b.accuracy)}</b>.</div>` : ""}
  <div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:10px;flex-wrap:wrap">
      <div><h3>Results</h3><p class="sub" style="margin:0">${b.rows > 500 ? "Showing the first 500 rows. The download has all of them." : "All rows."}</p></div>
      <button class="btn btn-primary btn-sm" id="dl">${icon("dl", 15)} Download predictions</button></div>
    <div class="table-wrap"><table class="tbl"><thead><tr>${b.columns.map(c => `<th>${esc(nice(c))}</th>`).join("")}</tr></thead><tbody>
      ${b.data.map(row => `<tr>${b.columns.map(c => c === "prediction" ? `<td><span class="badge b-${clsKey(row[c])}">${row[c]}</span></td>` : c.startsWith("p_") ? `<td class="num">${pct(row[c])}</td>` : `<td>${esc(typeof row[c] === "number" ? num(row[c]) : row[c])}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div></div>` : ""}`;
}
function bindBatch() {
  $("#tmpl")?.addEventListener("click", async () => { try { download("orders_template.csv", (await api("/api/template")).csv); } catch (e) { toast(e.message); } });
  $("#dl")?.addEventListener("click", () => download("predictions.csv", S.batch.csv));
  const drop = $("#drop"), inp = $("#file"); if (!drop) return;
  const send = async file => {
    const fd = new FormData(); fd.append("file", file);
    drop.innerHTML = '<div class="spin" style="margin:0 auto;border-color:rgba(59,130,246,.3);border-top-color:#3b82f6"></div><div style="margin-top:10px">Scoring...</div>';
    try { S.batch = { ...(await api(`/api/predict-batch?threshold=${S.threshold}`, { method: "POST", body: fd })), name: file.name }; }
    catch (e) { toast(e.message); }
    render();
  };
  inp.addEventListener("change", () => inp.files[0] && send(inp.files[0]));
  ["dragover", "dragenter"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => e.dataTransfer.files[0] && send(e.dataTransfer.files[0]));
}

/* ---------------- insights ---------------- */
function insights() {
  if (!ready()) return waiting();
  const m = S.metrics["deployable"];
  if (!m) return `<div class="card"><div class="skeleton" style="height:12px"></div></div>`;
  const top = m.importance.slice(0, 3).map(x => `<b>${esc(nice(x.feature))}</b>`).join(", ");
  return `
  <div class="page-head"><div><h1>AI <span class="accent-text">Insights</span></h1><p>What drives the Stage 1 late-risk prediction (TreeSHAP, test set)</p></div></div>
  <div class="grid" style="grid-template-columns:2fr minmax(280px,1fr)">
    <div class="card"><h3>Top 15 drivers</h3><p class="sub">Mean absolute SHAP value: how much each input moves the late-risk score on average.</p><div style="height:460px"><canvas id="imp"></canvas></div></div>
    <div style="display:grid;gap:20px;align-content:start">
      <div class="card"><h3>${icon("bulb", 16)} Key finding</h3><p class="sub" style="margin:6px 0 0;color:var(--text-secondary)">The strongest drivers of delay are ${top}. Operations teams can act on these before dispatch, for example by moving high-traffic orders to express slots or more reliable vehicles.</p></div>
      <div class="card"><h3>How to read it</h3><p class="sub" style="margin:6px 0 0;color:var(--text-secondary)">Categories appear one value at a time (for example <i>delivery mode standard</i>). For a single order's reasons, run a prediction on the Dashboard: the "Why this prediction?" chart shows its own top drivers.</p></div>
      <div class="card"><h3>About leakage</h3><p class="sub" style="margin:6px 0 0;color:var(--text-secondary)">The notebook's SLA time feature was built from the outcome itself, so it dominated. This deployable model leaves it out, so the drivers above are things you actually know before delivery.</p></div>
    </div>
  </div>`;
}
function bindInsights() {
  const m = S.metrics["deployable"]; if (!m || !$("#imp")) return;
  const d = m.importance;
  newChart($("#imp"), { type: "bar", data: { labels: d.map(x => nice(x.feature)), datasets: [{ data: d.map(x => x.value),
      backgroundColor: d.map((_, i) => i < 3 ? css("--accent") : (S.theme === "dark" ? "rgba(148,163,184,.45)" : "rgba(100,116,139,.35)")), borderRadius: 6 }] },
    options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: "mean |SHAP| (log-odds)" } }, y: { grid: { display: false } } } } });
}

/* ---------------- about ---------------- */
function about() {
  const st = S.status || {};
  return `
  <div class="page-head"><div><h1>About <span class="accent-text">DelayGuard</span></h1><p>Amazon Supply Chain Intelligence: Delivery Delay Risk Classification</p></div></div>
  <div class="grid g-2">
    <div class="card"><h3>How it works</h3><p class="sub">Same pipeline as the project notebook.</p>
      <ol style="margin:0;padding-left:18px;color:var(--text-secondary);line-height:1.9">
        <li>Missing values filled (median / "unknown").</li>
        <li>Six engineered features: order density, cost intensity, traffic pressure, reliability risk, distance × cost (and SLA time in notebook mode).</li>
        <li>One-hot encoding; 70/30 split stratified on the Stage 1 label.</li>
        <li><b>Stage 1</b> XGBoost (500 trees, depth 6, class weight 2.8) decides On-Time vs Late.</li>
        <li><b>Stage 2</b> grades late orders as At Risk or Delayed (regularised XGBoost or a 650-tree Random Forest, whichever scores better).</li>
        <li>TreeSHAP explains every prediction.</li>
      </ol></div>
    <div class="card"><h3>Architecture</h3><p class="sub">Like a typical ML web app: a browser frontend calling a Python API.</p>
      <div class="flow-step"><span class="n">1</span>Website (HTML, CSS, JavaScript, Chart.js)</div>
      <div class="flow-step"><span class="n">2</span>FastAPI backend: /api/predict, /api/predict-batch, /api/metrics ...</div>
      <div class="flow-step"><span class="n">3</span>Trained models (XGBoost + Random Forest), cached on disk</div>
      <p class="small muted" style="margin:12px 0 0">Dataset in use: <b>${esc(st.dataset || "none")}</b></p></div>
    <div class="card"><h3>Team</h3><p class="sub">UML501 Machine Learning · END-Semester Evaluation</p>
      <table class="tbl"><tbody><tr><td>Shreshth Garg</td><td class="mono">1024030380</td></tr><tr><td>Lakshit Goyal</td><td class="mono">1024030383</td></tr>
      <tr><td>Group</td><td>3C25 · BE Third Year, CSE</td></tr><tr><td>Submitted to</td><td>Akshun Sharma</td></tr><tr><td>Department</td><td>Computer Science and Engineering, TIET Patiala</td></tr></tbody></table></div>
    <div class="card"><h3>Replace the training data</h3><p class="sub">Upload a new dataset with the same columns. The model retrains automatically.</p>${uploadDatasetBox()}</div>
  </div>`;
}

/* ---------------- data loading ---------------- */
const pending = new Set();
async function loadMetrics(mode) {
  if (pending.has(mode)) return;
  pending.add(mode);
  try { S.metrics[mode] = await api(`/api/metrics?mode=${mode}&threshold=${S.threshold}`); }
  catch (e) { toast(e.message); }
  finally { pending.delete(mode); }
  render();
}
async function loadCore() {
  try {
    if (!S.options) S.options = await api("/api/options");
    if (!S.overview) S.overview = await api("/api/overview");
    if (!S.metrics["deployable"]) S.metrics["deployable"] = await api(`/api/metrics?mode=deployable&threshold=${S.threshold}`);
    if (!S.metrics["notebook"]) S.metrics["notebook"] = await api(`/api/metrics?mode=notebook&threshold=${S.threshold}`);
  } catch (e) { toast(e.message); }
}
async function pollStatus() {
  const wasReady = ready();
  try { S.status = await api("/api/status"); } catch (_) { S.status = null; }
  paintStatus();
  if (ready() && !wasReady) { await loadCore(); render(); }
  if (!ready() || (S.status && S.status.training.length)) setTimeout(pollStatus, 2500);
  else setTimeout(pollStatus, 15000);
}

/* ---------------- router ---------------- */
const PAGES = {
  dashboard: [dashboard, bindDashboard], analytics: [analytics, bindAnalytics], model: [modelPage, bindModel],
  batch: [batch, bindBatch], insights: [insights, bindInsights], about: [about, () => {}],
};
function render() {
  destroyCharts();
  const route = (location.hash.replace(/^#\/?/, "") || "").split("?")[0];
  const root = $("#root");
  if (!route) { root.innerHTML = landing(); $("#theme")?.addEventListener("click", () => { S.theme = S.theme === "dark" ? "light" : "dark"; localStorage.setItem("theme", S.theme); applyTheme(); render(); }); return; }
  const [view, bind] = PAGES[route] || PAGES.dashboard;
  root.innerHTML = shell(route in PAGES ? route : "dashboard", view());
  bindShell(); bindDatasetUpload(); bind();
  if (route === "model" && ready() && !S.metrics[S.mode]) loadMetrics(S.mode);
}
window.addEventListener("hashchange", () => { window.scrollTo(0, 0); render(); });
applyTheme();
render();
pollStatus();
