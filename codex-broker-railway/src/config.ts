// All environment-derived configuration for the broker in one place.
import path from "node:path";

// --- OAuth constants (Codex CLI public client) ------------------------------
// client_id is the Codex CLI's OAuth client (seen in the access-token JWT).
// Confirm on first live seed; override via env if OpenAI ever changes it.
export const TOKEN_URL = process.env.CODEX_TOKEN_URL || "https://auth.openai.com/oauth/token";
export const CLIENT_ID = process.env.CODEX_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";
export const REFRESH_SKEW_MS = 90_000; // refresh this long before the token actually expires
export const COOLDOWN_MS = 60_000; // back off an account after a transient failure
// A VM-reported usage/rate-limit puts the account in cooldown for this long  - 
// ChatGPT Codex accounts typically ease their limits after ~5h, so the broker
// skips a limited account until then and automatically readmits it after. The
// whole fleet shares this (a limit is a global per-account fact). Override via
// CODEX_RATE_LIMIT_COOLDOWN_MS.
export const RATE_LIMIT_COOLDOWN_MS = Number(process.env.CODEX_RATE_LIMIT_COOLDOWN_MS || 5 * 60 * 60 * 1000);

export const RAILWAY_BROKER_API_KEY = (process.env.RAILWAY_BROKER_API_KEY || "").trim();
export const PORT = Number(process.env.PORT || 8080);
export const DATA_DIR = process.env.DATA_DIR || "/data";

// refresh tokens rotate, so the live copy must survive restarts (Railway volume).
export const STORE_PATH = path.join(DATA_DIR, "accounts.json");

// The models the fleet is ALLOWED to run, served at GET /models. This is the
// central switch: to roll out a new model (e.g. gpt-5.6) fleet-wide, set
// CODEX_MODELS on this one Railway service - every VM's tabs-repl `/model`
// command validates against this list at switch time, so the new model is
// usable within seconds and needs NO VM redeploy. Comma-separated bare model
// ids (thinking suffix is added VM-side).
export const ALLOWED_MODELS = (process.env.CODEX_MODELS || "gpt-5.4,gpt-5.5,gpt-5.6-sol")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
