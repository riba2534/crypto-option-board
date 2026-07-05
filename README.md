# BTC Option Board

BTC Option Board 是一个面向 BTC 期权交易者的只读行情看板，重点展示 OKX BTC 期权的卖方收益、权利金美元价值、流动性与风险标签。

项目采用服务端请求 OKX API 的架构：浏览器只访问本项目服务端，服务端负责拉取 OKX 公共行情并缓存最新快照，适合部署在 Linux 服务器或开发机上供多设备访问。

## 功能特性

- BTC 期权链展示，数据源为 OKX `BTC-USD` 期权。
- 服务端聚合 OKX 行情，浏览器不直接请求 OKX。
- 服务端内存缓存，默认每 5 秒刷新一次。
- 支持 Put / Call / Both 过滤。
- 支持到期日、APR、价差和流动性过滤。
- 展示卖方 APR、Bid / Ask、Delta、OTM、OI、风险标签。
- 展示权利金美元价值：
  - `Bid USD/BTC = bidPx × BTC Index`
  - `Ask USD/BTC = askPx × BTC Index`
  - `权利金/张 = bidPx × BTC Index × ctMult`
- 支持浅色 / 暗色主题切换，默认浅色。
- 支持桌面端和移动端访问。
- 提供 Docker 部署方式。

## 技术栈

- TypeScript
- Next.js App Router
- React
- CSS Variables
- OKX Public REST API
- Docker

## 快速开始

### 环境要求

- Node.js 20.9 或更高版本
- npm

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

访问：

```text
http://localhost:3000
```

开发模式默认监听 `0.0.0.0`，同一局域网内其他设备可通过开发机 IP 访问。

## 生产运行

先构建：

```bash
npm run build
```

再启动：

```bash
npm run start
```

生产服务默认监听：

```text
0.0.0.0:3000
```

例如开发机 IP 为 `192.168.31.127` 时，其他设备可访问：

```text
http://192.168.31.127:3000
```

## Docker 部署

构建镜像：

```bash
docker build -t crypto-option-board .
```

运行容器：

```bash
docker run -d \
  --name crypto-option-board \
  -p 3000:3000 \
  --restart unless-stopped \
  crypto-option-board
```

查看日志：

```bash
docker logs -f crypto-option-board
```

停止并删除容器：

```bash
docker stop crypto-option-board
docker rm crypto-option-board
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OKX_BASE_URL` | `https://www.okx.com` | OKX API 基础地址 |
| `HOSTNAME` | `0.0.0.0` | 服务监听地址 |
| `PORT` | `3000` | 服务监听端口 |

示例：

```bash
OKX_BASE_URL=https://www.okx.com HOSTNAME=0.0.0.0 PORT=3000 npm run start
```

## 数据来源

当前使用 OKX 公共 REST API：

- 合约列表：`/api/v5/public/instruments?instType=OPTION&instFamily=BTC-USD`
- 期权行情：`/api/v5/market/tickers?instType=OPTION&instFamily=BTC-USD`
- IV / Greeks：`/api/v5/public/opt-summary?instFamily=BTC-USD`
- 持仓量：`/api/v5/public/open-interest?instType=OPTION&instFamily=BTC-USD`
- BTC 指数价：`/api/v5/market/index-tickers?instId=BTC-USD`

本项目服务端接口：

| 接口 | 说明 |
| --- | --- |
| `/api/options/snapshot` | 返回聚合后的 BTC 期权快照 |
| `/api/health` | 返回缓存和服务健康状态 |

## 计算口径

### 权利金

看板同时展示两个美元口径：

```text
Bid USD/BTC = bidPx × BTC Index
Ask USD/BTC = askPx × BTC Index
权利金/张 = bidPx × BTC Index × ctMult
```

其中 `ctMult` 来自 OKX 合约信息。当前 OKX BTC 期权通常为 `0.01 BTC`。

### APR

当前 APR 使用 `bidPx` 计算，代表卖方按买一价立即成交的保守口径。

卖 Put：

```text
premiumUsd = bidPx × BTC Index × ctMult

cashSecuredPutAPR =
  premiumUsd / (strike × ctMult) × 365 / DTE
```

卖 Covered Call：

```text
premiumUsd = bidPx × BTC Index × ctMult

coveredCallAPR =
  premiumUsd / (BTC Index × ctMult) × 365 / DTE
```

说明：

- 当前 APR 是简单年化，不是复利 APY。
- 当前 APR 未扣除手续费、滑点和真实账户保证金占用。
- `bidPx` 用于默认排序和收益计算，`askPx` 仅作为参考显示。

## 项目结构

```text
.
├── Dockerfile
├── docs/
│   └── product-plan.md
├── public/
│   └── logo.svg
├── scripts/
│   └── start-standalone.mjs
├── src/
│   ├── app/
│   │   ├── api/
│   │   ├── globals.css
│   │   ├── icon.svg
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components/
│   │   └── dashboard.tsx
│   └── lib/
│       ├── server/
│       │   ├── okx-cache.ts
│       │   └── okx-client.ts
│       └── types.ts
├── package.json
└── README.md
```

## 常用命令

```bash
npm run dev        # 启动开发服务
npm run build      # 生产构建
npm run start      # 启动生产服务
npm run typecheck  # TypeScript 类型检查
```

## 注意事项

- 本项目是只读行情看板，不包含下单、撤单和账户私有数据。
- OKX 公共接口可能出现空 bid、空 ask、低流动性或 IV 拟合缺失，页面会通过风险标签提示。
- 权利金和 APR 用于辅助比较，不构成投资建议。

## License

当前项目尚未指定开源许可证。如需正式开源，建议补充 `LICENSE` 文件。
