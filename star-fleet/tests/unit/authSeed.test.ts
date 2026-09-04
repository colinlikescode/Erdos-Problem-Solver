import { test, expect, describe } from "bun:test";
import { sectionPiAuth, PI_SETTINGS } from "../../src/electron/provision/children/auth";
import { bashSyntaxOk } from "./util";

// Codex ChatGPT auth is deliberately ABSENT here: the codex-broker (Railway)
// owns every refresh chain, and the supervisor feeds broker-vended access
// tokens to Pi at runtime. sectionPiAuth only seeds the regular API key.

describe("sectionPiAuth - regular key only, nothing codex on disk", () => {
  const s = sectionPiAuth("sk-proj-REG");

  test("is valid bash", () => {
    expect(bashSyntaxOk(s).ok).toBe(true);
  });
  test("seeds the regular openai key into Pi's auth.json", () => {
    expect(s).toContain("PI_REGULAR_KEY='sk-proj-REG'");
    expect(s).toContain('auth.openai = { type: "api_key", key: rk }');
  });
  test("never writes codex credentials or an accounts store", () => {
    expect(s).not.toContain("openai-codex");
    expect(s).not.toContain("codex-accounts");
    expect(s).not.toContain("ACCOUNTS_B64");
  });
  test("merges into existing auth.json instead of clobbering it", () => {
    expect(s).toContain("JSON.parse(fs.readFileSync(authPath");
  });
});

describe("PI_SETTINGS - compaction + trust", () => {
  const settings = JSON.parse(PI_SETTINGS);
  test("compaction on with reserve/keep budgets", () => {
    expect(settings.compaction.enabled).toBe(true);
    expect(settings.compaction.reserveTokens).toBeGreaterThan(0);
    expect(settings.compaction.keepRecentTokens).toBeGreaterThan(0);
  });
  test("headless VMs trust the snapshot project", () => {
    expect(settings.defaultProjectTrust).toBe("always");
  });
});
