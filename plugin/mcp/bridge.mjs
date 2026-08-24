#!/usr/bin/env node
// QuotaCove — cross-provider bridge (MCP server, stdio).
//
// Claude Code can only switch between Claude models. This server adds the rest:
// it sends a single prompt to another vendor using the user's own API keys, and
// reads a live model catalogue so tier choices never go stale.
//
// Coverage comes from three layers:
//   1. OpenRouter  — one key, 400+ models across every major vendor
//   2. Direct      — a dozen first-party endpoints, no aggregator fee
//   3. Custom      — any other OpenAI-compatible endpoint, including local
//                    runtimes (Ollama, LM Studio, vLLM), via one env var
//
// Keys come from the environment and are never logged or persisted.
// Zero dependencies: raw JSON-RPC over stdio, global fetch (Node 18+).

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 10 * 60 * 1000;

// Anything speaking POST /chat/completions with a Bearer key is one row here.
// Model ids drift as vendors ship new versions: `prefer` is a best-effort
// starting point, and callers can always pass an explicit `model`.
const BUILTIN = {
  openrouter: {
    label: "OpenRouter", envKey: "OPENROUTER_API_KEY", kind: "openai",
    url: "https://openrouter.ai/api/v1/chat/completions", aggregator: true,
    prefer: {
      economy: ["google/gemini-3.7-flash", "openai/gpt-5.6-luna", "anthropic/claude-haiku-4.5"],
      balanced: ["anthropic/claude-sonnet-5", "openai/gpt-5.6-luna-pro", "x-ai/grok-4.6"],
      premium: ["anthropic/claude-opus-5", "openai/gpt-5-pro", "x-ai/grok-4.6"],
    },
  },
  openai: {
    label: "OpenAI", envKey: "OPENAI_API_KEY", kind: "openai",
    url: "https://api.openai.com/v1/chat/completions",
    prefer: { economy: ["gpt-5-mini"], balanced: ["gpt-5"], premium: ["gpt-5-pro"] },
  },
  anthropic: {
    label: "Anthropic", envKey: "ANTHROPIC_API_KEY", kind: "openai",
    url: "https://api.anthropic.com/v1/chat/completions",
    note: "In Claude Code, prefer native subagent model overrides; this is for parity in other hosts.",
    prefer: { economy: ["claude-haiku-4-5"], balanced: ["claude-sonnet-5"], premium: ["claude-opus-5"] },
  },
  xai: {
    label: "xAI (Grok)", envKey: "XAI_API_KEY", kind: "openai",
    url: "https://api.x.ai/v1/chat/completions",
    prefer: { economy: ["grok-4.1-fast"], balanced: ["grok-4.5"], premium: ["grok-4.6"] },
  },
  google: {
    label: "Google (Gemini)", envKey: "GEMINI_API_KEY", kind: "gemini",
    prefer: { economy: ["gemini-flash-lite"], balanced: ["gemini-flash"], premium: ["gemini-pro"] },
  },
  groq: {
    label: "Groq", envKey: "GROQ_API_KEY", kind: "openai",
    url: "https://api.groq.com/openai/v1/chat/completions",
    note: "Very fast open-weight hosting (Llama, Mixtral).",
    prefer: { economy: ["llama-3.1-8b-instant"], balanced: ["llama-3.3-70b-versatile"], premium: ["llama-3.3-70b-versatile"] },
  },
  together: {
    label: "Together", envKey: "TOGETHER_API_KEY", kind: "openai",
    url: "https://api.together.xyz/v1/chat/completions",
    note: "Broad open-weight catalogue (Llama, Qwen, Mistral).",
    prefer: {
      economy: ["meta-llama/Llama-3.2-3B-Instruct-Turbo"],
      balanced: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
      premium: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
    },
  },
  deepseek: {
    label: "DeepSeek", envKey: "DEEPSEEK_API_KEY", kind: "openai",
    url: "https://api.deepseek.com/v1/chat/completions",
    prefer: { economy: ["deepseek-chat"], balanced: ["deepseek-chat"], premium: ["deepseek-reasoner"] },
  },
  mistral: {
    label: "Mistral", envKey: "MISTRAL_API_KEY", kind: "openai",
    url: "https://api.mistral.ai/v1/chat/completions",
    prefer: { economy: ["mistral-small-latest"], balanced: ["mistral-medium-latest"], premium: ["mistral-large-latest"] },
  },
  fireworks: {
    label: "Fireworks", envKey: "FIREWORKS_API_KEY", kind: "openai",
    url: "https://api.fireworks.ai/inference/v1/chat/completions",
    prefer: {
      economy: ["accounts/fireworks/models/llama-v3p1-8b-instruct"],
      balanced: ["accounts/fireworks/models/llama-v3p3-70b-instruct"],
      premium: ["accounts/fireworks/models/llama-v3p3-70b-instruct"],
    },
  },
  cerebras: {
    label: "Cerebras", envKey: "CEREBRAS_API_KEY", kind: "openai",
    url: "https://api.cerebras.ai/v1/chat/completions",
    prefer: { economy: ["llama3.1-8b"], balanced: ["llama-3.3-70b"], premium: ["llama-3.3-70b"] },
  },
  deepinfra: {
    label: "DeepInfra", envKey: "DEEPINFRA_API_KEY", kind: "openai",
    url: "https://api.deepinfra.com/v1/openai/chat/completions",
    prefer: {
      economy: ["meta-llama/Meta-Llama-3.1-8B-Instruct"],
      balanced: ["meta-llama/Llama-3.3-70B-Instruct"],
      premium: ["meta-llama/Llama-3.3-70B-Instruct"],
    },
  },
  perplexity: {
    label: "Perplexity", envKey: "PERPLEXITY_API_KEY", kind: "openai",
    url: "https://api.perplexity.ai/chat/completions",
    note: "Answers are web-grounded; good for questions needing current sources.",
    prefer: { economy: ["sonar"], balanced: ["sonar-pro"], premium: ["sonar-reasoning-pro"] },
  },
};

// Anything else the user wants, including local runtimes. One env var:
//   QUOTACOVE_EXTRA_PROVIDERS='[{"id":"ollama","label":"Local Ollama",
//     "url":"http://localhost:11434/v1/chat/completions","noAuth":true,
//     "prefer":{"economy":"llama3.2","balanced":"llama3.3","premium":"llama3.3"}}]'
function loadExtras() {
  const raw = process.env.QUOTACOVE_EXTRA_PROVIDERS;
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // stderr only — stdout carries JSON-RPC and must not be polluted.
    process.stderr.write("[quotacove] QUOTACOVE_EXTRA_PROVIDERS is not valid JSON; ignoring.\n");
    return {};
  }
  const out = {};
  for (const p of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!p?.id || !p?.url) {
      process.stderr.write("[quotacove] extra provider skipped: needs at least id and url.\n");
      continue;
    }
    const prefer = {};
    for (const tier of ["economy", "balanced", "premium"]) {
      const v = p.prefer?.[tier];
      prefer[tier] = Array.isArray(v) ? v : v ? [v] : [];
    }
    out[p.id] = {
      label: p.label ?? p.id,
      envKey: p.envKey ?? `${p.id.toUpperCase()}_API_KEY`,
      kind: "openai",
      url: p.url,
      noAuth: p.noAuth === true,
      custom: true,
      note: p.note,
      prefer,
    };
  }
  return out;
}

const PROVIDERS = { ...BUILTIN, ...loadExtras() };
const IDS = Object.keys(PROVIDERS);
const hasKey = (p) => PROVIDERS[p].noAuth === true || Boolean(process.env[PROVIDERS[p].envKey]);

// ---- live catalogue (public endpoint, no key required) ----
let catalogCache = { at: 0, models: null };

async function catalog() {
  if (catalogCache.models && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models;
  const res = await fetch(CATALOG_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Model catalogue unavailable (HTTP ${res.status}).`);
  const json = await res.json();
  const models = (json.data ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    context: m.context_length ?? null,
    inPerM: m.pricing?.prompt != null ? +m.pricing.prompt * 1e6 : null,
    outPerM: m.pricing?.completion != null ? +m.pricing.completion * 1e6 : null,
  }));
  catalogCache = { at: Date.now(), models };
  return models;
}

// Blended per-request cost for ranking, on a nominal 600-in/700-out turn.
// The catalogue reports -1 for dynamically priced meta-routers; those must not
// rank as "cheaper than free", so any negative or missing price sorts last.
const blended = (m) => {
  if (m.inPerM == null || m.outPerM == null) return Infinity;
  if (m.inPerM < 0 || m.outPerM < 0) return Infinity;
  return (m.inPerM * 600 + m.outPerM * 700) / 1e6;
};

async function resolveModel(provider, tier, explicit) {
  if (explicit) return explicit;
  const prefs = PROVIDERS[provider].prefer?.[tier] ?? [];
  if (provider !== "openrouter") return prefs[0];
  try {
    const ids = new Set((await catalog()).map((m) => m.id));
    const hit = prefs.find((p) => ids.has(p));
    if (hit) return hit;
  } catch {
    /* catalogue down: fall back to first preference */
  }
  return prefs[0];
}

// ---- callers ----
async function callOpenAICompatible(provider, model, prompt, effort) {
  const conf = PROVIDERS[provider];
  const body = { model, messages: [{ role: "user", content: prompt }] };
  if (effort && effort !== "standard") body.reasoning_effort = effort === "extended" ? "high" : "low";

  const headers = { "content-type": "application/json" };
  if (!conf.noAuth) headers.authorization = `Bearer ${process.env[conf.envKey]}`;
  if (provider === "openrouter") Object.assign(headers, { "HTTP-Referer": "https://github.com/", "X-Title": "QuotaCove" });

  const res = await fetch(conf.url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // Model ids drift between vendor releases; make that failure actionable.
    const hint =
      res.status === 404 || res.status === 400
        ? ` — "${model}" may not exist on ${conf.label} any more. Call search_models or pass an explicit model id.`
        : "";
    throw new Error(`${conf.label} ${res.status}: ${detail}${hint}`);
  }
  const json = await res.json();
  return { text: json.choices?.[0]?.message?.content ?? "", usage: json.usage ?? null };
}

async function callGemini(model, prompt) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return {
    text: (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(""),
    usage: json.usageMetadata ?? null,
  };
}

const TOOLS = [
  {
    name: "list_providers",
    description:
      "List every provider this bridge can reach and which are usable right now (key present in the environment). Call before ask_provider. OpenRouter is the broad one: a single key reaches 400+ models from every major vendor. Direct providers avoid the aggregator fee. Extra OpenAI-compatible endpoints, including local runtimes, can be added by the user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_models",
    description:
      "Search the live model catalogue (400+ models across OpenAI, Anthropic, Google, xAI/Grok, Meta/Llama, Mistral, DeepSeek and more) with current per-million prices. Needs no API key. Use to find the cheapest model that fits a job, check what a tier maps to today, or see what is new. Cheapest first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring match on model id or name, e.g. \"grok\", \"llama\", \"haiku\"." },
        max_price: { type: "number", description: "Only models at or below this blended dollar cost per typical request." },
        min_context: { type: "number", description: "Only models with at least this context window." },
        limit: { type: "number", description: "How many to return (default 15, max 50)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ask_provider",
    description:
      "Send one self-contained prompt to a non-Claude provider and return its answer. Use to escalate a hard subtask to another vendor, run bulk cheap work on the lowest-cost model, or get a second opinion from a different model family. The prompt must stand alone: the other model sees no conversation history and cannot use your tools.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: IDS },
        tier: {
          type: "string",
          enum: ["economy", "balanced", "premium"],
          description: "Cheapest capable tier for this subtask. Never exceed the user's maxModel cap.",
        },
        prompt: { type: "string", description: "Self-contained prompt, including all context the model needs." },
        model: { type: "string", description: "Optional exact model id (from search_models) overriding the tier default." },
        effort: { type: "string", enum: ["minimal", "standard", "extended"], description: "Reasoning effort; OpenAI-compatible providers only." },
      },
      required: ["provider", "tier", "prompt"],
      additionalProperties: false,
    },
  },
];

async function runTool(name, args) {
  if (name === "list_providers") {
    const rows = IDS.map((key) => {
      const c = PROVIDERS[key];
      return {
        provider: key,
        label: c.label,
        available: hasKey(key),
        kind: c.aggregator ? "aggregator" : c.custom ? "custom" : "direct",
        note: c.note,
        reason: hasKey(key) ? undefined : `set ${c.envKey} to enable`,
      };
    });
    const usable = rows.filter((r) => r.available);
    return {
      summary: usable.length
        ? `${usable.length} of ${rows.length} providers ready: ${usable.map((r) => r.provider).join(", ")}. Claude models stay reachable through native session and subagent model settings.`
        : `No providers configured yet. OPENROUTER_API_KEY gives the widest reach in one step; direct keys avoid the aggregator fee. search_models works with no key at all.`,
      add_your_own:
        "Any other OpenAI-compatible endpoint (including local Ollama, LM Studio or vLLM) can be added via the QUOTACOVE_EXTRA_PROVIDERS environment variable.",
      providers: rows,
    };
  }

  if (name === "search_models") {
    const { query, max_price, min_context, limit } = args ?? {};
    const all = await catalog();
    let list = all;
    if (query) {
      const q = String(query).toLowerCase();
      list = list.filter((m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q));
    }
    if (typeof min_context === "number") list = list.filter((m) => (m.context ?? 0) >= min_context);
    let ranked = list.filter((m) => Number.isFinite(blended(m))).sort((a, b) => blended(a) - blended(b));
    if (typeof max_price === "number") ranked = ranked.filter((m) => blended(m) <= max_price);
    const n = Math.min(Math.max(1, limit ?? 15), 50);
    return {
      total_catalog: all.length,
      matched: ranked.length,
      showing: Math.min(n, ranked.length),
      note: "Prices per 1M tokens, live from the provider catalogue. est_per_request assumes a 600-in/700-out turn.",
      models: ranked.slice(0, n).map((m) => ({
        id: m.id,
        name: m.name,
        context: m.context,
        // Source values carry float noise (0.049999…); round for display.
        in_per_1m: +m.inPerM.toFixed(4),
        out_per_1m: +m.outPerM.toFixed(4),
        est_per_request: +blended(m).toFixed(5),
      })),
    };
  }

  if (name === "ask_provider") {
    const { provider, tier, prompt, model, effort } = args ?? {};
    const conf = PROVIDERS[provider];
    if (!conf) throw new Error(`Unknown provider "${provider}". Known: ${IDS.join(", ")}.`);
    if (!hasKey(provider)) throw new Error(`${conf.label} is not configured — set ${conf.envKey} in your environment.`);
    if (!prompt || !String(prompt).trim()) throw new Error("prompt is required and must be non-empty.");

    const chosen = await resolveModel(provider, tier, model);
    if (!chosen)
      throw new Error(
        `No default model for tier "${tier}" on ${conf.label}. Pass an explicit model id — search_models lists current ones.`
      );

    const started = Date.now();
    const out =
      conf.kind === "gemini"
        ? await callGemini(chosen, prompt)
        : await callOpenAICompatible(provider, chosen, prompt, effort);
    return { provider, model: chosen, tier, elapsed_ms: Date.now() - started, usage: out.usage, answer: out.text };
  }

  throw new Error(`Unknown tool "${name}".`);
}

// ---- JSON-RPC over stdio ----
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  const raw = line.trim();
  if (!raw) return;

  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  if (req.id === undefined || req.id === null) return; // notification

  try {
    let result;
    if (req.method === "initialize") {
      result = {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "quotacove-bridge", version: "0.3.0" },
      };
    } else if (req.method === "tools/list") {
      result = { tools: TOOLS };
    } else if (req.method === "tools/call") {
      const payload = await runTool(req.params?.name, req.params?.arguments);
      result = { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    } else if (req.method === "ping") {
      result = {};
    } else {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
      return;
    }
    send({ jsonrpc: "2.0", id: req.id, result });
  } catch (err) {
    if (req.method === "tools/call") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] },
      });
    } else {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String(err?.message ?? err) } });
    }
  }
});
