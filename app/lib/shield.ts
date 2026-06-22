/**
 * The cognitive shield — SCAFFOLD.
 *
 * Judges ONE piece of incoming information: keep / flag / drop, with reasons. v0 asks Claude to
 * score it on five plain epistemic questions and explain. There is no real source-checking yet
 * (no DMARC/SPF, no corroboration search, no learned per-user preferences) — those slot in behind
 * this same `judge` interface later.
 *
 * The seam is `judge(item) -> ShieldVerdict`. Sophistication (real signals, the per-user memory,
 * learning from what the human keeps) goes INSIDE judge; callers (email triage, research filtering)
 * keep the same call. Not yet wired into the app — running it live needs a route/console surface.
 */
import "server-only";
import { generateObject } from "ai";
import { z } from "zod";
import { AGENT_MODEL } from "./chain";

export type Verdict = "keep" | "flag" | "drop";

/** A thing to judge. `source` empty = unknown, which is itself a signal. */
export interface ShieldItem {
  /** What kind of thing this is, e.g. "email", "web-page", "message". */
  kind: string;
  /** Who it's from, if known (sender, domain, URL, author). */
  source?: string;
  /** The content to judge, in plain text. */
  text: string;
}

export interface ShieldVerdict {
  /** keep = worth attention · flag = unsure, surface with a warning · drop = junk/harmful. */
  verdict: Verdict;
  /** 0–100: how worth-your-attention this is. */
  score: number;
  /** Short plain reasons — always shown, never a silent filter. */
  reasons: string[];
}

const schema = z.object({
  verdict: z.enum(["keep", "flag", "drop"]),
  score: z.number().min(0).max(100),
  reasons: z.array(z.string()).min(1).max(4),
});

const RUBRIC = `You are a cognitive shield. Judge ONE piece of information for whether it deserves
your human's attention. Weigh five questions:
1. Source — is it from a trusted source, and plausibly really who it claims to be?
2. Corroboration — is this the kind of claim independent sources would back up?
3. Manipulation — is it pushing urgency, fear, money, or credentials (scam/phishing/clickbait signs)?
4. Consistency — does it fit how the world generally works, or is it internally contradictory?
5. Relevance — is it something a person would actually want to see, vs. noise?

Then decide:
- "drop" → junk or harmful (spam, scam, phishing, pure noise)
- "flag" → unsure or mixed; surface it but with a warning
- "keep" → genuinely worth attention
Give 1–4 short, plain reasons. Be skeptical; when in doubt, prefer "flag" over "keep".`;

/**
 * Judge one item. v0 = a single Claude call against the rubric, returning structured output.
 * Throws only on an infra/model failure — a caller can treat a throw as "flag" (fail safe, surface it).
 */
export async function judge(item: ShieldItem): Promise<ShieldVerdict> {
  const { object } = await generateObject({
    model: AGENT_MODEL,
    schema,
    system: RUBRIC,
    prompt: `kind: ${item.kind}\nsource: ${item.source ?? "(unknown)"}\n\n${item.text}`,
  });
  return object;
}
