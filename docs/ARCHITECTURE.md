# 架构细节

中文 · [English](./ARCHITECTURE.en.md) · [返回 README](../README.md)

这份文档补充 README 里放不下的实现细节。读之前建议先看 README 的[系统架构](../README.md#系统架构)一节。

---

## 目录

- [请求链路逐段展开](#请求链路逐段展开)
- [选路算法](#选路算法)
- [并发租约](#并发租约)
- [两级超时与取消传播](#两级超时与取消传播)
- [协议适配层](#协议适配层)
- [计费状态机](#计费状态机)
- [数据模型](#数据模型)
- [鉴权模型](#鉴权模型)
- [文档与对象存储](#文档与对象存储)
- [可观测性](#可观测性)
- [已知取舍与可改进点](#已知取舍与可改进点)

---

## 请求链路逐段展开

### 阶段一：Servlet 线程（同步）

```
HTTP POST /api/relay/kiro
  │
  ├─ SecurityConfig.filterChain
  │    · CSRF 关闭，Session STATELESS
  │    · 放行：OPTIONS /**、GET {prefix}/public/docs/**、{prefix}/admin/auth/login
  │    · 授权：{prefix}/admin/** 需要 ROLE_ADMIN，其余 permitAll
  │    · HeaderWriterFilter.setShouldWriteHeadersEagerly(true)   ← 关键
  │
  ├─ AdminJwtFilter          只作用于 {prefix}/admin/**，relay 流量直接跳过
  │
  ├─ AccessTokenFilter       只作用于 {prefix}/relay/**，排除 /relay/health
  │    · 凭据：x-api-key → 回退 Authorization: Bearer
  │    · 机器码：x-relay-machine-id / x-relay-legacy-machine-id
  │    · 只有 POST /relay/session 视为登录，也只有登录能新建机器码绑定
  │    · 失败：401 / MACHINE_BINDING_REJECTED / 429 INVALID_TOKEN_COOLDOWN
  │    · 成功：AccessPrincipal 放进 request attribute，不进 SecurityContext
  │
  └─ KiroProxyController.relay
       · x-amz-target 分流：ListAvailableModels / GenerateAssistantResponse|SendMessage
       · 请求号：客户端 x-relay-request-id（[A-Za-z0-9-]{8,64}）或新 UUID
       · 权限收缩：AccessTokenService.restrict(configuration, principal)
       · 短路分支（都返回 HTTP 200 + 完整 EventStream）：
           Token 过期            → X-Relay-Result-Code: TOKEN_EXPIRED
           模型权限已变更        → X-Relay-Result-Code: MODEL_ACCESS_CHANGED
       · 返回 ResponseEntity<StreamingResponseBody>
         Content-Type: application/vnd.amazon.eventstream
         X-Accel-Buffering: no, Cache-Control: no-cache, X-Relay-Request-Id
```

**为什么安全响应头必须提前写完**：`StreamingResponseBody` 的 body 在 async dispatch 上产生，而 Tomcat 在 async 开始后会回收原始的 `MimeHeaders`。如果安全头在那之后才写，就会写到一块已经被回收的内存结构上。`setShouldWriteHeadersEagerly(true)` 把这件事强制拉回到初始 Servlet 线程。

### 阶段二：流式线程（异步）

```
RelayProxyService.streamChat
  │
  ├─ 1. 解析模型 + 读 conversationState.conversationId
  ├─ 2. ConversationAffinityService.find(...)        ← 查偏好上游
  ├─ 3. 写 initial-response 帧并 flush               ← 先让 Kiro 看到"已开始"
  │      不等上游响应头，也不等计费记录插入
  ├─ 4. KiroProtocol.translateRequest(...)           Kiro/AWS → OpenAI 形状规范体
  ├─ 5. RequestCapabilityInspector.inspect(...)      反推本次需要的能力集
  ├─ 6. streamWithFailover(...)                      ← 见下
  ├─ 7. 补终帧：toolUseEvent(stop) → metadataEvent(tokenUsage/stopReason)
  │             → messageMetadataEvent → flush
  └─ 8. 计费收口                                     ← 终帧已对客户端可见之后
```

`streamWithFailover` 的循环体：

```
attempted: Set<RouteKey(endpointId, protocolCode)>

loop:
  route = selector.selectRoute(modelId, required, preferredEndpointId, attempted, queueWait)
  if route == null: throw NoRelayAvailableException

  billing.beginBilling / switchBillingRoute / recordBillingProtocol
  body = ProtocolAdapters.get(route.protocol).encode(mapper, canonical)

  try:
      streamFromEndpoint(route, body, ...)          ← 真正打上游
      selector.recordSuccess(route.endpoint)        ← 异步，不阻塞请求线程
      affinity.recordSuccess(...)                   ← Lua CAS 续 idle 窗口
      break
  catch UpstreamFailure e:
      if state.firstOutputNanos != 0: throw e       ← 已吐内容不重试
      if !routeConfigurationError(e) && !hasProtocolAlternative(route):
          selector.recordFailure(route.endpoint)    ← 同步 + 立刻 reload
      attempted.add(route.key)
      continue
  finally:
      lease.close()                                 ← 释放本地 + Redis 并发名额
```

`routeConfigurationError` 覆盖 `MODEL_NOT_FOUND` / `MODEL_UNAVAILABLE` / `UPSTREAM_NOT_FOUND`。判定逻辑是：一个错误的模型别名属于 `(中转站, 模型)` 这一条关系上的配置问题，不该让整个中转站对其它模型集体降级。`MODEL_PRICE_NOT_CONFIGURED` 同样触发换路（日志 `relay route_unpriced`）。

### 阶段三：SSE 读取与转码

```
streamFromEndpoint
  │
  ├─ URL = endpoint.baseUrl + protocol.path()        （pathOverride 可覆盖）
  ├─ headers = adapter.headers(apiKey)               （Bearer / x-api-key + anthropic-version）
  ├─ awaitUpstreamHeaders(...)                       ← 响应头预算，见「两级超时」
  ├─ 校验 content-type 必须是 text/event-stream
  └─ 逐行读，按 `event:` / `data:` / 空行分帧
        │
        ├─ adapter.decode(mapper, eventName, data) → List<CanonicalStreamEvent>
        │
        └─ processSse 按事件类型编码成 AWS EventStream 帧：
              TEXT_DELTA      → assistantResponseEvent
              REASONING_DELTA → reasoningContentEvent
              TOOL_START      → toolUseEvent(start)
              TOOL_DELTA      → toolUseEvent(input)
              USAGE           → normalizeUsage(...) 归一化后留给终帧与计费
              MODEL           → 记 reportedModelId
              FINISH          → 记 stopReason
              DONE            → 立即结束上游读取，不等 HTTP EOF
              ERROR           → 转成 UpstreamFailure
```

`KiroProtocol` 里的 AWS EventStream 成帧是手写的二进制协议：

```
totalLength(4) | headersLength(4) | prelude CRC32(4) | headers | payload | message CRC32(4)
```

header 用 type 7（string）写 `:message-type`、`:event-type` 或 `:exception-type`、`:content-type`。

`normalizeUsage` 把三种上游的 usage 字段统一成一个 OpenAI 形状的对象：

| 上游协议 | 输入 | 缓存读 | 缓存写 | 输出 |
| --- | --- | --- | --- | --- |
| Chat Completions | `prompt_tokens` | `prompt_tokens_details.cached_tokens` | — | `completion_tokens` |
| Responses | `input_tokens` | `input_tokens_details.cached_tokens` | — | `output_tokens` |
| Anthropic Messages | `input_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` | `output_tokens` |

下游 metadata 和计费只消费归一化之后的那一个对象。

---

## 选路算法

候选单元不是"中转站"，而是 `(中转站 × 协议)` 二元组。

```
selectRoute(modelId, required, preferredEndpointId, attempted, queueWait)

1. eligible 过滤
     endpoint.enabled
   ∧ endpoint.healthStatus == UP
   ∧ endpoint.supports(modelId)
   ∧ RouteKey ∉ attempted

2. 能力过滤（刻意排在优先级和权重之前）
     protocols = endpoint.protocolsFor(modelId, required)
   若该模型有可用中转站但没有满足能力的协议
     → ProtocolCapabilityUnavailableException（PDF 场景有专门文案）

3. 排序键（数值小者优先）
     ① 亲和命中的 endpoint            → 0，其余 1
     ② protocol.priority()
     ③ endpoint.priorityFor(modelId)   模型级覆盖优先于中转站默认
     ④ endpoint.id()                   稳定 tie-break

4. 切 tier：①②③ 完全相同的候选归为同一层

5. tier 内按 endpoint.weightFor(modelId) 加权随机抽取
     抽中的候选拿不到并发许可 → 从本 tier 移除后重抽
     tier 抽空 → 降到下一 tier

6. 全部 tier 耗尽 → NoRelayAvailableException
```

`protocolsFor` 的解析顺序：

```
1. modelProtocols[modelId]                     来自 relay_configuration_model_protocol
   为空则继承 relay 级 protocols               来自 relay_configuration_protocol
   两者都空则兜底造一个默认协议
     OPENAI_CHAT_COMPLETIONS, priority 10
     能力 {TEXT, IMAGE, TOOL_USE, TOOL_RESULT, STREAMING}

2. 过滤 protocolStrategy.allows(code)
     AUTO             = 全部三种
     OPENAI_SMART     = {chat_completions, responses}      ← 默认
     ANTHROPIC_SMART  = {anthropic_messages, chat_completions}

3. 若不是显式映射，再按 ModelProtocolClassifier 的家族推断过滤
     含 claude / anthropic/            → ANTHROPIC
     openai/ / gpt- / chatgpt- / o1|o3|o4 系 / 含 codex → OPENAI
     否则                              → UNKNOWN（空集）
   显式映射优先级最高，直接跳过推断

4. 过滤 protocol.supports(required)：enabled ∧ capabilities ⊇ required
5. 按 priority，再按 code.name() 排序
```

**健康检查与选路是完全解耦的**：`RelaySelector` 只消费 `volatile List<RelayEndpoint>` 快照，请求线程上绝不做网络探测。快照由 `reload()` 整体替换，读路径无锁。

---

## 并发租约

每个中转站有 `max_concurrency`（0 表示不限）。限流分两层：

```
tryAcquire(endpoint)
  │
  ├─ 本层：进程内 ConcurrentHashMap<Long, AtomicInteger> inFlight
  │          CAS 到 maxConcurrency 为止
  │
  └─ 跨实例：Redis Lua ACQUIRE_SCRIPT 对 relay:inflight:{id} 计数
               TTL = max(60s, readTimeoutMs + 60s)     ← 防泄漏
               超限 → 回滚本层计数并返回失败
               Redis 抛异常 → 降级为单机限流并冷却 30 秒
```

释放走 `RELEASE_SCRIPT`，由 `Lease.close()` 在 `finally` 里调用。

会话亲和的 Redis 结构：

```
key    = "relay:conversation-affinity:" + hex(SHA-256(accessTokenId \n conversationId \n modelId))
value  = "{relayId}:{createdAtMillis}"
TTL    = min(idleTtl, maximumTtl - (now - createdAt))
```

- 哈希键的作用是既做三元组粒度，又不把原始 `conversationId` 落进 Redis。
- 续期用 Lua `REPLACE_SCRIPT` 做 CAS：只有当前值仍等于本请求读到的旧值才 `PSETEX`，并且**保留原 `createdAtMillis`**。所以滑动的只是 idle 窗口，12 小时硬上限不可续期。
- 首次写入用 `setIfAbsent`，避免并发首请求互相覆盖。
- 亲和是"软"的：偏好上游满并发时，`waitForPreferred` 以 25ms 步进自旋最多 `queue-wait`（默认 10s），等不到就降级到普通选路。
- 失效场景：偏好上游已失败、`selector.supportsRoute` 判定路由不再有效、能力不可用。删除用 `DELETE_SCRIPT` 值匹配才删。
- Redis 不可用时关闭亲和 30 秒，只 warn。

---

## 两级超时与取消传播

不使用 `HttpRequest.timeout`，因为它是**整响应 deadline**，会在 `readTimeoutMs` 时刻杀掉一个健康的长回答。

```
预算一：响应头超时          awaitUpstreamHeaders
  sendAsync + 每 5 秒轮询 future.get
  总 deadline = endpoint.readTimeoutMs
  每 5 秒向下游写一个空 assistantResponseEvent 心跳帧
      ├─ 防中间层缓冲
      └─ 探测客户端是否已断开
           下游 write 抛 IOException → pending.cancel(true) 取消上游
           ← 这就是取消传播 / 背压机制
  超时 → UpstreamFailure(504, UPSTREAM_HEADER_TIMEOUT)

预算二：流空闲超时          StreamIdleDeadline
  共享单线程 ScheduledThreadPoolExecutor（relay-deadline, daemon,
    setRemoveOnCancelPolicy(true)）+ generation ticket
  每读到一行 → touch() 重置
  空闲超时 → stream.close() 打断阻塞读
  → UpstreamFailure(504, UPSTREAM_IDLE_TIMEOUT)
  空闲预算同样取 endpoint.readTimeoutMs（V4 迁移专门调大过默认值）
```

错误体读取也是有界的：最多 64 KB，最多等 2 秒（超时就关流），且受整个请求的总 deadline 约束。上游原始错误正文既不透传也不记日志。

线程池打满时由 Spring MVC async 支持转成 HTTP 503（默认 `AbortPolicy` → `TaskRejectedException`），不自定义拒绝策略。

---

## 协议适配层

```
protocol/
├── ProtocolCode.java              枚举 + 默认路径
│                                    OPENAI_CHAT_COMPLETIONS  /chat/completions
│                                    OPENAI_RESPONSES         /responses
│                                    ANTHROPIC_MESSAGES       /messages
├── ProtocolAdapter.java          接口：code / encode / headers / decode
├── ProtocolAdapters.java         不可变注册表 Map<ProtocolCode, ProtocolAdapter>
├── OpenAiChatCompletionsAdapter  基准协议，encode 就是 deepCopy（零转换）
├── OpenAiResponsesAdapter        input / max_output_tokens 形状
├── AnthropicMessagesAdapter      system 提出、content block、x-api-key 头
├── CanonicalStreamEvent.java     统一事件模型（9 种 Type）
├── ProtocolCapability.java       TEXT IMAGE PDF TOOL_USE TOOL_RESULT
│                                 STREAMING PROMPT_CACHE
├── RequestCapabilityInspector    从请求体反推能力集
├── ModelProtocolClassifier       仅在无显式映射时做保守家族推断
├── ProtocolStrategy.java         AUTO / OPENAI_SMART / ANTHROPIC_SMART
├── RelayProtocol.java            库内协议记录（含 pathOverride、能力位）
└── ProtocolVerificationService   管理端异步协议实测
```

内部规范中间表示（canonical）就是 **OpenAI Chat Completions 形状的 JSON**。选它做基准的好处是 `OpenAiChatCompletionsAdapter.encode` 退化成一次 `deepCopy`，而这条路径在实际流量里占比最高。

`RequestCapabilityInspector` 的推断规则：

| 请求体特征 | 推断出的能力 |
| --- | --- |
| `stream: true` | `STREAMING` |
| 非空 `tools` 数组 | `TOOL_USE` |
| 存在 `role=tool` 的消息 | `TOOL_RESULT` |
| `content[].type == image_url` | `IMAGE` |
| `content[].type == file` 且 `file_data` 以 `data:application/pdf;` 开头 | `PDF` |

`ProtocolVerificationService` 是管理端的实测服务：`startDraftTest(endpoint, protocol, modelId)` 返回 `taskId`，状态流转 `QUEUED → RUNNING → COMPLETED/FAILED`，前端轮询取结果。`imageProbe` / `pdfProbe` 会构造内嵌 marker 的图片和 PDF 字节，用来确认上游真的能读图读 PDF，而不是只在文档里声明支持。验证证据（`DraftEvidence`）里只存 `apiKeyHash` 和 `secretFingerprint`，**不存明文 Key**；保存配置时才把 `verification_status` / `last_verified_at` / `last_verification_message` 落到 `relay_configuration_protocol`。探针超时上限 30 分钟。

---

## 计费状态机

```
                  begin(...)                      ← 发上游请求之前
                      │
                      ├─ validateTokenForCharge(tokenId)
                      │    SELECT ... FOR UPDATE 再锁一次 Token
                      │    复查 enabled / status / expires_at / 分组 enabled
                      │    ← 鉴权与计费是两个事务，防止并发禁用被旧 principal 绕过
                      │
                      ├─ findPrice(modelId, estimatedInputTokens, configurationId)
                      │    ① relay_configuration_model_pricing  (relay × model)
                      │         按 effective_from 与 min_input_tokens 阶梯
                      │    ② relay_model_pricing                (全局参考价)
                      │    ③ 都没有 → MODEL_PRICE_NOT_CONFIGURED（触发换路）
                      │
                      ├─ createSnapshot(...)  冻结 pointsPerUsd / billingMultiplier
                      │                       / ruleId / ruleVersion / 全部单价
                      │
                      ├─ ensureWallet + lockWallet   SELECT ... FOR UPDATE
                      │    available ≤ 0                        → INSUFFICIENT_POINTS
                      │    available < threshold 且已有冻结      → LOW_BALANCE_REQUEST_IN_PROGRESS
                      │    冻结额 = min(max(reserve, estimated), available)
                      │
                      ├─ ledger  INSERT  event_key = request:{id}:freeze
                      ├─ usage   INSERT  status = PENDING（含全部快照字段）
                      └─ syncCache(... "PENDING")    异步 Redis 镜像，失败静默

              任何 RuntimeException → BillingRejectedException("BILLING_UNAVAILABLE")
              ← fail-closed：冻结没提交就绝不发付费请求
                      │
                      ▼
          selectProtocol(charge, protocol)     回填 protocol_code
          switchRoute(...)                     换路重新查价，冻结额不变
                      │
                      ▼
                 上游流式转发
                      │
                      ▼
         complete(charge, usage, configId, reportedModelId, metrics)
                      │
                      ├─ usage 缺失 → finishAndRelease(MISSING_USAGE)，冻结额全退
                      │
                      ├─ provider_cost_usd   scale 10 HALF_UP
                      ├─ charged_points      scale 8  HALF_UP
                      ├─ usage  UPDATE  PENDING → READY_TO_SETTLE
                      └─ ★ 同一事务 INSERT relay_billing_outbox
                           event_key = request:{id}:settlement
                           WHERE NOT EXISTS (...)
                        ← 事务发件箱：用量落库与待结算事件同生共死
                      │
                      ▼
       BillingOutboxPublisher   @Scheduled(fixedDelay = outbox-delay-ms:1000)
                      │
                      ├─ claimBatch()  一条 SQL 完成租约领取
                      │    WITH claimed AS (
                      │      SELECT id FROM relay_billing_outbox
                      │       WHERE status='NEW' AND next_attempt_at <= now()
                      │       ORDER BY id LIMIT 100
                      │       FOR UPDATE SKIP LOCKED)
                      │    UPDATE ... SET next_attempt_at = now() + 60s
                      │    RETURNING id, request_id
                      │    ← SKIP LOCKED + 把 next_attempt_at 推到租约窗口外
                      │      多实例并行跑同一个库也不会重复投递
                      │      且无需在 RabbitMQ 往返期间持有事务
                      │
                      └─ rabbit.invoke(... waitForConfirms(5000))
                           messageId = "settlement:{requestId}"
                           confirm 成功 → status = PUBLISHED
                           失败        → attempts+1, next_attempt_at = now()+5s
                                          记 last_error（重试窗口从 60s 缩回 5s）
                      │
                      ▼
      RabbitMQ  billing.settlement.exchange (DirectExchange, durable)
                → billing.settlement.queue  (durable)
                  routing key: billing.settlement
                      │
                      ▼
       BillingSettlementWorker  @RabbitListener  消息体就是 requestId
                      │
                      ▼
                 settle(requestId)
                      ├─ SELECT ... WHERE status='READY_TO_SETTLE' FOR UPDATE
                      │    行不存在 → 直接 return（天然幂等）
                      ├─ lockWallet
                      │    available += reserved - charged
                      │    frozen     = max(0, frozen - reserved)
                      ├─ ledger INSERT  event_key = request:{id}:settle
                      │    WHERE NOT EXISTS → 插入 0 行就直接 return
                      │    ← 消息重复消费的去重闸门
                      ├─ usage UPDATE → SETTLED
                      └─ syncCache(... "SETTLED")

              失败路径 fail(charge, errorCode) → finishAndRelease
                      ├─ 锁 PENDING 行
                      ├─ available += reserved, frozen -= reserved
                      ├─ ledger INSERT  event_key = request:{id}:release
                      └─ usage UPDATE → FAILED
```

所有计费方法都是 `@Transactional(propagation = REQUIRES_NEW)`，与鉴权事务隔离。

幂等的三块基石：

1. `relay_point_ledger.event_key` 唯一约束 + `WHERE NOT EXISTS`，三种确定性键 `:freeze` / `:settle` / `:release`。
2. `settle` 只认 `READY_TO_SETTLE` 状态，重复消息看到的是 `SETTLED`，直接返回。
3. outbox 的 `event_key = request:{id}:settlement` 加 `WHERE NOT EXISTS`，重复 `complete` 不会产生第二条事件。

`BillingRuleService` 的规则缓存在 Redis 键 `billing:rule:current`，刷新用 `TransactionSynchronization.afterCommit`，保证缓存不会领先于数据库。

`BillingRealtimeCache` 写的两个键纯粹是读加速镜像，异步写、异常只 debug：

```
Hash    kiro:billing:wallet:{tokenId}   availablePoints / frozenPoints    TTL 24h
String  kiro:billing:request:{requestId} 状态                              TTL 24h
```

---

## 数据模型

`V1__initialize_complete_schema.sql` 建 21 张表，全部字段带中文 comment。

### 管理与内容

| 表 | 作用 |
| --- | --- |
| `admin_account` | 管理后台账号。表注释明确"密码按当前业务要求明文存储" |
| `relay_doc_category` | 教程分类 / 章节 |
| `relay_doc_article` | 教程文章（HTML 正文、slug、发布状态） |
| `relay_doc_asset` | 教程图片资源，指向 R2 对象 |
| `r2_media_files` | R2 对象清单（`object_key` / `status` / `ref_count`），支撑去重与孤儿清理 |

### 上游中转配置

| 表 | 作用 |
| --- | --- |
| `relay_configuration` | 每行 = 一个可独立调度的上游账号。含 `priority` / `weight` / `health_status` / `failure_count` / `failure_threshold` / `connect_timeout_ms` / `read_timeout_ms` / `max_concurrency` / `protocol_strategy` / `version`（乐观锁） |
| `relay_configuration_model` | 中转站 × 模型关联，含上游别名 `upstream_model_id` 与模型级 priority/weight 覆盖 |
| `relay_configuration_protocol` | 中转站实际开放的协议与能力位，含 `verification_status` 等验证字段 |
| `relay_configuration_model_protocol` | relay × model 粒度的协议限制与能力覆盖；无记录则继承中转站协议 |
| `relay_configuration_model_pricing` | relay × model 专属成本价，优先于全局参考价 |
| `relay_model` | 平台统一模型主数据（对外展示名、启用状态、排序、token 上限） |
| `relay_model_pricing` | 模型全局参考价（`min/max_input_tokens` 阶梯、`effective_from/to`） |

### 访问控制

| 表 | 作用 |
| --- | --- |
| `relay_access_group` | 访问分组：模型权限与 `billing_multiplier` 方案 |
| `relay_access_group_model` | 分组 × 模型的授权关系与模型级倍率 |
| `relay_access_token` | 访问令牌（用户侧凭据），关联分组、状态、过期时间 |
| `relay_access_token_machine` | Token 与客户端机器码的当前绑定关系 |

### 计费

| 表 | 作用 |
| --- | --- |
| `relay_billing_rule` | 平台全局"美元 → 积分"换算规则，保留历史版本 |
| `relay_token_wallet` | Token 积分钱包当前状态（`available` / `frozen`），原子预冻结与扣费的落点 |
| `relay_point_ledger` | 不可重复执行的积分账变流水（FREEZE / SETTLE / RELEASE），`event_key` 唯一 |
| `relay_usage_record` | 请求 token 用量与积分消费流水，保存请求发生时的价格与倍率快照 |
| `relay_billing_outbox` | 结算事务发件箱（`status` / `attempts` / `next_attempt_at` / `published_at` / `last_error` / `event_key`） |

### 迁移历史

| 版本 | 内容 |
| --- | --- |
| `V1` | 完整初始 schema，21 张表 |
| `V2` | 必需种子数据（管理员占位账号、初始计费规则、示例教程） |
| `V3` | 模型 token 上限字段 |
| `V4` | 调大流式空闲超时默认值 |
| `V5` | 放宽价格字段的小数位（`numeric(30,12)`） |

Flyway 配置 `baseline-on-migrate: true`。

> 本仓库为脱敏改写过 `V2`。已经执行过旧版 V2 的数据库首次启动会报
> `FlywayValidateException: Migration checksum mismatch for migration version 2`。
> 用 `KIRO_FLYWAY_REPAIR_BEFORE_MIGRATE=true` 启动一次即可修复（`config/FlywayRepairConfig.java`
> 会在 migrate 前跑一次官方 `repair`，只对齐校验和、不重放 DDL/DML），完整说明见
> [README 的部署要点](../README.md#已有数据库升级到脱敏版本flyway-校验和不匹配)。

---

## 鉴权模型

两套完全独立的机制，走不同的 Filter 和路径前缀。

| | 用户侧访问 Token | 管理端 JWT |
| --- | --- | --- |
| Filter | `AccessTokenFilter`（`OncePerRequestFilter`，容器注册） | `AdminJwtFilter`（只在 SecurityFilterChain 内，`addFilterBefore`） |
| 作用范围 | `{prefix}/relay/**`，排除 `/relay/health` | `{prefix}/admin/**`，排除 `auth/login` 与 `OPTIONS` |
| 凭据位置 | `x-api-key`，回退 `Authorization: Bearer` | `Authorization: Bearer <JWT>` |
| 校验方式 | 每次请求直接查库比对明文 Token，检查 Token 与分组启用状态，**不缓存认证结果** | HS256，密钥 `kiro.admin.jwt-secret`，有效期默认 12h |
| 与 Spring Security | **不进 SecurityContext**，结果放 request attribute；对应路径是 `permitAll()` | 写入 `SecurityContextHolder`（`ROLE_ADMIN`），`finally` 里 `clearContext()` |
| 额外维度 | 机器码绑定、绑定上限与解绑次数、过期时间、分组模型权限、防爆破冷却 | 无 |
| 失败响应 | 401 双语 JSON / `MACHINE_BINDING_REJECTED` / 429 `INVALID_TOKEN_COOLDOWN` | 401 JSON；Security 入口点另有 401/403 JSON |

`AdminJwtFilter` 被显式禁止 Servlet 容器二次注册（`FilterRegistrationBean.setEnabled(false)`），否则它会在 SecurityFilterChain 之外被跑一遍。

### 防爆破

```
key         security:invalid-token:{machineId}     ← 按机器码而非 IP
MAX_ATTEMPTS 10
COOLDOWN     1 小时（滑动，每次 INCR 都 expire(1h)）
计数范围     只对 POST /relay/session 登录动作计数
清除         登录成功即 DELETE
Redis 不可用 coolingDown 返回 false（fail-open），只 warn
```

按机器码而不是 IP 的取舍是：目标客户端是桌面 IDE，同一办公网出口 IP 下会有大量合法用户，按 IP 会互相牵连。只对登录动作计数是为了让正常 API 流量的偶发失败不触发冷却。

### 有效期的分层语义

Token 过期**只限制聊天调用**。已过期但仍存在且启用的 Token 依然可以登录、激活代理、读取所属分组的模型列表——这样用户能在面板里看到"已过期"并自己去续期，而不是面对一个什么都不显示的空界面。聊天请求会收到 HTTP 200 的完整 EventStream，对话里提示过期，响应头带 `X-Relay-Result-Code: TOKEN_EXPIRED` 和 `X-Relay-Token-Expired: true`，不调用上游也不本地应答。

---

## 文档与对象存储

Cloudflare R2 通过 AWS SDK v2 的 `S3Client` 访问（R2 提供 S3 兼容 API）。**凭据任一为空则视为未启用**，此时所有 R2 操作抛 503「R2 对象存储尚未配置」，不影响启动和转发。

`DocsAssetService` 的生命周期管理：

```
upload(file, articleId, uploadSessionId)
  · 校验文章存在
  · s3.putObject，失败抛 502
  · 元数据写 r2_media_files，按 content_hash 去重并维护 ref_count

reconcileArticleMedia(oldHtml, newHtml, uploadSessionId)
  · 对比编辑前后的 HTML，把不再引用的图片降引用

deleteArticleMedia(html)
  · 文章物理删除时释放引用
  · 共享 / 去重图片只有最后一个引用消失才真删 R2 对象

cleanupExpiredMedia()                      故意不加事务
  · 要走 R2 网络，长事务会把已清理的行回滚，留下指向已删除对象的记录
  · 并发安全靠"只有一个调用者能报告删除成功的行"
  · 先删数据库行再删 R2 对象：若 R2 拒绝，宁可留孤儿对象也不留悬空记录
  · 延迟由 kiro.docs.media-cleanup-delay-ms 控制（默认 60000）
```

草稿阶段的图片用 `uploadSessionId` 关联尚未落库的文章，文章保存时再把引用转正。

---

## 可观测性

### 请求编号贯穿全链路

客户端可以自带 `x-relay-request-id`（校验正则 `[A-Za-z0-9-]{8,64}`），否则后端生成 UUID。响应头回写同名字段，插件日志和后端日志因此可以对齐。

### 日志阶段

```
accepted
  → stream_start      含 queue_ms（在流式线程池里排了多久）
  → upstream_start
  → upstream_headers  含 upstream_headers_ms
  → first_output      含 first_output_ms
  → upstream_finish
  → upstream_done
  → stream_end        含 total_ms
```

这组阶段的价值在于区分三种"慢"：`upstream_headers_ms` 大是连接或上游排队慢，`first_output_ms` 减去 `upstream_headers_ms` 大是模型思考慢，`queue_ms` 大是自己的线程池吃紧。

注意插件侧感知到的"首字节"可能只是第 3 步就 flush 的初始帧，不能当成首个模型内容，也不能据此推算完整响应速度。

### 刻意不记的东西

提示词正文、访问 Token、上游 API Key、上游真实模型 ID、上游错误原文、图片内容。日志里只有字节数、历史消息条数、工具数量、图片条目数（`received_images` / `upstream_images`）和阶段耗时。

`StartupListener` 的类注释把这条写成了规则：凭据绝不记日志；请求路径上的模型标识可以记，因为路由与计费审计需要它。

---

## 已知取舍与可改进点

这一节是刻意留下的，开源项目里比"功能列表"更有用。

| 现状 | 取舍原因 | 如果要改 |
| --- | --- | --- |
| `admin_account.password` 明文存储 | 早期业务要求，表注释里写明了 | 换 BCrypt / Argon2，加一条迁移和一次强制改密 |
| `relay_access_token.token` 明文存储 | 管理端需要"查看明文"来把 Token 交付给用户 | 改成加密存储 + 仅签发时可见一次 |
| 没有半开熔断器 | 恢复完全靠 30 秒周期的健康检查，实现简单且可预测 | 加一个半开探测窗口，让恢复更快 |
| 健康检查每实例独立跑 | 无需分布式协调 | 实例数很多时调大 `RELAY_HEALTH_INTERVAL_MS`，或改成选主 |
| Redis 不可用时并发限流退化为单机 | 宁可短时超卖也不让网关停摆 | 如果超卖不可接受，改成 fail-closed |
| 正余额永远允许最后一次请求 | 避免"还有钱却发不出请求"的体验 | 把冻结额改成严格预估，接受偶发拒绝 |
| 前端 Token 存 cookie，cookie 名是模板遗留的随机串 | 沿用 shadcn-admin 模板 | 改成语义化名称，并评估 `HttpOnly` + 后端会话 |
| 用 `JdbcTemplate` 手写 SQL，没有 ORM | 计费路径需要精确控制锁、`FOR UPDATE SKIP LOCKED` 和 CTE | 不建议改，这是有意的 |
