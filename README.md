# QuotaCove

Get more out of the AI plan you already pay for.

Most people leave one model selected and use it for everything — architecture
decisions and commit messages alike. QuotaCove scores each prompt locally as you
type, tells you when you're about to spend a premium model on trivial work, and
routes delegated work to the cheapest tier that can actually do it.

On a subscription, that shows up as **more work before you hit your usage cap**.
On per-token billing, it shows up as a smaller bill.

Nothing leaves your machine. Scoring is a local heuristic — no network calls, no
telemetry, no account.

## Install

```
/plugin marketplace add Salish-Studios/quotacove
/plugin install quotacove@salish-tools
```

Restart your session so the hook registers. Requires Node 18+.

## What you get

**A prompt scorer that runs on every turn.** When the session is on a heavy model
and the task is clearly light, Claude adds one line suggesting the switch. It
never blocks a prompt — every failure path exits silently.

**A ceiling you set.** Optional `~/.claude/quotacove.config.json`:

```json
{
  "maxModel": "sonnet",
  "quiet": false,
  "log": true
}
```

- `maxModel` — never suggest or delegate above this (`haiku` | `sonnet` | `opus`). Default `opus`.
- `quiet` — keep logging, stop injecting suggestions. Default `false`.
- `log` — set `false` to disable the local savings log. Default `true`.

Above the cap, Claude is told to respect your ceiling and work within it, and to
mention a wall only once if it genuinely hits one.

**`/quotacove:route`** — splits a task and delegates chunks to cheap-model
subagents. Plan at the top tier, execute at the bottom, escalate only on failure.

**`/quotacove:savings`** — replays your own history and reports what routing
would have saved, by month or by project.

**Other providers, optionally.** An MCP bridge reaches OpenRouter (400+ models in
one key), OpenAI, Anthropic, xAI, Google, Groq, Together, DeepSeek, Mistral,
Fireworks, Cerebras, DeepInfra and Perplexity — plus any other OpenAI-compatible
endpoint, including local runtimes:

```bash
export OPENROUTER_API_KEY=...   # widest reach in one key
export OPENAI_API_KEY=...       # or connect directly, no aggregator fee
```

```bash
# anything else, including keyless local models
export QUOTACOVE_EXTRA_PROVIDERS='[{"id":"ollama","url":"http://localhost:11434/v1/chat/completions","noAuth":true,"prefer":{"balanced":"llama3.3"}}]'
```

With no keys set the bridge stays quiet and everything routes within Claude.
Keys are read from the environment only — never written to disk by this plugin.

## See what it would have saved you

```bash
node plugin/scripts/what-if.mjs --by-month
node plugin/scripts/what-if.mjs --by-project --days 30
```

Replays your local Claude Code history: scores the prompt behind each past turn
and reprices that turn's **actual** token counts at the tier the router would
have picked. No assumed token mix, and it never routes work upward. Reads model
names and token counts only; prompt text is scored in memory and never emitted.

## How good is the routing?

```bash
node eval/run.mjs --misses
```

Runs the shipped scorer against 71 hand-labelled prompts, weighted toward the
hard cases — terse-but-dangerous asks ("is this rate limiter thread safe") and
long pastes whose real request is trivial.

The metric that matters is the **false-downgrade rate**: work sent to a model too
weak for it. That is the failure you feel. A false upgrade only costs money.

**Current: 91.5% correct tier, 0% false downgrades.** The first version scored
35% with a **63% false-downgrade rate** — it routed security reviews to the
cheapest model, because it scored mostly on prompt length and real prompts are
short. Both fixes came out of this harness.

Caveat worth stating: the labels were written by the same author as the scorer,
so treat 91.5% as optimistic until it is validated against someone else's
prompts.

## Keeping the model catalogue current

```bash
node cron/sync-catalog.mjs            # diff and update the snapshot
node cron/sync-catalog.mjs --dry-run  # report only
```

Reports models added, retired, repriced, or resized, from the public catalogue —
no key required. Price wobbles under 0.5% are treated as float noise. Exit code
10 means something changed, so a scheduler can branch without parsing output.
`.github/workflows/catalog-sync.yml` runs it nightly and opens an issue.

## Honest limits

- The hook cannot change the session model itself — Claude Code picks the model
  before hooks run. It suggests; you switch. Real automatic switching happens at
  the subagent layer via `/quotacove:route`, and `/model opusplan` is built into
  Claude Code already.
- Subagent model overrides reach Claude models only. Other vendors go through the
  MCP bridge, which sends one self-contained prompt — the other model gets no
  conversation history and cannot use your tools.
- Savings figures use list prices. On a subscription there is no bill to shrink;
  the same effect appears as usage-window headroom.
- **Routing only helps against a premium baseline.** If you already default to a
  mid-tier model, expect little or nothing.
- Most spend is usually not the prompt. On long sessions, re-read context dwarfs
  everything typed or generated, so session length can matter more than model
  choice. Compacting may save more than routing does.

## Licence

MIT. Built by [Salish Studios](https://github.com/Salish-Studios).
