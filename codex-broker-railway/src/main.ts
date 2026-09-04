// codex-broker - the single, serialized refresher for a pool of ChatGPT Codex
// OAuth accounts. VMs never hold a refresh token; they ask the broker for a
// short-lived access token and use it via Pi's openai-codex provider.
//
// Why this exists: OpenAI rotates the refresh token on every refresh, so two
// machines refreshing the same account break it. The broker is the only thing
// that refreshes - rotations are captured and persisted here - so the whole
// fleet can draw from one pool of accounts without collisions.
//
// Layout (this src/ dir): config.ts (env) · store.ts (account pool + volume)
// · oauth.ts (refresh/vend one account) · server.ts (HTTP routes + tiering).
// Zero npm runtime dependencies - Node 20+ global fetch only.
import { PORT, RAILWAY_BROKER_API_KEY } from "./config.js";
import { load, listAccounts } from "./store.js";
import { createServer } from "./server.js";

load();
if (!RAILWAY_BROKER_API_KEY) {
  console.warn("[broker] WARNING: RAILWAY_BROKER_API_KEY not set - refusing all authed requests");
}
createServer().listen(PORT, () =>
  console.log(`[broker] listening on :${PORT} (${listAccounts().length} accounts)`)
);
