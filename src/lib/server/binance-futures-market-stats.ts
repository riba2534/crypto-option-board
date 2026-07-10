import { FuturesMarketStats } from "@/lib/types";
import { readFuturesLiquidationTotals } from "@/lib/server/market-db";

const BINANCE_FAPI_URL = process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com";
const CACHE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const SYMBOL = "BTCUSDT";

interface CacheState {
  value: FuturesMarketStats | null;
  expiresAt: number;
  pending: Promise<FuturesMarketStats | null> | null;
}

const globalForStats = globalThis as typeof globalThis & {
  __binanceFuturesMarketStats?: CacheState;
};

function getCache() {
  if (!globalForStats.__binanceFuturesMarketStats) {
    globalForStats.__binanceFuturesMarketStats = { value: null, expiresAt: 0, pending: null };
  }
  return globalForStats.__binanceFuturesMarketStats;
}

function toNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchBinance<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BINANCE_FAPI_URL}${path}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "crypto-option-board/0.1" }
    });
    if (!response.ok) throw new Error(`Binance ${path} HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

// futures/data rows arrive oldest-first; the newest sample is the last element.
interface TakerRatioRow {
  buyVol: string;
  sellVol: string;
  timestamp: number;
}

interface LongShortRatioRow {
  longShortRatio: string;
  timestamp: number;
}

interface FundingRow {
  fundingRate: string;
  fundingTime: number;
}

interface PremiumIndexRow {
  markPrice: string;
}

async function loadStats(): Promise<FuturesMarketStats> {
  const [takerRows, ratioRows, topTraderRows, fundingRows, premium] = await Promise.all([
    fetchBinance<TakerRatioRow[]>(`/futures/data/takerlongshortRatio?symbol=${SYMBOL}&period=1h&limit=24`),
    fetchBinance<LongShortRatioRow[]>(`/futures/data/globalLongShortAccountRatio?symbol=${SYMBOL}&period=1h&limit=1`),
    fetchBinance<LongShortRatioRow[]>(`/futures/data/topLongShortPositionRatio?symbol=${SYMBOL}&period=1h&limit=1`),
    fetchBinance<FundingRow[]>(`/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=30`),
    fetchBinance<PremiumIndexRow>(`/fapi/v1/premiumIndex?symbol=${SYMBOL}`)
  ]);

  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const markPx = toNumber(premium.markPrice);

  // Taker volumes are reported in BTC; convert with the current mark so both
  // exchanges surface comparable USD figures.
  const taker24h = takerRows.filter((row) => (toNumber(row.timestamp) ?? 0) >= dayAgo);
  const takerBuyBtc = taker24h.reduce((sum, row) => sum + (toNumber(row.buyVol) ?? 0), 0);
  const takerSellBtc = taker24h.reduce((sum, row) => sum + (toNumber(row.sellVol) ?? 0), 0);
  const takerTotalBtc = takerBuyBtc + takerSellBtc;
  const takerBuyVolume24h = markPx !== null ? takerBuyBtc * markPx : null;
  const takerSellVolume24h = markPx !== null ? takerSellBtc * markPx : null;

  const realized = fundingRows
    .map((row) => ({ ts: toNumber(row.fundingTime) ?? 0, rate: toNumber(row.fundingRate) }))
    .filter((row): row is { ts: number; rate: number } => row.rate !== null)
    .sort((a, b) => b.ts - a.ts);
  const funding24h = realized.filter((row) => row.ts >= dayAgo);
  const funding7d = realized.filter((row) => row.ts >= weekAgo);

  // Binance removed the public force-order REST history, so liquidation totals
  // come from our own force-order stream persisted into SQLite.
  let liquidations: { longUsd: number; shortUsd: number } | null = null;
  try {
    liquidations = readFuturesLiquidationTotals("Binance", 24);
  } catch (error) {
    console.error(
      `[binance-futures] liquidation read failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    takerBuyVolume24h,
    takerSellVolume24h,
    takerImbalance24h: takerTotalBtc > 0 ? (takerBuyBtc - takerSellBtc) / takerTotalBtc : null,
    longShortAccountRatio: toNumber(ratioRows[ratioRows.length - 1]?.longShortRatio),
    topTraderLongShortRatio: toNumber(topTraderRows[topTraderRows.length - 1]?.longShortRatio),
    longLiquidations24hUsd: liquidations?.longUsd ?? null,
    shortLiquidations24hUsd: liquidations?.shortUsd ?? null,
    lastRealizedFundingRate: realized[0]?.rate ?? null,
    fundingSum24h: funding24h.length ? funding24h.reduce((sum, row) => sum + row.rate, 0) : null,
    fundingAverage7d: funding7d.length
      ? funding7d.reduce((sum, row) => sum + row.rate, 0) / funding7d.length
      : null,
    updatedAt: now
  };
}

export async function getBinanceFuturesMarketStats() {
  const cache = getCache();
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;
  if (cache.pending) return cache.pending;

  cache.pending = loadStats()
    .then((value) => {
      cache.value = value;
      cache.expiresAt = Date.now() + CACHE_MS;
      return value;
    })
    .catch((error) => {
      console.error(`[binance-futures] market stats refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return cache.value;
    })
    .finally(() => {
      cache.pending = null;
    });
  return cache.pending;
}
