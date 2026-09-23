# kiro Relayrouter

kiro Relayrouter 控制管理系统前端，用于管理中转站、模型、路由与价格、访问分组、积分与计费规则，以及用量账单。

## 本地运行

```bash
pnpm install
pnpm dev
```

默认开发地址由 Vite 输出。后端地址可通过 `.env` 中的 `VITE_KIRO_API_BASE_URL` 配置。

## 质量检查

```bash
pnpm test
pnpm lint
pnpm format:check
pnpm build
```

## 技术栈

- React + TypeScript
- Vite
- TanStack Router / Query / Table
- Tailwind CSS + Radix UI
- Zustand

## 保留模块

- 中转站管理
- 模型管理
- 路由与价格
- 访问分组与计费
- 积分与计费规则（含销售利润模拟）
- 用量与账单
- 管理员登录与系统错误页
