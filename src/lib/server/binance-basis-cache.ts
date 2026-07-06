import { FuturesBasisSnapshot } from "@/lib/types";
import { fetchBinanceBtcFuturesSnapshot } from "@/lib/server/binance-client";
import {
  getMarketDbPath,
  readStoredFuturesBasisSnapshot,
  recordCollectorRun,
  saveFuturesBasisSnapshot
} from "@/lib/server/market-db";

const REFRESH_INTERVAL_MS = Number(process.env.BINANCE_BASIS_REFRESH_MS ?? 30_000);
const STALE_AFTER_MS = Number(process.env.BINANCE_BASIS_STALE_MS ?? 180_000);
const HISTORY_HOURS = Number(process.env.BINANCE_BASIS_HISTORY_HOURS ?? 24);

interface BasisCacheState {
  started: boolean;
  refreshing: Promise<FuturesBasisSnapshot> | null;
  timer: NodeJS.Timeout | null;
  snapshot: FuturesBasisSnapshot;
  consecutiveErrors: number;
}

const globalForBasisCache = globalThis as typeof globalThis & {
  __btcFuturesBasisCache?: BasisCacheState;
};

function createEmptyFuturesSnapshot(status: FuturesBasisSnapshot["status"], error: string | null): FuturesBasisSnapshot {
  const now = Date.now();

  return {
    status,
    generatedAt: now,
    refreshedAt: null,
    nextRefreshAt: now + REFRESH_INTERVAL_MS,
    ageMs: null,
    source: "binance-usdm-sqlite",
    error,
    dbPath: getMarketDbPath(),
    indexPx: null,
    curve: [],
    history: []
  };
}

function getState(): BasisCacheState {
  if (!globalForBasisCache.__btcFuturesBasisCache) {
    globalForBasisCache.__btcFuturesBasisCache = {
      started: false,
      refreshing: null,
      timer: null,
      snapshot: readStoredFuturesBasisSnapshot(HISTORY_HOURS) ?? createEmptyFuturesSnapshot("warming", null),
      consecutiveErrors: 0
    };
  }

  return globalForBasisCache.__btcFuturesBasisCache;
}

function withAge(snapshot: FuturesBasisSnapshot): FuturesBasisSnapshot {
  const now = Date.now();
  const ageMs = snapshot.refreshedAt === null ? null : now - snapshot.refreshedAt;
  const status =
    snapshot.refreshedAt !== null && ageMs !== null && ageMs > STALE_AFTER_MS
      ? "stale"
      : snapshot.status;

  return {
    ...snapshot,
    status,
    generatedAt: now,
    ageMs,
    nextRefreshAt:
      snapshot.nextRefreshAt ??
      (snapshot.refreshedAt === null ? now + REFRESH_INTERVAL_MS : snapshot.refreshedAt + REFRESH_INTERVAL_MS)
  };
}

async function refreshFuturesBasisSnapshot(): Promise<FuturesBasisSnapshot> {
  const state = getState();

  if (state.refreshing) {
    return state.refreshing;
  }

  const startedAt = Date.now();

  state.refreshing = fetchBinanceBtcFuturesSnapshot()
    .then(({ curve, rawBySymbol }) => {
      saveFuturesBasisSnapshot(curve, rawBySymbol);
      recordCollectorRun("binance-usdm-basis", "ok", startedAt, null);

      const stored = readStoredFuturesBasisSnapshot(HISTORY_HOURS) ?? createEmptyFuturesSnapshot("warming", null);
      state.snapshot = {
        ...stored,
        status: "ok",
        nextRefreshAt: Date.now() + REFRESH_INTERVAL_MS,
        error: null
      };
      state.consecutiveErrors = 0;
      return state.snapshot;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const now = Date.now();
      const existing = withAge(state.snapshot);

      state.consecutiveErrors += 1;
      recordCollectorRun("binance-usdm-basis", "error", startedAt, message);

      state.snapshot =
        existing.refreshedAt === null
          ? createEmptyFuturesSnapshot("error", message)
          : {
              ...existing,
              status:
                existing.ageMs !== null && existing.ageMs > STALE_AFTER_MS
                  ? "stale"
                  : "error",
              generatedAt: now,
              nextRefreshAt: now + REFRESH_INTERVAL_MS,
              ageMs: existing.refreshedAt === null ? null : now - existing.refreshedAt,
              error: message
            };

      return state.snapshot;
    })
    .finally(() => {
      state.refreshing = null;
    });

  return state.refreshing;
}

export function startBinanceBasisCollector() {
  const state = getState();
  if (state.started || process.env.MARKET_COLLECTOR_ENABLED === "false") {
    return;
  }

  state.started = true;
  void refreshFuturesBasisSnapshot();

  state.timer = setInterval(() => {
    void refreshFuturesBasisSnapshot();
  }, REFRESH_INTERVAL_MS);
  state.timer.unref?.();
}

export async function getFuturesBasisSnapshot(): Promise<FuturesBasisSnapshot> {
  startBinanceBasisCollector();
  const state = getState();

  if (state.snapshot.refreshedAt === null || state.snapshot.curve.length === 0) {
    return withAge(await refreshFuturesBasisSnapshot());
  }

  const stored = readStoredFuturesBasisSnapshot(HISTORY_HOURS);
  if (stored && stored.refreshedAt && stored.refreshedAt > (state.snapshot.refreshedAt ?? 0)) {
    state.snapshot = {
      ...stored,
      nextRefreshAt: (stored.refreshedAt ?? Date.now()) + REFRESH_INTERVAL_MS
    };
  }

  return withAge(state.snapshot);
}

export function getFuturesBasisHealth() {
  startBinanceBasisCollector();
  const state = getState();
  const snapshot = withAge(state.snapshot);

  return {
    status: snapshot.status,
    refreshedAt: snapshot.refreshedAt,
    ageMs: snapshot.ageMs,
    pointCount: snapshot.curve.length,
    historyCount: snapshot.history.length,
    consecutiveErrors: state.consecutiveErrors,
    source: snapshot.source,
    dbPath: snapshot.dbPath,
    error: snapshot.error
  };
}
