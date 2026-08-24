#!/usr/bin/env node
// QuotaCove — retrospective savings.
//
// Replays your own history through the router and reports what it would have
// changed. For every past turn it scores the prompt that produced it, works out
// the tier the router would have chosen, and reprices that turn's ACTUAL token
// counts at the cheaper model. No assumed token mix anywhere: the arithmetic
// runs on what each turn really cost.
//
//   node eval/what-if.mjs                    # all history
//   node eval/what-if.mjs --days 30          # recent window
//   node eval/what-if.mjs --by-month
//
// Prompt text is read in memory to score it and is never printed, stored, or
// transmitted. Only counts and totals leave this script.

import { readdirSync, statSync, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { analyze } from "../lib/score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(homedir(), ".claude", "projects");
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i === -1 ? d : argv[i + 1]; };
const DAYS = Number(flag("days", 0));
const BY_MONTH = argv.includes("--by-month");
const BY_PROJECT = argv.includes("--by-project");
const SINCE = DAYS ? Date.now() - DAYS * 864e5 : -Infinity;

// Live-catalogue prices ($/1M). Cache reads bill at about a tenth of input.
const PRICE = {
  economy: { in: 1, out: 5 },
  balanced: { in: 3, out: 15 },
  premium: { in: 5, out: 25 },
};
const CACHE_MULT = 0.1;
const TIER_OF_SCORE = { haiku: "economy", sonnet: "balanced", opus: "premium" };

// Which tier a model actually belongs to.
function tierOfModel(m) {
  const s = String(m).toLowerCase();
  if (s.includes("haiku")) return "economy";
  if (s.includes("sonnet")) return "balanced";
  if (s.includes("opus") || s.includes("fable") || s.includes("mythos")) return "premium";
  return null;
}

const costOf = (tier, t) =>
  (t.cacheRead * PRICE[tier].in * CACHE_MULT + (t.in + t.cacheWrite) * PRICE[tier].in + t.out * PRICE[tier].out) / 1e6;

function transcripts() {
  const out = [];
  (function walk(d) {
    let es;
    try { es = readdirSync(d); } catch { return; }
    for (const e of es) {
      const p = join(d, e);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) walk(p);
      else if (e.endsWith(".jsonl")) out.push(p);
    }
  })(ROOT);
  return out;
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
  return "";
};

const stats = {
  turns: 0, scored: 0, skipped: 0,
  actual: 0, routed: 0,
  byTier: { economy: 0, balanced: 0, premium: 0 },
  fromTo: {},
  periods: {},
  projects: {},
};

for (const f of transcripts()) {
  try { if (statSync(f).mtimeMs < SINCE) continue; } catch { continue; }
  // The folder under ~/.claude/projects encodes the working directory, so one
  // run covers every project on the machine, not just the one you cd'd into.
  const project = (f.split("/projects/")[1] ?? "").split("/")[0] || "(unknown)";
  const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
  let lastPrompt = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const m = j.message;
    if (!m) continue;

    if (m.role === "user") {
      const t = textOf(m.content).trim();
      // Tool results and command chatter are not prompts a user typed.
      if (t && !t.startsWith("/") && !t.startsWith("<") && t.length > 8) lastPrompt = t;
      continue;
    }
    if (m.role !== "assistant" || !m.usage) continue;

    const ts = Date.parse(j.timestamp ?? "");
    if (!Number.isNaN(ts) && ts < SINCE) continue;

    const actualTier = tierOfModel(m.model);
    if (!actualTier) { stats.skipped++; continue; }

    stats.turns++;
    const u = m.usage;
    const tok = {
      in: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      out: u.output_tokens ?? 0,
    };

    // Without the originating prompt the router has nothing to score, so the
    // turn is counted at its actual cost on both sides rather than guessed at.
    const wantTier = lastPrompt ? TIER_OF_SCORE[analyze(lastPrompt).tier] : actualTier;
    if (lastPrompt) stats.scored++;

    // The router never sends work UP: the ceiling is whatever you were using.
    const rank = { economy: 0, balanced: 1, premium: 2 };
    const finalTier = rank[wantTier] > rank[actualTier] ? actualTier : wantTier;

    const a = costOf(actualTier, tok);
    const r = costOf(finalTier, tok);
    stats.actual += a;
    stats.routed += r;
    stats.byTier[finalTier]++;
    const key = `${actualTier}→${finalTier}`;
    stats.fromTo[key] = (stats.fromTo[key] ?? 0) + 1;

    if (BY_PROJECT) {
      stats.projects[project] ??= { turns: 0, actual: 0, routed: 0 };
      stats.projects[project].turns++;
      stats.projects[project].actual += a;
      stats.projects[project].routed += r;
    }

    if (BY_MONTH && !Number.isNaN(ts)) {
      const p = new Date(ts).toISOString().slice(0, 7);
      stats.periods[p] ??= { turns: 0, actual: 0, routed: 0 };
      stats.periods[p].turns++;
      stats.periods[p].actual += a;
      stats.periods[p].routed += r;
    }
  }
}

const money = (n) => "$" + n.toFixed(2);
const saved = stats.actual - stats.routed;
const pctSaved = stats.actual > 0 ? (saved / stats.actual) * 100 : 0;

console.log(`QuotaCove — what routing would have done${DAYS ? ` (last ${DAYS} days)` : ""}\n`);
console.log(`  Turns replayed        ${stats.turns.toLocaleString()}  (${stats.scored.toLocaleString()} with a scoreable prompt)`);
console.log(`  Actual spend          ${money(stats.actual)}`);
console.log(`  Routed spend          ${money(stats.routed)}`);
console.log(`  Would have saved      ${money(saved)}   ${pctSaved.toFixed(1)}%`);

console.log("\n  Where turns would have gone:");
for (const [k, v] of Object.entries(stats.fromTo).sort((a, b) => b[1] - a[1])) {
  const moved = k.split("→")[0] !== k.split("→")[1];
  console.log(`    ${k.padEnd(22)} ${String(v).padStart(7)}${moved ? "   moved" : ""}`);
}

if (BY_MONTH) {
  console.log("\n  By month:");
  console.log("    " + "month".padEnd(10) + "turns".padStart(9) + "actual".padStart(12) + "routed".padStart(12) + "saved".padStart(12));
  for (const [p, v] of Object.entries(stats.periods).sort()) {
    console.log("    " + p.padEnd(10) + String(v.turns).padStart(9) + money(v.actual).padStart(12) + money(v.routed).padStart(12) + money(v.actual - v.routed).padStart(12));
  }
}

if (BY_PROJECT) {
  const rows = Object.entries(stats.projects).sort((a, b) => (b[1].actual - b[1].routed) - (a[1].actual - a[1].routed));
  console.log(`\n  By project (${rows.length} projects on this machine):`);
  console.log("    " + "project".padEnd(40) + "turns".padStart(9) + "actual".padStart(12) + "saved".padStart(12));
  for (const [p, v] of rows.slice(0, 20)) {
    console.log("    " + p.replace(/^-Users-bradd-?/, "").slice(0, 39).padEnd(40) + String(v.turns).padStart(9) + money(v.actual).padStart(12) + money(v.actual - v.routed).padStart(12));
  }
  if (rows.length > 20) console.log(`    … and ${rows.length - 20} more`);
}

console.log(`
  Read this as an upper bound. It reprices each turn's real tokens at a cheaper
  model, but a cheaper model sometimes answers at a different length, and a bad
  downgrade can cost a retry that this arithmetic never sees. Prices are list
  rates; a subscription shows the same effect as usage-window headroom instead.`);
