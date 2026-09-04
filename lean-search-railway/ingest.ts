// One-time indexing of the LeanSearch-v2 Mathlib corpus: build the kind-aware
// structured passage per record, embed with Gemini embeddings-2
// (RETRIEVAL_DOCUMENT), upsert into Chroma Cloud. Reads the local JSONL (fast,
// no HF rate limits) and embeds batches with a concurrency pool. Idempotent
// (id = d<absolute line #>), resumable via --offset.
//
//   npm run build && node dist/ingest.js --file /tmp/lsv2/lsv2-mathlib-v4.28.0-rc1.jsonl
//   node dist/ingest.js --file … --limit 500          # smoke test a slice
//   node dist/ingest.js --file … --offset 120000       # resume from line N
//   node dist/ingest.js --file … --concurrency 8       # parallel embed+upsert
import fs from "node:fs";
import readline from "node:readline";
import { collection, upsert } from "./src/chroma.js";
import { embed } from "./src/gemini.js";
import { buildPassage, buildMetadata, type CorpusRecord } from "./src/passage.js";

const EMBED_BATCH = 100; // texts per Gemini batchEmbed call

const numArg = (name: string, def: number): number => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const strArg = (name: string, def: string): string => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

interface Item {
  id: string;
  rec: CorpusRecord;
}

async function main(): Promise<void> {
  const file = strArg("--file", "/tmp/lsv2/lsv2-mathlib-v4.28.0-rc1.jsonl");
  const startOffset = numArg("--offset", 0);
  const limit = numArg("--limit", Infinity);
  const concurrency = numArg("--concurrency", 8);
  if (!fs.existsSync(file)) throw new Error(`corpus file not found: ${file}`);

  const col = await collection();
  console.log(`[ingest] file=${file} offset=${startOffset} concurrency=${concurrency}`);

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let lineNo = -1;
  let batch: Item[] = [];
  let done = 0;
  const inflight = new Set<Promise<void>>();
  let failed: Error | null = null;

  const runBatch = async (chunk: Item[]): Promise<void> => {
    const passages = chunk.map((x) => buildPassage(x.rec));
    const vectors = await embed(passages, "RETRIEVAL_DOCUMENT");
    await upsert(col, chunk.map((x) => x.id), vectors, passages, chunk.map((x) => buildMetadata(x.rec)));
    done += chunk.length;
    if (done % 2000 === 0 || done === chunk.length) console.log(`[ingest] upserted ${done}`);
  };
  const schedule = async (chunk: Item[]): Promise<void> => {
    while (inflight.size >= concurrency) await Promise.race(inflight);
    const p: Promise<void> = runBatch(chunk)
      .catch((e) => {
        failed = failed || (e as Error);
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };

  for await (const line of rl) {
    lineNo++;
    if (lineNo < startOffset) continue;
    if (done + batch.length >= limit) break;
    if (failed) break;
    const s = line.trim();
    if (!s) continue;
    let rec: CorpusRecord;
    try {
      rec = JSON.parse(s);
    } catch {
      continue;
    }
    batch.push({ id: `d${lineNo}`, rec });
    if (batch.length >= EMBED_BATCH) {
      await schedule(batch);
      batch = [];
    }
  }
  rl.close();
  if (batch.length && !failed) await schedule(batch);
  await Promise.allSettled(inflight);
  if (failed) throw failed;
  console.log(`[ingest] DONE - ${done} records indexed.`);
}

main().catch((e) => {
  console.error("[ingest] FAILED:", e.message);
  process.exit(1);
});
