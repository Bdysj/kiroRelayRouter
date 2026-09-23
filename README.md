<div align="center">

# kiroRelayRouter

**面向 Kiro IDE 的高并发模型中转与计费平台**

中文 · [English](./README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Java](https://img.shields.io/badge/Java-17%2B-orange.svg)](https://openjdk.org/)
[![Spring Boot](https://img.shields.io/badge/Spring%20Boot-3.4.9-6DB33F.svg)](https://spring.io/projects/spring-boot)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg)](https://react.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-336791.svg)](https://www.postgresql.org/)

</div>

---

## 这是什么

kiroRelayRouter 把多个上游 AI 中转服务聚合成一条可调度、可计费、可观测的链路，向 Kiro IDE 暴露成一个"看起来就是官方模型"的入口。

对使用者来说，装一个 Kiro 扩展、粘贴一张访问 Token，就能在 Kiro Agent 里正常选模型、写代码。对运营者来说，后面是一整套多上游路由、协议自适应、积分预扣与最终一致结算的系统。

三个子项目各司其职：

| 子项目 | 技术栈 | 职责 |
| --- | --- | --- |
| [`kiroProxy`](./kiroProxy) | Java 17 · Spring Boot 3.4.9 · PostgreSQL · Redis · RabbitMQ | 核心中转服务：鉴权、选路、协议转换、流式转发、积分计费 |
| [`kiro-proxy-frontend`](./kiro-proxy-frontend) | React 19 · TypeScript · Vite 8 · TanStack Router/Query · Tailwind 4 | 运营管理后台：中转站、模型、路由矩阵、分组与 Token、账单、教程 |
| [`kiro-relayrouter`](./kiro-relayrouter) | Node.js · VS Code Extension API | Kiro IDE 扩展：Token 登录、模型选择、本地透明代理 |

> **定位说明**：这是一个可以直接跑起来的完整架构样本，适合中小团队当成"多上游 AI 网关 + 计量计费"的参考实现来读、来改、来压测。它不隶属于 Amazon Web Services 或 Kiro，也不是它们的产品。

---

## 目录

- [核心特性](#核心特性)
- [系统架构](#系统架构)
- [高并发设计](#高并发设计)
- [高可用设计](#高可用设计)
- [计费一致性](#计费一致性)
- [功能清单](#功能清单)
- [快速开始](#快速开始)
- [配置参考](#配置参考)
- [生产部署要点](#生产部署要点)
- [关于种子数据里的图片](#关于种子数据里的图片)
- [安全须知](#安全须知)
- [开源说明](#开源说明)

---

## 核心特性

### 多上游聚合与自动故障转移

一个模型可以同时绑定多个上游中转站。每个中转站是一条独立可调度的记录，带自己的优先级、权重、并发上限、超时和健康阈值。请求进来时按 `能力 → 协议优先级 → 中转站优先级 → 加权随机` 逐层收敛出一条路由；打不通就换下一条，换的是 `(中转站 × 协议)` 组合，所以同一个中转站换个协议再试也算一次独立重试。

### 协议自适应

上游到底说 OpenAI Chat Completions、OpenAI Responses 还是 Anthropic Messages，由管理端显式配置或按模型家族保守推断决定。三种协议统一 decode 成一套内部规范事件（`TEXT_DELTA`/`REASONING_DELTA`/`TOOL_START`/`TOOL_DELTA`/`USAGE`/`FINISH`/`DONE`/`ERROR`），再统一编码成 Kiro 需要的 AWS EventStream 二进制帧。换上游不影响下游协议。

### 能力感知路由

系统会从请求体反推本次真正需要的能力集：带图片就是 `IMAGE`，带 PDF 就是 `PDF`，有 `tools` 就是 `TOOL_USE`，有 `role=tool` 消息就是 `TOOL_RESULT`。能力过滤发生在优先级和权重之前——宁可换一个优先级更低但真的支持视觉的上游，也不把带图请求发给一个纯文本通道。

管理端还能对每个 `(中转站, 协议, 模型)` 发真实探针（包含内嵌 marker 的图片与 PDF 字节）来实测能力，验证结果落库成 `verification_status`。

### 会话亲和

同一个会话默认粘在同一个上游，命中率靠 Redis 里 `Token × 会话 × 模型` 三元组的哈希键维持，这样多轮对话能吃到上游的 prompt cache。亲和带双 TTL：空闲 60 分钟滑动过期，硬上限 12 小时不可续期，避免长期倾斜。

### 积分预扣与最终一致结算

请求发出前先在 PostgreSQL 里锁钱包、冻结积分、写一条 `PENDING` 用量记录，冻结不成功就绝不发上游付费请求。流结束后按快照单价算出真实成本，同一个事务里写入 `relay_billing_outbox`，由发件箱轮询投递到 RabbitMQ，worker 消费后完成结算。整条链路的幂等基石是积分流水表上 `request:{id}:freeze` / `:settle` / `:release` 三种确定性事件键。

### 三级价格回退

`中转站 × 模型` 专属价 → 模型全局参考价 → 没有价格就换路由。价格支持按输入 token 分档（`min_input_tokens` 阶梯）和生效时间区间，每笔流水都冻结当次的单价、汇率和分组倍率快照，事后改价不会改写历史账单。

### 双轨鉴权

用户侧是访问 Token（`x-api-key` 或 `Authorization: Bearer`），带机器码绑定、过期时间、分组模型权限和防爆破冷却；管理端是独立的 HS256 JWT，`ROLE_ADMIN` 授权。两套机制走不同的 Filter、不同的路径前缀，互不干扰。

### 对下游永远优雅降级

Token 过期、模型权限变更、上游报错、无可用路由、积分不足——这些情况一律返回 HTTP 200 的完整 AWS EventStream，把人类可读的中英文提示和请求编号放进对话里，并用 `X-Relay-Result-Code` 响应头标记原因。Kiro 的 UI 不会因为后端状态异常而崩掉或卡死。

---

## 系统架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Kiro IDE                                                                │
│  ┌────────────────┐        ┌──────────────────────────────────────────┐  │
│  │  Kiro Agent    │───────▶│  kiro-relayrouter (扩展)                 │  │
│  │                │        │  · Token 登录 / SecretStorage            │  │
│  │                │        │  · 改写 codewhisperer.config 端点        │  │
│  │                │        │  · 本地 127.0.0.1:19801 透明代理         │  │
│  └────────────────┘        └───────────────────┬──────────────────────┘  │
└────────────────────────────────────────────────┼─────────────────────────┘
                                                 │ HTTPS
                                                 │ POST /api/relay/kiro
                                                 │ x-api-key, x-relay-machine-id
┌────────────────────────────────────────────────▼─────────────────────────┐
│  kiroProxy (Spring Boot 3.4.9 / Servlet 栈)                              │
│                                                                          │
│  SecurityConfig ─▶ AdminJwtFilter (/admin/**) ─▶ AccessTokenFilter       │
│                                                   (/relay/**)            │
│                              │                                           │
│                              ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ KiroProxyController   x-amz-target 分流 / 权限收缩 / 短路分支       │  │
│  └────────────────────────────┬───────────────────────────────────────┘  │
│                               ▼                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ RelayProxyService   立即 flush 初始帧 → 计费冻结 → 故障转移循环      │  │
│  │                     → SSE 解析 → EventStream 成帧 → 终帧 → 结算     │  │
│  └───┬──────────────┬───────────────┬──────────────┬─────────────────┘  │
│      ▼              ▼               ▼              ▼                     │
│  RelaySelector  ProtocolAdapters  KiroProtocol  UsageBillingService     │
│  (能力/优先级/   (3 种上游协议     (AWS Event-    (冻结/结算/退款)       │
│   权重/并发租约)   ⇄ 规范事件)      Stream 编码)                          │
│      ▲                                              │                    │
│  RelayHealthService          ConversationAffinity    │                   │
│  (30s GET /models 探测)      (Redis 三元组亲和)       │                   │
│                                                      ▼                   │
│                                          BillingOutboxPublisher          │
└──────┬──────────────────┬─────────────────┬──────────────┬──────────────┘
       │                  │                 │              │
       ▼                  ▼                 ▼              ▼
┌─────────────┐   ┌──────────────┐  ┌─────────────┐  ┌──────────────┐
│ PostgreSQL  │   │    Redis     │  │  RabbitMQ   │  │ Cloudflare R2│
│ 21 张表     │   │ 亲和 / 并发   │  │ 结算队列     │  │ 文档图片     │
│ 账务权威源   │   │ 健康镜像/钱包 │  │ (confirm)   │  │ (可选依赖)   │
│ Flyway 迁移 │   │ 全部可降级    │  │             │  │              │
└─────────────┘   └──────────────┘  └─────────────┘  └──────────────┘
       ▲
       │  JWT / ROLE_ADMIN
┌──────┴───────────────────────────────────────────────────────────────────┐
│  kiro-proxy-frontend (React 19 + Vite 8 + TanStack Router/Query)         │
│  中转站管理 · 模型管理 · 路由矩阵与价格 · 分组与 Token · 账单 · 教程管理   │
└──────────────────────────────────────────────────────────────────────────┘
```

上游请求链路的关键顺序（同一个 Servlet 线程内完成到"初始帧已 flush"，之后转入异步流式线程）：

1. `SecurityConfig` 处理 CORS 与授权规则，并把安全响应头**提前**写完（`StreamingResponseBody` 在 async dispatch 上完成，晚写会命中已回收的 Tomcat `MimeHeaders`）。
2. `AccessTokenFilter` 校验访问 Token、机器码绑定和防爆破冷却，把 `AccessPrincipal` 放进 request attribute。
3. `KiroProxyController` 按 `x-amz-target` 分流模型列表与聊天请求，把全局模型列表按 Token 分组权限收缩。
4. `RelayProxyService` **先写 `initial-response` 帧并 flush**，再去做翻译、计费冻结和上游连接——所以 Kiro 端不会因为后端在查库而显示卡住。
5. 故障转移循环逐条尝试路由，成功后逐帧转码，结束时补 `metadataEvent`/`messageMetadataEvent`。
6. **终帧对客户端可见之后**才收口计费，把用量落库并投递结算事件。

更细的实现（选路排序键、Lua 并发租约、两级超时、outbox 状态机、21 张表清单）见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

---

## 高并发设计

长连接流式转发的并发模型和普通 CRUD 完全不同：一个请求可能占用线程 10 分钟。这里的取舍如下。

### Direct handoff，不排队

```yaml
kiro.relay.streaming:
  core-pool-size: 16      # 核心线程
  max-pool-size: 200      # 上限
  queue-capacity: 0       # SynchronousQueue —— 关键
  async-timeout: 11m      # 比 request-timeout 多 1 分钟收尾
```

`queue-capacity: 0` 是刻意的。有队列的池会让新请求先排在一批 10 分钟长流后面慢慢饿死；直接交接（direct handoff）让线程池在核心线程忙完的瞬间就扩容到 200，真打满了立刻回 **HTTP 503 + `Retry-After: 1`**，把背压如实传导给客户端，而不是让它悬在那里。

### 两级超时，而不是一个整响应 deadline

给长 SSE 设一个"整响应超时"等于定时杀掉健康的长回答。所以超时被拆成两个独立预算：

- **响应头超时**：等上游响应头期间，每 5 秒向下游写一个空的 `assistantResponseEvent` 心跳帧。它同时干两件事——防中间层缓冲，以及探测客户端是否已经断开（下游 write 抛 IOException 就立刻 `cancel(true)` 取消上游请求，这就是取消传播/背压机制）。超时抛 `UPSTREAM_HEADER_TIMEOUT`。
- **流空闲超时**：共享一个单线程调度器 + generation ticket，每读到一行就 `touch()` 重置；真的空闲超时就直接 `close()` 输入流打断阻塞读，转成 `UPSTREAM_IDLE_TIMEOUT`。

### 跨实例并发配额

每个中转站有 `max_concurrency`。限流是两层的：进程内 `ConcurrentHashMap` + `AtomicInteger` 做 CAS，再用 Redis Lua 脚本对 `relay:inflight:{id}` 做跨实例配额，TTL 取 `max(60s, readTimeoutMs + 60s)` 防泄漏。**Redis 挂了就降级成单机限流并冷却 30 秒**，宁可短时超卖也不让整个网关停摆。租约用 try-with-resources 释放。

### 计费不进关键路径

- 结算走 RabbitMQ 异步，**不阻塞 SSE 终帧**。
- Redis 里的钱包和请求状态镜像是 `CompletableFuture.runAsync` 异步写，异常只打 debug 日志，纯读加速，不参与一致性。
- 发件箱轮询用 `FOR UPDATE SKIP LOCKED` 一条 SQL 完成租约领取，多实例并行跑同一个库也不会重复投递，且不需要在 RabbitMQ 往返期间持有事务。

### 其它

- 错误体读取有界：最多 64 KB、最多等 2 秒，绝不透传上游原始报错。
- HTTP 客户端按 connectTimeout 分桶缓存复用，健康检查线程池独立于请求线程池。
- 响应头带 `X-Accel-Buffering: no` + `Cache-Control: no-cache`，避免反代把流缓冲住。

---

## 高可用设计

### 无状态应用层

应用本身不存会话（Spring Security `STATELESS`），所有可变状态都在 PostgreSQL / Redis / RabbitMQ 里，可以直接水平扩容多实例。选路快照是 `volatile List`，整体替换，读路径无锁。

### 主动健康检查与自动剔除恢复

- 每 30 秒（可配）用 `GET {baseUrl}/models` 并行探测所有启用的中转站，自动尝试 `base/models` 与 `base/v1/models` 两种路径。
- 判 UP 要求：有 API Key、HTTP 2xx、且返回的模型目录里**匹配得上管理员已登记的模型**。健康检查绝不覆盖管理员的绑定关系。
- 连续失败数达到该中转站自己的 `failure_threshold` 才置 DOWN，DOWN 的候选直接被排除。下一次探测成功即归零恢复，不需要人工介入。
- 结果写 PostgreSQL（权威）+ Redis Hash 镜像（TTL 2 分钟，仅观测）。
- 应用就绪时 `StartupListener` 会同步跑一次全量探测，避免启动后 30 秒的冷窗口。

### 请求级故障转移的边界

故障转移是有纪律的，三条规则值得单独说：

1. **已经吐出过内容就不再重试。** 否则下游会看到两段互相矛盾的回答。
2. **配置型错误不计健康失败。** `MODEL_NOT_FOUND` / `MODEL_UNAVAILABLE` / `UPSTREAM_NOT_FOUND` 被判定为"这一条模型别名配错了"，属于关系级配置错误，不能让整个中转站因此对其它模型降级。
3. **没配价格也换路。** `MODEL_PRICE_NOT_CONFIGURED` 会触发换路而不是直接失败。

### 依赖全部可降级

| 依赖 | 挂掉之后 |
| --- | --- |
| Redis | 会话亲和关闭 30 秒、并发限流退化为单机、钱包镜像静默失败。**核心转发与计费不受影响**（权威数据在 PG）。 |
| RabbitMQ | 用量与 outbox 记录照常落库，事件堆在 `relay_billing_outbox` 里按 5 秒退避重投；恢复后自动补齐，不丢账。也可以用 `KIRO_BILLING_MESSAGING_ENABLED=false` 切换成同步结算。 |
| Cloudflare R2 | 只影响教程图片上传，相关接口返回 503，**不影响启动和转发**。凭据留空即视为未启用。 |
| PostgreSQL | 硬依赖。计费 fail-closed：冻结没提交成功就绝不发付费请求。 |

### 数据一致性边界

- PostgreSQL 是账务唯一真实来源，钱包操作全部 `SELECT ... FOR UPDATE`。
- 鉴权和计费是两个事务，所以计费入口会**再锁一次 Token 复查** `enabled/status/expires_at` 和分组状态，防止管理员并发禁用被旧 principal 绕过。
- 用量记录状态机：`PENDING → READY_TO_SETTLE → SETTLED`，或 `PENDING → FAILED / MISSING_USAGE`。
- 积分流水表的 `event_key` 唯一约束 + `WHERE NOT EXISTS` 让 RabbitMQ 的 at-least-once 重投、发件箱重复扫描、worker 重启都不会重复扣款。

---

## 计费一致性

```
                      ┌─ 发上游请求之前 ────────────────────────────────┐
                      │  SELECT ... FOR UPDATE 锁 Token（复查状态）      │
                      │  三级价格回退求单价                              │
                      │  冻结规则版本 + 分组倍率快照                     │
                      │  SELECT ... FOR UPDATE 锁钱包 → 冻结积分         │
                      │  ledger: request:{id}:freeze                    │
                      │  usage_record: PENDING（含全部单价快照）         │
                      └──────────────────┬─────────────────────────────┘
                                         │ 冻结失败 ⇒ BILLING_UNAVAILABLE
                                         │ 绝不发出付费请求 (fail-closed)
                                         ▼
                                  上游流式转发
                                         │
                      ┌──────────────────▼─────────────────────────────┐
                      │  终帧已对客户端可见之后才收口                    │
                      │  usage 缺失 ⇒ MISSING_USAGE，冻结额全退         │
                      │  否则按快照算 provider_cost_usd → charged_points│
                      │  usage_record: READY_TO_SETTLE                 │
                      │  ★ 同一事务 INSERT relay_billing_outbox         │
                      └──────────────────┬─────────────────────────────┘
                                         ▼
       BillingOutboxPublisher（1s 轮询，FOR UPDATE SKIP LOCKED 租约）
                                         │  publisher confirm 必须返回 true
                                         ▼
                        RabbitMQ  billing.settlement.queue
                                         │
                      ┌──────────────────▼─────────────────────────────┐
                      │  settle(requestId)                             │
                      │  锁 READY_TO_SETTLE 行（不存在直接返回 ⇒ 幂等）  │
                      │  available += reserved - charged                │
                      │  ledger: request:{id}:settle                   │
                      │    ← INSERT 返回 0 行就直接返回（重复消费去重）  │
                      │  usage_record: SETTLED                         │
                      └────────────────────────────────────────────────┘
```

计费公式：

```
provider_cost_usd = input_tokens             / pricing_unit × input_price
                  + cache_input_tokens       / pricing_unit × cache_input_price
                  + cache_write_input_tokens / pricing_unit × cache_write_input_price
                  + output_tokens            / pricing_unit × output_price
                  + tool_cost_usd

charged_points    = provider_cost_usd × points_per_usd × billing_multiplier
```

`points_per_usd` 是带版本的平台规则（默认 `1 USD = 10 积分`），`billing_multiplier` 来自访问分组，可以按模型单独覆盖。两者都在请求发生时冻结进流水快照。

产品口径上有一条刻意的设计：**正余额永远允许最后一次请求**。冻结额取 `min(max(reservePoints, estimatedPoints), available)`，实际用量可以把钱包打成负数，下一次请求再拒。这避免了"明明还有钱却发不出请求"的体验，代价是单次可控的透支。

---

## 功能清单

### 后端 kiroProxy

**转发与协议**
- Kiro AWS EventStream ⇄ OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 双向转换
- 上游模型别名映射（对外展示名与上游真实模型 ID 解耦，真实 ID 绝不下发）
- 图片理解：支持 `images[].source.bytes`、`data`、`source.data`、字节数组与 Buffer JSON 表示，当前消息与历史消息内均转换并按消息去重
- PDF 能力探测与路由（`data:application/pdf;` 前缀识别）
- 思考过程（reasoning）转发：三种上游协议的 `reasoning_content` / `reasoning` / `thinking` / `response.reasoning_text.delta` / `thinking_delta` 统一成 `reasoningContentEvent`
- 工具调用流式聚合（按 index 聚合 id / name / arguments）
- 本地应答简单问候与模型身份探测，不产生上游调用和计费
- SSE `[DONE]` 后立刻结束上游读取并发终帧，不等上游 HTTP EOF

**鉴权与风控**
- 访问 Token 明文存储、请求时直接查库比对，不缓存认证结果
- 机器码绑定：只有显式的 `POST /relay/session` 登录动作能新建绑定，普通 API 流量绝不静默重绑；支持绑定上限与解绑次数管理
- 无效 Token 防爆破：按机器码维度 1 小时内 10 次触发冷却，**仅对登录动作计数**，正常流量不受影响
- 管理端 HS256 JWT，默认 12 小时有效期
- 生产 Profile 默认关闭 `/swagger-ui.html` 与 `/v3/api-docs`（返回 404），业务接口不受影响

**计费与计量**
- 积分预冻结 / 结算 / 退款三态流水，`event_key` 幂等
- 三级价格回退（relay×model → 全局参考价 → 换路）
- 按输入 token 分档定价与生效时间区间
- 分组倍率 + 模型级倍率覆盖
- 事务发件箱 + publisher confirm + SKIP LOCKED 租约
- 用量记录保存价格 / 汇率 / 倍率快照，改价不改写历史账单

**运维与可观测**
- 全链路请求编号 `x-relay-request-id`，日志阶段：`accepted → stream_start(queue_ms) → upstream_start → upstream_headers → first_output → upstream_finish → upstream_done → stream_end`
- 阶段耗时 `upstream_headers_ms` / `first_output_ms` / `total_ms`，用于区分"连接慢 / 上游排队慢 / 生成本身慢"
- 日志只记字节数、历史消息数、工具数量和阶段时间，**不记提示词、Token、API Key、上游真实模型 ID 和上游错误原文**
- 启动自检：PostgreSQL 连接、中转配置、全量健康探测，异常只告警不阻断启动
- 双语用户可见文案（`lang` 参数，`zh` 前缀识别，默认 `en`）
- Log4j2 分 Profile 配置

### 管理后台 kiro-proxy-frontend

| 页面 | 能力 |
| --- | --- |
| 中转站管理 | 上游 CRUD、协议策略（自动混合 / OpenAI 智能 / Anthropic 智能）、每协议能力位与路径覆盖、优先级权重、并发与超时、失败阈值、批量健康检查、连通性测试、**草稿态协议实测**（异步 taskId 轮询，验证通过的 token 随保存一起提交）、乐观锁 `version` |
| 模型管理 | 对外模型条目、启用开关、拖拽排序（后端按步长 10 重编号）、输入/输出 token 上限、模型参考价维护 |
| 模型路由矩阵与价格 | `模型 × 中转站` 二维矩阵，并发拉取每个上游的真实模型目录做绑定校验；单格绑定编辑（上游别名、优先级/权重覆盖、分档成本价）、解绑、多选批量绑定与批量解绑 |
| 访问分组与计费 | 分组 CRUD 与汇总卡、按模型勾选授权并设置计费倍率、Token 单张与批量签发（CSV 导出）、查看明文、机器绑定上限与解绑次数的单条/批量修改、状态流转 ACTIVE/DISABLED/REVOKED、归档与可控硬删除 |
| 积分与计费规则 | `1 USD = N 积分` 的带版本规则、历史版本分页、计算逻辑说明，内嵌**销售套餐利润模拟器**（付款额 / 赠送积分 / 平台倍率 / 上游套餐价与额度 → 预计成本、利润、毛利率、倍率覆盖率） |
| 用量与账单 | 日期区间 + 中转站筛选，按分组 / 按 Token / 请求流水三个视图；请求数、token 数、上游成本 USD、扣费积分、已结算与异常数；每日曲线与模型占比。图表全部自研 SVG（平滑面积图 / 堆叠柱 / 环图 / 折线 / sparkline），**零图表库依赖** |
| 教程管理 | 分类 CRUD、文章草稿 / 发布 / 隐藏 / 同分类内排序 / 删除；tiptap 富文本编辑器，图片上传到 R2（草稿阶段用 `uploadSessionId` 关联未落库文章） |
| 公开教程页 | `/` 与 `/docs` 免鉴权，DOMPurify 消毒后渲染，目录锚点跳转与滚动高亮 |

工程细节：TanStack Router 文件路由 + 自动代码分割，TanStack Query 统一 401/403/500 兜底，登录重定向带**开放重定向白名单防护**，价格输入框按后端 `numeric(30,12)` 对齐到 12 位小数并处理全角字符与科学计数法，测试跑在 Vitest 4 browser mode（真实 headless Chromium + Playwright）。

### Kiro 扩展 kiro-relayrouter

- 访问 Token 登录，凭据存在 IDE SecretStorage，不在普通设置界面明文显示
- 保存前先调 `POST /api/relay/session` 查库验证候选 Token，失败不覆盖原配置、不重启代理
- 本地 `127.0.0.1:19801` 透明代理，改写 `codewhisperer.config` 的端点指向本地
- 模型列表、Token 有效期、剩余积分、当前选中模型的面板展示
- 模型权限变更轮询（15 秒），权限收缩时在对话里提示切换模型
- 断线重连：仅探测公开 health 路由，退避 3s → 6s → 12s → 30s，长时间中断不会变成请求风暴
- 同一设备多个 Kiro 窗口共享登录与连接状态
- 后端地址是构建期常量，由 `RELAYROUTER_BACKEND_ENDPOINT` 在打包时注入（仓库里只有 `http://127.0.0.1:8080`）

---

## 快速开始

### 1. 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| JDK | 17+ | Spring Boot 3.4.9 的最低要求 |
| Maven | 3.9.10 | 仓库自带 Wrapper，首次 `./mvnw` 自动下载，无需预装 |
| Node.js | 20.19+ | Vite 8 的要求 |
| pnpm | 9+（推荐 10） | 锁文件为 lockfileVersion 9.0 |
| PostgreSQL | 14+ | 账务与配置的唯一真实来源 |
| Redis | 6+ | 亲和、并发配额、缓存镜像 |
| RabbitMQ | 3.11+ | 结算队列 |
| Cloudflare R2 | — | 可选，仅教程图片需要 |

完整声明见 [`requirements.txt`](./requirements.txt)。

### 2. 一键校验与安装

```bash
git clone https://github.com/Bdysj/kiroRelayRouter.git
cd kiroRelayRouter

./scripts/setup.sh
```

脚本会做三件事：按 `requirements.txt` 逐项校验宿主环境（中间件跑在容器或远端时只告警不阻断）、从 `*.example` 生成本地配置文件（已存在的不覆盖）、安装前后端依赖并校验扩展可构建。

只想检查环境：`./scripts/setup.sh --check-only`。跳过依赖安装：`./scripts/setup.sh --skip-deps`。

### 3. 填写凭据

编辑 `kiroProxy/.dev.env`，把所有 `CHANGE_ME` 换成真实值：

```bash
DB_URL=jdbc:postgresql://localhost:5432/kiroProxy
DB_USERNAME=<your-db-user>
DB_PASSWORD=<your-db-password>

REDIS_HOST=localhost
RABBITMQ_USERNAME=<your-mq-user>
RABBITMQ_PASSWORD=<your-mq-password>

# 至少 32 字节随机值：openssl rand -hex 32
KIRO_ADMIN_JWT_SECRET=<random-32-bytes-hex>
KIRO_ADMIN_ALLOWED_ORIGIN_PATTERNS=http://localhost:*,http://127.0.0.1:*
```

编辑 `kiro-proxy-frontend/.env.local`：

```bash
VITE_KIRO_API_BASE_URL=http://127.0.0.1:8080/api
```

### 4. 建库并启动

```bash
createdb kiroProxy

cd kiroProxy
SPRING_PROFILES_ACTIVE=dev ./mvnw spring-boot:run
```

Flyway 会自动执行 5 个迁移脚本，建好 21 张表并写入种子数据。启动日志会打印 PostgreSQL 连通性、中转配置状态和一次全量健康探测结果。

### 5. 立刻修改种子管理员口令

种子数据里的管理员凭据是**公开的占位值**（`admin` / `ChangeMe@123456`），必须马上换掉：

```sql
UPDATE public.admin_account
   SET username = '<your-admin>', password = '<your-strong-password>';
```

> `admin_account.password` 当前是明文存储（表注释里有说明）。如果你要面向公网运营，建议先把它改成 BCrypt 之类的哈希方案，这是本项目已知的可改进点。

### 6. 启动管理后台

```bash
cd kiro-proxy-frontend
pnpm dev
```

打开 `http://localhost:5173/adminLogin` 登录。然后依次配置：中转站（Base URL + API Key + 协议）→ 模型 → 路由矩阵绑定与价格 → 访问分组与权限倍率 → 签发访问 Token。

### 7. 构建 Kiro 扩展

```bash
cd kiro-relayrouter

# 本地联调，指向 http://127.0.0.1:8080
node build.js
npm test

# 打包成 .vsix，注入自己的服务地址
RELAYROUTER_BACKEND_ENDPOINT=https://your-domain.example npm run package
```

把生成的 `.vsix` 拖进 Kiro 的扩展面板安装，或用命令面板 `Install from VSIX`。打开侧边栏的 RelayRouter，粘贴第 6 步签发的访问 Token 登录。

后端地址的解析优先级是 `RELAYROUTER_BACKEND_ENDPOINT` 环境变量 > 未跟踪的 `.endpoint.local` 文件 > 源码里的 `http://127.0.0.1:8080`。

---

## 配置参考

后端全部配置项都有环境变量占位符，模板见 [`kiroProxy/.env.example`](./kiroProxy/.env.example)。按 Profile 导入：`dev` 读 `.dev.env`，`prod` 读 `.prod.env`，两个文件都已被 gitignore。

高频调优项：

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RELAY_STREAM_CORE_POOL_SIZE` | `16` | 流式核心线程数 |
| `RELAY_STREAM_MAX_POOL_SIZE` | `200` | 同时执行的长连接上限，打满返回 503 |
| `RELAY_STREAM_QUEUE_CAPACITY` | `0` | direct handoff。**改成非 0 会让新请求排在长流后面** |
| `RELAY_STREAM_ASYNC_TIMEOUT` | `11m` | MVC async 超时，应大于 `RELAY_REQUEST_TIMEOUT` |
| `RELAY_REQUEST_TIMEOUT` | `10m` | 单请求总预算 |
| `RELAY_CONNECT_TIMEOUT` | `15s` | 上游连接超时 |
| `RELAY_HEALTH_INTERVAL_MS` | `30000` | 健康检查周期 |
| `RELAY_HEALTH_PARALLELISM` | `4` | 健康检查并行度 |
| `RELAY_AFFINITY_IDLE_TTL` | `60m` | 会话亲和空闲滑动窗口 |
| `RELAY_AFFINITY_MAXIMUM_TTL` | `12h` | 会话亲和硬上限，不可续期 |
| `RELAY_AFFINITY_QUEUE_WAIT` | `10s` | 偏好上游满并发时的自旋等待上限 |
| `KIRO_BILLING_MESSAGING_ENABLED` | `true` | 关掉即改为同步结算（单机或测试用） |
| `KIRO_BILLING_OUTBOX_DELAY_MS` | `1000` | 发件箱轮询间隔 |
| `KIRO_BILLING_REQUEST_RESERVE_POINTS` | `1` | 最小冻结积分 |
| `KIRO_BILLING_LOW_BALANCE_THRESHOLD` | `0.5` | 低余额阈值，低于此值且有在途冻结时拒绝新请求 |
| `SPRINGDOC_SWAGGER_UI_ENABLED` | prod `false` | 临时排障才打开 |

每个中转站还有自己的库内参数：`priority`、`weight`、`max_concurrency`、`connect_timeout_ms`、`read_timeout_ms`、`failure_threshold`、`protocol_strategy`，在管理后台的中转站管理页维护。

---

## 生产部署要点

### Nginx / 反向代理

流式路由必须关闭缓冲，否则 SSE 会被攒成一整块：

```nginx
location /api/relay/ {
    proxy_pass http://127.0.0.1:8080;

    proxy_http_version 1.1;
    proxy_buffering    off;     # 必须
    proxy_cache        off;     # 必须
    proxy_read_timeout 15m;     # 必须大于正常长请求时长

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

后端已开启 `forward-headers-strategy: framework`，会用 `X-Forwarded-*` 还原客户端看到的协议与主机。

### 生产 Profile 检查清单

```bash
SPRING_PROFILES_ACTIVE=prod
SERVER_ADDRESS=127.0.0.1                 # 只让反代访问
KIRO_ADMIN_JWT_SECRET=<openssl rand -hex 32>
KIRO_ADMIN_ALLOWED_ORIGIN_PATTERNS=https://admin.your-domain.example
SPRINGDOC_SWAGGER_UI_ENABLED=false
SPRINGDOC_API_DOCS_ENABLED=false
```

另外：种子管理员口令必须已修改；访问 Token 是明文存储的敏感凭据，数据库、备份和管理接口的访问范围都要收紧；管理 Token 绝不能发给普通用户。

### 修改过 Flyway 迁移脚本之后

本仓库为了脱敏改写过 `V2__seed_required_data.sql`。如果你的数据库在改动前已经执行过 V2，Flyway 启动时会因校验和不匹配而失败。两种处理方式：

```sql
-- 方式一：只在你确认差异只是脱敏占位值时使用
UPDATE flyway_schema_history SET checksum = <新校验和> WHERE version = '2';
```

新校验和会在 Flyway 的启动错误信息里直接给出（`Resolved locally: ...`）。或者用官方 `flyway repair`。全新部署的数据库不受影响。

### 水平扩容

应用层无状态，可直接起多实例。跨实例已经处理好的部分：Redis Lua 并发配额、`FOR UPDATE SKIP LOCKED` 的发件箱租约、积分流水的 `event_key` 幂等。需要注意的是健康检查是每实例独立跑的，实例数很多时可以调大 `RELAY_HEALTH_INTERVAL_MS` 以减少对上游的探测压力。

---

## 关于种子数据里的图片

`V2__seed_required_data.sql` 里的教程文章带了示例截图，图片地址指向占位域名：

```
https://YOUR-R2-PUBLIC-DOMAIN.example/relayrouter/docs/2026/09/....png
```

**部署之后这些图片一定是裂的，这是预期行为。** 原因是图片托管在原作者自己的 Cloudflare R2 存储桶上，那个桶和它的公共域名不会随仓库一起开源。

处理办法：

1. 在 Cloudflare 控制台建一个 R2 存储桶，开启公共访问，拿到公共域名（例如 `https://files.your-domain.example`）。
2. 把凭据填进 `kiroProxy/.prod.env`：

   ```bash
   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   R2_ACCESS_KEY_ID=<your-access-key>
   R2_SECRET_ACCESS_KEY=<your-secret>
   R2_BUCKET=<your-bucket>
   R2_PUBLIC_BASE_URL=https://files.your-domain.example
   R2_REGION=auto
   ```

3. 然后二选一：
   - **推荐**：在管理后台「教程管理」里重新编辑这几篇文章，删掉裂图，用编辑器直接上传自己的截图。系统会自动落库、计引用数并在 R2 里做去重管理。
   - 或者手动批量替换数据库里的域名：

     ```sql
     UPDATE public.relay_doc_article
        SET content_html = replace(content_html,
                                   'https://YOUR-R2-PUBLIC-DOMAIN.example',
                                   'https://files.your-domain.example');
     ```

     这条 SQL 只改域名前缀，路径不变，所以你需要把同名对象上传到自己桶里的同样路径下。`r2_media_files` 表里的 `object_key` 已经是相对路径，不含域名，不需要改。

如果完全不需要示例教程，直接在管理后台把这些文章删掉即可，不影响任何转发或计费功能。R2 凭据留空也能正常启动，只是教程图片上传接口会返回 503。

---

## 安全须知

仓库已经做过脱敏，公开内容里不包含任何真实主机地址、API Key、数据库凭据或数据库导出。详细清单见 [`SECURITY.md`](./SECURITY.md)。自部署时请注意：

- **种子管理员口令是公开占位值**，部署后立刻修改。
- `admin_account.password` 与 `relay_access_token.token` 目前都是**明文存储**（表注释里有明确说明）。这是当前的业务取舍，不是遗漏——面向公网运营前请自行评估，收紧数据库与备份的访问范围，或改成哈希方案。
- `.env` / `.dev.env` / `.prod.env` / `.env.local` / `.env.production` / `.endpoint.local` 全部已被 gitignore，`*.example` 模板才是提交的那份。
- `database-backups/` 已被 gitignore。`pg_dump` 导出里会带上游 API Key 和明文访问 Token，**永远不要提交或分享**。
- 生产环境把 `SERVER_ADDRESS` 设成 `127.0.0.1`，只让反向代理进来，并配好 HTTPS。
- `KIRO_ADMIN_ALLOWED_ORIGIN_PATTERNS` 要写成具体域名，不要留通配。

发现安全问题请开 issue 或私下联系维护者，不要直接公开利用细节。

---

## 开源说明

本项目以 [MIT License](./LICENSE) 开源，可以自由商用、修改和再分发，保留版权与许可声明即可。

### 项目定位

写这套东西的初衷是把"多上游 AI 网关"里那些真正难的部分完整地做一遍并留下可读的代码：长连接下的线程模型、能力感知的选路、跨实例并发配额、以及"钱不能错"的最终一致性计费。如果你在做类似的网关、计量计费或者流式代理，这里的取舍和注释应该比架构图更有参考价值。欢迎 issue 讨论、PR 改进，或者直接 fork 改成自己的东西。

### 独立项目声明

kiroRelayRouter 是独立开发的第三方项目，**不是** Amazon Web Services, Inc. 或其关联公司的产品，与 AWS 或 Kiro 不存在隶属、赞助、认可或其他官方关联。文档中对 "Kiro" 和 "Kiro Agent" 的引用仅用于说明兼容环境与使用方式。Kiro 及相关商标归各自权利人所有。

本项目只提供中转与计量的技术实现，不附带任何上游模型服务。使用者需要自行准备合法的上游服务凭据，并自行承担遵守上游服务条款与当地法律法规的责任。

### 致谢

管理后台基于 [shadcn-admin](https://github.com/satnaing/shadcn-admin) 模板改造。

---

<div align="center">

**kiroRelayRouter** · 多上游聚合 · 协议自适应 · 可计量 · 可扩容

</div>
