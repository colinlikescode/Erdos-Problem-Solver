// lean-search service entry point (Railway). Natural-language search over the
// Mathlib LeanSearch corpus: Gemini embeddings-2 + Chroma Cloud + GPT-5.5
// (xhigh) augment/rerank via the codex-broker -> OpenAI-key fallback chain.
// See README.md.
import { createServer } from "./server.js";
import {
  PORT,
  RAILWAY_LEAN_SEARCH_API_KEY,
  GEMINI_API_KEY,
  CHROMA_API_KEY,
  RAILWAY_BROKER_URL,
  OPENAI_API_KEY,
} from "./config.js";

for (const [k, v] of [
  ["RAILWAY_LEAN_SEARCH_API_KEY", RAILWAY_LEAN_SEARCH_API_KEY],
  ["GEMINI_API_KEY", GEMINI_API_KEY],
  ["CHROMA_API_KEY", CHROMA_API_KEY],
] as const) {
  if (!v) console.warn(`[lean-search] WARNING: ${k} is not set`);
}
if (!RAILWAY_BROKER_URL && !OPENAI_API_KEY) {
  console.warn("[lean-search] WARNING: no LLM provider (RAILWAY_BROKER_URL / OPENAI_API_KEY)");
}

createServer().listen(PORT, () => console.log(`[lean-search] listening on :${PORT}`));
