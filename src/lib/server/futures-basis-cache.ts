import { FuturesBasisSnapshot } from "@/lib/types";
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

const PERSIST_INTERVAL_MS = Number(process.env.FUTURES_BASIS_PERSIST_MS ?? 30_000);
const STALE_AFTER_MS = Number(process.env.FUTURES_BASIS_STALE_MS ?? 180_000);
const HISTORY_HOURS = Number(process.env.FUTURES_BASIS_HISTORY_HOURS ?? 24);
const SOURCE = "okx-usd-ws";

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
    history: []
  };
}

function persistSnapshot() {
  const startedAt = Date.now();
  const live = getOkxFuturesCurve();
  if (live.curve.length === 0) {
    return;
  }

  try {
    const rawBySymbol = new Map<string, unknown>(live.curve.map((point) => [point.symbol, point]));
    saveFuturesBasisSnapshot(live.curve, rawBySymbol);
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

  collector.timer = setInterval(persistSnapshot, PERSIST_INTERVAL_MS);
  collector.timer.unref?.();
}

export async function getFuturesBasisSnapshot(): Promise<FuturesBasisSnapshot> {
  startFuturesBasisCollector();

  const now = Date.now();
  const live = getOkxFuturesCurve();
  const stored = readStoredFuturesBasisSnapshot(HISTORY_HOURS);

  if (live.curve.length > 0) {
    const refreshedAt = live.refreshedAt ?? now;
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
      indexPx: live.indexPx,
      curve: live.curve,
      history: stored?.history ?? []
    };
  }

  if (stored) {
    const ageMs = stored.refreshedAt !== null ? now - stored.refreshedAt : null;
    return {
      ...stored,
      status: ageMs !== null && ageMs > STALE_AFTER_MS ? "stale" : stored.status,
      generatedAt: now,
      ageMs,
      nextRefreshAt: now + PERSIST_INTERVAL_MS
    };
  }

  return emptySnapshot("warming", null);
}

export function getFuturesBasisHealth() {
  startFuturesBasisCollector();

  const now = Date.now();
  const live = getOkxFuturesCurve();
  const feed = getOkxFeedHealth();
  const stored = readStoredFuturesBasisSnapshot(HISTORY_HOURS);
  const refreshedAt = live.refreshedAt ?? stored?.refreshedAt ?? null;
  const ageMs = refreshedAt !== null ? now - refreshedAt : null;
  const status =
    live.curve.length > 0 ? (ageMs !== null && ageMs > STALE_AFTER_MS ? "stale" : "ok") : "warming";

  return {
    status,
    connected: feed.connected,
    refreshedAt,
    ageMs,
    pointCount: live.curve.length,
    historyCount: stored?.history.length ?? 0,
    instrumentCount: feed.instrumentCount,
    lastMessageAt: feed.lastMessageAt,
    connErrors: feed.connErrors,
    source: SOURCE,
    dbPath: getMarketDbPath(),
    error: null
  };
}
