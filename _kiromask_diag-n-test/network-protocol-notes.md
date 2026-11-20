# Network protocol notes (as observed)

> **Two chat transports exist.** Older builds / feature flags use `GenerateAssistantResponse` over the AWS binary event
> stream (documented below). Kiro 1.4.178 with current server-side flags (`GetFeatureConfiguration` returns
> `"create_response"`) sends chat as **`POST runtime.us-east-1.kiro.dev/v1/responses`** — see
> [the Responses transport](#the-responses-transport-post-v1responses) at the end. Kiro Mask handles both.

What Kiro sends and expects, and how Kiro Mask handles each part. Observed from recorded traffic of
**Kiro 1.4.178** (stable channel, Windows, November 2026). Kiro changes this protocol between releases; when
something stops working, record fresh traffic with `capture.mjs` (in this folder) and
replay it with the tests (`KIROMASK_CAPTURES=<capture folder> node run-tests.mjs`).

## Transport

- Every request is HTTPS/1.1, one connection per request (`Connection: close`), via the proxy configured by the
  launcher. Bearer token in `Authorization`. Chromium's updater offers HTTP/2; Kiro's own clients do not.
- Hosts (all under `kiro.dev` unless noted):

| Host | What it is |
|---|---|
| `runtime.us-east-1.kiro.dev` | chat (`GenerateAssistantResponse`), MCP (`InvokeMCP`, and `POST /mcp`) |
| `management.us-east-1.kiro.dev` | model list, usage limits, feature flags, user preferences |
| `prod.us-east-1.auth.desktop.kiro.dev` | token refresh (`POST /refreshToken`) |
| `telemetry.us-east-1.kiro.dev` | OpenTelemetry (`/v1/traces`, `/v1/metrics`) |
| `app.kiro.dev` | web settings service (Smithy RPC v2 over **CBOR**) |
| `prod.download.desktop.kiro.dev` | update metadata (`/stable/metadata-<platform>-…json`) |
| `dc.services.visualstudio.com` | Microsoft telemetry (strict TLS; not intercepted) |

## Operations are named in a header, not the URL

Service calls are AWS JSON 1.0 RPC: `POST /` with `Content-Type: application/x-amz-json-1.0` and the operation in
`X-Amz-Target: <Service>.<Operation>`. Kiro Mask classifies by that header (any host), and by URL path as a
fallback for path-addressed operations.

| `X-Amz-Target` | Handled as |
|---|---|
| `KiroRuntimeService.GenerateAssistantResponse` | **chat** → custom model, or Kiro untouched |
| `KiroControlPlaneBearerService.ListAvailableModels` | **model list**: Kiro's models + yours merged |
| `KiroControlPlaneBearerService.GetUsageLimits`, `GET /getUsageLimits` | **usage**: passed through (real numbers), or a local "nothing used" answer |
| `KiroRuntimeService.InvokeMCP`, `POST /mcp` | **MCP**: `web_search` can be rewritten or answered locally |
| `…GetFeatureConfiguration`, `…GetUserPreference`, others | passed through |

## Chat request

Body: `{ "agentMode": "...", "profileArn": "...", "conversationState": { ... } }`. `conversationState` carries
`conversationId`, `rootConversationId`, `history[]`, `currentMessage.userInputMessage` (`content`, `modelId`,
`userInputMessageContext.tools[]` / `.toolResults[]`) — the same structure as before.

- **`agentMode`**: `default-v2` for normal chat, `session-title` for title requests. The header
  `x-amzn-kiro-mode-identifier` carries the same value.
- **System prompt**: `history[0]` is a user turn with Kiro's system prompt, immediately followed by an assistant
  turn whose content is exactly `I will follow these instructions.` Kiro Mask recognises the **pair** (not the
  text) and sends it as the provider's real system message. The text is now only a short *"(contd.)"* supplement:
  Kiro's main system prompt is added on Kiro's servers, so a custom model never sees it. `prompt.preamble`
  (default: a short built-in text) stands in for it.
- **Tools**: `toolSpecification` `{name, description, inputSchema: {json: …}}`, snake_case names (`read_file`,
  `fs_write`, `execute_pwsh`, `str_replace`, `web_fetch`, `load_resource`, `invoke_sub_agent`, `tool_call`).
  History may use tools that are no longer in the current list.
- **Tool calls in history**: assistant `toolUses[]` (`toolUseId`, `name`, `input` as an object); the next user
  turn carries `toolResults[]` (`toolUseId`, `status`, `content[{text}]`). Always paired.
- **Model**: `modelId` is whatever the picker holds; native models (e.g. `minimax-m2.1`, `auto`) come from
  `ListAvailableModels`.

### Session titles

For each new conversation Kiro sends `modelId: "simple-task"`, `agentMode: "session-title"`, no history, no tools.
The content is Kiro's instructions followed by `<first_message>` + the user's message (the *last* occurrence of the
tag; the instructions mention it earlier). It expects a 3–6 word, Title Case noun phrase as the streamed reply.
Kiro Mask answers locally by default (`session_title: local`), or asks a model.

## Chat response (`application/vnd.amazon.eventstream`)

Binary frames (length, headers, JSON payload, CRC32). Event order:

1. `initial-response` `{conversationId: ""}` (content-type `application/x-amz-json-1.0`)
2. `assistantResponseEvent` `{content, modelId}` — an empty first event, then text chunks
3. optionally `reasoningContentEvent` `{text}` … and a final one with `{signature}`
4. tool calls: `toolUseEvent` start `{name, toolUseId}`, input chunks `{input, name, toolUseId}`, stop `{…, stop: true}`
5. `metadataEvent` `{stopReason}` — `END_TURN` or `TOOL_USE` (Kiro Mask also emits `MAX_TOKENS`)
6. `contextUsageEvent` `{contextUsagePercentage}`
7. `meteringEvent` `{unit, unitPlural, usage}` — Kiro's credits; never emitted for custom models

Kiro Mask emits 1, 2 (with the requested `modelId`), 4, 5 and 6 for custom models, and 3 only with
`reasoning: native` (experimental; no signature is available).

## Other responses

- **ListAvailableModels**: `{models: [{modelId, modelName, description, rateMultiplier, rateUnit, tokenLimits,
  supportedInputTypes, promptCaching}], defaultModel: {modelId}}`. Custom entries use the same shape.
- **GetUsageLimits**: `{nextDateReset, overageConfiguration, subscriptionInfo, usageBreakdownList[], userInfo}`
  (the path-style variant adds `daysUntilReset`, `limits`).
- **InvokeMCP / `/mcp`**: JSON-RPC 2.0; `tools/list` (with `params.includeHidden`) and `tools/call`.
- **refreshToken**: `{accessToken, expiresIn, profileArn, refreshToken}`.
- **CBOR calls** (`app.kiro.dev`): when swallowed, answered with an empty CBOR map (`0xA0`).

## The Responses transport (`POST /v1/responses`)

Recorded from Kiro 1.4.178. Same host (`runtime.us-east-1.kiro.dev`), same auth headers; the body and reply follow the
OpenAI *Responses* shape, with Kiro extensions under `kiro:` names.

**Request** `{ model, input: [...], tools: [...], stream: true, origin, profileArn, metadata }`
- `model`: the model id Kiro's picker chose (custom models arrive under their injected id; `simple-task` for session titles).
- `metadata`: `kiro:agent_mode` (`default-v2`, `session-title`), `kiro:mode_identifier`, `kiro:conversation_id`, `kiro:root_conversation_id` (`sess_…`).
- `input` items: `{role:"user"|"assistant", content: string | [parts]}`, `{type:"function_call", call_id, name, arguments: "<json string>"}`, `{type:"function_call_output", call_id, output: string}`.
  Every call is its own item (not grouped like the AWS `toolUses`). The conversation still opens with the system prompt as a user message
  (`# Kiro - System Prompt…`) answered by the canned assistant line `I will follow these instructions.`; steering rules follow the last tool output as a user message.
- `tools`: `[{type:"function", name, description, parameters}]` — optional parameters are `type: ["string","null"]`.

**Response** `text/event-stream`, events `event: <type>\ndata: {...,"sequence_number":n}`, terminated by `data: [DONE]`:

| turn | events |
|---|---|
| start | `response.created`, `response.in_progress` (full response object incl. echoed `metadata`, `tools`) |
| text item | `output_item.added`(message) · `content_part.added` · `output_text.delta`* · `output_text.done` · `content_part.done` · `output_item.done` |
| tool call | `output_item.added`(function_call: `id`, `call_id`, `name`) · `function_call_arguments.delta`* · `function_call_arguments.done` · `output_item.done`(+`arguments`,`status`) |
| end | `response.completed` — `status` is **`requires_action`** when the turn ended in tool calls, else `completed`; `usage: {"kiro:credits": {value, unit, unit_plural}, "kiro:context_usage_percentage": n}` |

Kiro Mask's `ResponsesEncoder` (`_kiromask-src/translate/encoders.mjs`) is tested against these recordings event by event
(`tests/responses.test.js`, fixtures in `tests/fixtures/responses/`). Not verified: how the client
reacts to `reasoning` items (dropped), to a missing `kiro:credits` (always sent, value 0 for custom models), or to
`response.incomplete` (not used; a length cut-off is reported as a normal completion plus a visible note).

## Older notes from the python version (KiroPipe, Feb–Mar 2026)

Written while building the mitmproxy-based python version (the `_kiropipe-py_archived` folder), before the recordings above. They use
the older path-style names on `q.us-east-1.amazonaws.com` (`/generateAssistantResponse`); newer builds name the operation in
`X-Amz-Target` instead (see above). Nothing here was re-checked against Kiro 1.4.178 unless it says so.

### Endpoints seen then

| Host | Path | Method | What it is |
|---|---|---|---|
| `prod.us-east-1.auth.desktop.kiro.dev` | `/oauth/token` | POST | exchanges the OAuth code for access + refresh tokens |
| same | `/logout` | POST | invalidates the refresh token |
| `q.us-east-1.amazonaws.com` | `/generateAssistantResponse` | POST | chat |
| same | `/generatecompletions` | POST | inline completions (autocomplete) |
| same | `/ListAvailableModels` | POST | model list |
| same | `/getUsageLimits` | GET | usage bar / credits |
| `prod.us-east-1.telemetry.desktop.kiro.dev` | `/v1/metrics`, `/v1/traces` | POST | OpenTelemetry. Sent whatever the model or login state, logged out too |
| download host | `metadata-win32…` | GET | update check |

### Login token

`/oauth/token` answers `{accessToken, expiresIn, profileArn, refreshToken}`. The `accessToken` becomes the
`Authorization: Bearer …` header of every later request, and the `profileArn` shows up in the query of `getUsageLimits`.
Faking the login (answering `/oauth/token` and `/logout` locally with a structurally valid token) was planned on the idea that
the value does not matter if every later request is intercepted too, but it was never implemented in the python version.
`getUsageLimits` for a free account was recorded as `{"limits": [], "subscriptionInfo": {"type": "FREE"}}`.

### Completions

Request carries a `fileContext`. Reply shape:

```json
{"completions": [{"content": "<code>", "mostRelevantMissingImports": [], "references": []}],
 "modelId": null, "nextToken": "", "predictions": []}
```

An empty `completions` array with the rest the same was enough to turn autocomplete off. A custom completions model has to
rewrite its answer into this shape.

### The second chat request ("credits used")

While a custom model was answering, Kiro also sent a second `generateAssistantResponse` to the real AWS (no `modelId`, or a
Kiro one). Its reply was a small (about 1251 bytes) event stream holding the `metering` and `contextUsage` frames, which is
what Kiro shows as "Credits used". The python version answered any chat request that was still unanswered while blocking with
an empty 200 event stream. This may be related to the small credit charge that still shows up, see `to_do.txt` in the project root.

### Model list

`ListAvailableModels` was let through once to learn Kiro's own list, then answered from that cached list plus the custom
models. With no AWS at all, only the configured models plus a hardcoded template were shown.

### Left open then

- Other calls made after login (a profile fetch, maybe `/getProfile` on `q.amazonaws.com`) that could gate features were never identified.
- Blocking was by exclusion: telemetry, completions (with a custom model), usage limits (with a custom model) and update
  checks were blocked, everything unknown was let through. A strict allow-list was never built.
