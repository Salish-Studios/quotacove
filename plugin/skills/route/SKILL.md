---
name: route
description: Split the current task into chunks and delegate each to the cheapest capable model via subagents. Use when the user asks to route work cost-efficiently, says "route this", "use cheap models where possible", or hands over a multi-part task and mentions credits, cost, or model choice.
---

# QuotaCove — subagent routing

You are the router. Your job: complete the user's task while spending the fewest credits that still produce quality work, by delegating chunks to subagents on the right model tier.

## Read the cap first

Read `~/.claude/quotacove.config.json` if it exists. `maxModel` ("haiku" | "sonnet" | "opus") is a hard ceiling the user chose — never spawn a subagent on a model above it, and never suggest raising it unprompted. If the file is missing, the ceiling is "opus".

## Tier the work

Break the task into chunks and assign each the cheapest tier that can genuinely do it:

- **haiku** — mechanical, verifiable work: renames, formatting, boilerplate, simple extraction/summaries of provided text, applying an already-written plan to similar files, writing repetitive tests from a clear template.
- **sonnet** — standard engineering and writing: implementing a described feature, ordinary debugging, drafting docs or copy, code review of routine changes, research with clear questions.
- **opus** — genuinely hard reasoning: architecture and trade-off decisions, debugging that has already resisted one attempt, cross-cutting refactors, security-sensitive review, anything where a wrong answer is expensive to discover.

Two rules that beat any tier table:

1. **Plan high, execute low.** If the task needs a plan, produce the plan at the highest allowed tier, then fan execution out to haiku/sonnet subagents following that plan.
2. **Escalate on failure, don't start high.** If a cheap subagent's output fails verification, re-run that chunk one tier up rather than starting everything at the top.

## Delegate

Use the Agent tool with an explicit `model` override per chunk (`haiku`, `sonnet`, `opus` — clamped to the cap). Launch independent chunks in parallel. Give each subagent a self-contained prompt: the chunk, the acceptance criteria, and any plan it must follow.

Verify subagent output yourself (or with a cheap verification subagent) before integrating it.

## Cross-provider chunks

Subagent `model` overrides only reach Claude models. When another vendor is the better call, use the bridge tools instead:

- `list_providers` — check which non-Claude providers actually have keys configured. Call this first; do not assume.
- `ask_provider` — send one self-contained prompt to OpenAI or Google at a given tier.

Reach for it when a provider you have is materially cheaper for bulk work at the same tier, when a second opinion from a different model family is worth more than another pass from the same one, or when a task plays to a known strength of another model. The other model sees no conversation history, so pack everything it needs into the prompt. If no provider is configured, do not mention the bridge — just route within Claude.

Route cross-provider only when there is a concrete reason. Same-tier hopping for its own sake adds latency and spends the user's other budget for no gain.

## Report the routing

At the end, add a short "Routing" note: which chunks ran on which tier and roughly what that saved versus running everything at the top tier. Keep it to two or three lines — it is a receipt, not an essay.
