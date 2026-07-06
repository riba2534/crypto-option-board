# BTC Option Board

BTC Option Board 是一个面向 BTC 期权交易者的只读行情看板，重点展示 OKX BTC 期权的卖方收益、权利金美元价值、流动性与风险标签，并用 Binance BTC 期货数据监控永续、当季、次季合约的升贴水和期限溢价。

项目采用服务端请求交易所 API 的架构：浏览器只访问本项目服务端，服务端负责拉取 OKX / Binance 公共行情并缓存最新快照。期货期限溢价会定时写入本地 SQLite，适合部署在 Linux 服务器或开发机上供多设备访问。

## 功能特性

- BTC 期权链展示，数据源为 OKX `BTC-USD` 期权。
- BTC 期货期限溢价展示，数据源为 Binance USDⓈ-M `BTCUSDT` 永续、当季、次季合约。
- 服务端聚合 OKX 行情，浏览器不直接请求 OKX。
- 服务端聚合 Binance 期货 mark / index / funding / OI / 24h volume。
- 服务端内存缓存，默认每 5 秒刷新一次。
- SQLite 记录 Binance 期货 basis 快照，默认生产路径为 `/data/market.sqlite`。
- 独立的 `期权` 与 `期货 / Basis` tab。
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
- Binance USDⓈ-M Futures Public REST API
- SQLite (`node:sqlite`)
- Docker

## 快速开始

### 环境要求

- Node.js 22.5 或更高版本
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
  -v crypto-option-board-data:/data \
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
| `BINANCE_USDM_BASE_URL` | `https://fapi.binance.com` | Binance USDⓈ-M Futures API 基础地址 |
| `MARKET_DB_PATH` | 生产环境 `/data/market.sqlite`，开发环境 `.data/market.sqlite` | SQLite 数据库路径 |
| `MARKET_COLLECTOR_ENABLED` | 未设置 | 设为 `false` 可关闭后台定时采集 |
| `MARKET_RAW_RETENTION_DAYS` | `30` | 期货 basis 原始快照保留天数 |
| `BINANCE_BASIS_REFRESH_MS` | `30000` | Binance 期限溢价采样间隔 |
| `BINANCE_BASIS_STALE_MS` | `180000` | 期货数据 stale 判定时间 |
| `BINANCE_BASIS_HISTORY_HOURS` | `24` | API 返回的期货历史窗口 |
| `BIND_HOST` | `0.0.0.0` | 服务监听地址 |
| `PORT` | `3000` | 服务监听端口 |

示例：

```bash
OKX_BASE_URL=https://www.okx.com BIND_HOST=0.0.0.0 PORT=3000 npm run start
```

## 数据来源

期权 tab 使用 OKX 公共 REST API：

- 合约列表：`/api/v5/public/instruments?instType=OPTION&instFamily=BTC-USD`
- 期权行情：`/api/v5/market/tickers?instType=OPTION&instFamily=BTC-USD`
- IV / Greeks：`/api/v5/public/opt-summary?instFamily=BTC-USD`
- 持仓量：`/api/v5/public/open-interest?instType=OPTION&instFamily=BTC-USD`
- BTC 指数价：`/api/v5/market/index-tickers?instId=BTC-USD`

期货 / Basis tab 使用 Binance USDⓈ-M Futures 公共 REST API：

- 合约列表：`/fapi/v1/exchangeInfo`
- mark / index / funding：`/fapi/v1/premiumIndex`
- 当前 OI：`/fapi/v1/openInterest`
- 24h 成交：`/fapi/v1/ticker/24hr`
- 官方 basis 参考：`/futures/data/basis`

本项目服务端接口：

| 接口 | 说明 |
| --- | --- |
| `/api/options/snapshot` | 返回聚合后的 BTC 期权快照 |
| `/api/futures/basis` | 返回 Binance BTC 期货期限溢价最新曲线和 SQLite 历史 |
| `/api/futures/health` | 返回 Binance 期限溢价采集健康状态 |
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

### 期限溢价

期货 / Basis tab 使用 Binance `BTCUSDT` 线性合约曲线：

```text
basisPct = markPx / indexPx - 1

annualizedBasis = basisPct × 365 / DTE

annualizedFunding = fundingRate × 3 × 365
```

说明：

- 永续合约展示 `perp premium` 和 funding 年化。
- 当季、次季合约展示相对 Binance index 的年化升贴水。
- Binance 期货期限溢价用于市场结构监控，不替代 OKX 期权自己的 `indexPx / fwdPx / Greeks` 口径。

## 项目结构

```text
.
├── Dockerfile
├── docs/
│   └── product-plan.md
├── public/
│   └── logo.svg
├── scripts/
│   ├── prepare-standalone.mjs
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
│       │   ├── binance-basis-cache.ts
│       │   ├── binance-client.ts
│       │   ├── market-db.ts
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
