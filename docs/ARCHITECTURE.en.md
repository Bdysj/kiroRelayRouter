# Architecture details

[中文](./ARCHITECTURE.md) · English · [Back to README](../README.en.md)

This document carries the implementation detail that did not fit in the README. Read the README's [Architecture](../README.en.md#architecture) section first.

---

## Table of contents

- [The request path, stage by stage](#the-request-path-stage-by-stage)
- [Route selection algorithm](#route-selection-algorithm)
- [Concurrency leases](#concurrency-leases)
- [Two timeout budgets and cancellation propagation](#two-timeout-budgets-and-cancellation-propagation)
- [Protocol adaptation layer](#protocol-adaptation-layer)
- [Billing state machine](#billing-state-machine)
- [Data model](#data-model)
- [Authentication model](#authentication-model)
- [Docs and object storage](#docs-and-object-storage)
- [Observability](#observability)
- [Known trade-offs](#known-trade-offs)

---

## The request path, stage by stage

### Stage 1 — Servlet thread (synchronous)

```
HTTP POST /api/relay/kiro
  │
  ├─ SecurityConfig.filterChain
  │    · CSRF disabled, session STATELESS
  │    · Permitted: OPTIONS /**, GET {prefix}/public/docs/**, {prefix}/admin/auth/login
  │    · Authorisation: {prefix}/admin/** needs ROLE_ADMIN, everything else permitAll
  │    · HeaderWriterFilter.setShouldWriteHeadersEagerly(true)   ← critical
  │
  ├─ AdminJwtFilter          scoped to {prefix}/admin/**; relay traffic skips it
  │
  ├─ AccessTokenFilter       scoped to {prefix}/relay/**, excluding /relay/health
  │    · Credential: x-api-key, falling back to Authorization: Bearer
  │    · Machine ID: x-relay-machine-id / x-relay-legacy-machine-id
  │    · Only POST /relay/session counts as sign-in, and only sign-in may create a binding
  │    · Failure: 401 / MACHINE_BINDING_REJECTED / 429 INVALID_TOKEN_COOLDOWN
  │    · Success: AccessPrincipal into a request attribute, never into the SecurityContext
  │
  └─ KiroProxyController.relay
       · x-amz-target dispatch: ListAvailableModels / GenerateAssistantResponse|SendMessage
       · Request ID: client x-relay-request-id ([A-Za-z0-9-]{8,64}) or a fresh UUID
       · Scope narrowing: AccessTokenService.restrict(configuration, principal)
       · Short-circuit branches (all return HTTP 200 + a complete EventStream):
           expired token         → X-Relay-Result-Code: TOKEN_EXPIRED
           model access revoked  → X-Relay-Result-Code: MODEL_ACCESS_CHANGED
       · Returns ResponseEntity<StreamingResponseBody>
         Content-Type: application/vnd.amazon.eventstream
         X-Accel-Buffering: no, Cache-Control: no-cache, X-Relay-Request-Id
```

**Why security headers must be written eagerly.** The `StreamingResponseBody` body is produced on an async dispatch, and Tomcat recycles the original `MimeHeaders` once async begins. Headers written after that point land on a recycled structure. `setShouldWriteHeadersEagerly(true)` forces the work back onto the initial Servlet thread.

### Stage 2 — streaming thread (asynchronous)

```
RelayProxyService.streamChat
  │
  ├─ 1. resolve the model, read conversationState.conversationId
  ├─ 2. ConversationAffinityService.find(...)        ← look up the preferred upstream
  ├─ 3. write the initial-response frame and flush   ← let Kiro see "started"
  │      without waiting for upstream headers or for the billing row to insert
  ├─ 4. KiroProtocol.translateRequest(...)           Kiro/AWS → OpenAI-shaped canonical
  ├─ 5. RequestCapabilityInspector.inspect(...)      derive the required capability set
  ├─ 6. streamWithFailover(...)                      ← below
  ├─ 7. terminal frames: toolUseEvent(stop) → metadataEvent(tokenUsage/stopReason)
  │                      → messageMetadataEvent → flush
  └─ 8. finalise billing                             ← after the client can see the terminal frame
```

The failover loop:

```
attempted: Set<RouteKey(endpointId, protocolCode)>

loop:
  route = selector.selectRoute(modelId, required, preferredEndpointId, attempted, queueWait)
  if route == null: throw NoRelayAvailableException

  billing.beginBilling / switchBillingRoute / recordBillingProtocol
  body = ProtocolAdapters.get(route.protocol).encode(mapper, canonical)

  try:
      streamFromEndpoint(route, body, ...)          ← the actual upstream call
      selector.recordSuccess(route.endpoint)        ← async, never blocks the request thread
      affinity.recordSuccess(...)                   ← Lua CAS extends the idle window
      break
  catch UpstreamFailure e:
      if state.firstOutputNanos != 0: throw e       ← no retry once content was emitted
      if !routeConfigurationError(e) && !hasProtocolAlternative(route):
          selector.recordFailure(route.endpoint)    ← synchronous, reloads immediately
      attempted.add(route.key)
      continue
  finally:
      lease.close()                                 ← release the local and Redis slots
```

`routeConfigurationError` covers `MODEL_NOT_FOUND`, `MODEL_UNAVAILABLE`, and `UPSTREAM_NOT_FOUND`. The reasoning: a wrong model alias is a configuration problem on the `(relay, model)` relationship, and it must not degrade that relay for every other model. `MODEL_PRICE_NOT_CONFIGURED` also reroutes (logged as `relay route_unpriced`).

### Stage 3 — SSE reading and transcoding

```
streamFromEndpoint
  │
  ├─ URL = endpoint.baseUrl + protocol.path()        (pathOverride may replace it)
  ├─ headers = adapter.headers(apiKey)               (Bearer, or x-api-key + anthropic-version)
  ├─ awaitUpstreamHeaders(...)                       ← header budget, see below
  ├─ content-type must be text/event-stream
  └─ read line by line, framing on `event:` / `data:` / blank line
        │
        ├─ adapter.decode(mapper, eventName, data) → List<CanonicalStreamEvent>
        │
        └─ processSse encodes each canonical event into an AWS EventStream frame:
              TEXT_DELTA      → assistantResponseEvent
              REASONING_DELTA → reasoningContentEvent
              TOOL_START      → toolUseEvent(start)
              TOOL_DELTA      → toolUseEvent(input)
              USAGE           → normalizeUsage(...) then held for the terminal frame and billing
              MODEL           → record reportedModelId
              FINISH          → record stopReason
              DONE            → stop reading upstream at once, do not wait for HTTP EOF
              ERROR           → convert into UpstreamFailure
```

AWS EventStream framing in `KiroProtocol` is hand-written binary:

```
totalLength(4) | headersLength(4) | prelude CRC32(4) | headers | payload | message CRC32(4)
```

Headers use type 7 (string) for `:message-type`, `:event-type` or `:exception-type`, and `:content-type`.

`normalizeUsage` folds three upstream shapes into one OpenAI-shaped object:

| Upstream protocol | Input | Cache read | Cache write | Output |
| --- | --- | --- | --- | --- |
| Chat Completions | `prompt_tokens` | `prompt_tokens_details.cached_tokens` | — | `completion_tokens` |
| Responses | `input_tokens` | `input_tokens_details.cached_tokens` | — | `output_tokens` |
| Anthropic Messages | `input_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` | `output_tokens` |

Downstream metadata and billing only ever consume the normalised object.

---

## Route selection algorithm

The candidate unit is not a relay but a `(relay × protocol)` pair.

```
selectRoute(modelId, required, preferredEndpointId, attempted, queueWait)

1. eligibility filter
     endpoint.enabled
   ∧ endpoint.healthStatus == UP
   ∧ endpoint.supports(modelId)
   ∧ RouteKey ∉ attempted

2. capability filter (deliberately ahead of priority and weight)
     protocols = endpoint.protocolsFor(modelId, required)
   if the model has usable relays but no capable protocol
     → ProtocolCapabilityUnavailableException (with dedicated copy for the PDF case)

3. sort keys (lower wins)
     ① affinity hit on this endpoint    → 0, everything else 1
     ② protocol.priority()
     ③ endpoint.priorityFor(modelId)     model-level override beats the relay default
     ④ endpoint.id()                     stable tie-break

4. tiering: candidates identical on ①②③ form one tier

5. weighted random inside a tier by endpoint.weightFor(modelId)
     picked candidate cannot get a concurrency slot → drop it from the tier and redraw
     tier exhausted → fall through to the next tier

6. all tiers exhausted → NoRelayAvailableException
```

How `protocolsFor` resolves:

```
1. modelProtocols[modelId]                     from relay_configuration_model_protocol
   empty → inherit relay-level protocols       from relay_configuration_protocol
   both empty → synthesise a default
     OPENAI_CHAT_COMPLETIONS, priority 10
     capabilities {TEXT, IMAGE, TOOL_USE, TOOL_RESULT, STREAMING}

2. filter by protocolStrategy.allows(code)
     AUTO             = all three
     OPENAI_SMART     = {chat_completions, responses}      ← default
     ANTHROPIC_SMART  = {anthropic_messages, chat_completions}

3. if the mapping was not explicit, filter again by ModelProtocolClassifier
     contains claude / anthropic/            → ANTHROPIC
     openai/ / gpt- / chatgpt- / o1|o3|o4 / contains codex → OPENAI
     otherwise                               → UNKNOWN (empty set)
   explicit mappings win and skip inference entirely

4. filter by protocol.supports(required): enabled ∧ capabilities ⊇ required
5. sort by priority, then by code.name()
```

**Health checking and route selection are fully decoupled.** `RelaySelector` only consumes a `volatile List<RelayEndpoint>` snapshot and never performs network probing on a request thread. The snapshot is replaced wholesale by `reload()`, keeping the read path lock-free.

---

## Concurrency leases

Each relay carries a `max_concurrency` (0 means unlimited). Throttling has two layers:

```
tryAcquire(endpoint)
  │
  ├─ local: in-process ConcurrentHashMap<Long, AtomicInteger> inFlight
  │           CAS up to maxConcurrency
  │
  └─ cross-instance: Redis Lua ACQUIRE_SCRIPT counting relay:inflight:{id}
                       TTL = max(60s, readTimeoutMs + 60s)     ← leak guard
                       over quota → roll back the local counter and fail
                       Redis threw → degrade to single-node and cool off 30s
```

Release runs `RELEASE_SCRIPT`, invoked from `Lease.close()` in a `finally` block.

The affinity record in Redis:

```
key    = "relay:conversation-affinity:" + hex(SHA-256(accessTokenId \n conversationId \n modelId))
value  = "{relayId}:{createdAtMillis}"
TTL    = min(idleTtl, maximumTtl - (now - createdAt))
```

- Hashing the key gives triple-level granularity while keeping the raw `conversationId` out of Redis.
- Renewal uses a Lua `REPLACE_SCRIPT` CAS: it only `PSETEX`es when the current value still equals what this request read, and it **preserves the original `createdAtMillis`**. So only the idle window slides; the 12-hour hard cap cannot be renewed.
- The first write uses `setIfAbsent` so concurrent first requests do not clobber each other.
- Affinity is soft: when the preferred upstream is at capacity, `waitForPreferred` spins in 25 ms steps for up to `queue-wait` (default 10s) and then falls back to normal selection.
- Invalidation triggers: the preferred upstream already failed, `selector.supportsRoute` says the route is no longer valid, or the capability is unavailable. Deletion uses a value-matching `DELETE_SCRIPT`.
- When Redis is unavailable, affinity switches off for 30 seconds with a warning.

---

## Two timeout budgets and cancellation propagation

`HttpRequest.timeout` is not used, because it is a **whole-response deadline** and would kill a healthy long answer exactly at `readTimeoutMs`.

```
Budget 1: header timeout           awaitUpstreamHeaders
  sendAsync plus a future.get poll every 5 seconds
  total deadline = endpoint.readTimeoutMs
  every 5 seconds, write an empty assistantResponseEvent heartbeat downstream
      ├─ stops intermediaries from buffering
      └─ detects a disconnected client
           a failed downstream write raises IOException → pending.cancel(true)
           ← this is the cancellation-propagation / backpressure mechanism
  expiry → UpstreamFailure(504, UPSTREAM_HEADER_TIMEOUT)

Budget 2: stream idle timeout      StreamIdleDeadline
  a shared single-thread ScheduledThreadPoolExecutor (relay-deadline, daemon,
    setRemoveOnCancelPolicy(true)) plus a generation ticket
  every line read → touch() resets it
  idle expiry → stream.close() to break the blocking read
  → UpstreamFailure(504, UPSTREAM_IDLE_TIMEOUT)
  the idle budget is also endpoint.readTimeoutMs (V4 raised the default)
```

Error-body reads are bounded too: at most 64 KB, at most 2 seconds (then the stream is closed), and always within the request's overall deadline. Raw upstream error bodies are never passed through and never logged.

When the pool is saturated, Spring MVC async support turns the rejection into HTTP 503 (the default `AbortPolicy` raising `TaskRejectedException`); no custom rejection handler is installed.

---

## Protocol adaptation layer

```
protocol/
├── ProtocolCode.java              enum plus default paths
│                                    OPENAI_CHAT_COMPLETIONS  /chat/completions
│                                    OPENAI_RESPONSES         /responses
│                                    ANTHROPIC_MESSAGES       /messages
├── ProtocolAdapter.java          interface: code / encode / headers / decode
├── ProtocolAdapters.java         immutable Map<ProtocolCode, ProtocolAdapter> registry
├── OpenAiChatCompletionsAdapter  the baseline; encode is a deepCopy (no translation)
├── OpenAiResponsesAdapter        input / max_output_tokens shape
├── AnthropicMessagesAdapter      system hoisting, content blocks, x-api-key header
├── CanonicalStreamEvent.java     unified event model (9 types)
├── ProtocolCapability.java       TEXT IMAGE PDF TOOL_USE TOOL_RESULT
│                                 STREAMING PROMPT_CACHE
├── RequestCapabilityInspector    derives the capability set from the request body
├── ModelProtocolClassifier       conservative family inference, only without an explicit map
├── ProtocolStrategy.java         AUTO / OPENAI_SMART / ANTHROPIC_SMART
├── RelayProtocol.java            in-database protocol record (pathOverride, capability flags)
└── ProtocolVerificationService   asynchronous live protocol probing for the console
```

The canonical intermediate representation is **OpenAI Chat Completions shaped JSON**. Choosing it as the baseline collapses `OpenAiChatCompletionsAdapter.encode` into a single `deepCopy`, and that is the highest-volume path in practice.

`RequestCapabilityInspector` inference rules:

| Request-body signal | Inferred capability |
| --- | --- |
| `stream: true` | `STREAMING` |
| non-empty `tools` array | `TOOL_USE` |
| a message with `role=tool` | `TOOL_RESULT` |
| `content[].type == image_url` | `IMAGE` |
| `content[].type == file` with `file_data` starting `data:application/pdf;` | `PDF` |

`ProtocolVerificationService` is the console's live-probe service. `startDraftTest(endpoint, protocol, modelId)` returns a `taskId`, states move `QUEUED → RUNNING → COMPLETED/FAILED`, and the frontend polls for the result. `imageProbe` and `pdfProbe` build image and PDF byte payloads with embedded markers to confirm the upstream really can read images and PDFs, rather than merely claiming so in its docs. The verification evidence (`DraftEvidence`) stores only an `apiKeyHash` and a `secretFingerprint`, **never a plaintext key**; `verification_status`, `last_verified_at`, and `last_verification_message` are persisted to `relay_configuration_protocol` on save. The probe timeout ceiling is 30 minutes.

---

## Billing state machine

```
                  begin(...)                      ← before any upstream call
                      │
                      ├─ validateTokenForCharge(tokenId)
                      │    SELECT ... FOR UPDATE re-locks the token
                      │    rechecks enabled / status / expires_at / group enabled
                      │    ← auth and billing are separate transactions, so a stale
                      │      principal must not slip past a concurrent disable
                      │
                      ├─ findPrice(modelId, estimatedInputTokens, configurationId)
                      │    ① relay_configuration_model_pricing  (relay × model)
                      │         by effective_from and min_input_tokens tiers
                      │    ② relay_model_pricing                (global reference)
                      │    ③ neither → MODEL_PRICE_NOT_CONFIGURED (reroutes)
                      │
                      ├─ createSnapshot(...)  freezes pointsPerUsd / billingMultiplier
                      │                       / ruleId / ruleVersion / all unit prices
                      │
                      ├─ ensureWallet + lockWallet   SELECT ... FOR UPDATE
                      │    available ≤ 0                        → INSUFFICIENT_POINTS
                      │    available < threshold with a freeze   → LOW_BALANCE_REQUEST_IN_PROGRESS
                      │    freeze = min(max(reserve, estimated), available)
                      │
                      ├─ ledger  INSERT  event_key = request:{id}:freeze
                      ├─ usage   INSERT  status = PENDING (with the full snapshot)
                      └─ syncCache(... "PENDING")    async Redis mirror, silent on failure

              any RuntimeException → BillingRejectedException("BILLING_UNAVAILABLE")
              ← fail-closed: no paid request goes out if the freeze did not commit
                      │
                      ▼
          selectProtocol(charge, protocol)     back-fills protocol_code
          switchRoute(...)                     re-prices on reroute; freeze unchanged
                      │
                      ▼
                upstream streaming
                      │
                      ▼
         complete(charge, usage, configId, reportedModelId, metrics)
                      │
                      ├─ usage missing → finishAndRelease(MISSING_USAGE), full refund
                      │
                      ├─ provider_cost_usd   scale 10 HALF_UP
                      ├─ charged_points      scale 8  HALF_UP
                      ├─ usage  UPDATE  PENDING → READY_TO_SETTLE
                      └─ ★ same transaction: INSERT relay_billing_outbox
                           event_key = request:{id}:settlement
                           WHERE NOT EXISTS (...)
                        ← transactional outbox: usage and the pending settlement
                          event commit or roll back together
                      │
                      ▼
       BillingOutboxPublisher   @Scheduled(fixedDelay = outbox-delay-ms:1000)
                      │
                      ├─ claimBatch()  one SQL statement claims a lease
                      │    WITH claimed AS (
                      │      SELECT id FROM relay_billing_outbox
                      │       WHERE status='NEW' AND next_attempt_at <= now()
                      │       ORDER BY id LIMIT 100
                      │       FOR UPDATE SKIP LOCKED)
                      │    UPDATE ... SET next_attempt_at = now() + 60s
                      │    RETURNING id, request_id
                      │    ← SKIP LOCKED plus pushing next_attempt_at past the lease
                      │      window means many instances on one database never
                      │      double-publish, and no transaction is held across the
                      │      RabbitMQ round trip
                      │
                      └─ rabbit.invoke(... waitForConfirms(5000))
                           messageId = "settlement:{requestId}"
                           confirmed → status = PUBLISHED
                           failed    → attempts+1, next_attempt_at = now()+5s
                                        record last_error (retry window tightens 60s → 5s)
                      │
                      ▼
      RabbitMQ  billing.settlement.exchange (DirectExchange, durable)
                → billing.settlement.queue  (durable)
                  routing key: billing.settlement
                      │
                      ▼
       BillingSettlementWorker  @RabbitListener  body is just the requestId
                      │
                      ▼
                 settle(requestId)
                      ├─ SELECT ... WHERE status='READY_TO_SETTLE' FOR UPDATE
                      │    row absent → return (idempotent by construction)
                      ├─ lockWallet
                      │    available += reserved - charged
                      │    frozen     = max(0, frozen - reserved)
                      ├─ ledger INSERT  event_key = request:{id}:settle
                      │    WHERE NOT EXISTS → 0 rows inserted means return
                      │    ← the dedupe gate against duplicate delivery
                      ├─ usage UPDATE → SETTLED
                      └─ syncCache(... "SETTLED")

              failure path fail(charge, errorCode) → finishAndRelease
                      ├─ lock the PENDING row
                      ├─ available += reserved, frozen -= reserved
                      ├─ ledger INSERT  event_key = request:{id}:release
                      └─ usage UPDATE → FAILED
```

Every billing method is `@Transactional(propagation = REQUIRES_NEW)`, isolated from the authentication transaction.

Idempotency rests on three things:

1. A unique constraint on `relay_point_ledger.event_key` combined with `WHERE NOT EXISTS`, over the three deterministic keys `:freeze`, `:settle`, `:release`.
2. `settle` only accepts `READY_TO_SETTLE`; a duplicate message finds `SETTLED` and returns.
3. The outbox's `event_key = request:{id}:settlement` with `WHERE NOT EXISTS`, so a repeated `complete` never produces a second event.

`BillingRuleService` caches the current rule under the Redis key `billing:rule:current` and refreshes it through `TransactionSynchronization.afterCommit`, so the cache can never run ahead of the database.

`BillingRealtimeCache` writes two keys that are pure read accelerators — asynchronous, failures logged at debug only:

```
Hash    kiro:billing:wallet:{tokenId}    availablePoints / frozenPoints   TTL 24h
String  kiro:billing:request:{requestId} status                           TTL 24h
```

---

## Data model

`V1__initialize_complete_schema.sql` creates 21 tables; every column carries a comment.

### Administration and content

| Table | Purpose |
| --- | --- |
| `admin_account` | Console accounts. The table comment states plaintext password storage is a current business requirement |
| `relay_doc_category` | Tutorial categories / chapters |
| `relay_doc_article` | Tutorial articles (HTML body, slug, publication state) |
| `relay_doc_asset` | Tutorial image assets pointing at R2 objects |
| `r2_media_files` | R2 object inventory (`object_key`, `status`, `ref_count`) backing de-duplication and orphan cleanup |

### Upstream relay configuration

| Table | Purpose |
| --- | --- |
| `relay_configuration` | One row per independently schedulable upstream account. Holds `priority`, `weight`, `health_status`, `failure_count`, `failure_threshold`, `connect_timeout_ms`, `read_timeout_ms`, `max_concurrency`, `protocol_strategy`, `version` (optimistic lock) |
| `relay_configuration_model` | Relay × model association with the upstream alias `upstream_model_id` and model-level priority/weight overrides |
| `relay_configuration_protocol` | Protocols and capability flags a relay actually exposes, including `verification_status` and friends |
| `relay_configuration_model_protocol` | Protocol restrictions and capability overrides at relay × model granularity; absent rows inherit the relay's protocols |
| `relay_configuration_model_pricing` | Relay × model cost prices, taking precedence over the global reference |
| `relay_model` | Platform-wide model master data (display name, enabled state, ordering, token ceilings) |
| `relay_model_pricing` | Global model reference prices (`min/max_input_tokens` tiers, `effective_from/to`) |

### Access control

| Table | Purpose |
| --- | --- |
| `relay_access_group` | Access groups: model permissions and the `billing_multiplier` scheme |
| `relay_access_group_model` | Group × model authorisation with per-model multipliers |
| `relay_access_token` | Access tokens (the user-side credential) with group, status, expiry |
| `relay_access_token_machine` | Current binding between a token and client machine IDs |

### Billing

| Table | Purpose |
| --- | --- |
| `relay_billing_rule` | Platform-wide USD→points conversion rule, versioned history retained |
| `relay_token_wallet` | Current wallet state per token (`available` / `frozen`), the target of atomic pre-authorisation and charging |
| `relay_point_ledger` | Non-repeatable point movements (FREEZE / SETTLE / RELEASE) with a unique `event_key` |
| `relay_usage_record` | Per-request token usage and point consumption, holding the price and multiplier snapshot from request time |
| `relay_billing_outbox` | Settlement transactional outbox (`status`, `attempts`, `next_attempt_at`, `published_at`, `last_error`, `event_key`) |

### Migration history

| Version | Contents |
| --- | --- |
| `V1` | Full initial schema, 21 tables |
| `V2` | Required seed data (placeholder admin account, initial billing rule, sample tutorials) |
| `V3` | Model token-limit columns |
| `V4` | Raised the default streaming idle timeout |
| `V5` | Widened pricing decimal scale (`numeric(30,12)`) |

Flyway runs with `baseline-on-migrate: true`.

> `V2` was rewritten in this repository for sanitisation. A database that already applied the old V2 will report a checksum mismatch on first boot; see the [deployment notes](../README.en.md#after-a-flyway-migration-has-been-edited).

---

## Authentication model

Two entirely independent mechanisms on different filters and path prefixes.

| | User-side access token | Admin JWT |
| --- | --- | --- |
| Filter | `AccessTokenFilter` (`OncePerRequestFilter`, container-registered) | `AdminJwtFilter` (inside the SecurityFilterChain only, via `addFilterBefore`) |
| Scope | `{prefix}/relay/**`, excluding `/relay/health` | `{prefix}/admin/**`, excluding `auth/login` and `OPTIONS` |
| Credential | `x-api-key`, falling back to `Authorization: Bearer` | `Authorization: Bearer <JWT>` |
| Validation | Every request compares the plaintext token against the database and checks token and group enablement; **results are never cached** | HS256 with `kiro.admin.jwt-secret`, 12-hour default lifetime |
| Spring Security | **Never enters the SecurityContext**; the result goes into a request attribute and the paths are `permitAll()` | Written into `SecurityContextHolder` (`ROLE_ADMIN`) and cleared in a `finally` block |
| Extra dimensions | Machine binding, binding ceilings and unbind counts, expiry, per-group model permissions, brute-force cooldown | None |
| Failure response | Bilingual 401 JSON / `MACHINE_BINDING_REJECTED` / 429 `INVALID_TOKEN_COOLDOWN` | 401 JSON; the Security entry point adds its own 401/403 JSON |

`AdminJwtFilter` is explicitly barred from a second container registration (`FilterRegistrationBean.setEnabled(false)`), which would otherwise run it once outside the SecurityFilterChain.

### Brute-force protection

```
key          security:invalid-token:{machineId}     ← by machine ID, not IP
MAX_ATTEMPTS 10
COOLDOWN     1 hour (sliding; every INCR re-applies expire(1h))
counted for  POST /relay/session sign-in attempts only
cleared      on successful sign-in
Redis down   coolingDown returns false (fail-open) with a warning
```

Keying on machine ID rather than IP is a deliberate choice: the client is a desktop IDE, and a single office egress IP can front many legitimate users, so IP-based counting would make them punish each other. Counting only sign-in attempts keeps occasional API failures from triggering a cooldown.

### Layered expiry semantics

Token expiry **only blocks chat calls**. An expired but still present and enabled token can still sign in, activate the proxy, and read its group's model list — so the user sees "expired" in the panel and can go renew, instead of facing a blank screen. Chat requests receive a complete EventStream over HTTP 200, with an expiry notice in the conversation and the headers `X-Relay-Result-Code: TOKEN_EXPIRED` and `X-Relay-Token-Expired: true`. No upstream call happens, and no local answer is produced either.

---

## Docs and object storage

Cloudflare R2 is reached through the AWS SDK v2 `S3Client` (R2 offers an S3-compatible API). **If any credential is blank, R2 is considered disabled**: every R2 operation raises a 503 "object storage not configured" without affecting boot or relaying.

Lifecycle management in `DocsAssetService`:

```
upload(file, articleId, uploadSessionId)
  · verify the article exists
  · s3.putObject; a failure raises 502
  · write metadata into r2_media_files, de-duplicating on content_hash and
    maintaining ref_count

reconcileArticleMedia(oldHtml, newHtml, uploadSessionId)
  · diff the HTML before and after an edit and dereference dropped images

deleteArticleMedia(html)
  · release references when an article is hard-deleted
  · a shared or de-duplicated image is only removed from R2 when the last
    reference disappears

cleanupExpiredMedia()                      deliberately not transactional
  · it makes R2 network calls, and a long transaction would roll back rows for
    objects that were already deleted, leaving records pointing at nothing
  · concurrency safety comes from "only one caller can report the deleted row"
  · the database row is deleted before the R2 object: if R2 refuses, an orphaned
    object is preferable to a dangling record
  · the delay is controlled by kiro.docs.media-cleanup-delay-ms (default 60000)
```

Draft-stage images use an `uploadSessionId` to associate with an article that has not been persisted yet; the references are promoted when the article is saved.

---

## Observability

### One request ID end to end

A client may supply `x-relay-request-id` (validated against `[A-Za-z0-9-]{8,64}`); otherwise the backend generates a UUID. The same value is echoed in the response header, which is what lets extension logs and backend logs line up.

### Log stages

```
accepted
  → stream_start      with queue_ms (time spent in the streaming pool)
  → upstream_start
  → upstream_headers  with upstream_headers_ms
  → first_output      with first_output_ms
  → upstream_finish
  → upstream_done
  → stream_end        with total_ms
```

The value of these stages is separating three kinds of "slow": a large `upstream_headers_ms` means slow connect or upstream queueing; a large gap between `first_output_ms` and `upstream_headers_ms` means the model is thinking; a large `queue_ms` means your own thread pool is tight.

Note that the "first byte" the extension perceives may just be the initial frame flushed in step 3. It is not the first model content and cannot be used to extrapolate full response speed.

### What is deliberately not logged

Prompt text, access tokens, upstream API keys, real upstream model IDs, raw upstream error bodies, image content. Logs carry only byte counts, history message counts, tool counts, image item counts (`received_images` / `upstream_images`), and stage timings.

`StartupListener`'s class comment states the rule: credentials are never logged; model identifiers on the request path are, because routing and billing audits need them.

---

## Known trade-offs

This section is here on purpose. In an open-source project it is more useful than a feature list.

| Current state | Why | If you want to change it |
| --- | --- | --- |
| `admin_account.password` in plaintext | An early business requirement, documented in the table comment | Move to BCrypt or Argon2 with a migration and a forced password reset |
| `relay_access_token.token` in plaintext | The console needs a "reveal" action to hand the token to a user | Encrypt at rest and show it once at issuance |
| No half-open circuit breaker | Recovery relies purely on the 30-second health cycle, which is simple and predictable | Add a half-open probe window for faster recovery |
| Health checks run per instance | No distributed coordination required | With many instances, raise `RELAY_HEALTH_INTERVAL_MS` or elect a leader |
| Concurrency limiting degrades to single-node when Redis is down | Brief oversell beats a stalled gateway | Make it fail-closed if oversell is unacceptable |
| A positive balance always allows one more request | Avoids "I have credit but cannot send anything" | Use a strict estimate as the freeze amount and accept occasional rejections |
| The frontend stores the token in a cookie whose name is a template-era random string | Inherited from shadcn-admin | Rename it meaningfully and evaluate `HttpOnly` plus a server-side session |
| Hand-written SQL through `JdbcTemplate`, no ORM | The billing path needs precise control over locking, `FOR UPDATE SKIP LOCKED`, and CTEs | Not recommended; this one is intentional |
