import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDotEnv, resolveAgentEnv } from "../../src/electron/agentEnv";
import { ROOT } from "./util";

const EMPTY = { openaiApiKey: "" };

describe("parseDotEnv", () => {
  test("keeps KEY=value lines, trims, ignores comments/blanks", () => {
    const raw = ["# comment", "", "FOO=bar", "BAZ = qux ", "lowercase=nope", "A_B1=v"].join("\n");
    const t = parseDotEnv(raw);
    expect(t.FOO).toBe("bar");
    expect(t.A_B1).toBe("v");
    expect(t.BAZ).toBeUndefined(); // space in key breaks the match
    expect(t.lowercase).toBeUndefined();
  });
  test("value with '=' keeps everything after first '='", () => {
    expect(parseDotEnv("K=a=b=c").K).toBe("a=b=c");
  });
});

describe("resolveAgentEnv - OpenAI-only mapping", () => {
  const dotenv = {
    RAILWAY_BROKER_URL: "https://broker.example",
    RAILWAY_BROKER_API_KEY: "brk-x",
    OPENAI_REGULAR_API_KEY: "sk-proj-REG",
    GEMINI_API_KEY: "AQ.gemini",
    CHROMA_API_KEY: "ck-chroma",
    // A leftover codex blob (should never exist, but must never pass through:
    // the broker owns all Codex refresh chains; local copies are stale/harmful).
    OPENAI_CODEX_AUTH_JSON_B64_1: "c3RhbGU=",
    // The Codex PAT is fully deprecated - must never be mapped, even if present.
    OPENAI_CODEX_API_KEY: "at-DEPRECATED",
  };
  const env = resolveAgentEnv(dotenv, EMPTY);

  test("broker coordinates pass through (the supervisor's tier 1)", () => {
    expect(env.RAILWAY_BROKER_URL).toBe("https://broker.example");
    expect(env.RAILWAY_BROKER_API_KEY).toBe("brk-x");
  });
  test("codex account blobs NEVER pass through", () => {
    expect(env.OPENAI_CODEX_AUTH_JSON_B64_1).toBeUndefined();
  });
  test("deprecated Codex PAT is never mapped", () => {
    expect(env.OPENAI_CODEX_API_KEY).toBeUndefined();
  });
  test("maps regular + gemini (broker is tier 1, regular key is the fallback)", () => {
    expect(env.OPENAI_REGULAR_API_KEY).toBe("sk-proj-REG");
    expect(env.GEMINI_API_KEY).toBe("AQ.gemini");
  });
  test("Chroma Cloud vars do NOT pass through (Memora removed; Chroma is server-side only)", () => {
    expect(env.CHROMA_API_KEY).toBeUndefined();
    expect(env.CHROMA_TENANT).toBeUndefined();
    expect(env.CHROMA_DATABASE).toBeUndefined();
  });
  test("passes through skill provider keys (E2B/Cloudflare/Modal x2/Daytona/Firecrawl)", () => {
    const skillEnv = resolveAgentEnv(
      {
        E2B_API_KEY: "e2b_x",
        CLOUDFLARE_ACCOUNT_ID: "cf-acct",
        CLOUDFLARE_API_KEY: "cfat_x",
        DAYTONA_API_KEY: "dtn_x",
        MODAL_TOKEN_ID_1: "ak-1",
        MODAL_TOKEN_SECRET_1: "as-1",
        MODAL_TOKEN_ID_2: "ak-2",
        MODAL_TOKEN_SECRET_2: "as-2",
        FIRECRAWL_API_KEY: "fc-x",
        SENDBLUE_API_KEY: "sb-key",
        SENDBLUE_API_SECRET: "sb-secret",
        SENDBLUE_FROM_NUMBER: "+15550000000",
        OPERATOR_PHONE_NUMBER: "+15550000001",
      },
      EMPTY
    );
    expect(skillEnv.E2B_API_KEY).toBe("e2b_x");
    expect(skillEnv.CLOUDFLARE_ACCOUNT_ID).toBe("cf-acct");
    expect(skillEnv.CLOUDFLARE_API_KEY).toBe("cfat_x");
    expect(skillEnv.DAYTONA_API_KEY).toBe("dtn_x");
    expect(skillEnv.MODAL_TOKEN_ID_1).toBe("ak-1");
    expect(skillEnv.MODAL_TOKEN_SECRET_2).toBe("as-2");
    expect(skillEnv.FIRECRAWL_API_KEY).toBe("fc-x");
    expect(skillEnv.SENDBLUE_API_KEY).toBe("sb-key");
    expect(skillEnv.SENDBLUE_API_SECRET).toBe("sb-secret");
    expect(skillEnv.SENDBLUE_FROM_NUMBER).toBe("+15550000000");
    expect(skillEnv.OPERATOR_PHONE_NUMBER).toBe("+15550000001");
  });
  test("no claude/cursor keys anymore", () => {
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
  });
});

describe("resolveAgentEnv - settings precedence", () => {
  test("settings sk- key wins over .env", () => {
    const env = resolveAgentEnv({ OPENAI_REGULAR_API_KEY: "sk-ENV" }, { ...EMPTY, openaiApiKey: "sk-proj-SET" });
    expect(env.OPENAI_REGULAR_API_KEY).toBe("sk-proj-SET");
  });
  test("a non-matching settings value does not override .env", () => {
    const env = resolveAgentEnv({ OPENAI_REGULAR_API_KEY: "sk-ENV" }, { ...EMPTY, openaiApiKey: "notakey" });
    expect(env.OPENAI_REGULAR_API_KEY).toBe("sk-ENV");
  });
  test("empty everything yields empty env", () => {
    expect(resolveAgentEnv({}, EMPTY)).toEqual({});
  });
});

describe("resolveAgentEnv - against the real project .env", () => {
  test("broker + regular + gemini present; nothing codex stored locally", () => {
    let raw = "";
    try {
      raw = readFileSync(join(ROOT, "..", ".env"), "utf8");
    } catch {
      return; // no .env - skip
    }
    const parsed = parseDotEnv(raw);
    const env = resolveAgentEnv(parsed, EMPTY);
    // The .env must hold NO codex account credentials - they live only in the
    // broker (Railway volume). Tiers: broker pool -> reserve -> regular key.
    expect(Object.keys(parsed).filter((k) => k.startsWith("OPENAI_CODEX_AUTH"))).toEqual([]);
    expect(env.RAILWAY_BROKER_URL?.startsWith("https://")).toBe(true);
    expect(env.RAILWAY_BROKER_API_KEY?.startsWith("brk-")).toBe(true);
    expect(env.OPENAI_REGULAR_API_KEY?.startsWith("sk-")).toBe(true);
    expect(env.GEMINI_API_KEY?.length).toBeGreaterThan(10);
  });
});
