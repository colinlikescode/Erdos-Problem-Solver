// Gemini client - EMBEDDINGS only (gemini-embedding-2, asymmetric task types).
// The augment/rerank LLM lives in llm.ts (GPT-5.5 via broker -> OpenAI key).
import { GEMINI_API_KEY, GEMINI_BASE, EMBED_MODEL } from "./config.js";

const EMBED_DIM = Number(process.env.LEAN_EMBED_DIM || 1536);

async function gpost(path: string, body: unknown, retries = 6): Promise<any> {
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${GEMINI_BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    lastErr = `gemini ${path} ${res.status}: ${text.slice(0, 200)}`;
    // Back off on rate limits / transient server errors and retry.
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 30000)));
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

/**
 * Embed a batch of texts. `side` picks the task type - RETRIEVAL_DOCUMENT for
 * corpus passages, RETRIEVAL_QUERY for search queries (asymmetric retrieval;
 * the two sides must use different task types or recall drops).
 */
export async function embed(
  texts: string[],
  side: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" = "RETRIEVAL_QUERY"
): Promise<number[][]> {
  const out = await gpost(`models/${EMBED_MODEL}:batchEmbedContents`, {
    requests: texts.map((t) => ({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text: t }] },
      taskType: side,
      outputDimensionality: EMBED_DIM,
    })),
  });
  return ((out.embeddings || []) as { values: number[] }[]).map((e) => e.values);
}
