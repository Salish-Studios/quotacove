#!/usr/bin/env node
// QuotaCove — quota weight probe.
//
// The open question under every headline number: how much of a 5-hour usage
// window does one turn on each model actually consume? Providers do not publish
// weights, and Claude Code does not persist the readout — /usage renders it live
// and writes nothing to disk. So the design pairs what CAN be captured
// automatically (token counts, from local transcripts) with two numbers a human
// reads off /usage at each end of a window.
//
//   node eval/quota-probe.mjs tokens --since "2026-08-24T09:00" --until "...:14:00"
//       Totals tokens by model for that window, straight from the transcripts.
//
//   node eval/quota-probe.mjs record --since ... --until ... --start 4 --end 61 --note "opus only"
//       Appends one observation: the token totals plus your two /usage readings.
//
//   node eval/quota-probe.mjs fit
//       Least-squares fit of quota consumed against per-model token totals,
//       yielding the weights. Needs several observations that differ in mix.
//
// Reads only model names and token counts. No prompt or response content is
// read, stored, or emitted.

import { readdirSync, statSync, createReadStream, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, "quota-observations.jsonl");
const ROOT = join(homedir(), ".claude", "projects");

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt = undefined) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? dflt : argv[i + 1];
};

function transcripts() {
  const out = [];
  (function walk(d) {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const p = join(d, e);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) walk(p);
      else if (e.endsWith(".jsonl")) out.push(p);
    }
  })(ROOT);
  return out;
}

// Accepts an ISO timestamp, a relative age like "5h" or "90m", or nothing.
// Typing a full ISO string at the end of every window is the kind of friction
// that stops an experiment from being run at all.
function parseWhen(v, dflt) {
  if (v == null) return dflt;
  const rel = /^(\d+(?:\.\d+)?)\s*([mhd])$/i.exec(String(v).trim());
  if (rel) {
    const mult = { m: 6e4, h: 36e5, d: 864e5 }[rel[2].toLowerCase()];
    return Date.now() - Number(rel[1]) * mult;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`could not read "${v}" as a time — use ISO, or a relative age like 5h`);
  return t;
}

// Default the window start to just after the last recorded observation, so
// consecutive windows butt up against each other without being typed out.
function defaultSince() {
  const obs = loadObs();
  if (!obs.length) return Date.now() - 5 * 36e5; // one usage window back
  const last = obs[obs.length - 1];
  const t = Date.parse(last.until ?? "");
  return Number.isNaN(t) ? Date.now() - 5 * 36e5 : t;
}

// Sum tokens per model for assistant turns inside [since, until).
async function tally(since, until) {
  const lo = since === undefined ? defaultSince() : parseWhen(since, defaultSince());
  const hi = until === undefined ? Date.now() : parseWhen(until, Date.now());

  const byModel = {};
  let turns = 0;
  for (const f of transcripts()) {
    // Cheap skip: a file untouched before the window cannot contain its turns.
    try { if (statSync(f).mtimeMs < lo) continue; } catch { continue; }
    const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const m = j.message;
      if (!m || m.role !== "assistant" || !m.usage) continue;
      const ts = Date.parse(j.timestamp ?? "");
      if (Number.isNaN(ts) || ts < lo || ts >= hi) continue;
      const model = m.model ?? "unknown";
      const u = m.usage;
      byModel[model] ??= { turns: 0, in: 0, cacheRead: 0, cacheWrite: 0, out: 0 };
      const b = byModel[model];
      b.turns++;
      b.in += u.input_tokens ?? 0;
      b.cacheRead += u.cache_read_input_tokens ?? 0;
      b.cacheWrite += u.cache_creation_input_tokens ?? 0;
      b.out += u.output_tokens ?? 0;
      turns++;
    }
  }
  return { turns, byModel };
}

// Normalised token weight per model, so the fit has one number per model.
// Cache reads bill at roughly a tenth of fresh input everywhere, so they are
// discounted here rather than counted at face value.
const effTokens = (b) => b.cacheRead * 0.1 + b.in + b.cacheWrite + b.out;

function printTally(t) {
  console.log(`${t.turns} assistant turns in window\n`);
  console.log("model".padEnd(30) + "turns".padStart(7) + "fresh in".padStart(11) + "cache read".padStart(12) + "output".padStart(10) + "effective".padStart(12));
  for (const [m, b] of Object.entries(t.byModel).sort((a, c) => c[1].turns - a[1].turns)) {
    console.log(
      m.slice(0, 29).padEnd(30) + String(b.turns).padStart(7) +
      String(b.in).padStart(11) + String(b.cacheRead).padStart(12) +
      String(b.out).padStart(10) + String(Math.round(effTokens(b))).padStart(12)
    );
  }
}

function loadObs() {
  try {
    return readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Solve min ||Aw - b||^2 for non-negative-ish weights via normal equations with
// a small ridge term, so a near-singular design (all observations the same mix)
// degrades to something stable rather than exploding.
function fit(models, A, b, ridge = 1e-6) {
  const n = models.length;
  const AtA = Array.from({ length: n }, () => new Array(n).fill(0));
  const Atb = new Array(n).fill(0);
  for (let r = 0; r < A.length; r++) {
    for (let i = 0; i < n; i++) {
      Atb[i] += A[r][i] * b[r];
      for (let j = 0; j < n; j++) AtA[i][j] += A[r][i] * A[r][j];
    }
  }
  for (let i = 0; i < n; i++) AtA[i][i] += ridge;

  // Gaussian elimination.
  const M = AtA.map((row, i) => [...row, Atb[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

async function main() {
  if (cmd === "tokens") {
    printTally(await tally(flag("since"), flag("until")));
    return;
  }

  if (cmd === "record") {
    const start = Number(flag("start")), end = Number(flag("end"));
    if (Number.isNaN(start) || Number.isNaN(end)) {
      console.error("need --start and --end: the two /usage percentages either side of the window");
      console.error("(--since/--until are optional; the window defaults to since the last record)");
      process.exit(1);
    }
    const lo = flag("since") === undefined ? defaultSince() : parseWhen(flag("since"));
    const hi = flag("until") === undefined ? Date.now() : parseWhen(flag("until"));
    const since = new Date(lo).toISOString();
    const until = new Date(hi).toISOString();

    const t = await tally(since, until);
    if (!t.turns) {
      console.error(`no assistant turns found between ${since} and ${until} — widen the window with --since 8h`);
      process.exit(1);
    }
    const obs = {
      since, until,
      quotaDelta: end - start,
      note: flag("note", ""),
      turns: t.turns,
      models: Object.fromEntries(Object.entries(t.byModel).map(([m, b]) => [m, { turns: b.turns, eff: Math.round(effTokens(b)) }])),
    };
    appendFileSync(LOG, JSON.stringify(obs) + "\n");
    printTally(t);
    console.log(`\nrecorded: quota ${start}% → ${end}% (${obs.quotaDelta} points) over ${t.turns} turns`);
    console.log(`observations so far: ${loadObs().length}`);
    return;
  }

  if (cmd === "fit") {
    const obs = loadObs();
    if (obs.length < 2) {
      console.log(`Need at least 2 observations to fit; have ${obs.length}.`);
      console.log("Record windows that differ in model mix — one heavy on the top model,");
      console.log("one heavy on the cheap one — or the fit cannot separate them.");
      return;
    }
    const models = [...new Set(obs.flatMap((o) => Object.keys(o.models)))].sort();
    // Per 100k effective tokens, so the weights land in a readable range.
    const A = obs.map((o) => models.map((m) => (o.models[m]?.eff ?? 0) / 1e5));
    const b = obs.map((o) => o.quotaDelta);
    const w = fit(models, A, b);
    if (!w) {
      console.log("Fit is singular — the observations do not differ enough in mix.");
      return;
    }
    console.log(`Fitted quota cost per 100k effective tokens, from ${obs.length} windows:\n`);
    const base = Math.min(...w.filter((x) => x > 0));
    for (let i = 0; i < models.length; i++) {
      const rel = base > 0 ? (w[i] / base).toFixed(2) + "x" : "n/a";
      console.log("  " + models[i].padEnd(30) + w[i].toFixed(3).padStart(9) + " pts/100k" + rel.padStart(9));
    }
    // Residuals: how well the linear model explains the readings.
    const pred = A.map((row) => row.reduce((s, x, i) => s + x * w[i], 0));
    const ss = b.reduce((s, y, i) => s + (y - pred[i]) ** 2, 0);
    const mean = b.reduce((s, y) => s + y, 0) / b.length;
    const tot = b.reduce((s, y) => s + (y - mean) ** 2, 0);
    console.log(`\n  R² ${tot > 0 ? (1 - ss / tot).toFixed(3) : "n/a"} over ${obs.length} observations`);
    if (obs.length < 5) console.log("  Treat as indicative until you have 5 or more windows.");
    return;
  }

  console.log(`QuotaCove quota probe

  tokens  [--since 5h] [--until now]        what the transcripts say you used
  record  --start N --end N [--note "..."]  log a window with both /usage reads
  fit                                        estimate the per-model weights

Times accept a relative age ("5h", "90m", "2d") or an ISO timestamp. The window
defaults to everything since your last record, so consecutive windows need no
timestamps at all.

Protocol, once per working block:
  1. /usage in Claude Code  ->  note the percentage.
  2. Work. To isolate one model, stay on it for the whole block.
  3. /usage again  ->  note the percentage.
  4. node eval/quota-probe.mjs record --start 4 --end 61 --note "opus only"
  5. Repeat. Vary which model you lean on, or the fit cannot separate them.
  6. node eval/quota-probe.mjs fit   (meaningful from about five windows)`);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
