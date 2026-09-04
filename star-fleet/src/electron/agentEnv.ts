import type { AppSettings } from "./settings";

/**
 * Parse a `.env`-style file into a flat map. Only lines of the form
 * `KEY=value` (uppercase/digits/underscore key) are kept; everything else
 * (blank lines, comments) is ignored. Values are trimmed.
 */
export function parseDotEnv(raw: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m) tokens[m[1]] = m[2].trim();
  }
  return tokens;
}

/**
 * Resolve the env passed to the remote agent. OpenAI-only, in the fallback
 * order the supervisor exhausts them (see vm-base/scaffolding/agent-loop.sh):
 *   1. The codex-broker (`RAILWAY_BROKER_URL` + `RAILWAY_BROKER_API_KEY`) - the pooled
 *      ChatGPT Codex accounts + the reserve. Refresh chains live only in the
 *      broker (Railway volume); VMs fetch short-lived access tokens per turn.
 *      Codex account credentials are never stored in `.env` or shipped to VMs
 *      - OpenAI rotates refresh tokens on every refresh, so local copies go
 *      stale instantly and using them risks breaking the broker's chains.
 *   2. Regular OpenAI key - `OPENAI_REGULAR_API_KEY` (settings `sk-…` wins).
 * Plus `GEMINI_API_KEY`, which powers the search-tool embeddings.
 */
export function resolveAgentEnv(
  dotenv: Record<string, string>,
  settings: AppSettings
): Record<string, string> {
  const env: Record<string, string> = {};

  // Regular OpenAI key (sk-…) - tier 2 (final fallback after the broker).
  const regular =
    (settings.openaiApiKey?.startsWith("sk-") ? settings.openaiApiKey : "") ||
    dotenv.OPENAI_REGULAR_API_KEY ||
    dotenv.OPENAI_API_KEY;
  if (regular) env.OPENAI_REGULAR_API_KEY = regular;

  // Gemini (embeddings for lean-search live server-side; the key is still
  // exported for any direct Gemini use from the VM).
  const gemini = dotenv.GEMINI_API_KEY || dotenv.GEMINI_API_KEY_1;
  if (gemini) env.GEMINI_API_KEY = gemini;

  // The codex-broker - tier 1: VMs pull short-lived Codex access tokens from
  // it (the pooled accounts + the reserve). The supervisor consumes these.
  if (dotenv.RAILWAY_BROKER_URL) env.RAILWAY_BROKER_URL = dotenv.RAILWAY_BROKER_URL;
  if (dotenv.RAILWAY_BROKER_API_KEY) env.RAILWAY_BROKER_API_KEY = dotenv.RAILWAY_BROKER_API_KEY;

  // The lean-search service (self-hosted Mathlib NL search) - powers the
  // `lean-search` skill on the VM.
  if (dotenv.RAILWAY_LEAN_SEARCH_URL) env.RAILWAY_LEAN_SEARCH_URL = dotenv.RAILWAY_LEAN_SEARCH_URL;
  if (dotenv.RAILWAY_LEAN_SEARCH_API_KEY) env.RAILWAY_LEAN_SEARCH_API_KEY = dotenv.RAILWAY_LEAN_SEARCH_API_KEY;

  // Elastic compute + search providers, consumed by the snapshot skills
  // (.agents/skills/*): E2B + Cloudflare (CPU), Modal x2 + Daytona (GPU),
  // Firecrawl (web/research search). Passed through as-is.
  for (const k of SKILL_PROVIDER_KEYS) {
    if (dotenv[k]) env[k] = dotenv[k];
  }

  return env;
}

/** Provider keys forwarded to the VM for the snapshot's provider skills. */
export const SKILL_PROVIDER_KEYS = [
  "E2B_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_KEY",
  "DAYTONA_API_KEY",
  "MODAL_TOKEN_ID_1",
  "MODAL_TOKEN_SECRET_1",
  "MODAL_PROFILE_1",
  "MODAL_TOKEN_ID_2",
  "MODAL_TOKEN_SECRET_2",
  "MODAL_PROFILE_2",
  "FIRECRAWL_API_KEY",
  "SENDBLUE_API_KEY",
  "SENDBLUE_API_SECRET",
  "SENDBLUE_FROM_NUMBER",
  "OPERATOR_PHONE_NUMBER",
] as const;

