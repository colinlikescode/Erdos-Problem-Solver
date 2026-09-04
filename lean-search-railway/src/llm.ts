// GPT-5.5 (xhigh) completions for augment + rerank, with the fleet's exact
// provider fallback: codex-broker (pool -> reserve, decided broker-side) -> the
// regular OPENAI_API_KEY against the public Responses API.
import {
  LLM_MODEL,
  LLM_EFFORT,
  RAILWAY_BROKER_URL,
  RAILWAY_BROKER_API_KEY,
  OPENAI_API_KEY,
} from "./config.js";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_URL = "https://api.openai.com/v1/responses";

async function codexComplete(prompt: string): Promise<string> {
  if (!RAILWAY_BROKER_URL || !RAILWAY_BROKER_API_KEY) throw new Error("no broker configured");
  const vend = await fetch(`${RAILWAY_BROKER_URL.replace(/\/$/, "")}/token`, {
    headers: { Authorization: `Bearer ${RAILWAY_BROKER_API_KEY}` },
  });
  const tok = (await vend.json()) as { access_token?: string; account_id?: string };
  if (!tok.access_token) throw new Error(`broker vend failed: ${JSON.stringify(tok).slice(0, 200)}`);

  const res = await fetch(CODEX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tok.access_token}`,
      "chatgpt-account-id": tok.account_id || "",
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      instructions: "You are an expert in Lean 4 and formalized mathematics (Mathlib).",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
      reasoning: { effort: LLM_EFFORT },
      store: false,
      stream: true, // the Codex backend only speaks SSE
    }),
  });
  if (!res.ok) throw new Error(`codex backend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let text = "";
  for (const line of (await res.text()).split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data: ")) continue;
    try {
      const ev = JSON.parse(s.slice(6));
      if (ev.type === "response.output_text.delta") text += ev.delta || "";
    } catch {
      /* keep-alives */
    }
  }
  if (!text.trim()) throw new Error("codex backend returned no text");
  return text.trim();
}

async function openaiComplete(prompt: string): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error("no OPENAI_API_KEY");
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, input: prompt, reasoning: { effort: LLM_EFFORT } }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = (await res.json()) as { output?: { type: string; content?: { type: string; text?: string }[] }[] };
  const text = (out.output || [])
    .filter((i) => i.type === "message")
    .flatMap((i) => i.content || [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text || "")
    .join("")
    .trim();
  if (!text) throw new Error("openai returned no text");
  return text;
}

/** GPT-5.5 xhigh completion: broker pool -> reserve -> OpenAI key. */
export async function complete(prompt: string): Promise<string> {
  const errors: string[] = [];
  for (const tier of [codexComplete, openaiComplete]) {
    try {
      return await tier(prompt);
    } catch (e) {
      errors.push(`${tier.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(`all LLM tiers failed - ${errors.join(" | ")}`);
}

/** Expand a short user query into a richer mathematical description. */
export async function augment(query: string): Promise<string> {
  const prompt =
    "Rewrite the user's search query into a single, richer natural-language description " +
    "of the Mathlib theorem/definition they want - include standard terminology and " +
    "closely related concepts. Return ONLY the rewritten description, no preamble.\n\n" +
    `Query: ${query}`;
  try {
    const t = (await complete(prompt)).trim();
    return t || query;
  } catch {
    return query; // augmentation is best-effort; fall back to the raw query
  }
}

export interface Candidate {
  name: string;
  kind: string;
  signature?: string;
  informal_name?: string;
  informal_description?: string;
  [k: string]: unknown;
}

/**
 * Listwise rerank: given the query and candidate Mathlib declarations, return
 * the indices of the top `k` most relevant, best first. Kind-aware (the
 * paper's +2-3 points): the model weighs definitions/instances by what they
 * define. Falls back to vector order if the LLM fails.
 */
export async function rerank(query: string, candidates: Candidate[], k: number): Promise<number[]> {
  const list = candidates
    .map(
      (c, i) =>
        `[${i}] (${c.kind}) ${c.informal_name || c.name}\n    sig: ${(c.signature || "")
          .replace(/\s+/g, " ")
          .slice(0, 240)}\n    ${(c.informal_description || "").slice(0, 400)}`
    )
    .join("\n\n");
  const prompt =
    "You are reranking Mathlib declarations for a Lean 4 user. Given the QUERY and " +
    "the numbered CANDIDATES, pick the ones that best match what the user is looking " +
    "for, most relevant first. Judge by mathematical meaning, not surface words; for " +
    "definitions/instances/classes weigh WHAT THEY DEFINE. Return STRICT JSON ONLY " +
    `(no code fences, no prose): {"ranked":[<indices>]} with at most ${k} indices, ` +
    `best first, no ties.\n\nQUERY: ${query}\n\nCANDIDATES:\n${list}`;
  try {
    const raw = await complete(prompt);
    const m = raw.match(/\{[\s\S]*\}/); // tolerate stray text around the JSON
    const idxs = JSON.parse(m ? m[0] : raw).ranked as number[];
    const seen = new Set<number>();
    const order: number[] = [];
    for (const i of idxs) {
      if (Number.isInteger(i) && i >= 0 && i < candidates.length && !seen.has(i)) {
        seen.add(i);
        order.push(i);
      }
    }
    if (order.length) return order.slice(0, k);
  } catch {
    /* fall through to vector order */
  }
  return candidates.map((_, i) => i).slice(0, k);
}
