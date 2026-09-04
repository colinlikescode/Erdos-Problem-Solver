// All environment-derived configuration for the lean-search service.
export const PORT = Number(process.env.PORT || 8080);

// Shared bearer secret the VMs authenticate with (like the codex-broker).
export const RAILWAY_LEAN_SEARCH_API_KEY = (process.env.RAILWAY_LEAN_SEARCH_API_KEY || "").trim();

// Gemini - embeddings only (gemini-embedding-2 with asymmetric task types).
export const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
export const EMBED_MODEL = process.env.LEAN_EMBED_MODEL || "gemini-embedding-2";
export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// The augment + rerank LLM: GPT-5.5 at xhigh reasoning, via the fleet's
// fallback chain - codex-broker pool -> reserve (broker-side) -> OPENAI_API_KEY.
export const LLM_MODEL = process.env.LEAN_LLM_MODEL || "gpt-5.5";
export const LLM_EFFORT = process.env.LEAN_LLM_EFFORT || "xhigh";
export const RAILWAY_BROKER_URL = (process.env.RAILWAY_BROKER_URL || "").trim();
export const RAILWAY_BROKER_API_KEY = (process.env.RAILWAY_BROKER_API_KEY || "").trim();
export const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

// Chroma Cloud - its OWN database (CHROMA_DATABASE_2=lean-search), separate
// from the app's. Collection holds the 311k Mathlib passages (cosine space).
export const CHROMA_API_KEY = (process.env.CHROMA_API_KEY || "").trim();
export const CHROMA_TENANT = (process.env.CHROMA_TENANT || "").trim();
export const CHROMA_DATABASE = (process.env.CHROMA_DATABASE_2 || "lean-search").trim();
export const COLLECTION = process.env.LEAN_COLLECTION || "mathlib";

// Retrieval knobs. Pull a wide candidate set from Chroma, then the LLM reranks
// it down (the reranker is the ~+10 nDCG quality jump - always on).
export const CANDIDATES = Number(process.env.LEAN_CANDIDATES || 50); // top-K from vectors
export const DEFAULT_RESULTS = Number(process.env.LEAN_RESULTS || 10); // after rerank
