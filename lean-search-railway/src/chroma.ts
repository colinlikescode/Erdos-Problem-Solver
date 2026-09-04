// Chroma Cloud client for the lean-search collection. We embed ourselves
// (Gemini embeddings-2, asymmetric task types), so the collection has NO
// embedding function - we upsert precomputed vectors and query by vector.
import { CloudClient, type Collection } from "chromadb";
import { CHROMA_API_KEY, CHROMA_TENANT, CHROMA_DATABASE, COLLECTION } from "./config.js";

let _collection: Collection | null = null;

export async function collection(): Promise<Collection> {
  if (_collection) return _collection;
  const client = new CloudClient({
    apiKey: CHROMA_API_KEY,
    tenant: CHROMA_TENANT,
    database: CHROMA_DATABASE,
  });
  _collection = await client.getOrCreateCollection({
    name: COLLECTION,
    metadata: { "hnsw:space": "cosine", source: "FrenzyMath/lsv2-mathlib-v4.28.0-rc1-jsonl" },
    embeddingFunction: null as never, // vectors are supplied explicitly
  });
  return _collection;
}

// Chroma Cloud rate-limits queries per database. Two defenses so parallel load
// (a fleet of VMs searching at once) queues instead of failing:
//  1. a concurrency gate - at most GATE Chroma calls in flight from this service;
//  2. jittered exponential backoff wide enough to ride out a full limit window.
const GATE = 4;
let active = 0;
const waiters: (() => void)[] = [];
async function gated<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= GATE) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries = 8): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await gated(fn);
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error).message || e);
      if (!/rate limit|429|quota|too many|unavailable|ECONNRESET|fetch failed/i.test(msg)) throw e;
      await new Promise((r) =>
        setTimeout(r, Math.min(1000 * 2 ** attempt, 30000) * (0.5 + Math.random()))
      );
    }
  }
  throw lastErr;
}

export async function upsert(
  col: Collection,
  ids: string[],
  embeddings: number[][],
  documents: string[],
  metadatas: Record<string, string>[]
): Promise<void> {
  await withRetry(() => col.upsert({ ids, embeddings, documents, metadatas }));
}

export interface Hit {
  id: string;
  document?: string;
  distance?: number;
  [k: string]: unknown;
}

/** Query by a single embedding vector; returns up to n candidate records. */
export async function queryByVector(col: Collection, vector: number[], n: number): Promise<Hit[]> {
  const res = await withRetry(() => col.query({ queryEmbeddings: [vector], nResults: n }));
  const ids = res.ids?.[0] || [];
  const metas = res.metadatas?.[0] || [];
  const docs = res.documents?.[0] || [];
  const dists = res.distances?.[0] || [];
  return ids.map((id: string, i: number) => ({
    id,
    ...((metas[i] as Record<string, unknown>) || {}),
    document: docs[i] as string | undefined,
    distance: dists[i] as number | undefined,
  }));
}
