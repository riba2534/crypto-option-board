import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  FuturesBasisHistoryPoint,
  FuturesBasisSnapshot,
  FuturesContractType,
  FuturesCurvePoint
} from "@/lib/types";

const DEFAULT_HISTORY_HOURS = 24;
const DEFAULT_RAW_RETENTION_DAYS = 30;

interface DbState {
  db: DatabaseSync | null;
  path: string | null;
}

interface StoredFuturesBasisRow {
  ts: number;
  exchange: string;
  pair: string;
  symbol: string;
  contract_type: FuturesContractType;
  label: string;
  expiry_ts: number | null;
  dte_days: number | null;
  index_px: number | null;
  mark_px: number | null;
  basis_abs: number | null;
  basis_pct: number | null;
  annualized_basis: number | null;
  funding_rate: number | null;
  annualized_funding: number | null;
  next_funding_time: number | null;
  open_interest: number | null;
  volume_24h: number | null;
  quote_volume_24h: number | null;
  source_ts: number | null;
}

const globalForMarketDb = globalThis as typeof globalThis & {
  __marketDb?: DbState;
};

function marketDbPath() {
  if (process.env.MARKET_DB_PATH) {
    return process.env.MARKET_DB_PATH;
  }

  if (process.env.NODE_ENV === "production" && existsSync("/data")) {
    return "/data/market.sqlite";
  }

  return join(process.cwd(), ".data", "market.sqlite");
}

function getRetentionMs() {
  const days = Number(process.env.MARKET_RAW_RETENTION_DAYS ?? DEFAULT_RAW_RETENTION_DAYS);
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_RAW_RETENTION_DAYS;
  return safeDays * 24 * 60 * 60 * 1000;
}

function ensureParentDir(path: string) {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function getDbState(): DbState {
  if (!globalForMarketDb.__marketDb) {
    globalForMarketDb.__marketDb = {
      db: null,
      path: null
    };
  }

  return globalForMarketDb.__marketDb;
}

export function getMarketDbPath() {
  return marketDbPath();
}

export function getMarketDb() {
  const state = getDbState();
  const path = marketDbPath();

  if (state.db && state.path === path) {
    return state.db;
  }

  ensureParentDir(path);
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS market_instruments (
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      pair TEXT NOT NULL,
      market_type TEXT NOT NULL,
      contract_type TEXT NOT NULL,
      base_asset TEXT NOT NULL,
      quote_asset TEXT NOT NULL,
      margin_asset TEXT NOT NULL,
      expiry_ts INTEGER,
      status TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (exchange, symbol)
    );

    CREATE TABLE IF NOT EXISTS futures_basis_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      exchange TEXT NOT NULL,
      pair TEXT NOT NULL,
      symbol TEXT NOT NULL,
      contract_type TEXT NOT NULL,
      label TEXT NOT NULL,
      expiry_ts INTEGER,
      dte_days REAL,
      index_px REAL,
      mark_px REAL,
      basis_abs REAL,
      basis_pct REAL,
      annualized_basis REAL,
      funding_rate REAL,
      annualized_funding REAL,
      next_funding_time INTEGER,
      open_interest REAL,
      volume_24h REAL,
      quote_volume_24h REAL,
      source_ts INTEGER,
      raw_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_futures_basis_symbol_ts
      ON futures_basis_snapshots(exchange, symbol, ts DESC);

    CREATE INDEX IF NOT EXISTS idx_futures_basis_ts
      ON futures_basis_snapshots(ts DESC);

    CREATE TABLE IF NOT EXISTS market_collector_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS futures_liquidations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT NOT NULL,
      ts INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL,
      qty REAL,
      notional_usd REAL
    );

    CREATE INDEX IF NOT EXISTS idx_futures_liquidations_ts
      ON futures_liquidations(exchange, ts DESC);
  `);

  state.db = db;
  state.path = path;
  return db;
}

export function saveMarketInstruments(
  instruments: Array<{
    exchange: string;
    symbol: string;
    pair: string;
    marketType: string;
    contractType: FuturesContractType;
    baseAsset: string;
    quoteAsset: string;
    marginAsset: string;
    expiryTs: number | null;
    status: string;
    raw: unknown;
  }>
) {
  const db = getMarketDb();
  const stmt = db.prepare(`
    INSERT INTO market_instruments (
      exchange, symbol, pair, market_type, contract_type, base_asset, quote_asset,
      margin_asset, expiry_ts, status, raw_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(exchange, symbol) DO UPDATE SET
      pair = excluded.pair,
      market_type = excluded.market_type,
      contract_type = excluded.contract_type,
      base_asset = excluded.base_asset,
      quote_asset = excluded.quote_asset,
      margin_asset = excluded.margin_asset,
      expiry_ts = excluded.expiry_ts,
      status = excluded.status,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);
  const now = Date.now();

  db.exec("BEGIN");
  try {
    for (const item of instruments) {
      stmt.run(
        item.exchange,
        item.symbol,
        item.pair,
        item.marketType,
        item.contractType,
        item.baseAsset,
        item.quoteAsset,
        item.marginAsset,
        item.expiryTs,
        item.status,
        JSON.stringify(item.raw),
        now
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveFuturesBasisSnapshot(curve: FuturesCurvePoint[], rawBySymbol: Map<string, unknown>) {
  const db = getMarketDb();
  const stmt = db.prepare(`
    INSERT INTO futures_basis_snapshots (
      ts, exchange, pair, symbol, contract_type, label, expiry_ts, dte_days,
      index_px, mark_px, basis_abs, basis_pct, annualized_basis,
      funding_rate, annualized_funding, next_funding_time, open_interest,
      volume_24h, quote_volume_24h, source_ts, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ts = Date.now();

  db.exec("BEGIN");
  try {
    for (const point of curve) {
      stmt.run(
        ts,
        point.exchange,
        point.pair,
        point.symbol,
        point.contractType,
        point.label,
        point.expiryTs,
        point.dte,
        point.indexPx,
        point.markPx,
        point.basisAbs,
        point.basisPct,
        point.annualizedBasis,
        point.fundingRate,
        point.annualizedFunding,
        point.nextFundingTime,
        point.openInterest,
        point.volume24h,
        point.quoteVolume24h,
        point.sourceTs,
        JSON.stringify(rawBySymbol.get(point.symbol) ?? {})
      );
    }

    db.prepare("DELETE FROM futures_basis_snapshots WHERE ts < ?").run(ts - getRetentionMs());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function recordFuturesLiquidation(event: {
  exchange: string;
  ts: number;
  symbol: string;
  side: "long" | "short";
  price: number | null;
  qty: number | null;
  notionalUsd: number | null;
}) {
  const db = getMarketDb();
  db.prepare(
    "INSERT INTO futures_liquidations (exchange, ts, symbol, side, price, qty, notional_usd) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(event.exchange, event.ts, event.symbol, event.side, event.price, event.qty, event.notionalUsd);
  db.prepare("DELETE FROM futures_liquidations WHERE ts < ?").run(Date.now() - getRetentionMs());
}

export function readFuturesLiquidationTotals(exchange: string, hours: number) {
  const db = getMarketDb();
  const since = Date.now() - hours * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT side, SUM(notional_usd) AS total FROM futures_liquidations
       WHERE exchange = ? AND ts >= ? GROUP BY side`
    )
    .all(exchange, since) as unknown as Array<{ side: string; total: number | null }>;
  return {
    longUsd: rows.find((row) => row.side === "long")?.total ?? 0,
    shortUsd: rows.find((row) => row.side === "short")?.total ?? 0
  };
}

export function getEarliestFuturesSymbolTs(exchange: string, symbol: string): number | null {
  const row = getMarketDb()
    .prepare("SELECT MIN(ts) AS ts FROM futures_basis_snapshots WHERE exchange = ? AND symbol = ?")
    .get(exchange, symbol) as { ts: number | null } | undefined;
  return row?.ts ?? null;
}

export function insertFuturesBasisBackfill(
  rows: Array<{
    ts: number;
    exchange: string;
    pair: string;
    symbol: string;
    contractType: FuturesContractType;
    label: string;
    indexPx: number | null;
    openInterest: number | null;
  }>
) {
  if (rows.length === 0) return;
  const db = getMarketDb();
  const stmt = db.prepare(`
    INSERT INTO futures_basis_snapshots (
      ts, exchange, pair, symbol, contract_type, label, expiry_ts, dte_days,
      index_px, mark_px, basis_abs, basis_pct, annualized_basis,
      funding_rate, annualized_funding, next_funding_time, open_interest,
      volume_24h, quote_volume_24h, source_ts, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, '{}')
  `);

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      stmt.run(
        row.ts,
        row.exchange,
        row.pair,
        row.symbol,
        row.contractType,
        row.label,
        row.indexPx,
        row.openInterest,
        row.ts
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function recordCollectorRun(source: string, status: "ok" | "error", startedAt: number, error: string | null) {
  getMarketDb()
    .prepare(
      "INSERT INTO market_collector_runs (source, status, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?)"
    )
    .run(source, status, startedAt, Date.now(), error);
}

function rowToCurvePoint(row: StoredFuturesBasisRow): FuturesCurvePoint {
  return {
    exchange: row.exchange,
    pair: row.pair,
    symbol: row.symbol,
    contractType: row.contract_type,
    label: row.label,
    expiryTs: row.expiry_ts,
    dte: row.dte_days,
    indexPx: row.index_px,
    markPx: row.mark_px,
    basisAbs: row.basis_abs,
    basisPct: row.basis_pct,
    annualizedBasis: row.annualized_basis,
    fundingRate: row.funding_rate,
    annualizedFunding: row.annualized_funding,
    nextFundingTime: row.next_funding_time,
    openInterest: row.open_interest,
    openInterestUsd:
      row.open_interest !== null && row.index_px !== null ? row.open_interest * row.index_px : null,
    volume24h: row.volume_24h,
    quoteVolume24h: row.quote_volume_24h,
    lastPx: row.mark_px,
    open24h: null,
    high24h: null,
    low24h: null,
    change24hPct: null,
    bidPx: null,
    askPx: null,
    bidSize: null,
    askSize: null,
    spreadBps: null,
    sourceTs: row.source_ts
  };
}

function rowToHistoryPoint(row: StoredFuturesBasisRow): FuturesBasisHistoryPoint {
  return {
    ts: row.ts,
    exchange: row.exchange,
    pair: row.pair,
    symbol: row.symbol,
    contractType: row.contract_type,
    basisPct: row.basis_pct,
    annualizedBasis: row.annualized_basis,
    fundingRate: row.funding_rate,
    annualizedFunding: row.annualized_funding,
    markPx: row.mark_px,
    indexPx: row.index_px,
    openInterest: row.open_interest,
    volume24h: row.volume_24h
  };
}

export function readStoredFuturesBasisSnapshot(historyHours = DEFAULT_HISTORY_HOURS): FuturesBasisSnapshot | null {
  const db = getMarketDb();
  const latest = db
    .prepare("SELECT MAX(ts) AS ts FROM futures_basis_snapshots")
    .get() as { ts: number | null } | undefined;

  if (!latest?.ts) {
    return null;
  }

  const curveRows = db
    .prepare(
      `SELECT * FROM futures_basis_snapshots
       WHERE ts = ?
       ORDER BY
         CASE contract_type
           WHEN 'PERPETUAL' THEN 0
           WHEN 'CURRENT_QUARTER' THEN 1
           WHEN 'NEXT_QUARTER' THEN 2
           ELSE 3
         END`
    )
    .all(latest.ts) as unknown as StoredFuturesBasisRow[];

  const minHistoryTs = Date.now() - Math.max(historyHours, 1) * 60 * 60 * 1000;
  // The collector stores every contract every 30 seconds. Sending every dated
  // tenor back to the browser made this endpoint grow to several megabytes and
  // forced mobile clients to download the same payload every refresh. Charts
  // only consume perpetual price/OI history, so keep one sample per 5-minute
  // bucket for each exchange/symbol (at most ~1,200 rows for four 24h perps).
  const historyBucketMs = 5 * 60 * 1000;
  const historyRows = db
    .prepare(
      `SELECT sample.*
       FROM futures_basis_snapshots AS sample
       INNER JOIN (
         SELECT MAX(id) AS id
         FROM futures_basis_snapshots
         WHERE ts >= ? AND contract_type = 'PERPETUAL'
         GROUP BY exchange, symbol, CAST(ts / ? AS INTEGER)
       ) AS buckets ON buckets.id = sample.id
       ORDER BY sample.ts ASC, sample.exchange ASC, sample.symbol ASC`
    )
    .all(minHistoryTs, historyBucketMs) as unknown as StoredFuturesBasisRow[];

  const now = Date.now();
  const curve = curveRows.map(rowToCurvePoint);

  return {
    status: "ok",
    generatedAt: now,
    refreshedAt: latest.ts,
    nextRefreshAt: null,
    ageMs: now - latest.ts,
    source: "sqlite",
    error: null,
    dbPath: getMarketDbPath(),
    indexPx: curve.find((point) => point.indexPx !== null)?.indexPx ?? null,
    curve,
    history: historyRows.map(rowToHistoryPoint),
    marketStats: null,
    binanceMarketStats: null
  };
}
