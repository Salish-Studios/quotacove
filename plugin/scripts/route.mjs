#!/usr/bin/env node
// QuotaCove — UserPromptSubmit hook.
// Scores the prompt locally (nothing leaves the machine), suggests the cheapest
// capable model, respects the user's maxModel cap, and appends a savings log line.
// Must never block the prompt: every failure path exits 0 silently.

import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { analyze, capTier } from "../lib/score.mjs";

function safeExit() {
  process.exit(0);
}

let prompt = "";
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  prompt = String(input.prompt || "");
} catch {
  safeExit();
}

const words = prompt.trim() ? prompt.trim().split(/\s+/).length : 0;
// Skip slash commands, pastes of pure whitespace, and trivial prompts.
if (!prompt || prompt.trimStart().startsWith("/") || words < 3) safeExit();

// ---- config ----
// ~/.claude/quotacove.config.json
//   maxModel: "haiku" | "sonnet" | "opus"  — never suggest above this (default "opus")
//   quiet:    true  — log savings but inject no suggestions (default false)
//   log:      false — disable the savings log (default true)
const cfgPath = join(homedir(), ".claude", "quotacove.config.json");
let cfg = { maxModel: "opus", quiet: false, log: true };
try {
  cfg = { ...cfg, ...JSON.parse(readFileSync(cfgPath, "utf8")) };
} catch {
  /* no config file is fine */
}

// ---- scoring ----
// Lives in lib/score.mjs so the evaluation harness measures this exact code
// rather than a copy that can drift away from it.
const { score, tier: rawTier } = analyze(prompt);
const tier = capTier(rawTier, cfg.maxModel);
const capped = tier !== rawTier;

// Illustrative list prices ($/1M tokens in, out) and an assumed 600-in/700-out turn.
const PRICE = { haiku: [1, 5], sonnet: [3, 15], opus: [15, 75] };
const turnCost = (k) => (PRICE[k][0] * 600 + PRICE[k][1] * 700) / 1e6;
const savedVsPremium = +(turnCost("opus") - turnCost(tier)).toFixed(4);

if (cfg.log) {
  try {
    appendFileSync(
      join(homedir(), ".claude", "quotacove-savings.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), score, tier, capped, savedVsPremium }) + "\n"
    );
  } catch {
    /* logging is best-effort */
  }
}

if (cfg.quiet) safeExit();

const NAME = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };
let ctx;
if (capped) {
  // The work scored above the ceiling the user set. Respect the ceiling, but be
  // candid that this is a deliberate trade rather than an easy task.
  ctx =
    `[quotacove] complexity ${score}/100 — this scored above the user's maxModel cap (${cfg.maxModel}), ` +
    `so ${NAME[tier]} is the ceiling by their choice. Do the work on the current model without suggesting an upgrade. ` +
    `If you hit a wall that a stronger model would clear, say so plainly once, and leave the decision to them.`;
} else if (tier === "opus") {
  ctx = `[quotacove] complexity ${score}/100 — premium-tier work; the top model is warranted. No downgrade note needed.`;
} else {
  ctx =
    `[quotacove] complexity ${score}/100 — cheapest capable tier: ${NAME[tier]}. ` +
    `If this session is running a pricier model AND the task really is this simple, end your reply with one short line: ` +
    `"QuotaCove: this was ${NAME[tier]}-tier work — /model ${tier} would save credits on prompts like this." ` +
    `Skip that line if you've suggested it within the last few turns, if the task turned out harder than it looked, or if the user already switched.`;
}

console.log(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx },
  })
);
