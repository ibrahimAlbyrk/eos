# 06 — External Ecosystem: Provider-Agnostic Agentic Tool-Use (Ground Truth)

Research dimension: EXTERNAL ECOSYSTEM. Goal — bring outside ground truth on how to
build a clean, SOLID, provider-agnostic agentic tool-use loop so the architect designs
on best practice, building on Eos's existing `ModelClient` shape rather than greenfield.

Anchored in the current Eos code:
- `core/src/ports/ModelClient.ts` — `createTurn(messages)` + optional `streamTurn(messages, cb)` → `ModelTurn { text?, reasoning?, toolCalls, stopReason: end_turn|tool_use|max_tokens|error, usage }`; `ModelMessage { role: user|assistant|tool, content: unknown }`; `ModelToolCall { callId, name, input }`.
- `core/src/use-cases/ToolRuntime.ts` — the Eos-hosted loop: call model → gate+execute every tool call at one chokepoint → feed `tool_result` back → repeat (max 50), emitting canonical `AgentEvent`s.
- `infra/src/backends/AnthropicModelClient.ts` — `POST /v1/messages`, content-block parse (text/thinking/tool_use), reads `cache_read_input_tokens`. **No `streamTurn`.**
- `infra/src/backends/OpenAIModelClient.ts` — `POST /v1/chat/completions`, function tools, `reasoning_content` (DeepSeek/Kimi), SSE `streamTurn` buffering `tool_calls` by `index`, `baseUrl` override for OpenAI-compatible servers.
- `manager/container.ts:758` wires both with `{apiKey, model, baseUrl, tools}`; `contracts/src/backend.ts` `BackendProfile { kind, model, baseUrl?, auth?, pricing?, costMode?, params?: Record<string,unknown> }`.

Citation convention: every external claim = **statement** + *verbatim quote* + source URL + date. Sources accessed **2026-06-30** unless a publish date is noted. Thin / single-source claims are tagged **[LOW-CONFIDENCE]**.

---

## 1. Summary — key takeaways

1. **The dominant pattern is "normalize at the edge, never branch on provider in the loop" — but the *shape* you normalize to splits by what you're building, and the split puts Eos squarely on the neutral-internal side.** Wire-level **gateways** (LiteLLM, OpenRouter) normalize to the **OpenAI Chat Completions** shape for drop-in compatibility with existing OpenAI-SDK callers — LiteLLM: *"Every response follows the OpenAI Chat Completions format, regardless of provider."* ([LiteLLM](https://docs.litellm.ai/docs/), © 2026); OpenRouter *"normalizes the schema across models and providers to comply with the OpenAI Chat API."* ([OpenRouter overview](https://openrouter.ai/docs/api/reference/overview)). In-process **SDKs/frameworks** (Vercel AI SDK, LangChain) instead define their **own neutral internal representation** that each provider adapter implements — Vercel: *"The AI SDK's prompt and content structures are provider-agnostic, requiring conversion logic that maps between the standardized `LanguageModelV4Prompt` format and each provider's native API requirements."* ([Vercel, custom providers](https://ai-sdk.dev/providers/community-providers/custom-providers)); LangChain: *"`AIMessage.tool_calls` provides a standardized interface for getting model tool invocations."* ([LangChain, tool-calling blog](https://blog.langchain.com/tool-calling-with-langchain/)). **Eos is an in-process orchestrator with an `AgentBackend` port + capability descriptor — it belongs with the AI SDK/LangChain camp, and `ModelTurn` already IS that neutral shape.** Do not adopt an OpenAI-shape passthrough internally (§3.1 explains why that specifically breaks on Anthropic thinking). The design job: (a) keep the dialect adapters thin, (b) move every per-provider quirk into a capability descriptor, (c) add a native escape-hatch field (next point).

2. **The one truly universal idea across all four abstractions: a normalized surface PLUS a provider-native escape hatch.** None of them lossily discards data the neutral shape can't express. LiteLLM/OpenRouter preserve the raw value in `provider_specific_fields["native_finish_reason"]` / `native_finish_reason`; Vercel uses `providerOptions`/`providerMetadata`; LangChain keeps `additional_kwargs` + lazy `.content_blocks`. **Recommendation: give `ModelTurn` an optional `providerMetadata?: Record<string,unknown>` sidecar** so adapters can stash the native stop reason, signed thinking blocks, cache fields, etc. without bloating the neutral contract.

3. **You need only TWO wire dialects to cover the whole ecosystem, not one-per-provider.** Anthropic Messages is its own dialect; *everything else* — OpenAI, Ollama, vLLM, LM Studio, LiteLLM proxy, OpenRouter, DeepSeek, GLM — speaks **OpenAI Chat Completions**. Eos's two existing clients (`AnthropicModelClient` + `baseUrl`-swappable `OpenAIModelClient`) are therefore the *complete* transport set; local models are reached by pointing `baseUrl` at `localhost`, no new class. This is the single most important pattern to adopt (and Eos is already 80% there).

4. **Target Chat Completions, NOT the OpenAI Responses API.** OpenAI now says *"While Chat Completions remains supported, Responses is recommended for all new projects."* ([OpenAI](https://developers.openai.com/api/docs/guides/responses-vs-chat-completions)) — but Responses is OpenAI-proprietary; none of the OpenAI-*compatible* ecosystem implements it. For a "talk to ANY provider" lane, Chat Completions is the portable target. Eos's `OpenAIModelClient` already chose correctly.

5. **The biggest cross-provider footgun is the reasoning round-trip rule — and it is OPPOSITE across providers.** DeepSeek's reasoner *"will return a `400` error"* if you echo `reasoning_content` back in history; Anthropic *requires* you to *"pass `thinking` blocks back to the API"* (signed) across tool turns or it returns *"a 400 `invalid_request_error`"*. A single mishandling rule breaks the loop on one provider or the other. (Runner-up footgun: **prompt caching is essentially non-portable** — Anthropic is explicit/opt-in, OpenAI/DeepSeek are automatic, with three different usage-field shapes — and Eos's current message mapper injects **no** `cache_control` breakpoints, so the Anthropic API lane gets **zero** caching today.)

6. **Streaming is two different protocols, not one.** OpenAI streams a flat `choices[].delta` with `tool_calls` fragments keyed by `index`. Anthropic streams **typed events** (`message_start` → `content_block_start`/`content_block_delta`/`content_block_stop` → `message_delta` → `message_stop`), with tool input arriving as `input_json_delta.partial_json` to be accumulated and parsed at `content_block_stop`. The two `streamTurn` parsers must stay separate; only the *output* (`ModelTurn` + `ModelStreamCallbacks`) unifies. Eos has the OpenAI parser; the Anthropic one is missing.

7. **"OpenAI-compatible" is a spectrum, not a guarantee.** Tool calling, tool-call streaming, `tool_choice`, structured-output envelopes, and `reasoning_content` history rules all diverge across local servers. Capabilities must be **declared per model/endpoint in config**, never assumed from the fact that an endpoint speaks `/v1/chat/completions`.

---

## 2. Provider landscape & normalization (shape differences)

### 2.1 Anthropic Messages API — the one non-OpenAI dialect

**Tool definition & flow.** Tools carry an `input_schema`; the model returns `tool_use` blocks and `stop_reason: "tool_use"`; you reply with a `tool_result`.
> *"**Client tools** … run in your application. Claude responds with `stop_reason: "tool_use"` and one or more `tool_use` blocks. Your code executes the operation and sends back a `tool_result`."* — [Anthropic, Tool use overview](https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview), accessed 2026-06-30.

**Tool-result threading is positionally strict** — the continuation is a *user* message containing **only** `tool_result` blocks, one per `tool_use`:
> *"The continuation is a user message of `tool_result` blocks, one for every `tool_use` block in the response"* … *"that message must contain nothing except the `tool_result` blocks."* — [Anthropic, Handling stop reasons](https://platform.claude.com/docs/en/docs/build-with-claude/handling-stop-reasons), accessed 2026-06-30.

Eos already does this in `toAnthropicMessage` (tool role → `{role:"user", content:[{type:"tool_result", tool_use_id, content, is_error}]}`). ✔

**Stop reasons (7 values)** — a superset of what Eos normalizes:
> *"`end_turn` — Claude finished its response naturally. `max_tokens` — The response reached your `max_tokens` limit. `stop_sequence` — Claude emitted one of your `stop_sequences`. `tool_use` — Claude is calling a tool. `pause_turn` — A server-tool loop reached its iteration limit. `refusal` — Claude declined to respond. `model_context_window_exceeded` — The response filled the model's context window."* — [Anthropic, Handling stop reasons](https://platform.claude.com/docs/en/docs/build-with-claude/handling-stop-reasons), accessed 2026-06-30.

Eos maps to `{end_turn, tool_use, max_tokens, error}`. `stop_sequence`/`refusal` fold acceptably into `end_turn`; `pause_turn` is a *server-tool* concept and won't arise for Eos's client-tool loop; `model_context_window_exceeded` should map to `error` (currently falls through to `end_turn` — minor gap).

**Strict tool use** is now available to guarantee schema conformance:
> *"Add `strict: true` to your custom tool definitions to ensure Claude's tool calls always match your schema exactly."* — [Anthropic, Tool use overview](https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview), accessed 2026-06-30.

### 2.2 OpenAI Chat Completions — the lingua franca

**Tool definition.** A `tools` array of `{type:"function", function:{name, description, parameters, strict}}`:
> *"A function definition has the following properties: … `type` This should always be `function` … `name` … `description` … `parameters` JSON schema defining the function's input arguments … `strict` Whether to enforce strict mode for the function call"* — [OpenAI, Function calling](https://developers.openai.com/api/docs/guides/function-calling), accessed 2026-06-30.

**Response shape.** `tool_calls[]` each with `id` + `function.{name, arguments-as-JSON-string}`:
> *"The response has an array of `tool_calls`, each with an `id` (used later to submit the function result) and a `function` containing a `name` and JSON-encoded `arguments`."* — [OpenAI, Function calling](https://developers.openai.com/api/docs/guides/function-calling), accessed 2026-06-30.

**Tool-result threading** uses a flat `role:"tool"` message keyed by `tool_call_id` (NOT Anthropic's nested user/`tool_result`):
> result message shape `{"role": "tool", "tool_call_id": tool_call.id, "content": str(result)}` — [OpenAI, Function calling](https://developers.openai.com/api/docs/guides/function-calling), accessed 2026-06-30.

Eos handles this in `toOpenAIMessage`. ✔ **Stop reason** is `finish_reason` (`stop`/`length`/`tool_calls`/`content_filter`); Eos maps `length → max_tokens`, presence of tool calls → `tool_use`, else `end_turn`. ✔

**This is the shape EVERY other provider mimics** — the normalization target.

### 2.3 The normalization spectrum across OpenAI-compatible servers

Sourced by the local-servers research pass; the cross-cutting table below lists what *breaks a naive OpenAI client*. (Quotes verbatim; URLs + dates inline.)

| Server | Tool calling | Key divergences (what bites) |
|---|---|---|
| **Ollama** `/v1` | `tool_calls` supported on `/v1/chat/completions` | `tool_choice` **unsupported**; **streaming + tools breaks** (collapses to one block); historically missing `index` on streamed deltas |
| **vLLM** | `--enable-auto-tool-choice` + `--tool-call-parser <p>` required | parser **must match model**; with named `tool_choice`, first chunk historically missing `"type":"function"`; `hermes` parser can emit tool calls **as raw text** in streaming; Mistral parser wants **9-digit** ids |
| **LM Studio** | matches OpenAI `choices[0].message.tool_calls` + `finish_reason:"tool_calls"` | closest to OpenAI; falls back to prompt-based format for models without a tool chat template |
| **LiteLLM proxy** | unified OpenAI shape over 100+ providers | normalizes via capability map + `drop_params`; routes by model prefix (`anthropic/`, `ollama_chat/`) |
| **OpenRouter** | OpenAI Chat Completions passthrough | drop-in via base URL; auto fallbacks |
| **DeepSeek** | tool calls supported on V3.x chat (thinking mode) | reasoner model **disallows function calling**; `reasoning_content` extra field; **400 if `reasoning_content` echoed back** |
| **GLM (Z.ai)** | `tool_calls` supported | non-standard `thinking` param; `reasoning_content` in delta; streamed tool calls tracked by `index` (id may be absent) |

Verbatim anchors for the highest-impact rows:

- Ollama tools: *"Ollama's OpenAI compatible endpoint also now supports tools"* / *"Supported models will now answer with a `tool_calls` response."* — [Ollama blog](https://ollama.com/blog/tool-support), published 2024-07-25.
- Ollama `tool_choice` unsupported: *"[ ] `tool_choice`"* — [Ollama OpenAI-compat docs](https://docs.ollama.com/api/openai-compatibility), accessed 2026-06-30.
- Ollama streaming+tools broken: *"When enabling `tools`, the Ollama API seems to break streaming (`stream=True`) on the `/v1` endpoint."* / *"Instead of returning chunks … it waits and sends the entire response as a single block."* — [ollama#9092](https://github.com/ollama/ollama/issues/9092), filed 2025-02-14.
- vLLM flags: *"--enable-auto-tool-choice -- **mandatory** … --tool-call-parser -- select the tool parser to use."* — [vLLM tool calling](https://docs.vllm.ai/en/latest/features/tool_calling.html), accessed 2026-06-30.
- vLLM raw-text leak: *"tool calls are correctly parsed in non-streaming mode but fail to be parsed in streaming mode"* / *"Tool calls are returned as raw text `<tool_call>...</tool_call>` in the `content` field"* — [vllm#31871](https://github.com/vllm-project/vllm/issues/31871), filed 2026-01-07. **[LOW-CONFIDENCE on resolution status.]**
- LM Studio shape: *"an array of tool call request objects will be provided in the response field, `choices[0].message.tool_calls`"* / *"The `finish_reason` field … will also be populated with `"tool_calls"`."* — [LM Studio tools](https://lmstudio.ai/docs/developer/openai-compat/tools), accessed 2026-06-30.
- LiteLLM normalization + drop_params: *"LiteLLM maps all supported openai params by provider + model"* / *"When `drop_params=True` is set, LiteLLM will drop the unsupported parameter instead of raising an exception."* — [LiteLLM drop_params](https://docs.litellm.ai/docs/completion/drop_params), accessed 2026-06-30.
- LiteLLM tool fallback for non-supporting models: *"not all ollama models support function calling, litellm defaults to json mode tool calls if native tool calling not supported"* — [LiteLLM Ollama](https://docs.litellm.ai/docs/providers/ollama), accessed 2026-06-30.
- DeepSeek reasoner blocks tools: *"Not Supported Features: Function Calling, FIM (Beta)"* — [DeepSeek reasoning model](https://api-docs.deepseek.com/guides/reasoning_model), accessed 2026-06-30.

**Normalization takeaway:** the *response* shapes converge on OpenAI's, but **streaming tool calls, `tool_choice`, and reasoning fields diverge**. A robust client must: tolerate missing `index`/`id`/`type` on streamed tool deltas; tolerate tool calls arriving as text (or simply prefer non-streaming for known-broken parsers); and treat `tool_choice`/structured-output/effort params as *capability-gated*, droppable per model (the LiteLLM `drop_params` lesson).

---

## 3. Recommended provider-agnostic abstraction for Eos

The headline: **Eos's existing `ModelClient`/`ModelTurn`/`ToolRuntime` triad is the correct architecture and matches the industry pattern. Do not redesign it — harden it along four axes.** Each recommendation is mapped to a SOLID principle and to the concrete file.

### 3.1 Keep `ModelTurn` as the neutral internal shape (don't couple to OpenAI's wire shape) — DIP

The two-camp split (Summary §1) is decisive here: in-process SDKs (Vercel AI SDK, LangChain) define a neutral internal type; wire gateways (LiteLLM, OpenRouter) reuse OpenAI's envelope only because they must accept what existing OpenAI-SDK callers already send. Eos owns both sides of the call, so it should be in the neutral camp — and `ModelTurn`/`ModelMessage`/`ModelToolCall` already is a *minimal neutral* type that is neither Anthropic's nor OpenAI's. **Why this specifically matters and isn't just taste:** the OpenAI envelope structurally *cannot* hold Anthropic's signed thinking blocks — LiteLLM documents that *"OpenAI's Chat Completions spec has no field for `thinking_blocks`"*, so *"OpenAI-compatible clients (LibreChat, Open WebUI, Vercel AI SDK) ignore this field, causing thinking blocks to be lost when reconstructing multi-turn conversations"* → 400 ([LiteLLM, reasoning_content](https://docs.litellm.ai/docs/reasoning_content), accessed 2026-06-30). A neutral type + escape hatch dodges that. The `ToolRuntime` loop depends on the abstraction; each adapter maps wire→`ModelTurn`. **Recommendation: confirm and freeze `ModelTurn` as the single internal contract (plus the `providerMetadata?` escape hatch from Summary §2); all dialect work stays inside the adapters.**

### 3.2 Two dialect adapters cover the ecosystem; extend by config, not subclassing — OCP

The whole ecosystem is two wire dialects:
- `AnthropicModelClient` → Anthropic Messages (`/v1/messages`).
- `OpenAIModelClient` → OpenAI Chat Completions (`/v1/chat/completions`) — **and** OpenAI-compatible local/proxy servers via `baseUrl`. Confirmed: OpenRouter is *"a drop-in replacement"* by base URL ([OpenRouter](https://openrouter.ai/docs/quickstart)); LM Studio/Ollama/vLLM all expose `/v1/chat/completions`.

So a new provider (Ollama at `localhost:11434/v1`, vLLM, GLM, DeepSeek, OpenRouter, a LiteLLM proxy) is added by writing a **`BackendProfile`** (`{kind, model, baseUrl, params}`) — **no new class**. This is textbook Open/Closed and aligns with Eos's "branch on capabilities, never on backend `kind`" rule. The only justification for a *third* adapter would be a genuinely third wire dialect (e.g. native Ollama `/api/chat`, which LiteLLM recommends over `/v1` for tools) — defer unless `/v1` proves too lossy.

### 3.3 Add `streamTurn` to `AnthropicModelClient` — but with a SEPARATE parser — ISP + SRP

`streamTurn` being optional on `ModelClient` is correct ISP (the runtime already falls back to `createTurn`). The Anthropic stream is a **different protocol** and needs its own drain function:

> Event flow: *"1. `message_start`: contains a `Message` object with empty `content`. 2. A series of content blocks, each of which has a `content_block_start`, one or more `content_block_delta` events, and a `content_block_stop` event. … 3. One or more `message_delta` events … 4. A final `message_stop` event."* — [Anthropic, Streaming](https://platform.claude.com/docs/en/docs/build-with-claude/streaming), accessed 2026-06-30.

> Tool input streams as partial JSON: *"The deltas for `tool_use` content blocks correspond to updates for the `input` field … the deltas are *partial JSON strings*, whereas the final `tool_use.input` is always an *object*. You can accumulate the string deltas and parse the JSON once you receive a `content_block_stop` event"* (delta shape `{"type":"input_json_delta","partial_json":"{\"location\": \"San Fra"}`). — [Anthropic, Streaming](https://platform.claude.com/docs/en/docs/build-with-claude/streaming), accessed 2026-06-30.

> Thinking streams via `thinking_delta`, closed by a `signature_delta` *"sent just before the `content_block_stop` event."* — same source.

> **Usage in `message_delta` is cumulative:** *"The token counts shown in the `usage` field of the `message_delta` event are *cumulative*."* — same source.

Implementation contrast vs the existing OpenAI parser (`parseOpenAIStream`): OpenAI buffers `tool_calls` by `delta.tool_calls[].index` and concatenates `function.arguments`; Anthropic buffers `input_json_delta.partial_json` by content-block `index` and parses at `content_block_stop`. Reasoning maps to the same `onReasoningDelta` callback (`thinking_delta` ≈ `reasoning_content`). Usage must be taken as the **last** cumulative value, not summed. Keep these as two functions; share only `ModelStreamCallbacks`.

### 3.4 Move every per-provider quirk into a capability descriptor — OCP + "branch on capabilities, not kind"

`BackendProfile.params: Record<string,unknown>` is the existing hook but is untyped. Promote a typed **`ProviderCapabilities`** (config-driven, per model) so the loop and adapters read declared facts instead of `if (model.startsWith("deepseek"))`:

```
interface ProviderCapabilities {
  wire: "anthropic" | "openai-chat";        // which dialect adapter
  contextWindow: number;                     // never hardcode — per model
  supportsStreaming: boolean;                // Ollama /v1 + tools ⇒ false
  supportsParallelToolCalls: boolean;
  supportsTools: boolean;                    // deepseek-reasoner ⇒ false
  reasoning: "none" | "openai-effort" | "anthropic-thinking" | "reasoning_content";
  reasoningRoundTrip: "drop" | "preserve-signed" | "none";  // §4.4 — the #1 hazard
  cache: "none" | "anthropic-explicit" | "automatic";
  cacheMinTokens?: number;                   // per-model; under-threshold no-ops
  structuredOutput: "none" | "openai-response_format" | "anthropic-output_config" | "vllm-guided_json" | "ollama-format";
}
```

This is the same idea Eos already uses for `AgentCapabilities`/`BackendDescriptor`; extend it to the API lane. Two industry takes on "what to do with an unsupported param" frame the choice:
- LiteLLM *drops* it on opt-in: *"By default, LiteLLM raises an exception if you send a parameter to a model that doesn't support it."* … *"When `drop_params=True` is set, LiteLLM will drop the unsupported parameter instead of raising an exception."* ([LiteLLM, drop_params](https://docs.litellm.ai/docs/completion/drop_params)).
- OpenRouter *gates* on it: *"When you send a request with `tools` or `tool_choice`, OpenRouter will only route to providers that support tool use"*, and `require_parameters: true` hard-skips providers missing any requested param ([OpenRouter overview](https://openrouter.ai/docs/api/reference/overview)).

**Gating > silent-dropping.** Silent param drops are repeatedly the worst failure mode in the ecosystem (OpenRouter's silent-ignore default, LangChain's `with_structured_output()` silently dropping bound tools). Eos's capability descriptor + fail-closed gate already favor the loud/explicit path — keep it: a param the model can't honor should be a known no-op by capability, not a send-and-pray.

OpenRouter's **three-path tool transformation** is the model for Eos's tool mapper when it fronts arbitrary local servers: *"Will be passed down as-is for providers implementing OpenAI's interface. For providers with custom interfaces, we transform and map the properties. Otherwise, we transform the tools into a YAML template."* ([OpenRouter overview](https://openrouter.ai/docs/api/reference/overview)) — i.e. prompt-inject tool schemas for models with no native function calling (mirrors LiteLLM's *"defaults to json mode tool calls if native tool calling not supported"*). For Eos this is a `capabilities.supportsTools=false` branch, likely out of scope for v1.

### 3.5 Normalize the usage object at ingest (it is NOT uniform) — SRP

`ModelTurn.usage` normalizes input/output, but the cache field is leaking provider specifics:
- Anthropic: `input_tokens`/`output_tokens` + `cache_creation_input_tokens`/`cache_read_input_tokens`. (Eos reads `cache_read_input_tokens` ✔.)
- OpenAI: `prompt_tokens`/`completion_tokens` + `usage.prompt_tokens_details.cached_tokens`. **GAP: `OpenAIModelClient` does not read `cached_tokens`, so `cacheReadTokens` is always 0 on the OpenAI lane.**
- DeepSeek: `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` — a third shape Eos reads neither of.

Each adapter should map its provider's cache field into `ModelTurn.usage.cacheReadTokens` so the canonical `usage`/`context` events the `ToolRuntime` emits are accurate across providers.

### 3.6 The loop itself (`ToolRuntime`) is already best-practice — keep it

The find→gate→execute→feed-back→repeat loop with a single fail-closed chokepoint matches every agent framework's core. The industry framing, verbatim: *"Agents are large language models (LLMs) that use tools in a loop to accomplish tasks."* — [Vercel AI SDK](https://ai-sdk.dev/docs/foundations/agents), AI SDK 7, accessed 2026-06-30. Vercel's loop is exactly Eos's: *"When `stopWhen` is set and the model generates a tool call, the AI SDK will trigger a new generation passing in the tool result until there are no further tool calls or the stopping condition is met"*, with a default cap where *"agents stop after 20 steps using `isStepCount(20)`"* ([Vercel, loop control](https://ai-sdk.dev/docs/agents/loop-control), accessed 2026-06-30). Eos's `maxIterations` (default 50) is the same guard, and it already stops on `end_turn` with no tool calls. Two transferable refinements: (a) Vercel exposes *composable* stop conditions (step-count + `hasToolCall(name)` + custom predicate) where Eos has only a step cap — a hook worth considering; (b) a documented Vercel footgun — *"`stopWhen` only evaluates when the last step contains tool results"* — is a reminder that Eos's terminal-state check must handle a purely-text final step (it does, via `toolCalls.length === 0`). Note Vercel *removed* `maxSteps` in favor of `stopWhen` (v4→v5), evidence that a single integer cap was found too blunt over time.

---

## 4. Cross-provider gotchas (caching, tokens, structured output, effort)

### 4.1 Prompt caching — essentially NOT portable; Eos's Anthropic lane caches nothing today

- **Anthropic (explicit, opt-in breakpoints).** *"Place `cache_control` directly on individual content blocks"* with `"cache_control": {"type": "ephemeral"}`; *"You can define up to 4 cache breakpoints"*; default *"5-minute lifetime"*, optional `"ttl": "1h"`; min cacheable is **per model** (*"1,024 tokens for Claude Opus 4.8 …"*) and *"Any requests to cache fewer than this number of tokens will be processed without caching, and no error is returned."* — [Anthropic, Prompt caching](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching), accessed 2026-06-30.
- **OpenAI (automatic, no code).** *"Prompt Caching works automatically on all your API requests (no code changes required)"*; *"Caching is available for prompts containing 1024 tokens or more."*; exposed at *"`usage.prompt_tokens_details`"* `cached_tokens`; *"Cache hits are only possible for exact prefix matches."* — [OpenAI, Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), accessed 2026-06-30.
- **DeepSeek (automatic, on-disk, third field shape).** *"enabled by default for all users"*; reports *"`prompt_cache_hit_tokens`"* / *"`prompt_cache_miss_tokens`"* — [DeepSeek KV cache](https://api-docs.deepseek.com/guides/kv_cache), accessed 2026-06-30.

**Implication for Eos:** `toAnthropicMessage` injects **no** `cache_control`, so the API lane forfeits all Anthropic caching — and since worker prompts are assembled per-spawn (DPI) with a large, stable system prompt + tool schemas, this is exactly the high-value cacheable prefix being thrown away. Recommend a per-dialect, capability-gated "cache hint" step: for `cache:"anthropic-explicit"`, place `cache_control` breakpoints on the system block + tools (the stable prefix); for `cache:"automatic"`, no-op. Only the *prefix-stability discipline* (static content first, volatile last) is portable; the field names and opt-in model are not.

### 4.2 Structured / JSON output — converging on JSON Schema, different envelopes

- **OpenAI:** `response_format: {type:"json_schema", json_schema:{strict:true, schema:…}}`; *"Structured Outputs is the evolution of JSON mode. While both ensure valid JSON … only Structured Outputs ensure schema adherence."* — [OpenAI, Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), accessed 2026-06-30.
- **Anthropic — now NATIVE (correction to prior belief that only tool-use prefilling worked):** *"Structured outputs provide two complementary features: JSON outputs (`output_config.format`) … Strict tool use (`strict: true`)"*; GA on *"Claude Opus 4.8 … and Claude Haiku 4.5."* **But the JSON-Schema subset is limited:** NOT supported — *"Recursive schemas … External `$ref` … Numerical constraints (such as `minimum`, `maximum`, `multipleOf`) … String constraints (`minLength`, `maxLength`) … `additionalProperties` set to anything other than `false`"*, and *"Strict tools per request | 20"*. — [Anthropic, Structured outputs](https://platform.claude.com/docs/en/docs/build-with-claude/structured-outputs), accessed 2026-06-30.
- **Local servers don't follow `response_format`:** vLLM uses *"guided_json (output will follow the JSON schema)"* ([vLLM structured outputs](https://docs.vllm.ai/en/v0.9.2/features/structured_outputs.html)); Ollama uses a single `format` param (`"json"` or a schema object) **[LOW-CONFIDENCE — search-summary]** ([Ollama](https://docs.ollama.com/capabilities/structured-outputs)).

**Implication:** JSON Schema is the portable core; the *wrapper key* (`response_format` vs `output_config.format` vs `guided_json` vs `format`) and the *supported subset* are provider-specific → drive from `capabilities.structuredOutput`, and emit a conservative lowest-common-denominator schema (no recursion/$ref/numeric/string constraints).

### 4.3 Token counting & context limits — config-driven, never hardcoded

- Anthropic has a free count endpoint: `POST /v1/messages/count_tokens`, *"The response contains the total number of input tokens"*, and *"The token count should be considered an estimate."* — [Anthropic, Token counting](https://platform.claude.com/docs/en/docs/build-with-claude/token-counting), accessed 2026-06-30.
- OpenAI now has one too (correction to prior belief that only tiktoken existed): `POST /v1/responses/input_tokens` — *"The input token count endpoint accepts the same input format as the Responses API"* — but it's a **Responses-API** endpoint, so for the Chat Completions lane local `tiktoken` (plain text) remains the practical option; *"Tools and schemas add tokens that are hard to count locally."* — [OpenAI, Counting tokens](https://developers.openai.com/api/docs/guides/token-counting), accessed 2026-06-30.
- **Tokenizers changed across generations:** *"Claude Fable 5 and Claude Mythos 5 use the tokenizer introduced with Claude Opus 4.7, which produces roughly 30% more tokens … don't reuse token counts measured on a model before Claude Opus 4.7."* — [Anthropic, Token counting](https://platform.claude.com/docs/en/docs/build-with-claude/token-counting), accessed 2026-06-30.

**Implication:** usage field names (`input_tokens`/`output_tokens` vs `prompt_tokens`/`completion_tokens`) and context-window sizes and cache-min thresholds are per-provider/per-model → all belong in `ProviderCapabilities`, never as constants. DeepSeek/GLM/local servers have no count endpoint at all → fall back to local estimation or the returned `usage`.

### 4.4 Reasoning / effort — the #1 non-portable hazard (round-trip rules are OPPOSITE)

- **OpenAI:** discrete `reasoning_effort` enum (model-dependent values incl. *"minimal, low, medium, high"*); reasoning is hidden and billed as output: *"While reasoning tokens are not visible via the API, they still occupy space in the model's context window and are billed as output tokens."*; counted at *"`output_tokens_details: { "reasoning_tokens": 1024 }`"*. — [OpenAI, Reasoning](https://developers.openai.com/api/docs/guides/reasoning), accessed 2026-06-30.
- **Anthropic:** token *budget*, not enum — `"thinking": {"type":"enabled","budget_tokens":10000}`, and *"`budget_tokens` must be set to a value less than `max_tokens`."* Thinking blocks ARE returned (with `signature`). **Note `budget_tokens` is being deprecated on 4.6+ in favor of an effort/adaptive-thinking model** — *"Use adaptive thinking with the effort parameter to control thinking depth instead."* — [Anthropic, Extended thinking](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking), accessed 2026-06-30.
- **DeepSeek/GLM:** a `thinking:{type:enabled|disabled}` toggle and a sibling `reasoning_content` response field (Eos's `OpenAIModelClient` already maps `reasoning_content → ModelTurn.reasoning` ✔).

**The hazard — opposite round-trip requirements in a multi-turn tool loop:**
- DeepSeek: *"If the `reasoning_content` field is included in the sequence of input messages, the API will return a `400` error."* — [DeepSeek reasoning model](https://api-docs.deepseek.com/guides/reasoning_model), accessed 2026-06-30. → you must **strip** reasoning before feeding history back.
- Anthropic: *"During tool use, you must pass `thinking` blocks back to the API for the last assistant message. Include the complete unmodified block"*; *"If thinking blocks are modified, the API returns a 400 `invalid_request_error` whose message contains `` `thinking` … blocks in the latest assistant message cannot be modified ``."* — [Anthropic, Extended thinking](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking), accessed 2026-06-30. → you must **preserve** (signed) thinking blocks across tool turns.

Independently corroborated by LiteLLM, which hits this exact wall *because* it normalizes to the OpenAI shape: *"OpenAI's Chat Completions spec has no field for `thinking_blocks`"*, so OpenAI-compatible clients *"ignore this field, causing thinking blocks to be lost when reconstructing multi-turn conversations"* → 400; their fix is a `litellm.modify_params=True` reconstruction hack ([LiteLLM, reasoning_content](https://docs.litellm.ai/docs/reasoning_content), accessed 2026-06-30). This is the strongest concrete argument for Eos keeping a neutral `ModelTurn` + escape hatch rather than an OpenAI-shape passthrough: the passthrough camp has to bolt on a workaround that the neutral camp avoids by construction.

**Implication for Eos:** today `toAnthropicMessage` re-emits **only** `tool_use` blocks for an assistant turn (drops `thinking`), and `toOpenAIMessage` re-emits only `tool_calls` (drops `reasoning`). That is *correct for DeepSeek* (avoids the 400) and *latently wrong for Anthropic extended-thinking-with-tools* (would hit the "cannot be modified" 400 the moment thinking is enabled on the API lane). Drive this with `capabilities.reasoningRoundTrip`: `"drop"` (OpenAI/DeepSeek) vs `"preserve-signed"` (Anthropic) — and to preserve, `ModelToolCall`/`ModelMessage` must be able to carry the opaque signed thinking block alongside the tool calls. Reasoning-tokens-bill-as-output is the one near-universal; only the exposing field differs.

---

## 5. Open questions (for the architect)

1. **Anthropic streaming: build it now or defer?** `streamTurn` is missing on `AnthropicModelClient`; adding it gives the Anthropic API lane the same live-thinking UX as claude-sdk/OpenAI. Worth it, but it's a distinct SSE parser (§3.3). Decision: in scope for the first cut, or fast-follow?
2. **Capability descriptor home.** Promote `BackendProfile.params` into a typed `ProviderCapabilities` in `contracts/`, or keep loose `params` and read keys defensively? A typed contract is more SOLID but adds a schema all 6 dimensions touch.
3. **Reasoning round-trip representation.** To support Anthropic thinking-with-tools, the neutral `ModelMessage`/`ModelToolCall` must carry an opaque, provider-owned "reasoning block to echo back" payload. How invasive is that to `ModelTurn`? (DeepSeek/OpenAI want it dropped, so the field is optional.)
4. **Proxy vs in-process.** Should Eos optionally point at a **LiteLLM/OpenRouter** proxy (offloads 100+ providers, `drop_params`, fallbacks) instead of speaking raw HTTP itself? It's just another `baseUrl` for `OpenAIModelClient`. Tradeoff: less code & instant breadth vs an external hop and dependency, against the stated "Eos supplies the whole harness / raw HTTP" goal. Probably: support it as a `baseUrl` option, don't require it.
5. **Capability discovery vs declaration.** Capabilities are declared in config here. Is any runtime probing wanted (e.g. detect that an Ollama model can't stream tools, or that `deepseek-reasoner` rejects tools) — or is mis-config simply a config bug? LiteLLM's model-capability map is declarative; recommend the same.
6. **Caching ROI on the Anthropic lane.** Given DPI prompts are large + stable, injecting `cache_control` breakpoints (§4.1) could cut input cost materially. Worth a measured spike? (Min-token threshold is per-model and silently no-ops below it.)
7. **`max_tokens` defaults.** `AnthropicModelClient` defaults `max_tokens: 4096`; with extended thinking, `budget_tokens` must be < `max_tokens`, and reasoning models can need far more. Should `max_tokens` be capability-driven per model rather than a constant?

---

### Source list (primary, accessed 2026-06-30 unless noted)
- Anthropic — [Tool use overview](https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview) · [Handling stop reasons](https://platform.claude.com/docs/en/docs/build-with-claude/handling-stop-reasons) · [Streaming](https://platform.claude.com/docs/en/docs/build-with-claude/streaming) · [Prompt caching](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching) · [Structured outputs](https://platform.claude.com/docs/en/docs/build-with-claude/structured-outputs) · [Token counting](https://platform.claude.com/docs/en/docs/build-with-claude/token-counting) · [Extended thinking](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking)
- OpenAI — [Function calling](https://developers.openai.com/api/docs/guides/function-calling) · [Responses vs Chat Completions](https://developers.openai.com/api/docs/guides/responses-vs-chat-completions) · [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) · [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) · [Counting tokens](https://developers.openai.com/api/docs/guides/token-counting) · [Reasoning](https://developers.openai.com/api/docs/guides/reasoning)
- Ollama — [Tool support blog](https://ollama.com/blog/tool-support) (2024-07-25) · [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) · [ollama#9092](https://github.com/ollama/ollama/issues/9092)
- vLLM — [Tool calling](https://docs.vllm.ai/en/latest/features/tool_calling.html) · [Structured outputs](https://docs.vllm.ai/en/v0.9.2/features/structured_outputs.html) · [vllm#31871](https://github.com/vllm-project/vllm/issues/31871)
- LM Studio — [Tools](https://lmstudio.ai/docs/developer/openai-compat/tools)
- LiteLLM — [Overview](https://docs.litellm.ai/docs/) · [drop_params](https://docs.litellm.ai/docs/completion/drop_params) · [Ollama provider](https://docs.litellm.ai/docs/providers/ollama) · [reasoning_content](https://docs.litellm.ai/docs/reasoning_content)
- OpenRouter — [Quickstart](https://openrouter.ai/docs/quickstart) · [API overview / normalization](https://openrouter.ai/docs/api/reference/overview)
- Vercel AI SDK — [Agents](https://ai-sdk.dev/docs/foundations/agents) (AI SDK 7) · [Loop control](https://ai-sdk.dev/docs/agents/loop-control) · [Custom providers](https://ai-sdk.dev/providers/community-providers/custom-providers)
- LangChain — [Overview](https://docs.langchain.com/oss/python/langchain/overview) · [Tool-calling blog](https://blog.langchain.com/tool-calling-with-langchain/)
- DeepSeek — [KV cache](https://api-docs.deepseek.com/guides/kv_cache) · [Reasoning model](https://api-docs.deepseek.com/guides/reasoning_model) · [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)
- Z.ai (GLM) — [GLM-4.6](https://docs.z.ai/guides/llm/glm-4.6) · [Stream tool](https://docs.z.ai/guides/tools/stream-tool)
