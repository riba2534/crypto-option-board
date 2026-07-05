# BTC Option Board Product Plan

## Product Manager View

The product is a seller-first BTC options workstation. The first screen answers one question fast: for a given expiry and strike, what is the executable USD annualized return, and is the risk/liquidity acceptable?

P0 scope:

- BTC only, OKX only.
- Read-only market board.
- Server-side OKX fetch and 5 second cache.
- Browser reads only this application server.
- Primary workflow: filter side/expiry/liquidity, scan APR matrix, inspect selected contract.

## Professional Options Seller View

Default opportunity ranking uses executable bid-based premium rather than mark or mid.

Core formulas:

- Put APR: `premiumUsd / (strike * ctMult) * 365 / DTE`
- Covered call APR: `premiumUsd / (btcIndexPx * ctMult) * 365 / DTE`
- Premium USD per contract: `bidPx * btcIndexPx * ctMult`
- Put breakeven: `strike - bidPx * btcIndexPx`
- Call breakeven: `strike + bidPx * btcIndexPx`

Risk flags must remain visible next to yield:

- No bid / no ask
- Wide spread
- Low OI
- Low volume
- Near ATM
- Short DTE
- Stale quote

## Designer View

The interface should feel like a professional trading workstation, not a landing page.

Layout:

- Header market strip for BTC index, 24h range, contract count, cache status.
- Left fixed controls for side, metric, expiry and liquidity constraints.
- Center yield matrix and candidate table.
- Right detail panel for quote, APR, breakeven, Greeks, IV and market structure.

Visual rules:

- Dark, high-density layout.
- Tabular numbers for comparability.
- Green means higher yield, not lower risk.
- Amber flags liquidity/risk conditions.
- Heatmap cells keep stable dimensions to prevent layout shift.

## Engineering View

Architecture:

```text
OKX REST
  -> server OKX client
  -> in-memory snapshot cache refreshed every 5 seconds
  -> /api/options/snapshot
  -> browser dashboard polling local server only
```

Endpoints used:

- `/api/v5/public/instruments?instType=OPTION&instFamily=BTC-USD`
- `/api/v5/market/tickers?instType=OPTION&instFamily=BTC-USD`
- `/api/v5/public/opt-summary?instFamily=BTC-USD`
- `/api/v5/public/open-interest?instType=OPTION&instFamily=BTC-USD`
- `/api/v5/market/index-tickers?instId=BTC-USD`

Deployment:

- Next.js + TypeScript.
- Standalone production output.
- Docker image runs `node server.js` from the standalone build.

## Roadmap

P1:

- IV term structure and skew views.
- User-defined target APR alerts.
- Delta bucket comparison.
- Historical APR and IV persistence.

P2:

- OKX account read-only integration.
- Real margin ROE from account equity and positions.
- Portfolio Greeks and stress scenarios.

P3:

- Rolling workflow, strategy templates and optional trade execution guardrails.
