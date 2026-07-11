import { FuturesMarketStats } from "@/lib/types";

const OKX_BASE_URL = process.env.OKX_BASE_URL ?? "https://www.okx.com";
const CACHE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

interface CacheState {
  value: FuturesMarketStats | null;
  expiresAt: number;
  pending: Promise<FuturesMarketStats | null> | null;
}

const globalForStats = globalThis as typeof globalThis & {
  __okxFuturesMarketStats?: CacheState;
};

function getCache() {
  if (!globalForStats.__okxFuturesMarketStats) {
    globalForStats.__okxFuturesMarketStats = { value: null, expiresAt: 0, pending: null };
  }
  return globalForStats.__okxFuturesMarketStats;
}

function toNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchOkx<T>(path: string): Promise<T[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${OKX_BASE_URL}${path}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "crypto-option-board/0.1" }
    });
    if (!response.ok) throw new Error(`OKX ${path} HTTP ${response.status}`);
    const payload = (await response.json()) as { code: string; msg: string; data: T[] };
    if (payload.code !== "0" || !Array.isArray(payload.data)) {
      throw new Error(`OKX ${path} code ${payload.code}: ${payload.msg}`);
    }
    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

interface LiquidationGroup {
  details: Array<{ posSide: "long" | "short"; sz: string; ts: string }>;
}

interface FundingRow {
  fundingRate: string;
  realizedRate?: string;
  fundingTime: string;
}

async function loadStats(): Promise<FuturesMarketStats> {
  const [takerRows, ratioRows, topTraderRows, liquidationGroups, fundingRows] = await Promise.all([
    fetchOkx<string[]>("/api/v5/rubik/stat/taker-volume?ccy=BTC&instType=CONTRACTS&period=1H"),
    fetchOkx<string[]>("/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H"),
    fetchOkx<string[]>(
      "/api/v5/rubik/stat/contracts/long-short-position-ratio-contract-top-trader?instId=BTC-USDT-SWAP&period=1H"
    ),
    fetchOkx<LiquidationGroup>("/api/v5/public/liquidation-orders?instType=SWAP&uly=BTC-USD&state=filled&limit=100"),
    fetchOkx<FundingRow>("/api/v5/public/funding-rate-history?instId=BTC-USD-SWAP&limit=30")
  ]);

  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const taker24h = takerRows.filter((row) => (toNumber(row[0]) ?? 0) >= dayAgo);
  const takerBuyVolume24h = taker24h.reduce((sum, row) => sum + (toNumber(row[1]) ?? 0), 0);
  const takerSellVolume24h = taker24h.reduce((sum, row) => sum + (toNumber(row[2]) ?? 0), 0);
  const takerTotal = takerBuyVolume24h + takerSellVolume24h;

  let longLiquidations24hUsd = 0;
  let shortLiquidations24hUsd = 0;
  for (const group of liquidationGroups) {
    for (const detail of group.details ?? []) {
      if ((toNumber(detail.ts) ?? 0) < dayAgo) continue;
      const notionalUsd = (toNumber(detail.sz) ?? 0) * 100;
      if (detail.posSide === "long") longLiquidations24hUsd += notionalUsd;
      if (detail.posSide === "short") shortLiquidations24hUsd += notionalUsd;
    }
  }

  const realized = fundingRows
    .map((row) => ({
      ts: toNumber(row.fundingTime) ?? 0,
      rate: toNumber(row.realizedRate ?? row.fundingRate)
    }))
    .filter((row): row is { ts: number; rate: number } => row.rate !== null);
  const funding24h = realized.filter((row) => row.ts >= dayAgo);
  const funding7d = realized.filter((row) => row.ts >= weekAgo);

  return {
    takerBuyVolume24h,
    takerSellVolume24h,
    takerImbalance24h: takerTotal > 0 ? (takerBuyVolume24h - takerSellVolume24h) / takerTotal : null,
    longShortAccountRatio: toNumber(ratioRows[0]?.[1]),
    topTraderLongShortRatio: toNumber(topTraderRows[0]?.[1]),
    longLiquidations24hUsd,
    shortLiquidations24hUsd,
    lastRealizedFundingRate: realized[0]?.rate ?? null,
    fundingSum24h: funding24h.length ? funding24h.reduce((sum, row) => sum + row.rate, 0) : null,
    fundingAverage7d: funding7d.length
      ? funding7d.reduce((sum, row) => sum + row.rate, 0) / funding7d.length
      : null,
    topTraderAccountRatio: null,
    topTraderPositionRatio: null,
    openInterestChange24h: null,
    openInterestToMarketCap: null,
    adlRisk: null,
    insuranceFundUsd: null,
    statsSource: "OKX",
    liquidationSource: "OKX",
    updatedAt: now
  };
}

export async function getOkxFuturesMarketStats() {
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
      console.error(`[okx-futures] market stats refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return cache.value;
    })
    .finally(() => {
      cache.pending = null;
    });
  return cache.pending;
}
