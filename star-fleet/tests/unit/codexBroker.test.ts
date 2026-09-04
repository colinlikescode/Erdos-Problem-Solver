import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "node:path";
import { REPO } from "./util";

// Boots the real broker (Node service) with a temp DATA_DIR + a fake OAuth
// token endpoint stub, then exercises hot-add and the fallback tier over HTTP.
// No real OpenAI calls: CODEX_TOKEN_URL points at a local stub.

// The broker is TypeScript now - bun runs the source directly (no build step).
const BROKER = join(REPO, "codex-broker-railway", "src", "main.ts");
const KEY = "brk-test-key";
let proc: Subprocess | null = null;
let stub: ReturnType<typeof Bun.serve> | null = null;
let base = "";

async function waitHealthy(url: string) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("broker did not become healthy");
}

beforeAll(async () => {
  // Stub OpenAI's token endpoint: any refresh succeeds with a fake bundle.
  stub = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        JSON.stringify({ access_token: "at-fake", refresh_token: "rt.next", expires_in: 3600 }),
        { headers: { "Content-Type": "application/json" } }
      ),
  });
  const port = 8791;
  proc = spawn({
    cmd: ["bun", BROKER],
    env: {
      ...process.env,
      PORT: String(port),
      RAILWAY_BROKER_API_KEY: KEY,
      DATA_DIR: join("/tmp", `broker-test-${Date.now()}`),
      CODEX_TOKEN_URL: `http://localhost:${stub.port}/token`,
      CODEX_MODELS: "gpt-5.4,gpt-5.5,gpt-5.6", // includes a "future" model
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  base = `http://localhost:${port}`;
  await waitHealthy(base);
});

afterAll(() => {
  proc?.kill();
  stub?.stop();
});

const auth = { Authorization: `Bearer ${KEY}` };

describe("codex-broker - auth + health", () => {
  test("/health needs no auth; authed routes reject a bad key", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/accounts`)).status).toBe(401);
    expect((await fetch(`${base}/accounts`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });
});

describe("codex-broker - model allowlist (GET /models)", () => {
  test("serves the CODEX_MODELS list (the fleet-wide model switch)", async () => {
    const r = await fetch(`${base}/models`, { headers: auth });
    expect(r.status).toBe(200);
    const body = await r.json();
    // Boot env sets CODEX_MODELS to include a "future" model to prove rollout.
    expect(body.models).toContain("gpt-5.5");
    expect(body.models).toContain("gpt-5.6");
  });
  test("requires auth", async () => {
    expect((await fetch(`${base}/models`)).status).toBe(401);
  });
});

describe("codex-broker - hot-add without restart", () => {
  test("POST /accounts adds to the live pool and it becomes usable immediately", async () => {
    const add = await fetch(`${base}/accounts`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: "acc-1", refresh_token: "rt.seed.1" }),
    });
    expect(add.status).toBe(200);
    const list = await (await fetch(`${base}/accounts`, { headers: auth })).json();
    expect(list.accounts.some((a: { account_id: string }) => a.account_id === "acc-1")).toBe(true);
    // and it can immediately vend a token (refresh via the stub)
    const tok = await (await fetch(`${base}/token`, { headers: auth })).json();
    expect(tok.tier).toBe("codex-oauth");
    expect(tok.access_token).toBe("at-fake");
  });
  test("re-POST replaces the token (recovers a dead account) - no duplicate", async () => {
    await fetch(`${base}/accounts`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "account-1", refresh_token: "rt.reseeded" }),
    });
    const list = await (await fetch(`${base}/accounts`, { headers: auth })).json();
    const matches = list.accounts.filter((a: { label: string }) => a.label === "account-1");
    expect(matches.length).toBe(1);
  });
  test("DELETE drops an account", async () => {
    await fetch(`${base}/accounts?account=account-1`, { method: "DELETE", headers: auth });
    const list = await (await fetch(`${base}/accounts`, { headers: auth })).json();
    expect(list.accounts.some((a: { label: string }) => a.label === "account-1")).toBe(false);
  });
});

describe("codex-broker - reserve tier, then pool exhaustion", () => {
  test("empty regular pool + reserve present → reserve is vended (tagged)", async () => {
    await fetch(`${base}/accounts`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "codex-reserve", refresh_token: "rt.reserve", reserve: true }),
    });
    const tok = await (await fetch(`${base}/token`, { headers: auth })).json();
    expect(tok.tier).toBe("codex-oauth-reserve");
    expect(tok.label).toBe("codex-reserve");
  });
  test("reserve never appears while a regular account is usable", async () => {
    await fetch(`${base}/accounts`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "account-2", refresh_token: "rt.regular" }),
    });
    for (let i = 0; i < 4; i++) {
      const tok = await (await fetch(`${base}/token`, { headers: auth })).json();
      expect(tok.label).toBe("account-2");
      expect(tok.tier).toBe("codex-oauth");
    }
    await fetch(`${base}/accounts?account=account-2`, { method: "DELETE", headers: auth });
  });
  test("everything gone → /token 503 pool_exhausted (no PAT tier; VM falls back to its own key)", async () => {
    await fetch(`${base}/accounts?account=codex-reserve`, { method: "DELETE", headers: auth });
    const res = await fetch(`${base}/token`, { headers: auth });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.pool_exhausted).toBe(true);
  });
});
