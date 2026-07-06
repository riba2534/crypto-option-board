import { OptionSnapshot } from "@/lib/types";
import {
  createEmptySnapshot,
  fetchBtcOptionSnapshot,
  refreshOptionRuntimeState
} from "@/lib/server/okx-client";

const REFRESH_INTERVAL_MS = 5_000;
const STALE_AFTER_MS = 20_000;

interface CacheState {
  started: boolean;
  refreshing: Promise<OptionSnapshot> | null;
  timer: NodeJS.Timeout | null;
  snapshot: OptionSnapshot;
  consecutiveErrors: number;
}

const globalForCache = globalThis as typeof globalThis & {
  __btcOptionCache?: CacheState;
};

function getState(): CacheState {
  if (!globalForCache.__btcOptionCache) {
    globalForCache.__btcOptionCache = {
      started: false,
      refreshing: null,
      timer: null,
      snapshot: createEmptySnapshot("warming", null),
      consecutiveErrors: 0
    };
  }

  return globalForCache.__btcOptionCache;
}

async function refreshSnapshot(): Promise<OptionSnapshot> {
  const state = getState();

  if (state.refreshing) {
    return state.refreshing;
  }

  state.refreshing = fetchBtcOptionSnapshot()
    .then((snapshot) => {
      state.snapshot = snapshot;
      state.consecutiveErrors = 0;
      return snapshot;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const now = Date.now();
      const existing = state.snapshot;
      state.consecutiveErrors += 1;

      state.snapshot =
        existing.refreshedAt === null
          ? createEmptySnapshot("error", message)
          : {
              ...existing,
              status: now - existing.refreshedAt > STALE_AFTER_MS ? "stale" : "error",
              generatedAt: now,
              nextRefreshAt: now + REFRESH_INTERVAL_MS,
              ageMs: now - existing.refreshedAt,
              error: message
            };

      return state.snapshot;
    })
    .finally(() => {
      state.refreshing = null;
    });

  return state.refreshing;
}

function startCache() {
  const state = getState();
  if (state.started) {
    return;
  }

  state.started = true;
  void refreshSnapshot();
  state.timer = setInterval(() => {
    void refreshSnapshot();
  }, REFRESH_INTERVAL_MS);
}

function withAge(snapshot: OptionSnapshot): OptionSnapshot {
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
      (snapshot.refreshedAt === null ? now + REFRESH_INTERVAL_MS : snapshot.refreshedAt + REFRESH_INTERVAL_MS),
    options: snapshot.options.map((option) => refreshOptionRuntimeState(option, now))
  };
}

export async function getServerSnapshot(): Promise<OptionSnapshot> {
  startCache();
  const state = getState();

  if (state.snapshot.refreshedAt === null) {
    return withAge(await refreshSnapshot());
  }

  return withAge(state.snapshot);
}

export function getCacheHealth() {
  startCache();
  const state = getState();
  const snapshot = withAge(state.snapshot);

  return {
    status: snapshot.status,
    refreshedAt: snapshot.refreshedAt,
    ageMs: snapshot.ageMs,
    contractCount: snapshot.contractCount,
    consecutiveErrors: state.consecutiveErrors,
    source: snapshot.source,
    error: snapshot.error
  };
}
