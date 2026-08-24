// QuotaCove — renders usage.json into a self-contained dashboard page.
// Run eval/collect.mjs first. Categorical palette is validated for chroma,
// CVD separation, normal-vision separation and contrast in both themes.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(readFileSync(join(HERE, "usage.json"), "utf8"));

// Trim to what the page renders; keeps the payload small and the file readable.
const payload = {
  turns: d.turns, actual: d.actual, routed: d.routed, tokens: d.tokens,
  projects: d.projects.map((p) => ({ n: p.name, t: p.turns, a: +p.actual.toFixed(2), r: +p.routed.toFixed(2), m: p.models.slice(0, 5) })),
  models: d.models.map((m) => ({ n: m.name, t: m.turns, a: +m.actual.toFixed(2), tier: m.tier })),
  days: d.days.map((x) => ({ d: x.d, t: x.turns, a: +x.actual.toFixed(2), r: +x.routed.toFixed(2) })),
};

const html = `<title>Usage Atlas</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --surface: #f5efe4; --panel: #fbf7f0; --line: #ddd4c4; --line-soft: #e8e0d2;
    --ink: #1a1815; --ink-2: #4a443c; --ink-3: #7d766b;
    /* Categorical tier palette — validated: chroma, CVD, normal-vision and
       contrast all pass against this surface. Assigned in fixed order. */
    --c1: #1a6e9e; --c2: #b8791f; --c3: #a03a6a;
    --good: #2f6b46;
    --sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --cond: "Barlow Condensed", "Arial Narrow", sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root { --surface:#14120f; --panel:#1c1915; --line:#33302a; --line-soft:#26231e;
            --ink:#f2ece1; --ink-2:#b8b1a4; --ink-3:#847d72;
            --c1:#3f8fbf; --c2:#bd862b; --c3:#c05f8f; --good:#5f9a76; }
  }
  :root[data-theme="light"] { --surface:#f5efe4; --panel:#fbf7f0; --line:#ddd4c4; --line-soft:#e8e0d2;
    --ink:#1a1815; --ink-2:#4a443c; --ink-3:#7d766b; --c1:#1a6e9e; --c2:#b8791f; --c3:#a03a6a; --good:#2f6b46; }
  :root[data-theme="dark"] { --surface:#14120f; --panel:#1c1915; --line:#33302a; --line-soft:#26231e;
    --ink:#f2ece1; --ink-2:#b8b1a4; --ink-3:#847d72; --c1:#3f8fbf; --c2:#bd862b; --c3:#c05f8f; --good:#5f9a76; }

  * { box-sizing: border-box; }
  body { margin:0; background:var(--surface); color:var(--ink); font-family:var(--sans); line-height:1.55; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1080px; margin:0 auto; padding:40px 22px 80px; }
  .eyebrow { font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3); }
  h1 { font-family:var(--cond); font-size:42px; font-weight:600; text-transform:uppercase; letter-spacing:.01em; margin:6px 0 6px; }
  .lede { color:var(--ink-2); font-size:15px; max-width:66ch; margin:0 0 8px; }
  h2 { font-family:var(--cond); font-size:19px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin:0 0 3px; }
  .note { font-size:13px; color:var(--ink-3); margin:0 0 18px; max-width:70ch; }
  .sec { margin-top:44px; padding-top:24px; border-top:1px solid var(--line); }
  .toggle { font-family:var(--mono); font-size:11px; letter-spacing:.08em; text-transform:uppercase; background:none;
    border:1px solid var(--line); color:var(--ink-3); border-radius:3px; padding:6px 11px; cursor:pointer; }
  .toggle:hover { border-color:var(--ink); color:var(--ink); }
  .toggle.on { border-color:var(--ink); color:var(--ink); }

  .tiles { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-top:26px; }
  @media (max-width:720px){ .tiles{grid-template-columns:1fr} }
  .tile { background:var(--panel); border:1px solid var(--line); border-radius:5px; padding:18px 20px; }
  .tile-k { font-family:var(--mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); }
  .tile-v { font-family:var(--cond); font-size:44px; font-weight:600; line-height:1; margin-top:8px; letter-spacing:-.01em; font-variant-numeric:tabular-nums; }
  .tile-s { font-size:12.5px; color:var(--ink-2); margin-top:6px; }

  .legend { display:flex; gap:16px; flex-wrap:wrap; font-size:12.5px; color:var(--ink-2); margin-bottom:14px; }
  .legend i { display:inline-block; width:10px; height:10px; border-radius:2px; background:var(--k); margin-right:6px; vertical-align:-1px; }
  .legend .ln { width:16px; height:2px; border-radius:2px; vertical-align:3px; }

  .bars { display:flex; flex-direction:column; gap:3px; }
  .bar { display:grid; grid-template-columns:190px 1fr 92px; gap:12px; align-items:center; padding:5px 8px;
    border:1px solid transparent; border-radius:4px; cursor:pointer; background:none; text-align:left; color:inherit; font:inherit; width:100%; }
  .bar:hover, .bar.sel { background:var(--panel); border-color:var(--line); }
  .bar-n { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bar-t { position:relative; height:17px; }
  .bar-t span { position:absolute; left:0; top:0; height:100%; border-radius:0 3px 3px 0; }
  .bar-t .routed { background:var(--c1); }
  .bar-t .save { background:var(--c3); opacity:.85; }
  .bar-v { font-family:var(--mono); font-size:12px; text-align:right; font-variant-numeric:tabular-nums; color:var(--ink-2); }
  @media (max-width:640px){ .bar{grid-template-columns:120px 1fr 76px} }

  .drill { margin-top:16px; background:var(--panel); border:1px solid var(--line); border-radius:5px; padding:18px 20px; }
  .drill h3 { font-family:var(--cond); font-size:17px; text-transform:uppercase; letter-spacing:.04em; margin:0 0 2px; font-weight:600; }
  .drill .sub { font-size:12.5px; color:var(--ink-3); margin-bottom:14px; }
  .drill-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; }
  .dstat-k { font-family:var(--mono); font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-3); }
  .dstat-v { font-family:var(--mono); font-size:19px; font-variant-numeric:tabular-nums; margin-top:3px; }
  .mlist { margin-top:16px; display:flex; flex-direction:column; gap:6px; }
  .mrow { display:grid; grid-template-columns:1fr 60px; gap:10px; font-size:12.5px; align-items:center; }
  .mrow .swatch { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:7px; background:var(--k); }
  .mrow b { font-family:var(--mono); text-align:right; font-variant-numeric:tabular-nums; font-weight:400; color:var(--ink-2); }

  .chartbox { background:var(--panel); border:1px solid var(--line); border-radius:5px; padding:18px; position:relative; }
  svg.chart { width:100%; height:auto; display:block; overflow:visible; }
  .chart text { font-family:var(--mono); font-size:9.5px; fill:var(--ink-3); }
  .tip { position:absolute; pointer-events:none; background:var(--ink); color:var(--surface); border-radius:4px;
    padding:7px 10px; font-family:var(--mono); font-size:11px; line-height:1.5; opacity:0; transition:opacity .12s; white-space:nowrap; z-index:5; }
  .tip.on { opacity:1; }

  .composition { display:flex; height:34px; border-radius:4px; overflow:hidden; border:1px solid var(--line); }
  .composition span { position:relative; }
  .complabels { display:flex; gap:18px; flex-wrap:wrap; margin-top:10px; font-size:12.5px; color:var(--ink-2); }
  .complabels i { display:inline-block; width:10px; height:10px; border-radius:2px; background:var(--k); margin-right:6px; }

  table { border-collapse:collapse; width:100%; font-size:12.5px; margin-top:14px; }
  th { font-family:var(--mono); font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-3);
    text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); font-weight:600; }
  td { padding:7px 10px; border-bottom:1px solid var(--line-soft); }
  td.num { font-family:var(--mono); text-align:right; font-variant-numeric:tabular-nums; }
  .tablewrap { display:none; overflow-x:auto; }
  .tablewrap.on { display:block; }

  footer { margin-top:46px; padding-top:20px; border-top:1px solid var(--line); font-size:12.5px; color:var(--ink-3); line-height:1.7; }
  footer b { color:var(--ink-2); font-weight:600; }
  @media (prefers-reduced-motion:reduce){ *{transition:none!important} }
</style>

<div class="wrap">
  <span class="eyebrow">QuotaCove · usage atlas</span>
  <h1>Where the spend goes</h1>
  <p class="lede">Every Claude Code turn on this machine, read from local transcripts: 29 projects, 5 models,
  priced at list rates. Click any project to drill into it.</p>
  <button class="toggle" id="themeBtn" type="button">Invert</button>

  <div class="tiles" id="tiles"></div>

  <div class="sec">
    <h2>Where the tokens actually are</h2>
    <p class="note">The surprise in the data. Context re-read on every turn dwarfs everything typed or generated,
    which means spend tracks conversation length far more than prompt complexity.</p>
    <div class="composition" id="comp"></div>
    <div class="complabels" id="complabels"></div>
  </div>

  <div class="sec">
    <h2>By project</h2>
    <p class="note">Ranked by spend. The filled bar is what routing would still cost; the lighter end is what it would save.</p>
    <div class="legend">
      <span><i style="--k:var(--c1)"></i>Routed cost</span>
      <span><i style="--k:var(--c3)"></i>Avoidable</span>
    </div>
    <div class="bars" id="bars"></div>
    <div class="drill" id="drill"></div>
  </div>

  <div class="sec">
    <h2>Daily spend</h2>
    <p class="note">Actual against what routing would have cost, same scale, same units.</p>
    <div class="legend">
      <span><i class="ln" style="--k:var(--c3)"></i>Actual</span>
      <span><i class="ln" style="--k:var(--c1)"></i>Routed</span>
      <button class="toggle" id="tableBtn" type="button" style="margin-left:auto">Table view</button>
    </div>
    <div class="chartbox">
      <svg class="chart" id="daily" viewBox="0 0 900 260" role="img" aria-label="Daily spend, actual versus routed"></svg>
      <div class="tip" id="tip"></div>
    </div>
    <div class="tablewrap" id="tablewrap"></div>
  </div>

  <div class="sec">
    <h2>By model</h2>
    <p class="note">Which models the turns actually ran on.</p>
    <div class="bars" id="mbars"></div>
  </div>

  <footer>
    <b>What this covers.</b> Claude Code only. Local transcripts carry the model, token counts and project for every
    turn, which is why this view exists at all. Claude chat, Gemini and ChatGPT subscriptions publish no comparable
    per-conversation usage, so they cannot be charted this way — API keys and OpenRouter can, and Cursor exposes a
    team admin API.
    <br><b>On the numbers.</b> List prices, cache reads billed at a tenth of input. On a subscription there is no
    invoice; the same effect shows up as usage-window headroom. Savings assume a turn on a cheaper model costs the
    same tokens, so read them as an upper bound.
  </footer>
</div>

<script>
const D = ${JSON.stringify(payload)};

const $ = (id) => document.getElementById(id);
const money = (n) => n >= 1000 ? "$" + Math.round(n).toLocaleString() : "$" + n.toFixed(n < 10 ? 2 : 0);
const TIERC = { economy: "var(--c1)", balanced: "var(--c2)", premium: "var(--c3)" };
const saved = D.actual - D.routed;

// hero tiles
$("tiles").innerHTML = [
  ["Turns recorded", D.turns.toLocaleString(), "across " + D.projects.length + " projects"],
  ["Spend at list price", money(D.actual), "50 days of history"],
  ["Avoidable by routing", money(saved), Math.round(saved / D.actual * 100) + "% of the total"],
].map(([k, v, s], i) =>
  '<div class="tile"><div class="tile-k">' + k + '</div><div class="tile-v"' +
  (i === 2 ? ' style="color:var(--good)"' : "") + ">" + v + '</div><div class="tile-s">' + s + "</div></div>"
).join("");

// token composition
const T = D.tokens, tot = T.in + T.cacheRead + T.out;
const parts = [["Context re-read", T.cacheRead, "var(--c3)"], ["Generated", T.out, "var(--c2)"], ["Typed in", T.in, "var(--c1)"]];
$("comp").innerHTML = parts.map(([n, v, c], i) =>
  '<span style="background:' + c + ';width:' + (v / tot * 100) + '%' + (i ? ';border-left:2px solid var(--panel)' : '') + '" title="' + n + '"></span>'
).join("");
$("complabels").innerHTML = parts.map(([n, v, c]) =>
  '<span><i style="--k:' + c + '"></i>' + n + " " + (v / 1e9 >= 1 ? (v / 1e9).toFixed(1) + "B" : (v / 1e6).toFixed(1) + "M") +
  " · " + (v / tot * 100).toFixed(v / tot > .01 ? 1 : 2) + "%</span>"
).join("");

// project bars
const maxA = Math.max(...D.projects.map((p) => p.a));
let sel = null;
function renderBars() {
  $("bars").innerHTML = D.projects.map((p, i) =>
    '<button class="bar' + (sel === i ? " sel" : "") + '" data-i="' + i + '" type="button">' +
      '<span class="bar-n">' + p.n + "</span>" +
      '<span class="bar-t">' +
        '<span class="routed" style="width:' + (p.r / maxA * 100) + '%"></span>' +
        '<span class="save" style="left:' + (p.r / maxA * 100) + '%;width:' + ((p.a - p.r) / maxA * 100) + '%"></span>' +
      "</span>" +
      '<span class="bar-v">' + money(p.a) + "</span>" +
    "</button>"
  ).join("");
  document.querySelectorAll(".bar").forEach((b) =>
    b.addEventListener("click", () => { const i = +b.dataset.i; sel = sel === i ? null : i; renderBars(); renderDrill(); })
  );
}
function renderDrill() {
  const p = sel == null ? null : D.projects[sel];
  if (!p) {
    $("drill").innerHTML = '<div class="sub" style="margin:0">Select a project above to drill in.</div>';
    return;
  }
  const s = p.a - p.r;
  $("drill").innerHTML =
    "<h3>" + p.n + "</h3><div class='sub'>" + p.t.toLocaleString() + " turns · " +
      (p.a / D.actual * 100).toFixed(1) + "% of all spend</div>" +
    '<div class="drill-grid">' +
      '<div><div class="dstat-k">Spend</div><div class="dstat-v">' + money(p.a) + "</div></div>" +
      '<div><div class="dstat-k">After routing</div><div class="dstat-v">' + money(p.r) + "</div></div>" +
      '<div><div class="dstat-k">Avoidable</div><div class="dstat-v" style="color:var(--good)">' + money(s) + "</div></div>" +
      '<div><div class="dstat-k">Per turn</div><div class="dstat-v">$' + (p.a / p.t).toFixed(3) + "</div></div>" +
    "</div>" +
    '<div class="mlist">' + p.m.map((x) => {
      const md = D.models.find((m) => m.n === x.m);
      return '<div class="mrow"><span><span class="swatch" style="--k:' + (TIERC[md ? md.tier : "premium"]) + '"></span>' +
        x.m + "</span><b>" + x.c.toLocaleString() + "</b></div>";
    }).join("") + "</div>";
}
renderBars(); renderDrill();

// model bars
const maxM = Math.max(...D.models.map((m) => m.a));
$("mbars").innerHTML = D.models.map((m) =>
  '<div class="bar" style="cursor:default">' +
    '<span class="bar-n">' + m.n + "</span>" +
    '<span class="bar-t"><span style="width:' + (m.a / maxM * 100) + "%;background:" + TIERC[m.tier] + '"></span></span>' +
    '<span class="bar-v">' + money(m.a) + "</span>" +
  "</div>"
).join("");

// daily chart
(function daily() {
  const W = 900, H = 260, L = 52, R = 14, T2 = 12, B = 30;
  const days = D.days;
  const max = Math.max(...days.map((d) => Math.max(d.a, d.r))) * 1.08;
  const x = (i) => L + (i / Math.max(1, days.length - 1)) * (W - L - R);
  const y = (v) => H - B - (v / max) * (H - T2 - B);
  const path = (key) => days.map((d, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(d[key]).toFixed(1)).join(" ");

  let g = "";
  [0, .5, 1].forEach((f) => {
    const gy = y(max * f);
    g += '<line x1="' + L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - R) + '" y2="' + gy.toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>' +
         '<text x="' + (L - 8) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end">' + money(max * f) + "</text>";
  });
  let xl = "";
  [0, Math.floor(days.length / 3), Math.floor(days.length * 2 / 3), days.length - 1].forEach((i) => {
    xl += '<text x="' + x(i).toFixed(1) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + days[i].d.slice(5) + "</text>";
  });

  $("daily").innerHTML = g + xl +
    '<path d="' + path("a") + '" fill="none" stroke="var(--c3)" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="' + path("r") + '" fill="none" stroke="var(--c1)" stroke-width="2" stroke-linejoin="round"/>' +
    '<line id="cross" x1="0" y1="' + T2 + '" x2="0" y2="' + (H - B) + '" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>' +
    '<circle id="pa" r="4" fill="var(--c3)" stroke="var(--panel)" stroke-width="2" opacity="0"/>' +
    '<circle id="pr" r="4" fill="var(--c1)" stroke="var(--panel)" stroke-width="2" opacity="0"/>' +
    '<rect x="' + L + '" y="' + T2 + '" width="' + (W - L - R) + '" height="' + (H - T2 - B) + '" fill="transparent" id="hit"/>';

  const svg = $("daily"), tip = $("tip");
  const show = (on) => { ["cross", "pa", "pr"].forEach((id) => svg.querySelector("#" + id).setAttribute("opacity", on ? "1" : "0")); tip.classList.toggle("on", on); };
  svg.querySelector("#hit").addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * W;
    let i = Math.round((px - L) / (W - L - R) * (days.length - 1));
    i = Math.max(0, Math.min(days.length - 1, i));
    const d = days[i];
    svg.querySelector("#cross").setAttribute("x1", x(i)); svg.querySelector("#cross").setAttribute("x2", x(i));
    svg.querySelector("#pa").setAttribute("cx", x(i)); svg.querySelector("#pa").setAttribute("cy", y(d.a));
    svg.querySelector("#pr").setAttribute("cx", x(i)); svg.querySelector("#pr").setAttribute("cy", y(d.r));
    show(true);
    tip.innerHTML = d.d + "<br>actual " + money(d.a) + "<br>routed " + money(d.r) + "<br>" + d.t + " turns";
    const box = svg.getBoundingClientRect();
    tip.style.left = Math.min(box.width - 130, Math.max(0, (x(i) / W) * box.width + 12)) + "px";
    tip.style.top = ((y(d.a) / H) * box.height - 10) + "px";
  });
  svg.querySelector("#hit").addEventListener("mouseleave", () => show(false));

  $("tablewrap").innerHTML = "<table><thead><tr><th>Date</th><th>Turns</th><th>Actual</th><th>Routed</th><th>Saved</th></tr></thead><tbody>" +
    days.map((d) => "<tr><td>" + d.d + '</td><td class="num">' + d.t + '</td><td class="num">' + money(d.a) +
      '</td><td class="num">' + money(d.r) + '</td><td class="num">' + money(d.a - d.r) + "</td></tr>").join("") +
    "</tbody></table>";
  $("tableBtn").addEventListener("click", () => {
    const on = $("tablewrap").classList.toggle("on");
    $("tableBtn").classList.toggle("on", on);
    $("tableBtn").textContent = on ? "Hide table" : "Table view";
  });
})();

$("themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : cur === "light" ? "dark"
    : (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", next);
});
</script>`;

const dest = process.argv[2] ?? join(HERE, "usage-atlas.html");
writeFileSync(dest, html);
console.log(`wrote ${dest} (${(html.length / 1024).toFixed(0)}KB)`);
