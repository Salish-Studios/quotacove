#!/usr/bin/env node
// QuotaCove — catalogue sync.
//
// Pulls the live model catalogue, diffs it against the stored snapshot, and
// reports what changed: models added or retired, price moves, context changes.
// Designed to run on a schedule (GitHub Action, pg_cron, plain crontab).
//
//   node cron/sync-catalog.mjs              # diff and report, write snapshot
//   node cron/sync-catalog.mjs --dry-run    # diff and report, leave snapshot alone
//   node cron/sync-catalog.mjs --json       # machine-readable report on stdout
//
// OpenRouter's catalogue is public and needs no key, and it carries the same
// models the direct providers sell, so one fetch covers pricing for every
// vendor. Direct provider endpoints are additionally probed when keys exist,
// since a vendor occasionally ships a model before the aggregator lists it.
//
// Exit codes: 0 = no changes, 10 = changes found, 1 = error.
// (10 lets a scheduler branch on "something moved" without parsing output.)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, "..", "data", "catalog-snapshot.json");
const CATALOG_URL = "https://openrouter.ai/api/v1/models";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const JSON_OUT = args.has("--json");

// Direct provider model-list endpoints, probed only when a key is present.
const DIRECT = [
  { id: "openai", env: "OPENAI_API_KEY", url: "https://api.openai.com/v1/models" },
  { id: "xai", env: "XAI_API_KEY", url: "https://api.x.ai/v1/models" },
  { id: "groq", env: "GROQ_API_KEY", url: "https://api.groq.com/openai/v1/models" },
  { id: "mistral", env: "MISTRAL_API_KEY", url: "https://api.mistral.ai/v1/models" },
  { id: "deepseek", env: "DEEPSEEK_API_KEY", url: "https://api.deepseek.com/v1/models" },
  { id: "together", env: "TOGETHER_API_KEY", url: "https://api.together.xyz/v1/models" },
];

const num = (v) => (v == null ? null : Number(v));

async function fetchCatalog() {
  const res = await fetch(CATALOG_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`catalogue HTTP ${res.status}`);
  const json = await res.json();
  const out = {};
  for (const m of json.data ?? []) {
    const inP = num(m.pricing?.prompt);
    const outP = num(m.pricing?.completion);
    out[m.id] = {
      name: m.name ?? m.id,
      // Negative means dynamically priced (meta-routers); store as null so it
      // never looks like a price cut on the next diff.
      in_per_1m: inP != null && inP >= 0 ? +(inP * 1e6).toFixed(4) : null,
      out_per_1m: outP != null && outP >= 0 ? +(outP * 1e6).toFixed(4) : null,
      context: m.context_length ?? null,
    };
  }
  return out;
}

async function probeDirect() {
  const seen = {};
  for (const p of DIRECT) {
    if (!process.env[p.env]) continue;
    try {
      const res = await fetch(p.url, { headers: { authorization: `Bearer ${process.env[p.env]}` } });
      if (!res.ok) {
        seen[p.id] = { error: `HTTP ${res.status}` };
        continue;
      }
      const json = await res.json();
      const ids = (json.data ?? []).map((m) => m.id).filter(Boolean).sort();
      seen[p.id] = { count: ids.length, models: ids };
    } catch (err) {
      seen[p.id] = { error: String(err?.message ?? err) };
    }
  }
  return seen;
}

function loadSnapshot() {
  try {
    return JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  } catch {
    return null;
  }
}

// A price move under this fraction is float noise, not a repricing.
const MOVE_EPS = 0.005;
const moved = (a, b) => {
  if (a == null || b == null) return a !== b;
  if (a === 0 && b === 0) return false;
  const base = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / base > MOVE_EPS;
};

function diff(prev, next) {
  const added = [];
  const removed = [];
  const repriced = [];
  const recontexted = [];

  for (const id of Object.keys(next)) {
    if (!prev[id]) {
      added.push({ id, ...next[id] });
      continue;
    }
    const a = prev[id];
    const b = next[id];
    if (moved(a.in_per_1m, b.in_per_1m) || moved(a.out_per_1m, b.out_per_1m)) {
      repriced.push({
        id,
        in: [a.in_per_1m, b.in_per_1m],
        out: [a.out_per_1m, b.out_per_1m],
        direction:
          (b.in_per_1m ?? 0) + (b.out_per_1m ?? 0) < (a.in_per_1m ?? 0) + (a.out_per_1m ?? 0) ? "cheaper" : "dearer",
      });
    }
    if (a.context !== b.context) recontexted.push({ id, from: a.context, to: b.context });
  }
  for (const id of Object.keys(prev)) if (!next[id]) removed.push({ id, ...prev[id] });

  return { added, removed, repriced, recontexted };
}

function render(d, total, direct) {
  const L = [];
  L.push(`QuotaCove catalogue sync — ${total} models live`);
  const none = !d.added.length && !d.removed.length && !d.repriced.length && !d.recontexted.length;
  if (none) L.push("No changes since the last sync.");

  if (d.added.length) {
    L.push("", `NEW (${d.added.length}) — needs routing guidance before the router will pick it:`);
    for (const m of d.added.slice(0, 25)) {
      const price = m.in_per_1m == null ? "dynamic pricing" : `$${m.in_per_1m}/$${m.out_per_1m} per 1M`;
      L.push(`  + ${m.id} — ${price}`);
    }
    if (d.added.length > 25) L.push(`  … and ${d.added.length - 25} more (full list in the JSON report)`);
  }
  if (d.removed.length) {
    L.push("", `RETIRED (${d.removed.length}) — check tier defaults do not still point at these:`);
    for (const m of d.removed.slice(0, 25)) L.push(`  - ${m.id}`);
    if (d.removed.length > 25) L.push(`  … and ${d.removed.length - 25} more`);
  }
  if (d.repriced.length) {
    L.push("", `REPRICED (${d.repriced.length}):`);
    for (const m of d.repriced.slice(0, 25)) {
      L.push(`  ~ ${m.id} — in ${m.in[0]}→${m.in[1]}, out ${m.out[0]}→${m.out[1]} (${m.direction})`);
    }
    if (d.repriced.length > 25) L.push(`  … and ${d.repriced.length - 25} more`);
  }
  if (d.recontexted.length) {
    L.push("", `CONTEXT CHANGED (${d.recontexted.length}):`);
    for (const m of d.recontexted.slice(0, 15)) L.push(`  ~ ${m.id} — ${m.from} → ${m.to}`);
  }
  const probed = Object.keys(direct);
  if (probed.length) {
    L.push("", "Direct provider probes:");
    for (const id of probed) {
      const v = direct[id];
      L.push(v.error ? `  ${id}: ${v.error}` : `  ${id}: ${v.count} models listed`);
    }
  }
  return L.join("\n");
}

async function main() {
  const next = await fetchCatalog();
  const total = Object.keys(next).length;
  if (!total) throw new Error("catalogue returned zero models; refusing to overwrite the snapshot");

  const prev = loadSnapshot();
  const direct = await probeDirect();

  // First run has nothing to compare against — record the baseline, claim nothing.
  if (!prev) {
    if (!DRY) {
      mkdirSync(dirname(SNAPSHOT), { recursive: true });
      writeFileSync(SNAPSHOT, JSON.stringify({ fetched: new Date().toISOString(), models: next }, null, 2));
    }
    const msg = `QuotaCove catalogue sync — baseline recorded, ${total} models. Nothing to diff yet.`;
    console.log(JSON_OUT ? JSON.stringify({ baseline: true, total }, null, 2) : msg);
    process.exit(0);
  }

  const d = diff(prev.models ?? {}, next);
  const changed = d.added.length + d.removed.length + d.repriced.length + d.recontexted.length;

  if (!DRY) {
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify({ fetched: new Date().toISOString(), models: next }, null, 2));
  }

  console.log(
    JSON_OUT
      ? JSON.stringify({ total, since: prev.fetched, changed, ...d, direct }, null, 2)
      : render(d, total, direct)
  );
  process.exit(changed ? 10 : 0);
}

main().catch((err) => {
  console.error(`catalogue sync failed: ${err?.message ?? err}`);
  process.exit(1);
});
