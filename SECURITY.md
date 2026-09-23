# 安全说明 / Security

[中文](#中文) · [English](#english)

---

## 中文

### 报告漏洞

请不要在公开 issue 里附带可直接利用的细节。先开一个只说明影响范围的 issue，或直接私下联系维护者，等修复发布后再公开技术细节。

### 这个仓库做过什么脱敏

开源之前做过一轮系统性脱敏，公开内容里不包含任何真实凭据或线上地址。

| 项目 | 处理方式 |
| --- | --- |
| 后端线上域名 | 已从 `kiro-relayrouter/src/extension.js` 移除。源码里只有 `http://127.0.0.1:8080`，真实地址由 `build.js` 在打包时从 `RELAYROUTER_BACKEND_ENDPOINT` 注入 |
| 前端 API 地址 | `src/lib/api/admin.ts` 与 `docs.ts` 的兜底值改成 `http://127.0.0.1:8080/api`，线上地址只存在于被 gitignore 的 `.env.local` / `.env.production` |
| 数据库 / Redis / RabbitMQ 凭据 | 只提交 `kiroProxy/.env.example`，全部值为 `CHANGE_ME`。`.dev.env` 与 `.prod.env` 已被 gitignore |
| Cloudflare R2 凭据 | 同上，`.env.example` 里是占位值 |
| 管理端 JWT 密钥 | `.env.example` 里是占位值，`application.yml` 的默认值带 `change-me` 字样 |
| 种子管理员口令 | `V2__seed_required_data.sql` 里改成公开占位值 `admin` / `ChangeMe@123456`，并在脚本头部写了必须立即修改的提示 |
| 教程图片域名 | 改成 `https://YOUR-R2-PUBLIC-DOMAIN.example`，部署后需要替换成自己的 R2 公共域名 |
| 数据库导出 | `kiroProxy/database-backups/` 已被 gitignore。`pg_dump` 导出里含上游 API Key 与明文访问 Token |
| 日志文件 | `kiroProxy/kiroProxyLogs/` 与所有 `*.log` / `*.log.gz` 已被 gitignore |
| 已打包的 `.vsix` 与压缩包 | 全部被 gitignore，里面固化了构建时的线上地址 |
| 前端构建产物 | `dist/` 已被 gitignore，打包结果里含注入的线上地址 |

被 gitignore 的凭据类文件清单：

```
kiroProxy/.dev.env
kiroProxy/.prod.env
kiroProxy/.env
kiroProxy/database-backups/
kiro-proxy-frontend/.env.local
kiro-proxy-frontend/.env.production
kiro-relayrouter/.endpoint.local
```

只有 `*.example` 模板会被提交。

### 自部署必读

**部署后立刻做的三件事**

1. 修改种子管理员凭据：
   ```sql
   UPDATE public.admin_account SET username = '<your-admin>', password = '<strong-password>';
   ```
2. 生成一个真正随机的管理端 JWT 密钥：
   ```bash
   openssl rand -hex 32
   ```
3. 把 `KIRO_ADMIN_ALLOWED_ORIGIN_PATTERNS` 写成具体域名，不要留通配。

**网络边界**

- 生产环境 `SERVER_ADDRESS=127.0.0.1`，只让反向代理进来，TLS 在反代上终止。
- 生产 Profile 默认已关闭 `/swagger-ui.html` 与 `/v3/api-docs`（返回 404），只在临时排障时打开。
- 管理接口（`/api/admin/**`）和用户接口（`/api/relay/**`）走两套独立鉴权，不要把管理端凭据发给终端用户。

**明文存储的两个字段**

`admin_account.password` 与 `relay_access_token.token` 目前都是明文存储，表注释里有明确说明。这是当前的业务取舍——管理端需要"查看明文"来把访问 Token 交付给用户。如果你要面向公网运营：

- 收紧数据库、数据库备份和管理接口的访问范围。
- 管理后台的"查看明文"操作应当有审计。
- 更彻底的做法是改成加密存储 + 仅签发时可见一次，代价是运营流程要跟着改。

**日志**

后端刻意不记录提示词正文、访问 Token、上游 API Key、上游真实模型 ID、上游错误原文和图片内容。如果你新增日志，请沿用这条约定。

**依赖**

后端依赖由 `kiroProxy/pom.xml` 固定版本，前端由 `pnpm-lock.yaml` 锁定。升级前建议跑一遍 `./mvnw dependency:tree` 和 `pnpm audit`。

---

## English

### Reporting a vulnerability

Please do not attach directly exploitable details to a public issue. Open an issue describing only the impact, or contact the maintainer privately, and publish the technical detail after a fix ships.

### What was sanitised in this repository

A systematic pass was made before open-sourcing. The published content contains no real credentials and no production hostnames.

| Item | How it was handled |
| --- | --- |
| Backend production hostname | Removed from `kiro-relayrouter/src/extension.js`. The source only contains `http://127.0.0.1:8080`; the real address is injected by `build.js` from `RELAYROUTER_BACKEND_ENDPOINT` at packaging time |
| Frontend API base URL | The fallbacks in `src/lib/api/admin.ts` and `docs.ts` are now `http://127.0.0.1:8080/api`; the production URL exists only in the git-ignored `.env.local` / `.env.production` |
| Database / Redis / RabbitMQ credentials | Only `kiroProxy/.env.example` is committed, with every value set to `CHANGE_ME`. `.dev.env` and `.prod.env` are git-ignored |
| Cloudflare R2 credentials | Same: placeholders in `.env.example` |
| Admin JWT secret | A placeholder in `.env.example`; the `application.yml` default is visibly a `change-me` value |
| Seeded admin credential | `V2__seed_required_data.sql` now carries the public placeholder `admin` / `ChangeMe@123456`, with a header note requiring an immediate change |
| Tutorial image hostname | Replaced with `https://YOUR-R2-PUBLIC-DOMAIN.example`, to be swapped for your own R2 public domain after deployment |
| Database dumps | `kiroProxy/database-backups/` is git-ignored. A `pg_dump` there carries upstream API keys and plaintext access tokens |
| Log files | `kiroProxy/kiroProxyLogs/` and every `*.log` / `*.log.gz` are git-ignored |
| Packaged `.vsix` files and archives | All git-ignored; they bake in the build-time production address |
| Frontend build output | `dist/` is git-ignored; the bundle contains the injected production address |

Credential-bearing files excluded by `.gitignore`:

```
kiroProxy/.dev.env
kiroProxy/.prod.env
kiroProxy/.env
kiroProxy/database-backups/
kiro-proxy-frontend/.env.local
kiro-proxy-frontend/.env.production
kiro-relayrouter/.endpoint.local
```

Only the `*.example` templates are committed.

### Required reading before self-hosting

**Three things to do immediately after deployment**

1. Change the seeded administrator credential:
   ```sql
   UPDATE public.admin_account SET username = '<your-admin>', password = '<strong-password>';
   ```
2. Generate a genuinely random admin JWT secret:
   ```bash
   openssl rand -hex 32
   ```
3. Set `KIRO_ADMIN_ALLOWED_ORIGIN_PATTERNS` to concrete domains, never a wildcard.

**Network boundary**

- In production set `SERVER_ADDRESS=127.0.0.1` so only the reverse proxy can reach the app, and terminate TLS at the proxy.
- The prod profile already disables `/swagger-ui.html` and `/v3/api-docs` (they return 404). Enable them only for temporary troubleshooting.
- Admin endpoints (`/api/admin/**`) and user endpoints (`/api/relay/**`) run on two independent authentication mechanisms. Never hand admin credentials to an end user.

**Two columns stored in plaintext**

`admin_account.password` and `relay_access_token.token` are currently stored in plaintext, as their table comments state. It is a business trade-off: the console needs a "reveal" action to deliver access tokens to users. If you plan to operate publicly:

- Tighten access to the database, its backups, and the admin endpoints.
- Audit the console's "reveal plaintext" action.
- The thorough fix is encryption at rest with one-time visibility at issuance, which means adapting your operational process too.

**Logging**

The backend deliberately never logs prompt text, access tokens, upstream API keys, real upstream model IDs, raw upstream error bodies, or image content. If you add logging, keep that convention.

**Dependencies**

Backend dependency versions are pinned in `kiroProxy/pom.xml`; the frontend is locked by `pnpm-lock.yaml`. Before upgrading, run `./mvnw dependency:tree` and `pnpm audit`.
