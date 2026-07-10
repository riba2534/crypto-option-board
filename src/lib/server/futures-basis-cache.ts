import { FuturesBasisSnapshot, FuturesCurvePoint } from "@/lib/types";
import {
  getMarketDbPath,
  readStoredFuturesBasisSnapshot,
  recordCollectorRun,
  saveFuturesBasisSnapshot
} from "@/lib/server/market-db";
import {
  getOkxFeedHealth,
  getOkxFuturesCurve,
  startOkxFuturesFeed
} from "@/lib/server/okx-futures-client";
import { getOkxFuturesMarketStats } from "@/lib/server/okx-futures-market-stats";
import {
  getBinanceFeedHealth,
  getBinanceFuturesCurve,
  startBinanceFuturesFeed
} from "@/lib/server/binance-futures-client";
import { getBinanceFuturesMarketStats } from "@/lib/server/binance-futures-market-stats";

const PERSIST_INTERVAL_MS = Number(process.env.FUTURES_BASIS_PERSIST_MS ?? 30_000);
const STALE_AFTER_MS = Number(process.env.FUTURES_BASIS_STALE_MS ?? 180_000);
const HISTORY_HOURS = Number(process.env.FUTURES_BASIS_HISTORY_HOURS ?? 24);
const SOURCE = "okx-ws+binance-rest";

interface CollectorState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

const globalForCollector = globalThis as typeof globalThis & {
  __futuresBasisCollector?: CollectorState;
};

function getCollector(): CollectorState {
  if (!globalForCollector.__futuresBasisCollector) {
    globalForCollector.__futuresBasisCollector = { started: false, timer: null };
  }
  return globalForCollector.__futuresBasisCollector;
}

// Perps first (OKX then Binance), dated tenors after (OKX then Binance).
function mergeCurves(okx: FuturesCurvePoint[], binance: FuturesCurvePoint[]): FuturesCurvePoint[] {
  const isPerp = (point: FuturesCurvePoint) => point.contractType === "PERPETUAL";
  return [
    ...okx.filter(isPerp),
    ...binance.filter(isPerp),
    ...okx.filter((point) => !isPerp(point)),
    ...binance.filter((point) => !isPerp(point))
  ];
}

function emptySnapshot(status: FuturesBasisSnapshot["status"], error: string | null): FuturesBasisSnapshot {
  const now = Date.now();
  return {
    status,
    generatedAt: now,
    refreshedAt: null,
    nextRefreshAt: now + PERSIST_INTERVAL_MS,
    ageMs: null,
    source: SOURCE,
    error,
    dbPath: getMarketDbPath(),
    indexPx: null,
    curve: [],
    history: [],
    marketStats: null,
    binanceMarketStats: null
  };
}

function persistSnapshot() {
  const startedAt = Date.now();
  const curve = mergeCurves(getOkxFuturesCurve().curve, getBinanceFuturesCurve().curve);
  if (curve.length === 0) {
    return;
  }

  try {
    const rawBySymbol = new Map<string, unknown>(curve.map((point) => [point.symbol, point]));
    saveFuturesBasisSnapshot(curve, rawBySymbol);
    recordCollectorRun(SOURCE, "ok", startedAt, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordCollectorRun(SOURCE, "error", startedAt, message);
  }
}

export function startFuturesBasisCollector() {
  const collector = getCollector();
  if (collector.started || process.env.MARKET_COLLECTOR_ENABLED === "false") {
    return;
  }

  collector.started = true;
  startOkxFuturesFeed();
  startBinanceFuturesFeed();

  collector.timer = setInterval(persistSnapshot, PERSIST_INTERVAL_MS);
  collector.timer.unref?.();
}

export async function getFuturesBasisSnapshot(): Promise<FuturesBasisSnapshot> {
  startFuturesBasisCollector();

  const now = Date.now();
  const okxLive = getOkxFuturesCurve();
  const binanceLive = getBinanceFuturesCurve();
  const curve = mergeCurves(okxLive.curve, binanceLive.curve);
  const stored = readStoredFuturesBasisSnapshot(HISTORY_HOURS);
  const [marketStats, binanceMarketStats] = await Promise.all([
    getOkxFuturesMarketStats(),
    getBinanceFuturesMarketStats()
  ]);

  if (curve.length > 0) {
    const refreshedAt = Math.max(okxLive.refreshedAt ?? 0, binanceLive.refreshedAt ?? 0) || now;
    const ageMs = now - refreshedAt;
    return {
      status: ageMs > STALE_AFTER_MS ? "stale" : "ok",
      generatedAt: now,
      refreshedAt,
      nextRefreshAt: now + PERSIST_INTERVAL_MS,
      ageMs,
      source: SOURCE,
      error: null,
      dbPath: getMarketDbPath(),
      indexPx: okxLive.indexPx,
      curve,
      history: stored?.history ?? [],
      marketStats,
      binanceMarketStats
    };
  }

  if (stored) {
    const ageMs = stored.refreshedAt !== null ? now - stored.refreshedAt : null;
    return {
      ...stored,
      status: ageMs !== null && ageMs > STALE_AFTER_MS ? "stale" : stored.status,
      generatedAt: now,
      ageMs,
      nextRefreshAt: now + PERSIST_INTERVAL_MS,
      marketStats,
      binanceMarketStats
    };
  }

  return emptySnapshot("warming", null);
}

export function getFuturesBasisHealth() {
  startFuturesBasisCollector();

  const now = Date.now();
  const okxLive = getOkxFuturesCurve();
  const binanceLive = getBinanceFuturesCurve();
  const okxFeed = getOkxFeedHealth();
  const binanceFeed = getBinanceFeedHealth();
  const curveCount = okxLive.curve.length + binanceLive.curve.length;
  const stored = readStoredFuturesBasisSnapshot(HISTORY_HOURS);
  const refreshedAt =
    Math.max(okxLive.refreshedAt ?? 0, binanceLive.refreshedAt ?? 0) || stored?.refreshedAt || null;
  const ageMs = refreshedAt !== null ? now - refreshedAt : null;
  const status =
    curveCount > 0 ? (ageMs !== null && ageMs > STALE_AFTER_MS ? "stale" : "ok") : "warming";

  return {
    status,
    connected: okxFeed.connected && binanceFeed.connected,
    refreshedAt,
    ageMs,
    pointCount: curveCount,
    historyCount: stored?.history.length ?? 0,
    instrumentCount: okxFeed.instrumentCount + binanceFeed.instrumentCount,
    lastMessageAt: okxFeed.lastMessageAt,
    connErrors: okxFeed.connErrors + binanceFeed.connErrors,
    source: SOURCE,
    dbPath: getMarketDbPath(),
    error: null,
    okx: {
      connected: okxFeed.connected,
      instrumentCount: okxFeed.instrumentCount,
      lastMessageAt: okxFeed.lastMessageAt,
      connErrors: okxFeed.connErrors
    },
    binance: {
      connected: binanceFeed.connected,
      instrumentCount: binanceFeed.instrumentCount,
      lastSuccessAt: binanceFeed.lastSuccessAt,
      connErrors: binanceFeed.connErrors,
      lastError: binanceFeed.lastError,
      backfillDone: binanceFeed.backfillDone,
      backfilledRows: binanceFeed.backfilledRows,
      liquidationStreams: binanceFeed.liquidationStreams
    }
  };
}
