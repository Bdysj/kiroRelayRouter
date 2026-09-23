# kiroProxy

`kiroProxy` 是 `kiro-relayrouter` 的后端。它从 PostgreSQL 读取中转站的 Base URL、模型 ID 和 API Key，将 Kiro 请求转成 OpenAI Chat Completions 请求，再将上游 SSE 转成 Kiro 需要的 AWS EventStream。

> **阅读顺序提示**
>
> 权威的架构说明、部署步骤和配置参考请看仓库根目录：
> [`README.md`](../README.md) / [`README.en.md`](../README.en.md) 与
> [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) / [`docs/ARCHITECTURE.en.md`](../docs/ARCHITECTURE.en.md)。
>
> 本文是按功能演进逐步累积的开发笔记，保留了很多实现取舍的原始上下文，值得读，
> 但**其中的管理接口鉴权示例已经过时**：早期版本用 `KIRO_ADMIN_TOKEN` 环境变量 +
> `X-Admin-Token` 请求头，当前版本已改为 `admin_account` 表 + `POST /api/admin/auth/login`
> 签发的 HS256 JWT，管理接口统一用 `Authorization: Bearer <JWT>`。下文出现
> `X-Admin-Token` 的地方请按新机制替换。
>
> Authoritative architecture, deployment, and configuration docs live at the repository
> root. This file is an accumulated development log: still worth reading for the original
> reasoning, but **its admin-authentication examples are outdated** — `KIRO_ADMIN_TOKEN`
> with an `X-Admin-Token` header has been replaced by an HS256 JWT issued from
> `POST /api/admin/auth/login`, sent as `Authorization: Bearer <JWT>`.

## 本地启动

默认连接参数：

```text
jdbc:postgresql://localhost:5432/kiroProxy
username: root
password: 12345678
```

这些值可分别用 `DB_URL`、`DB_USERNAME`、`DB_PASSWORD` 环境变量覆盖。首次启动时 Flyway 会创建 `relay_configuration` 和 `relay_model` 表。

```bash
./mvnw spring-boot:run
```

服务默认只监听 `127.0.0.1:8080`。

应用就绪后 `StartupListener` 会自动检查 PostgreSQL、中转配置和中转站 `/models` 连接。检查异常会写入启动日志但不会终止进程；日志不会输出 API Key 或上游真实模型 ID。

## 配置中转站

初始记录的 API Key 为空，设置 `KIRO_ADMIN_TOKEN` 环境变量并启动后调用：

```bash
curl -X PUT http://127.0.0.1:8080/api/relay/config \
  -H 'X-Admin-Token: change-this-admin-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "enabled": true,
    "baseUrl": "https://api.your-upstream-provider.example/v1",
    "models": ["your-model-id"],
    "apiKey": "your-api-key"
  }'
```

`GET /api/relay/config` 必须携带有效访问 Token，只返回授权模型的展示名及状态，不返回上游地址、真实模型 ID 或密钥。再次 `PUT` 时如果 `apiKey` 留空，会保留数据库中已有的密钥。

读取配置时，后端会尝试从中转站 `GET /models` 刷新模型，成功或失败结果默认缓存 5 分钟，避免每次打开面板都增加一次上游 RTT。Kiro 和扩展只能看到 `display_name`，上游真实模型 ID 仅保留在后端数据库与请求链路中。可用 `RELAY_MODEL_CATALOG_CACHE_TTL` 修改缓存时间。

模型列表按 `relay_model.sort_order` 升序排列，数值越小越靠前；相同时按 `model_id` 稳定排序。Token 的分类权限筛选保留该顺序，首个授权模型作为默认模型。中转站目录刷新保留已有模型的排序值，新模型追加到已有排序值之后；显式通过配置更新接口提交模型列表时仍按提交顺序保存。修改排序值后，后端下一次模型列表查询读取新顺序；Kiro Agent 会按自身约 5 分钟的周期自动刷新下拉列表，无需重载窗口。当前 `relay_access_group` 没有 `sort_order` 字段。

后端会本地回答简单问候和模型身份探测，不将它们发往中转站。包含项目、代码、结构、分析等任务语义的请求不会被该规则拦截。

图文请求支持 Kiro 的 `images[].source.bytes`，以及 `data`、`source.data`、字节数组和 Buffer JSON 表示；`png`、`jpg` 等格式会转换成完整 MIME 类型。当前消息和历史消息中的图片均转换为 Chat Completions 的 `image_url` 内容块，与文字一起发给中转站；同时读取消息与上下文中的图片，并在每条消息内去重。带图请求不进入本地问候回复，缺失或无效图片会明确报错。上游日志的 `received_images`、`upstream_images` 分别表示收到的图片条目数和转换后实际发送的图片数，不输出图片内容。图片理解能力取决于中转站所用模型是否支持视觉输入。

## 访问 Token 与模型分类

访问认证始终开启，旧的 `KIRO_ACCESS_AUTH_ENABLED=false` 不再生效。管理接口另外使用环境变量：

```bash
export KIRO_ADMIN_TOKEN='change-this-admin-token'
```

访问 Token 明文保存在 `relay_access_token.token`，每次请求由后端直接查库比对，并检查 Token 及所属分类启用状态，不缓存认证结果。前端只提交当前 Token，不下载数据库 Token 列表。有效期独立限制聊天调用：已过期但仍存在且启用的 Token 可以登录、激活代理并读取所属分类模型。

先创建分类并在 `relay_access_group_model` 中明确绑定允许访问的模型，再签发 Token。分类和其他表统一通过数值 `id` 关联，新模型不会自动授权。管理接口的 `models` 字段优先使用 Model ID，同时兼容展示名。

```bash
# 创建分类；响应中的 id 用于后续签发 Token
curl -X POST http://127.0.0.1:8080/api/admin/access/groups \
  -H 'X-Admin-Token: change-this-admin-token' -H 'Content-Type: application/json' \
  -d '{"displayName":"5.5 用户","enabled":true,"billingMultiplier":1.0,"models":["gpt-5.5"]}'

# 签发 Token；将响应中的 token 交给用户
curl -X POST http://127.0.0.1:8080/api/admin/access/tokens \
  -H 'X-Admin-Token: change-this-admin-token' -H 'Content-Type: application/json' \
  -d '{"label":"user-001","groupId":1,"enabled":true,"expiresAt":null,"initialPoints":100}'
```

可通过 `GET /api/admin/access/groups`、`GET /api/admin/access/tokens` 查看分类和明文 Token（仅管理 Token 可访问），通过 `DELETE /api/admin/access/tokens/{id}` 禁用，下次请求立即生效。扩展使用 SecretStorage 保存 Token，并在后端请求中携带 `Authorization: Bearer ...`。

扩展点击“保存并应用”时先调用 `POST /api/relay/session` 查库验证候选 Token，成功后才保存并重启代理；失败不会覆盖原配置或触发重载。此接口只读本地模型配置，不等待中转站模型目录刷新。无效 Token 返回 401；合法 Token 发送已被移出分组的模型时，返回符合 Kiro 协议的终止流和 `MODEL_ACCESS_CHANGED` 结果标记，在对话中提示切换模型，不请求上游。模型列表响应携带 `Cache-Control: no-store`。

登录和配置接口通过 `tokenStatus` 返回 `expiresAt`（为空表示永不过期）、`expired`、向上取整的 `remainingDays` 及服务器时间 `serverTime`。聊天请求收到后，若 Token 已过期，后端返回 HTTP 200 的完整 Kiro EventStream，在对话中提示“当前访问 Token 已过期”，响应头带 `X-Relay-Result-Code: TOKEN_EXPIRED` 和 `X-Relay-Token-Expired: true`；不会调用中转站，也不会执行本地问候回复。续期后下一次聊天请求即可正常通过。

升级注意：V4 将访问认证切换为明文 Token，V5 移除已废弃的 `legacy_token_hash` 字段，并为访问令牌表及全部 9 个字段添加中文数据库注释。迁移原地更新表结构，保留已有主键、明文 Token 和分类关系。hash 无法还原为明文，历史上没有明文 Token 的记录仍保持禁用，需重新签发或补录 `token` 后启用。明文 Token 属于敏感凭据，请限制数据库、备份及管理接口访问。

V6 移除冗余的 `token_prefix` 字段，当前表保留 8 个字段及其中文注释。管理接口为兼容原调用方，仍返回实时从 `token` 截取的 `prefix`；扩展的前缀展示直接从本地 SecretStorage 保存的 Token 生成，不读取后端前缀字段。

## Token 用量与积分计费

V7 为 `relay_access_group` 增加 `billing_multiplier`，并新建价格版本表 `relay_model_pricing` 和请求流水表 `relay_usage_record`。当前系统没有独立用户表，因此流水关联 `access_token_id`，用于按每个发放 Token 统计总量。价格和流水字段均带中文 comment；价格表不外键关联可被目录刷新删除的模型表，以保留历史价格和账单。

每次真正转发给中转站的请求先写入 `PENDING`，上游 SSE 的 usage 到达后写入普通输入、缓存读取、缓存写入及输出 Token。失败请求记为 `FAILED`，没有 usage 记为 `MISSING_USAGE`；未配置模型价格时仍保留 Token 用量，但状态为 `UNPRICED`、积分为 0，避免使用错误单价记账。

```text
provider_cost_usd =
    input_tokens             / pricing_unit * input_price
  + cache_input_tokens       / pricing_unit * cache_input_price
  + cache_write_input_tokens / pricing_unit * cache_write_input_price
  + output_tokens            / pricing_unit * output_price
  + tool_cost_usd

charged_points = provider_cost_usd * 10 * billing_multiplier
```

`1 USD = 10 积分` 是后端常量。每条流水保存价格、兑换率和分组倍率快照，后续修改价格不会改写历史账单。管理员通过 `POST /api/admin/access/pricing` 添加价格版本，`GET /api/admin/access/pricing` 查看价格，`GET /api/admin/access/usage?accessTokenId=...&limit=100` 查看流水；`GET /api/admin/access/tokens` 的 `usage` 字段返回每个 Token 的累计 Token、美元成本和积分。

价格示例（`modelId` 必须替换为数据库中的真实模型 ID，单价以中转商实际费率为准）：

```bash
curl -X POST http://127.0.0.1:8080/api/admin/access/pricing \
  -H 'X-Admin-Token: change-this-admin-token' -H 'Content-Type: application/json' \
  -d '{"modelId":"your-real-model-id","inputPrice":3,"cacheInputPrice":0.3,"cacheWriteInputPrice":0,"outputPrice":15,"pricingUnit":1000000,"currency":"USD","priceSource":"relay","enabled":true}'
```

## 并发与流式请求

中转站返回标准 SSE，kiroProxy 为每个请求独立解析 SSE 并转换为 Kiro AWS EventStream。下游初始帧会在等待上游响应头之前立即 flush；日志会记录 `upstream_headers_ms`、`first_output_ms` 和 `total_ms`，只记录展示名，用来区分是连接、上游排队还是生成本身慢。

后端使用可复用的 HTTP 客户端连接池和有界流式任务线程池，默认最多 200 个同时执行的长连接、无排队。16 个核心线程忙碌后立即扩容，到达 200 个时返回 HTTP 503 和 `Retry-After: 1`。旧配置的 500 容量队列会先排队、队满后才扩容，不适合长时间流式响应。可通过 `RELAY_STREAM_CORE_POOL_SIZE`、`RELAY_STREAM_MAX_POOL_SIZE`、`RELAY_STREAM_QUEUE_CAPACITY` 和 `RELAY_STREAM_ASYNC_TIMEOUT` 调整。

收到 SSE `[DONE]` 后立即结束上游读取并发送 Kiro 结束元数据，不继续等待上游 HTTP EOF；`finish_reason` 后可能还有 usage 帧，因此保留到 `[DONE]` 为止。上游未发 `[DONE]` 但在 `finish_reason` 后正常 EOF 时也可结束。异常断流返回错误，响应体读取受整个请求的 10 分钟截止时间约束。

每个请求的 InputStream、解析状态、OutputStream 都独立。通过 `x-relay-request-id` 关联插件和后端日志：`accepted` → `stream_start`（含 queue_ms）→ `upstream_start` → `upstream_headers` → `first_output` → `upstream_finish` → `upstream_done` → `stream_end`。插件的“首字节”可能只是初始帧，不能当成首个模型内容或完整响应速度。后端仅记录字节数、历史消息数、工具数量和阶段时间，不记录提示词、Token 或上游错误原文。

中转站在模型输出前返回模型不存在、模型不可用等业务错误时，后端读取 HTTP JSON 或 SSE 错误，转换成 Kiro 对话中可读的提示并完整结束流。日志 `upstream_error` 记录 HTTP 状态、标准化错误类别（如 `MODEL_NOT_FOUND`）及请求编号。普通 404 不直接认定模型不存在；上游原始错误、真实模型 ID 和密钥不下发。错误响应正文最多读取 64 KiB，等待最多 2 秒且受总请求截止时间约束，不自动重试。已经开始输出内容或工具调用后的异常仍走异常帧，避免把未完成的工具调用当成成功。

云端经过 Nginx 时，在流式路由配置 `proxy_buffering off;`、`proxy_cache off;`，并让 `proxy_read_timeout` 大于正常长请求时长。额外网络往返受部署地区影响，不应凭本地 60 秒等待直接推算云端延迟。

其他接口：

- `GET /api/relay/health`：后端与配置状态。
- `POST /api/relay/session`：校验访问 Token 并返回授权模型配置。
- `POST /api/relay/kiro`：接收扩展透传的 Kiro 请求。
- `/swagger-ui.html`：OpenAPI 界面。

> 配置更新接口会写入 API Key，必须使用管理 Token。如果将服务改为非本机监听，还应配置 HTTPS，不要将管理 Token 发给普通用户。

## 验证

```bash
./mvnw test
```
