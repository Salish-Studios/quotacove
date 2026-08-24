// QuotaCove — prompt scoring.
//
// Shared by the UserPromptSubmit hook and the evaluation harness, so what the
// eval measures is exactly what runs in a session. Pure and dependency-free:
// nothing here touches the network, the filesystem, or the environment.
//
// Design, learned the hard way from eval/run.mjs:
//
// 1. Default to the MIDDLE tier. The first version started every prompt near
//    zero and climbed with length, which meant terse-but-hard prompts ("is this
//    rate limiter thread safe") scored 6/100 and got routed to the cheapest
//    model. False-downgrade rate was 63%. Unknown work now starts at sonnet and
//    must earn its way down.
//
// 2. Downgrades need positive evidence. Only explicit triviality — formatting,
//    spelling, translation, a bare definition — pulls a prompt to the cheap
//    tier. Absence of scary words is not evidence that a task is easy.
//
// 3. Stakes outrank length. A seven-word security question outranks a
//    two-hundred-word paste of meeting notes. Length is a weak tiebreak, not a
//    driver, because real prompts are short.

export const TIERS = ["haiku", "sonnet", "opus"];

const BASE = 45; // unknown work sits in sonnet territory

// Evidence the task is genuinely mechanical. Large negative weights: these are
// the only things allowed to reach the cheapest tier.
export const TRIVIAL = [
  { re: /\b(typos?|spell(ing)?|grammar|proofread|punctuation)\b/i, w: -30, label: "proofreading" },
  { re: /\b(format|reformat|indent|capitali[sz]e|title case|lower ?case|upper ?case|tidy up)\b/i, w: -28, label: "formatting" },
  { re: /\b(translate|convert (this|these|it) (in)?to|change these .* to)\b/i, w: -26, label: "conversion" },
  { re: /\b(what (is|are|does|do)|who (is|was)|when (is|was)|define|meaning of|stand for|how do you spell)\b/i, w: -26, label: "lookup" },
  { re: /\b(summar(y|ize|ise)|tl;?dr|shorten|condense|two lines|one line)\b/i, w: -22, label: "summarise" },
  { re: /\b(sort|alphabeti[sz]e|extract|pull out|list (them|these|the)|deduplicate)\b/i, w: -20, label: "extraction" },
  { re: /\b(rename|commit message|add a comment|boilerplate|log line)\b/i, w: -22, label: "trivial edit" },
  { re: /\b(bullet points?|into a paragraph|markdown table)\b/i, w: -18, label: "restructure text" },
];

// Evidence the task carries real risk or difficulty. These outrank everything.
export const STAKES = [
  { re: /\b(secure|security|safe|unsafe|vulnerab|exploit|injection|xss|csrf|audit|encrypt|decrypt|hash(ing)?|credential|isolation|leak|auth[a-z]*|permission)\b/i, w: 30, label: "security" },
  { re: /\b(deadlock|race condition|thread[- ]?safe|concurren|atomic|mutex|lock(ing)?|synchroni[sz]|parallel)\b/i, w: 30, label: "concurrency" },
  { re: /\b(lose data|data loss|partial failure|consistency|idempoten|duplicate|double[- ]?charg|exactly once|transaction)\b/i, w: 28, label: "data integrity" },
  { re: /\b(scale|scaling|throughput|latency|p9[59]|bottleneck|optimi[sz]|million|billion|performance)\b/i, w: 24, label: "scale" },
  { re: /\b(architect|architecture|design (a|an|the|our|my)|schema|strategy|trade[- ]?offs?|end[- ]to[- ]end|from scratch|multi[- ]tenant|retry|backoff)\b/i, w: 26, label: "system design" },
  { re: /\b(migrat|zero[- ]downtime|cutover|rollout|rollback)\b/i, w: 22, label: "migration" },
  { re: /\b(prove|proof|theorem|derive|complexity|algorithm|invariant)\b/i, w: 26, label: "formal reasoning" },
  { re: /\b(analy[sz]e|evaluate|assess|investigate|root cause|figure out|walk (me )?through|what could|why (does|is|am|are)|reason about)\b/i, w: 20, label: "diagnosis" },
  { re: /\b(review|audit|check .* for|find the|what is wrong|whats wrong)\b/i, w: 20, label: "review" },
  { re: /\b(plan|planning|roadmap|scope out|orchestrate|step[- ]by[- ]step)\b/i, w: 18, label: "planning" },
  { re: /\b(edge cases?|corner cases?|failure modes?|intermittent|flaky|under load|never reproduce)\b/i, w: 22, label: "edge cases" },
  { re: /\b(should we|which should|better approach|pros and cons|justify)\b/i, w: 18, label: "judgement call" },
];

// Ordinary construction work. Nudges only — these belong in the middle tier and
// the base already puts them there.
export const BUILD = [
  { re: /\b(write|implement|add|create|build|draft|generate|set up|configure)\b/i, w: 3, label: "build" },
  { re: /\b(function|component|endpoint|api|script|regex|sql|query|test|dockerfile|hook|schema)\b/i, w: 3, label: "code" },
  { re: /\b(refactor|debug|fix|update|convert|document)\b/i, w: 4, label: "modify" },
  { re: /\b(explain|describe|how does|difference between|compare)\b/i, w: 4, label: "explanation" },
];

// Tasks that are mechanical no matter what they are about. Writing a commit
// message for security code is still writing a commit message: the TASK sets
// the tier, the SUBJECT does not. These short-circuit the stakes signals, which
// would otherwise catch the subject matter and route trivial work to the top.
export const DEFINITIVE = [
  { re: /\b(commit message|proofread|fix (the )?typos?|spell ?check)\b/i, label: "definitively trivial" },
  { re: /\b(reformat|format (this|these|it)|capitali[sz]e|title case|indent)\b/i, label: "definitively trivial" },
  { re: /\b(translate (this|these|it)|sort (these|them|this)|alphabeti[sz]e)\b/i, label: "definitively trivial" },
];

// Signals should read the instruction, not the material pasted with it. In a
// long prompt the ask sits at one end and the context fills the middle, so
// scanning both ends keeps "our staging is flaky" in someone's meeting notes
// from reading as a production incident.
const WINDOW = 40;
function instructionOf(text) {
  const w = text.split(/\s+/);
  if (w.length <= WINDOW * 2) return text;
  return w.slice(0, WINDOW).join(" ") + "\n" + w.slice(-WINDOW).join(" ");
}

export function analyze(prompt) {
  const t = String(prompt ?? "").trim();
  const words = t ? t.split(/\s+/).length : 0;
  if (!words) return { score: 0, tier: "haiku", words, hits: [] };

  const instruction = instructionOf(t);

  for (const d of DEFINITIVE) {
    if (d.re.test(instruction)) {
      return { score: 10, tier: "haiku", words, hits: [d.label] };
    }
  }

  let score = BASE;
  const hits = [];

  // Stakes first: if a prompt shows any, triviality signals are almost
  // certainly incidental ("summarise the security review" is not summarising).
  let stakes = 0;
  for (const s of STAKES) {
    if (s.re.test(instruction)) {
      stakes += s.w;
      hits.push(s.label);
    }
  }
  // Diminishing returns so three overlapping matches cannot pin every prompt
  // to the top tier.
  score += stakes > 0 ? Math.round(30 * Math.log2(1 + stakes / 30)) : 0;

  if (stakes === 0) {
    for (const s of TRIVIAL) {
      if (s.re.test(instruction)) {
        score += s.w;
        hits.push(s.label);
      }
    }
  }

  for (const s of BUILD) {
    if (s.re.test(instruction)) {
      score += s.w;
      hits.push(s.label);
    }
  }

  // Length is a weak tiebreak, not a driver. A long paste is usually context
  // for a simple ask, not evidence of difficulty.
  if (words > 120) score += 4;
  if ((instruction.match(/\?/g) || []).length >= 3) score += 4;

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, tier: tierFor(score), words, hits };
}

export function tierFor(score) {
  return score >= 62 ? "opus" : score >= 30 ? "sonnet" : "haiku";
}

// Clamp a tier to a user-set ceiling.
export function capTier(tier, maxModel) {
  const cap = TIERS.indexOf(maxModel);
  if (cap === -1) return tier;
  return TIERS.indexOf(tier) > cap ? TIERS[cap] : tier;
}
