---
name: savings
description: Report what model routing has saved, or would have saved, from this machine's own Claude Code history. Use when the user asks "how much am I saving", "what would this have saved me", "show my QuotaCove savings", or wants a usage or spend breakdown.
---

# QuotaCove — savings report

Two sources. The retrospective is almost always the better one.

## Preferred: replay the real history

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/what-if.mjs" --by-month
```

Also takes `--days 30` for a recent window and `--by-project` to split by
working directory. It reads local Claude Code transcripts, scores the prompt
behind each past turn, and reprices that turn's **actual** token counts at the
tier the router would have chosen. No assumed token mix enters the arithmetic,
and it never routes work upward — whatever model was in use is the ceiling.

It reads only model names and token counts. Prompt text is scored in memory and
is never printed, stored, or transmitted.

## Secondary: the live log

If the hook has been running with logging on, `~/.claude/quotacove-savings.jsonl`
holds one line per scored prompt:

```json
{"ts":"2026-08-24T18:02:11.000Z","score":18,"tier":"haiku","capped":false,"savedVsPremium":0.0525}
```

It only covers prompts seen since the hook was installed, so it is thinner than
the retrospective. Use it for the tier distribution of recent work, or when
transcripts are unavailable.

## Presenting it

Lead with the headline: total saved, and the percentage. Then whichever
breakdown was asked for — by month, by project, or by tier — as one compact
table.

State the caveats once, at the end, without softening them:

- Figures use list prices. On a subscription there is no invoice to shrink; the
  same effect shows up as usage-window headroom instead.
- It is an upper bound. It assumes a cheaper model answers in the same number of
  tokens, and a bad downgrade can cost a retry the arithmetic never sees.
- If many turns were capped by `maxModel`, say so — quality on those may have varied.

If a figure looks implausibly large, check whether cache-read tokens dominate the
total before repeating it. On long sessions they usually do, and that is worth
telling the user directly: their spend is being driven by context size more than
by model choice, and compacting sessions may save more than routing does.
