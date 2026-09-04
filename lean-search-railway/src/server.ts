// HTTP surface for lean-search. All routes except /health require
// `Authorization: Bearer $RAILWAY_LEAN_SEARCH_API_KEY`.
//
//   GET  /health           liveness (no auth) + collection count
//   POST /search           { query, k?, augment?, kind? } -> reranked Mathlib hits
//
// Pipeline: (optional) GPT-5.5 augment -> embed query (RETRIEVAL_QUERY, Gemini) ->
// Chroma top-CANDIDATES by cosine -> GPT-5.5 listwise rerank -> top-k.
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RAILWAY_LEAN_SEARCH_API_KEY, CANDIDATES, DEFAULT_RESULTS } from "./config.js";
import { collection, queryByVector } from "./chroma.js";
import { embed } from "./gemini.js";
import { augment, rerank, type Candidate } from "./llm.js";

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function authed(req: IncomingMessage): boolean {
  const h = req.headers["authorization"] || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  return Boolean(RAILWAY_LEAN_SEARCH_API_KEY) && tok === RAILWAY_LEAN_SEARCH_API_KEY;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

async function handleSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (!body || !body.query || typeof body.query !== "string") {
    return send(res, 400, { error: "body must be { query: string, k?, augment?, kind? }" });
  }
  const k = Math.min(Math.max(Number(body.k) || DEFAULT_RESULTS, 1), 50);
  try {
    const col = await collection();
    const searchText = body.augment === false ? body.query : await augment(body.query);
    const [vec] = await embed([searchText], "RETRIEVAL_QUERY");
    let cands = (await queryByVector(col, vec, CANDIDATES)) as unknown as (Candidate & { id: string })[];
    if (body.kind) cands = cands.filter((c) => c.kind === String(body.kind).toLowerCase());
    if (!cands.length) return send(res, 200, { query: body.query, results: [] });
    const order = await rerank(body.query, cands, k);
    const results = order.map((i) => {
      const c = cands[i];
      return {
        name: c.name,
        kind: c.kind,
        signature: c.signature,
        informal_name: c.informal_name,
        informal_description: c.informal_description,
        module: c.module,
      };
    });
    return send(res, 200, { query: body.query, augmented: searchText !== body.query, results });
  } catch (e) {
    return send(res, 502, { error: String((e as Error).message || e) });
  }
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/health") {
      try {
        const col = await collection();
        return send(res, 200, { ok: true, count: await col.count() });
      } catch (e) {
        return send(res, 200, { ok: false, error: String((e as Error).message || e) });
      }
    }
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    if (url.pathname === "/search" && req.method === "POST") return handleSearch(req, res);
    return send(res, 404, { error: "not found" });
  });
}
