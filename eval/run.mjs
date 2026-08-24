#!/usr/bin/env node
// QuotaCove — routing evaluation.
//
// Runs the shipped scorer against a hand-labelled set and reports how often it
// picks the right tier. The headline number is not overall accuracy: it is the
// FALSE DOWNGRADE rate, where the router sends work to a model too weak for it.
// That is the failure users feel — a wrong answer, a retry, lost trust — and
// it is the one that must stay near zero for the tool to be worth running.
//
// A false upgrade (routing simple work to an expensive model) only costs money,
// which is the failure this tool exists to reduce but is not dangerous.
//
//   node eval/run.mjs            # summary
//   node eval/run.mjs --misses   # summary plus every miscall
//   node eval/run.mjs --json     # machine-readable

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, TIERS } from "../plugin/lib/score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

const rows = readFileSync(join(HERE, "prompts.jsonl"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const rank = (t) => TIERS.indexOf(t);

const results = rows.map((r) => {
  const a = analyze(r.prompt);
  const delta = rank(a.tier) - rank(r.label);
  return {
    prompt: r.prompt,
    expected: r.label,
    got: a.tier,
    score: a.score,
    words: a.words,
    hits: a.hits,
    correct: delta === 0,
    // Negative delta = routed cheaper than the work needed = false downgrade.
    downgrade: delta < 0,
    upgrade: delta > 0,
    severity: Math.abs(delta),
  };
});

const n = results.length;
const correct = results.filter((r) => r.correct).length;
const downgrades = results.filter((r) => r.downgrade);
const upgrades = results.filter((r) => r.upgrade);
const severe = downgrades.filter((r) => r.severity > 1); // opus work sent to haiku

const pct = (x) => ((x / n) * 100).toFixed(1) + "%";

// Confusion matrix, expected (rows) against predicted (columns).
const matrix = {};
for (const e of TIERS) {
  matrix[e] = {};
  for (const g of TIERS) matrix[e][g] = 0;
}
for (const r of results) matrix[r.expected][r.got]++;

// Per-tier recall: of the prompts that truly needed this tier, how many got it.
const recall = {};
for (const t of TIERS) {
  const total = results.filter((r) => r.expected === t).length;
  const hit = results.filter((r) => r.expected === t && r.got === t).length;
  recall[t] = { total, hit, pct: total ? ((hit / total) * 100).toFixed(0) + "%" : "n/a" };
}

if (args.has("--json")) {
  console.log(JSON.stringify({ n, correct, downgrades: downgrades.length, upgrades: upgrades.length, severe: severe.length, matrix, recall, results }, null, 2));
  process.exit(downgrades.length ? 1 : 0);
}

console.log(`QuotaCove routing eval — ${n} labelled prompts\n`);
console.log(`  Correct tier        ${correct}/${n}  ${pct(correct)}`);
console.log(`  False DOWNGRADE     ${downgrades.length}/${n}  ${pct(downgrades.length)}   <- the one that hurts`);
console.log(`     of those, severe  ${severe.length}  (needed opus, got haiku)`);
console.log(`  False upgrade       ${upgrades.length}/${n}  ${pct(upgrades.length)}   (costs money, not trust)`);

console.log("\n  Recall by tier (did work that needed this tier get it):");
for (const t of TIERS) console.log(`    ${t.padEnd(8)} ${recall[t].hit}/${recall[t].total}  ${recall[t].pct}`);

console.log("\n  Confusion (rows = needed, cols = routed):");
console.log("            " + TIERS.map((t) => t.padStart(8)).join(""));
for (const e of TIERS) {
  console.log("    " + e.padEnd(8) + TIERS.map((g) => String(matrix[e][g]).padStart(8)).join(""));
}

if (downgrades.length) {
  console.log("\n  FALSE DOWNGRADES:");
  for (const r of downgrades) {
    console.log(`    [${r.expected} -> ${r.got}] score ${String(r.score).padStart(3)} · ${r.words}w · ${r.prompt.slice(0, 62)}${r.prompt.length > 62 ? "…" : ""}`);
    console.log(`        signals: ${r.hits.join(", ") || "none"}`);
  }
}

if (args.has("--misses") && upgrades.length) {
  console.log("\n  FALSE UPGRADES:");
  for (const r of upgrades) {
    console.log(`    [${r.expected} -> ${r.got}] score ${String(r.score).padStart(3)} · ${r.words}w · ${r.prompt.slice(0, 62)}${r.prompt.length > 62 ? "…" : ""}`);
    console.log(`        signals: ${r.hits.join(", ") || "none"}`);
  }
}

process.exit(downgrades.length ? 1 : 0);
