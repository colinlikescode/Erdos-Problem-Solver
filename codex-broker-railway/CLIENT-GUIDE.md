# Calling the broker from a client

Notes for anyone writing something that vends a token from this broker and
calls the Codex backend with it. Most of this was learned the hard way while
getting `gpt-5.6-sol` to work; the advice applies to any model.

## pi setup

If you run pi (`@earendil-works/pi-coding-agent`) against this broker, pi
already does most of the work. It posts to
`https://chatgpt.com/backend-api/codex/responses`, pulls `chatgpt-account-id`
out of the token JWT, turns in-stream `error` / `response.failed` events into a
failed turn, and its retry classifier matches `overloaded`. What it doesn't do
out of the box: know about newer models, retry enough, or fall back to another
model.

### 1. Teach pi the model

pi's bundled `openai-codex` catalog may not include the model you want. Try
`pi update` first and re-check with `pi --list-models <name>`. If it's still
missing, declare it in `~/.pi/agent/models.json`, copying the shape pi uses for
`gpt-5.5`:

```json
{
  "models": [
    {
      "id": "gpt-5.6-sol",
      "name": "GPT-5.6 Sol",
      "api": "openai-codex-responses",
      "provider": "openai-codex",
      "baseUrl": "https://chatgpt.com/backend-api",
      "reasoning": true,
      "thinkingLevelMap": { "xhigh": "xhigh", "minimal": "low" },
      "input": ["text", "image"],
      "contextWindow": 272000,
      "maxTokens": 128000
    }
  ]
}
```

`api` and `provider` must be exactly those values. That's what routes the
request through pi's Codex path (subscription auth) rather than the platform
API (per-token billing).

### 2. Feed it a broker token

pi reads credentials from `~/.pi/agent/auth.json` under the `openai-codex`
provider. Vend with the model named so entitled accounts rank first:

```
GET $RAILWAY_BROKER_URL/token?model=gpt-5.6-sol
```

Write the returned `access_token` and `account_id` into that file before
launching pi. Re-vend with `&avoid=<comma,separated,tried>` only after a 401 or
the entitlement 400 described below, never for overload.

### 3. Raise the retry budget

pi defaults to `retry.maxRetries = 3`, `retry.baseDelayMs = 2000`. When a model
is only admitted part of the time, four attempts isn't enough and turns
hard-fail in a way that reads as "the model is broken". Retries are a fast,
independent lottery, so many quick tries beat a few slow ones. In
`~/.pi/agent/settings.json` (or `<cwd>/.pi/settings.json`):

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 8,
    "baseDelayMs": 500
  }
}
```

pi's backoff is exponential and uncapped, so don't push `maxRetries` much past
8 or the tail gets long.

### 4. Wrap the turn to fall back to another model

pi retries the same model and has no fallback-model chain. So the downgrade has
to be yours. Run the turn on the preferred model; if pi still exits failed after
its retries, rerun the same session on the fallback. Reusing `--session-id` is
what preserves the conversation:

```bash
SID="run-$(date +%s)"
pi -p --model openai-codex/gpt-5.6-sol --thinking xhigh --session-id "$SID" "$PROMPT" \
  || pi -p --model openai-codex/gpt-5.5 --thinking xhigh --session-id "$SID" "$PROMPT"
```

Use `--mode json` instead of `-p` if you want to inspect the failure reason
programmatically. Log which model actually produced each result; fallback turns
run on the weaker model.

### What not to do

Don't rotate accounts on `server_is_overloaded`. It's shared OpenAI capacity,
not per-account state; cycling accounts just spends vends to collect the same
error. Don't report an overload to `/model-unsupported` either. That endpoint
is only for the durable entitlement 400, and using it on a transient error
would take a good account out of rotation for that model permanently.

## Two different HTTP 400s

Some accounts can't serve some models at all. The backend says so with:

```
{"detail":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}
```

That's a property of the account (typically its plan), not of the request. Pass
`?model=` when vending so the broker ranks entitled accounts first, and report
the 400 to `/model-unsupported` so the whole fleet stops rediscovering it.

There is a second, unrelated 400: `requires a newer version of Codex`. That one
is about the `version` header. Don't try to fix the entitlement 400 by sending
a version header. When we measured it, the same gated accounts failed on every
version, and pinning a version is actively risky: a hardcoded value becomes the
stale one as soon as OpenAI raises the floor, and then every account fails.
Sending no `version` header has never been gated. `probe_version_matrix.py`
reproduces the matrix.

## Failures arrive inside HTTP 200

The Codex path reports capacity failures in the SSE stream, under a 200:

```
data: {"type":"error","error":{"type":"service_unavailable_error",
       "code":"server_is_overloaded","message":"Our servers are currently overloaded."}}
data: {"type":"response.failed","response":{"status":"failed",...}}
```

`res.ok` is true, the stream ends cleanly, and there is no text. Anything that
scores a turn on HTTP status counts these as successes. Count a turn as
successful only when text actually arrives.

Parse events rather than substring-matching. Note that `"output_text.delta"`
does not occur as a substring of `"response.output_text.delta"` when preceded
by a quote, so naive matching reports every good turn as empty:

```ts
const ev = JSON.parse(line.slice(6));
if (ev.type === "response.output_text.delta") parts.push(ev.delta ?? "");
if (ev.type === "error" || ev.type === "response.failed") {
  const code = ev.error?.code ?? ev.response?.error?.code ?? "unknown";
  throw new Error(`codex in-stream failure: ${code}`); // back off; do not rotate
}
```

`probe_sse_shape.py` dumps every event with arrival time; `probe_sol_truth.py`
measures the true success rate per model.

## What the broker gives you

`GET /token` accepts:

- `?model=<id>`: rank accounts entitled to that model first, keeping the rest
  as fallback. Pass this. Without it you vend blind.
- `?avoid=<a,b,c>`: a comma-separated set of every account you have already
  tried and seen fail. Passing only the most recent one lets the broker hand
  you the same bad accounts again. If the set excludes everything, the broker
  drops the filter and still returns a token.
- `?account=<label>` pins one. `?force=1` bypasses the access-token cache (use
  after a 401 `token_invalidated`).

`POST /model-unsupported?account=<label>&model=<id>` records an account/model
gate. Call it when you see the "not supported with a ChatGPT account" 400.

`POST /rate-limit?account=<label>` cools an account fleet-wide (~5h) after a
429 `usage_limit_reached`.

## Reference client

The important parts: pass `model`, accumulate `tried` across attempts, and
report the two permanent conditions back to the broker.

```ts
export async function codex(system: string, user: string, timeoutMs = 2_700_000): Promise<string> {
  const broker = need("RAILWAY_BROKER_URL").replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${need("RAILWAY_BROKER_API_KEY")}` };

  // Every account already tried, not just the last one. Re-offering a
  // known-bad account can burn the whole retry budget before reaching a
  // good one.
  const tried = new Set<string>();
  let lastErr = "";

  for (let attempt = 1; attempt <= 8; attempt++) {
    const q = new URLSearchParams({ model: CODEX_MODEL });
    if (tried.size) q.set("avoid", [...tried].join(","));
    const vend = await fetch(`${broker}/token?${q}`, { headers: auth, signal: AbortSignal.timeout(90_000) });
    const tok = (await vend.json()) as { access_token?: string; account_id?: string; label?: string };
    if (!tok.access_token) throw new Error(`broker vend failed: ${JSON.stringify(tok).slice(0, 200)}`);

    const res = await fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tok.access_token}`,
        "chatgpt-account-id": tok.account_id ?? "",
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        accept: "text/event-stream",
        // deliberately no `version` header, see above
      },
      body: JSON.stringify({
        model: CODEX_MODEL,
        instructions: system,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: user }] }],
        reasoning: { effort: CODEX_EFFORT },
        store: false,
        stream: true, // the Codex backend only speaks SSE
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.ok && res.body) {
      const out = (await sseOutputText(res)).trim();
      if (out) return out;
      lastErr = "codex backend returned no text";
      continue;
    }

    const bodyText = (await res.text().catch(() => "")).slice(0, 300);
    lastErr = `HTTP ${res.status}: ${bodyText}`;
    if (tok.label) tried.add(tok.label);

    if (res.status === 429 && bodyText.includes("usage_limit_reached") && tok.label) {
      await fetch(`${broker}/rate-limit?account=${encodeURIComponent(tok.label)}`, { method: "POST", headers: auth }).catch(() => {});
      continue;
    }
    if (res.status === 400 && bodyText.includes("not supported") && tok.label) {
      await fetch(
        `${broker}/model-unsupported?account=${encodeURIComponent(tok.label)}&model=${encodeURIComponent(CODEX_MODEL)}`,
        { method: "POST", headers: auth }
      ).catch(() => {});
      continue;
    }
    if (res.status === 401 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1_500 * attempt));
      continue;
    }
    break; // non-retryable
  }
  throw new Error(`codex call failed after rotation: ${lastErr}`);
}
```

## Verifying a client

`probe_fallback_chain.py <model>` mimics a client exactly: vend, call, and on
failure re-vend with the accumulated `avoid` set. It fails loudly if the broker
ever hands back an account already tried.
