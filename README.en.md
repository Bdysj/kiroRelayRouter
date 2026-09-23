<div align="center">

# kiroRelayRouter

**A high-concurrency AI model relay and metering platform for Kiro IDE**

[中文](./README.md) · English

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Java](https://img.shields.io/badge/Java-17%2B-orange.svg)](https://openjdk.org/)
[![Spring Boot](https://img.shields.io/badge/Spring%20Boot-3.4.9-6DB33F.svg)](https://spring.io/projects/spring-boot)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-336791.svg)](https://www.postgresql.org/)

</div>

---

## What this is

kiroRelayRouter aggregates several upstream AI relay providers into one schedulable, meterable, observable path, and exposes it to Kiro IDE as something that simply looks like a first-party model.

From a user's point of view: install one Kiro extension, paste one access token, then pick a model in Kiro Agent and get on with the work. Behind that token sits multi-upstream routing, protocol adaptation, point pre-authorisation, and eventually-consistent settlement.

Three sub-projects, clean separation:

| Sub-project | Stack | Responsibility |
| --- | --- | --- |
| [`kiroProxy`](./kiroProxy) | Java 17 · Spring Boot 3.4.9 · PostgreSQL · Redis · RabbitMQ | Core relay service: auth, routing, protocol translation, streaming, point billing |
| [`kiro-proxy-frontend`](./kiro-proxy-frontend) | React 19 · TypeScript · Vite 8 · TanStack Router/Query · Tailwind 4 | Operator console: relays, models, route matrix, groups and tokens, billing, docs |
| [`kiro-relayrouter`](./kiro-relayrouter) | Node.js · VS Code Extension API | Kiro IDE extension: token sign-in, model selection, local transparent proxy |

> **Positioning.** This is a complete, runnable architecture sample. It suits small and mid-sized teams who want a reference implementation of a multi-upstream AI gateway with metering and billing: read it, fork it, load-test it. It is not affiliated with Amazon Web Services or Kiro, and it is not their product.

---

## Table of contents

- [Core capabilities](#core-capabilities)
- [Architecture](#architecture)
- [Concurrency design](#concurrency-design)
- [Availability design](#availability-design)
- [Billing consistency](#billing-consistency)
- [Feature inventory](#feature-inventory)
- [Getting started](#getting-started)
- [Configuration reference](#configuration-reference)
- [Production deployment notes](#production-deployment-notes)
- [About the images in the seed data](#about-the-images-in-the-seed-data)
- [Security notes](#security-notes)
- [Open-source notes](#open-source-notes)

---

## Core capabilities

### Multi-upstream aggregation with automatic failover

One model can be bound to several upstream relays at once. Each relay is an independently schedulable row with its own priority, weight, concurrency ceiling, timeouts, and failure threshold. An incoming request narrows down through `capability → protocol priority → relay priority → weighted random`. If a route fails, the next one is tried — and the unit of retry is the `(relay × protocol)` pair, so re-trying the same relay over a different protocol counts as a distinct attempt.

### Protocol adaptation

Whether an upstream speaks OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages is decided by explicit console configuration, or by a conservative model-family inference when no explicit mapping exists. All three decode into one internal canonical event set (`TEXT_DELTA`/`REASONING_DELTA`/`TOOL_START`/`TOOL_DELTA`/`USAGE`/`FINISH`/`DONE`/`ERROR`), which is then encoded into the AWS EventStream binary frames Kiro expects. Swapping upstreams never changes the downstream protocol.

### Capability-aware routing

The required capability set is inferred from the request body itself: images mean `IMAGE`, a PDF attachment means `PDF`, a non-empty `tools` array means `TOOL_USE`, a `role=tool` message means `TOOL_RESULT`. Capability filtering deliberately runs **before** priority and weight — better to fall through to a lower-priority upstream that genuinely supports vision than to send an image request down a text-only channel.

The console can also fire real probes at each `(relay, protocol, model)` triple, using image and PDF payloads with embedded markers, and persist the outcome as a `verification_status`.

### Conversation affinity

A conversation sticks to the same upstream by default, keyed in Redis by a hash of the `token × conversation × model` triple, so multi-turn sessions benefit from upstream prompt caching. Affinity carries two TTLs: a 60-minute sliding idle window, and a hard 12-hour cap that cannot be renewed, which keeps traffic from skewing permanently.

### Point pre-authorisation and eventually-consistent settlement

Before any upstream call, the service locks the wallet in PostgreSQL, freezes points, and writes a `PENDING` usage row. If the freeze does not commit, no paid upstream request is ever sent. After the stream ends, real cost is computed from the frozen price snapshot and — in the same transaction — an event is inserted into `relay_billing_outbox`. A poller publishes it to RabbitMQ, and a worker settles it. Idempotency rests on three deterministic event keys in the point ledger: `request:{id}:freeze`, `:settle`, `:release`.

### Three-tier price fallback

`relay × model` specific price → global model reference price → no price at all means reroute. Prices support input-token tiers (`min_input_tokens` steps) and effective date ranges. Every usage row freezes the unit prices, exchange rate, and group multiplier in effect at request time, so later price edits never rewrite historical invoices.

### Dual-track authentication

The user side uses access tokens (`x-api-key` or `Authorization: Bearer`) with machine binding, expiry, per-group model permissions, and brute-force cooldown. The admin side uses an independent HS256 JWT with `ROLE_ADMIN`. They run through different filters on different path prefixes and never interfere.

### Always degrade gracefully downstream

Expired token, revoked model access, upstream error, no available route, insufficient points — all of these return a complete AWS EventStream over HTTP 200, carrying a human-readable bilingual notice plus the request ID inside the conversation, with the reason tagged in an `X-Relay-Result-Code` header. Kiro's UI never hangs or breaks because the backend is unhappy.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Kiro IDE                                                                │
│  ┌────────────────┐        ┌──────────────────────────────────────────┐  │
│  │  Kiro Agent    │───────▶│  kiro-relayrouter (extension)            │  │
│  │                │        │  · token sign-in / SecretStorage         │  │
│  │                │        │  · rewrites codewhisperer.config         │  │
│  │                │        │  · local transparent proxy :19801        │  │
│  └────────────────┘        └───────────────────┬──────────────────────┘  │
└────────────────────────────────────────────────┼─────────────────────────┘
                                                 │ HTTPS
                                                 │ POST /api/relay/kiro
                                                 │ x-api-key, x-relay-machine-id
┌────────────────────────────────────────────────▼─────────────────────────┐
│  kiroProxy (Spring Boot 3.4.9, Servlet stack)                            │
│                                                                          │
│  SecurityConfig ─▶ AdminJwtFilter (/admin/**) ─▶ AccessTokenFilter       │
│                                                   (/relay/**)            │
│                              │                                           │
│                              ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ KiroProxyController   x-amz-target dispatch / scope / short paths   │  │
│  └────────────────────────────┬───────────────────────────────────────┘  │
│                               ▼                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ RelayProxyService   flush initial frame → freeze points → failover  │  │
│  │                     → parse SSE → EventStream frames → settle       │  │
│  └───┬──────────────┬───────────────┬──────────────┬─────────────────┘  │
│      ▼              ▼               ▼              ▼                     │
│  RelaySelector  ProtocolAdapters  KiroProtocol  UsageBillingService     │
│  (capability/    (3 upstream       (AWS Event-   (freeze/settle/        │
│   priority/       protocols ⇄       Stream        release)              │
│   weight/lease)   canonical)        encoder)                            │
│      ▲                                              │                    │
│  RelayHealthService          ConversationAffinity    │                   │
│  (30s GET /models probe)     (Redis triple key)      │                   │
│                                                      ▼                   │
│                                          BillingOutboxPublisher          │
└──────┬──────────────────┬─────────────────┬──────────────┬──────────────┘
       │                  │                 │              │
       ▼                  ▼                 ▼              ▼
┌─────────────┐   ┌──────────────┐  ┌─────────────┐  ┌──────────────┐
│ PostgreSQL  │   │    Redis     │  │  RabbitMQ   │  │ Cloudflare R2│
│ 21 tables   │   │ affinity /   │  │ settlement  │  │ doc images   │
│ system of   │   │ concurrency  │  │ queue with  │  │ (optional    │
│ record      │   │ health/wallet│  │ confirms    │  │  dependency) │
│ Flyway      │   │ all degrade  │  │             │  │              │
└─────────────┘   └──────────────┘  └─────────────┘  └──────────────┘
       ▲
       │  JWT / ROLE_ADMIN
┌──────┴───────────────────────────────────────────────────────────────────┐
│  kiro-proxy-frontend (React 19 + Vite 8 + TanStack Router/Query)         │
│  relays · models · route matrix & pricing · groups & tokens · billing    │
└──────────────────────────────────────────────────────────────────────────┘
```

The ordering on the upstream path matters (everything up to "initial frame flushed" happens on the original Servlet thread, then work moves to the async streaming pool):

1. `SecurityConfig` applies CORS and authorisation rules and writes security response headers **eagerly**. `StreamingResponseBody` completes on an async dispatch, and writing headers late would hit Tomcat `MimeHeaders` that have already been recycled.
2. `AccessTokenFilter` validates the access token, machine binding, and brute-force cooldown, then puts an `AccessPrincipal` into a request attribute.
3. `KiroProxyController` dispatches on `x-amz-target` between the model list and chat, and narrows the global model list down to what the token's group is allowed to see.
4. `RelayProxyService` **writes and flushes the `initial-response` frame first**, and only then translates the payload, freezes points, and opens the upstream connection. That is why Kiro never looks stuck while the backend is querying the database.
5. The failover loop tries routes one by one, transcodes frame by frame, and appends `metadataEvent`/`messageMetadataEvent` at the end.
6. Billing is finalised **only after the terminal frame is visible to the client**: usage is persisted and a settlement event is queued.

Deeper detail — the sort keys in route selection, the Lua concurrency lease, the two-level timeout budget, the outbox state machine, and the full 21-table inventory — lives in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Concurrency design

Streaming relay concurrency looks nothing like ordinary CRUD: a single request can hold a thread for ten minutes. The trade-offs follow from that.

### Direct handoff, no queue

```yaml
kiro.relay.streaming:
  core-pool-size: 16      # core threads
  max-pool-size: 200      # ceiling
  queue-capacity: 0       # SynchronousQueue — the important bit
  async-timeout: 11m      # one minute more than request-timeout, for teardown
```

`queue-capacity: 0` is deliberate. A pool with a queue would park new requests behind a batch of ten-minute streams and starve them. Direct handoff grows the pool to 200 the moment core threads are busy, and once that ceiling is genuinely reached it returns **HTTP 503 with `Retry-After: 1`** — honest backpressure instead of an indefinite hang.

### Two timeout budgets, not one whole-response deadline

A whole-response timeout on a long SSE stream is just a scheduled kill for healthy long answers. So the budget is split in two:

- **Header timeout.** While waiting for upstream response headers, an empty `assistantResponseEvent` heartbeat frame is written downstream every 5 seconds. That does two jobs at once: it stops intermediaries from buffering, and it detects a disconnected client — a failed downstream write raises `IOException`, which immediately `cancel(true)`s the upstream request. That is the cancellation-propagation and backpressure mechanism. Expiry raises `UPSTREAM_HEADER_TIMEOUT`.
- **Stream idle timeout.** A shared single-thread scheduler plus a generation ticket; every line read calls `touch()` to reset it. A genuine idle expiry closes the input stream to break the blocking read and surfaces `UPSTREAM_IDLE_TIMEOUT`.

### Cross-instance concurrency quota

Each relay has a `max_concurrency`. Throttling is two-layer: an in-process `ConcurrentHashMap` of `AtomicInteger` with CAS, then a Redis Lua script holding a cross-instance quota on `relay:inflight:{id}` with a TTL of `max(60s, readTimeoutMs + 60s)` to prevent leaks. **If Redis goes down, the limiter degrades to single-node and cools off for 30 seconds** — brief oversell beats a stalled gateway. Leases are released with try-with-resources.

### Billing stays off the critical path

- Settlement is asynchronous over RabbitMQ and **never blocks the terminal SSE frame**.
- The Redis wallet and request-status mirrors are written with `CompletableFuture.runAsync`; failures only log at debug level. They are a read accelerator and play no part in consistency.
- The outbox poller claims a lease in a single SQL statement using `FOR UPDATE SKIP LOCKED`, so multiple instances against one database never double-publish, and no transaction is held open across the RabbitMQ round trip.

### Odds and ends

- Error bodies are read with a bound: at most 64 KB, at most 2 seconds, and raw upstream errors are never passed through.
- HTTP clients are pooled and reused per connect-timeout bucket; health checks run on their own thread pool, isolated from request threads.
- Responses carry `X-Accel-Buffering: no` and `Cache-Control: no-cache` so reverse proxies do not buffer the stream.

---

## Availability design

### Stateless application tier

The application keeps no session state (Spring Security `STATELESS`); all mutable state lives in PostgreSQL, Redis, or RabbitMQ, so instances scale horizontally as-is. The routing snapshot is a `volatile List` replaced wholesale, which keeps the read path lock-free.

### Active health checks with automatic eviction and recovery

- Every 30 seconds (configurable), all enabled relays are probed in parallel with `GET {baseUrl}/models`, trying both `base/models` and `base/v1/models`.
- To be marked UP a relay needs an API key, an HTTP 2xx, **and** a returned catalogue that matches models the administrator has registered. Health checks never overwrite administrator bindings.
- A relay only goes DOWN once consecutive failures reach its own `failure_threshold`; DOWN candidates are excluded outright. The next successful probe resets the counter and restores it — no human intervention.
- Results are written to PostgreSQL (authoritative) and mirrored into a Redis hash (2-minute TTL, observability only).
- On application readiness, `StartupListener` runs one full probe synchronously, so there is no 30-second cold window after boot.

### Where request-level failover stops

Failover is disciplined. Three rules deserve to be called out:

1. **No retry once content has been emitted.** Otherwise the client sees two contradicting answers.
2. **Configuration errors do not count as health failures.** `MODEL_NOT_FOUND` / `MODEL_UNAVAILABLE` / `UPSTREAM_NOT_FOUND` mean "this model alias is wrong", which is a relationship-level config error; one bad alias must not degrade an entire relay for every other model.
3. **A missing price reroutes too.** `MODEL_PRICE_NOT_CONFIGURED` triggers a route switch rather than an outright failure.

### Every dependency degrades

| Dependency | When it is down |
| --- | --- |
| Redis | Conversation affinity switches off for 30 seconds, concurrency limiting falls back to single-node, wallet mirroring fails silently. **Core relaying and billing are unaffected** — PostgreSQL holds the truth. |
| RabbitMQ | Usage and outbox rows still commit; events accumulate in `relay_billing_outbox` and retry on a 5-second backoff. Nothing is lost once the broker returns. `KIRO_BILLING_MESSAGING_ENABLED=false` switches to synchronous settlement. |
| Cloudflare R2 | Only tutorial image uploads are affected; those endpoints return 503. **Boot and relaying are untouched.** Blank credentials simply mean "disabled". |
| PostgreSQL | Hard dependency. Billing is fail-closed: if the freeze did not commit, no paid request goes out. |

### Consistency boundaries

- PostgreSQL is the single system of record for money; every wallet operation uses `SELECT ... FOR UPDATE`.
- Authentication and billing are separate transactions, so the billing entry point **re-locks the token** and re-checks `enabled` / `status` / `expires_at` plus group state. A stale principal cannot slip past a concurrent administrative disable.
- Usage state machine: `PENDING → READY_TO_SETTLE → SETTLED`, or `PENDING → FAILED / MISSING_USAGE`.
- A unique constraint on the ledger's `event_key` combined with `WHERE NOT EXISTS` means RabbitMQ at-least-once redelivery, duplicate outbox scans, and worker restarts can never double-charge.

---

## Billing consistency

```
                      ┌─ before any upstream call ─────────────────────┐
                      │  SELECT ... FOR UPDATE on token (recheck)      │
                      │  three-tier price fallback                     │
                      │  freeze rule version + group multiplier        │
                      │  SELECT ... FOR UPDATE on wallet → freeze      │
                      │  ledger: request:{id}:freeze                   │
                      │  usage_record: PENDING (full price snapshot)   │
                      └──────────────────┬────────────────────────────┘
                                         │ freeze failed ⇒ BILLING_UNAVAILABLE
                                         │ no paid request is sent (fail-closed)
                                         ▼
                                upstream streaming
                                         │
                      ┌──────────────────▼────────────────────────────┐
                      │  finalised only after the client sees the      │
                      │  terminal frame                               │
                      │  usage missing ⇒ MISSING_USAGE, full refund   │
                      │  else provider_cost_usd → charged_points      │
                      │  usage_record: READY_TO_SETTLE                │
                      │  ★ same transaction: INSERT billing_outbox     │
                      └──────────────────┬────────────────────────────┘
                                         ▼
       BillingOutboxPublisher (1s poll, FOR UPDATE SKIP LOCKED lease)
                                         │  publisher confirm must return true
                                         ▼
                        RabbitMQ  billing.settlement.queue
                                         │
                      ┌──────────────────▼────────────────────────────┐
                      │  settle(requestId)                            │
                      │  lock READY_TO_SETTLE row (absent ⇒ return)   │
                      │  available += reserved - charged              │
                      │  ledger: request:{id}:settle                  │
                      │    ← 0 rows inserted ⇒ return (dedupe gate)   │
                      │  usage_record: SETTLED                        │
                      └───────────────────────────────────────────────┘
```

The formula:

```
provider_cost_usd = input_tokens             / pricing_unit × input_price
                  + cache_input_tokens       / pricing_unit × cache_input_price
                  + cache_write_input_tokens / pricing_unit × cache_write_input_price
                  + output_tokens            / pricing_unit × output_price
                  + tool_cost_usd

charged_points    = provider_cost_usd × points_per_usd × billing_multiplier
```

`points_per_usd` is a versioned platform rule (default `1 USD = 10 points`); `billing_multiplier` comes from the access group and can be overridden per model. Both are frozen into the usage snapshot at request time.

One product decision is intentional: **a positive balance always allows one more request.** The freeze amount is `min(max(reservePoints, estimatedPoints), available)`, and real usage may push the wallet negative — the *next* request is the one that gets rejected. That avoids the "I still have credit but cannot send anything" experience, at the cost of a bounded, single-request overdraft.

---

## Feature inventory

### Backend — kiroProxy

**Relaying and protocols**
- Bidirectional translation between Kiro AWS EventStream and OpenAI Chat Completions / OpenAI Responses / Anthropic Messages
- Upstream model aliasing: the public display name is decoupled from the real upstream model ID, and the real ID is never sent downstream
- Vision input: `images[].source.bytes`, `data`, `source.data`, byte arrays, and Buffer JSON forms, converted for both the current message and history, de-duplicated per message
- PDF capability detection and routing (recognised by the `data:application/pdf;` prefix)
- Reasoning passthrough: `reasoning_content` / `reasoning` / `thinking` / `response.reasoning_text.delta` / `thinking_delta` across all three upstream protocols, unified into `reasoningContentEvent`
- Streaming tool-call aggregation (id / name / arguments accumulated by index)
- Simple greetings and model-identity probes answered locally, with no upstream call and no charge
- Upstream reading stops at SSE `[DONE]` and the terminal frame is emitted immediately, without waiting for HTTP EOF

**Authentication and abuse control**
- Access tokens stored in plaintext and compared directly against the database per request; authentication results are never cached
- Machine binding: only an explicit `POST /relay/session` sign-in can create a binding, ordinary API traffic never silently rebinds; binding ceilings and unbind counts are manageable
- Brute-force protection: 10 invalid attempts per machine ID within one hour trigger a cooldown, and **only sign-in attempts are counted**, so normal traffic is never penalised
- Admin HS256 JWT, 12-hour default lifetime
- The prod profile disables `/swagger-ui.html` and `/v3/api-docs` by default (they return 404) while every business endpoint keeps working

**Billing and metering**
- Three-state point ledger — freeze / settle / release — idempotent on `event_key`
- Three-tier price fallback (relay×model → global reference → reroute)
- Input-token tiered pricing with effective date ranges
- Group multiplier with per-model override
- Transactional outbox + publisher confirms + `SKIP LOCKED` leases
- Usage rows store price / rate / multiplier snapshots, so re-pricing never rewrites history

**Operations and observability**
- End-to-end request ID `x-relay-request-id`, with log stages `accepted → stream_start(queue_ms) → upstream_start → upstream_headers → first_output → upstream_finish → upstream_done → stream_end`
- Stage timings `upstream_headers_ms` / `first_output_ms` / `total_ms` to separate "slow connect" from "slow upstream queue" from "slow generation"
- Logs record byte counts, history message counts, tool counts, and stage timings only — **never prompts, tokens, API keys, real upstream model IDs, or raw upstream errors**
- Startup self-check: PostgreSQL connectivity, relay configuration, and a full health probe; problems warn but never block boot
- Bilingual user-facing copy (`lang` parameter, `zh` prefix detection, `en` default)
- Per-profile Log4j2 configuration

### Operator console — kiro-proxy-frontend

| Page | Capability |
| --- | --- |
| Relays | Upstream CRUD; protocol strategy (auto-mixed / OpenAI-smart / Anthropic-smart); per-protocol capability flags and path override; priority and weight; concurrency and timeouts; failure threshold; batch health check; connectivity test; **draft-state protocol probing** (async `taskId` polling, with verified tokens submitted alongside the save); optimistic locking via `version` |
| Models | Public model entries, enable toggles, drag-and-drop ordering (the backend renumbers in steps of 10), input/output token ceilings, reference price maintenance |
| Route matrix & pricing | A `model × relay` matrix that concurrently fetches each upstream's real catalogue to validate bindings; per-cell binding editing (upstream alias, priority/weight override, tiered cost prices), unbinding, and multi-select bulk bind/unbind |
| Groups & billing | Group CRUD with summary cards; per-model authorisation with billing multipliers; single and batch token issuance with CSV export; plaintext reveal; single and bulk edits to machine-binding ceilings and unbind counts; ACTIVE/DISABLED/REVOKED transitions; archive and guarded hard delete |
| Points & billing rules | Versioned `1 USD = N points` rule with paginated history and an explanation of the maths, embedding a **sales package profit simulator** (payment, granted points, platform multiplier, upstream package price and quota → projected cost, profit, gross margin, multiplier coverage) |
| Usage & invoices | Date range plus relay filter across three views: by group, by token, and the raw request ledger; request counts, token counts, upstream cost in USD, charged points, settled and anomalous counts; daily curves and model share. Every chart is hand-rolled SVG (smooth area, stacked bar, donut, line, sparkline) with **zero charting-library dependencies** |
| Tutorial management | Category CRUD; article draft / publish / hide / reorder within a category / delete; a tiptap rich-text editor with image upload to R2 (drafts use an `uploadSessionId` to associate images with an unsaved article) |
| Public tutorial page | `/` and `/docs` need no authentication, render through DOMPurify, and support anchor navigation with scroll highlighting |

Engineering details: TanStack Router file-based routing with automatic code splitting; TanStack Query centralising 401/403/500 fallbacks; login redirect guarded by an **open-redirect allowlist**; the price input aligns to the backend's `numeric(30,12)` at 12 decimal places while handling full-width characters and scientific notation; tests run in Vitest 4 browser mode against real headless Chromium via Playwright.

### Kiro extension — kiro-relayrouter

- Access-token sign-in, credential kept in IDE SecretStorage, never shown in plain text in ordinary settings views
- Before saving, the candidate token is validated against the database via `POST /api/relay/session`; on failure the existing configuration is untouched and the proxy is not restarted
- A local transparent proxy on `127.0.0.1:19801`, with `codewhisperer.config` endpoints rewritten to point at it
- Panel view of available models, token expiry, remaining points, and the currently selected model
- Model-permission polling every 15 seconds; when access narrows, the conversation is told to switch models
- Reconnect logic probes only the public health route with a 3s → 6s → 12s → 30s backoff, so a long outage never becomes a request flood
- Multiple Kiro windows on one device share sign-in and connection state
- The backend address is a build-time constant injected by `RELAYROUTER_BACKEND_ENDPOINT` at packaging time; the repository only ever contains `http://127.0.0.1:8080`

---

## Getting started

### 1. Prerequisites

| Component | Version | Notes |
| --- | --- | --- |
| JDK | 17+ | Minimum for Spring Boot 3.4.9 |
| Maven | 3.9.10 | The bundled wrapper downloads it on first `./mvnw`; no local install needed |
| Node.js | 20.19+ | Required by Vite 8 |
| pnpm | 9+ (10 recommended) | The lockfile is lockfileVersion 9.0 |
| PostgreSQL | 14+ | System of record for billing and configuration |
| Redis | 6+ | Affinity, concurrency quota, cache mirrors |
| RabbitMQ | 3.11+ | Settlement queue |
| Cloudflare R2 | — | Optional, only for tutorial images |

The full declaration lives in [`requirements.txt`](./requirements.txt).

### 2. One-shot verification and install

```bash
git clone https://github.com/Bdysj/kiroRelayRouter.git
cd kiroRelayRouter

./scripts/setup.sh
```

The script verifies every prerequisite from `requirements.txt` (middleware running in containers or on remote hosts only produces warnings), creates local config files from the `*.example` templates without overwriting anything, then installs both dependency trees and checks that the extension builds.

Verify only: `./scripts/setup.sh --check-only`. Skip installs: `./scripts/setup.sh --skip-deps`.

### 3. Fill in credentials

Edit `kiroProxy/.dev.env` and replace every `CHANGE_ME`:

```bash
DB_URL=jdbc:postgresql://localhost:5432/kiroProxy
DB_USERNAME=<your-db-user>
DB_PASSWORD=<your-db-password>

REDIS_HOST=localhost
RABBITMQ_USERNAME=<your-mq-user>
RABBITMQ_PASSWORD=<your-mq-password>

# at least 32 random bytes: openssl rand -hex 32
KIRO_ADMIN_JWT_SECRET=<random-32-bytes-hex>
KIRO_ADMIN_ALLOWED_ORIGIN_PATTERNS=http://localhost:*,http://127.0.0.1:*
```

Edit `kiro-proxy-frontend/.env.local`:

```bash
VITE_KIRO_API_BASE_URL=http://127.0.0.1:8080/api
```

### 4. Create the database and boot

```bash
createdb kiroProxy

cd kiroProxy
SPRING_PROFILES_ACTIVE=dev ./mvnw spring-boot:run
```

Flyway runs five migrations, creating 21 tables and seeding required data. The startup log reports PostgreSQL connectivity, relay configuration state, and the result of one full health probe.

### 5. Change the seeded admin credential immediately

The seeded administrator is a **public placeholder** (`admin` / `ChangeMe@123456`). Replace it right away:

```sql
UPDATE public.admin_account
   SET username = '<your-admin>', password = '<your-strong-password>';
```

> `admin_account.password` is currently stored in plaintext, as the table comment states. If you plan to run this on the public internet, moving it to BCrypt or similar is a known and worthwhile improvement.

### 6. Start the console

```bash
cd kiro-proxy-frontend
pnpm dev
```

Sign in at `http://localhost:5173/adminLogin`, then configure in order: relays (base URL + API key + protocols) → models → route matrix bindings and prices → access groups with permissions and multipliers → issue access tokens.

### 7. Build the Kiro extension

```bash
cd kiro-relayrouter

# local development against http://127.0.0.1:8080
node build.js
npm test

# package a .vsix with your own service address baked in
RELAYROUTER_BACKEND_ENDPOINT=https://your-domain.example npm run package
```

Drag the resulting `.vsix` into Kiro's extension panel, or use `Install from VSIX` from the command palette. Open RelayRouter in the sidebar and paste the access token issued in step 6.

Backend address resolution order: the `RELAYROUTER_BACKEND_ENDPOINT` environment variable, then an untracked `.endpoint.local` file, then the `http://127.0.0.1:8080` default in source.

---

## Configuration reference

Every backend setting has an environment-variable placeholder; the template is [`kiroProxy/.env.example`](./kiroProxy/.env.example). Profiles import their own file: `dev` reads `.dev.env`, `prod` reads `.prod.env`, and both are git-ignored.

The knobs worth tuning:

| Variable | Default | Effect |
| --- | --- | --- |
| `RELAY_STREAM_CORE_POOL_SIZE` | `16` | Streaming core threads |
| `RELAY_STREAM_MAX_POOL_SIZE` | `200` | Ceiling on concurrent long connections; 503 beyond it |
| `RELAY_STREAM_QUEUE_CAPACITY` | `0` | Direct handoff. **Anything non-zero parks new requests behind long streams** |
| `RELAY_STREAM_ASYNC_TIMEOUT` | `11m` | MVC async timeout; keep it above `RELAY_REQUEST_TIMEOUT` |
| `RELAY_REQUEST_TIMEOUT` | `10m` | Total budget per request |
| `RELAY_CONNECT_TIMEOUT` | `15s` | Upstream connect timeout |
| `RELAY_HEALTH_INTERVAL_MS` | `30000` | Health-check period |
| `RELAY_HEALTH_PARALLELISM` | `4` | Health-check parallelism |
| `RELAY_AFFINITY_IDLE_TTL` | `60m` | Sliding idle window for conversation affinity |
| `RELAY_AFFINITY_MAXIMUM_TTL` | `12h` | Hard affinity cap, never renewed |
| `RELAY_AFFINITY_QUEUE_WAIT` | `10s` | Spin-wait ceiling when the preferred upstream is at capacity |
| `KIRO_BILLING_MESSAGING_ENABLED` | `true` | Turn off for synchronous settlement (single node or tests) |
| `KIRO_BILLING_OUTBOX_DELAY_MS` | `1000` | Outbox poll interval |
| `KIRO_BILLING_REQUEST_RESERVE_POINTS` | `1` | Minimum freeze amount |
| `KIRO_BILLING_LOW_BALANCE_THRESHOLD` | `0.5` | Below this, with a freeze in flight, new requests are rejected |
| `SPRINGDOC_SWAGGER_UI_ENABLED` | `false` in prod | Enable only for temporary troubleshooting |

Each relay additionally carries its own in-database parameters — `priority`, `weight`, `max_concurrency`, `connect_timeout_ms`, `read_timeout_ms`, `failure_threshold`, `protocol_strategy` — maintained on the Relays page of the console.

---

## Production deployment notes

### Nginx / reverse proxy

Buffering must be off on streaming routes, or SSE will be collected into one lump:

```nginx
location /api/relay/ {
    proxy_pass http://127.0.0.1:8080;

    proxy_http_version 1.1;
    proxy_buffering    off;     # required
    proxy_cache        off;     # required
    proxy_read_timeout 15m;     # must exceed your normal long-request duration

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

The backend already runs with `forward-headers-strategy: framework`, so it reconstructs the client-visible scheme and host from `X-Forwarded-*`.

### Production checklist

```bash
SPRING_PROFILES_ACTIVE=prod
SERVER_ADDRESS=127.0.0.1                 # reachable only through the proxy
KIRO_ADMIN_JWT_SECRET=<openssl rand -hex 32>
KIRO_ADMIN_ALLOWED_ORIGIN_PATTERNS=https://admin.your-domain.example
SPRINGDOC_SWAGGER_UI_ENABLED=false
SPRINGDOC_API_DOCS_ENABLED=false
```

Also: the seeded admin credential must already be changed; access tokens are plaintext credentials, so tighten access to the database, its backups, and the admin endpoints; never hand an admin token to an end user.

### After a Flyway migration has been edited

`V2__seed_required_data.sql` was rewritten in this repository to remove secrets. If your database already applied the previous V2, Flyway will refuse to start on a checksum mismatch. Two ways out:

```sql
-- Only when you have confirmed the difference is nothing but sanitised placeholders
UPDATE flyway_schema_history SET checksum = <new checksum> WHERE version = '2';
```

Flyway prints the new value in its own error message (`Resolved locally: ...`). Alternatively run the official `flyway repair`. Fresh deployments are unaffected.

### Scaling out

The application tier is stateless, so extra instances just work. Already handled across instances: the Redis Lua concurrency quota, the `FOR UPDATE SKIP LOCKED` outbox lease, and `event_key` idempotency in the point ledger. Note that health checks run per instance, so with many instances consider raising `RELAY_HEALTH_INTERVAL_MS` to reduce probe pressure on upstreams.

---

## About the images in the seed data

The tutorial articles in `V2__seed_required_data.sql` include sample screenshots whose URLs point at a placeholder host:

```
https://YOUR-R2-PUBLIC-DOMAIN.example/relayrouter/docs/2026/09/....png
```

**Those images will be broken after you deploy, and that is expected.** They were hosted in the original author's own Cloudflare R2 bucket, and neither the bucket nor its public domain is part of this open-source release.

To fix it:

1. Create an R2 bucket in the Cloudflare dashboard, enable public access, and note the public domain (for example `https://files.your-domain.example`).
2. Put the credentials into `kiroProxy/.prod.env`:

   ```bash
   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   R2_ACCESS_KEY_ID=<your-access-key>
   R2_SECRET_ACCESS_KEY=<your-secret>
   R2_BUCKET=<your-bucket>
   R2_PUBLIC_BASE_URL=https://files.your-domain.example
   R2_REGION=auto
   ```

3. Then pick one:
   - **Recommended.** Re-edit those articles under Tutorial management in the console: delete the broken images and upload your own screenshots straight from the editor. The system persists them, maintains reference counts, and de-duplicates objects in R2 for you.
   - Or rewrite the hostname in bulk:

     ```sql
     UPDATE public.relay_doc_article
        SET content_html = replace(content_html,
                                   'https://YOUR-R2-PUBLIC-DOMAIN.example',
                                   'https://files.your-domain.example');
     ```

     This only swaps the host prefix and leaves the paths alone, so you would need to upload objects to the same paths in your own bucket. The `object_key` column in `r2_media_files` is already a relative path with no hostname and needs no change.

If you do not want the sample tutorials at all, delete those articles in the console. Nothing about relaying or billing depends on them. Leaving the R2 credentials blank also boots fine — only the tutorial image upload endpoints will return 503.

---

## Security notes

The repository has been sanitised: the published content contains no real hostnames, API keys, database credentials, or database dumps. The full checklist is in [`SECURITY.md`](./SECURITY.md). When self-hosting, mind the following:

- **The seeded admin credential is a public placeholder.** Change it immediately after deployment.
- `admin_account.password` and `relay_access_token.token` are both stored **in plaintext** today, as their table comments say. That is a deliberate business trade-off rather than an oversight — evaluate it yourself before running publicly, tighten access to the database and its backups, or move to a hashed scheme.
- `.env`, `.dev.env`, `.prod.env`, `.env.local`, `.env.production`, and `.endpoint.local` are all git-ignored; the `*.example` templates are what gets committed.
- `database-backups/` is git-ignored. A `pg_dump` here carries upstream API keys and plaintext access tokens — **never commit or share one**.
- In production, set `SERVER_ADDRESS` to `127.0.0.1` so only the reverse proxy can reach the app, and terminate TLS properly.
- `KIRO_ADMIN_ALLOWED_ORIGIN_PATTERNS` should name concrete domains, never a wildcard.

Please report security problems through an issue or privately to the maintainer rather than publishing exploit details.

---

## Open-source notes

Released under the [MIT License](./LICENSE): free for commercial use, modification, and redistribution, provided the copyright and licence notice are kept.

### Why this exists

The point of building this was to work through the genuinely hard parts of a multi-upstream AI gateway and leave behind code someone can read: the thread model under long-lived connections, capability-aware route selection, cross-instance concurrency quotas, and billing that cannot get the money wrong. If you are building a similar gateway, a metering layer, or a streaming proxy, the trade-offs and the inline comments will probably be worth more to you than the architecture diagram. Issues, pull requests, and outright forks are all welcome.

### Independent project notice

kiroRelayRouter is an independently developed third-party project. It is **not** a product of Amazon Web Services, Inc. or its affiliates, and it is not affiliated with, sponsored by, endorsed by, or officially associated with AWS or Kiro. References to "Kiro" and "Kiro Agent" describe only the compatible environment and intended usage. Kiro and related trademarks belong to their respective owners.

This project ships a relaying and metering implementation, not any upstream model service. Operators must supply their own lawful upstream credentials and remain responsible for complying with upstream terms of service and applicable local law.

### Credits

The operator console is derived from the [shadcn-admin](https://github.com/satnaing/shadcn-admin) template.

---

<div align="center">

**kiroRelayRouter** · multi-upstream · protocol-adaptive · metered · horizontally scalable

</div>
