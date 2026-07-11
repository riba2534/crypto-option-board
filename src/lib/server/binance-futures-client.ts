import { FuturesContractType, FuturesCurvePoint } from "@/lib/types";
import {
  getEarliestFuturesSymbolTs,
  insertFuturesBasisBackfill,
  recordFuturesLiquidation,
  saveMarketInstruments
} from "@/lib/server/market-db";

const BINANCE_FAPI_URL = process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com";
const BINANCE_DAPI_URL = process.env.BINANCE_DAPI_URL ?? "https://dapi.binance.com";
// Since 2026-04-23 market-class streams (mark price, force orders, ...) only flow
// on the "/market" websocket route; the legacy "/ws" route accepts subscriptions
// but stays silent. Verified live from the production host.
const BINANCE_FSTREAM_URL = process.env.BINANCE_FSTREAM_URL ?? "wss://fstream.binance.com/market/ws";
const BINANCE_DSTREAM_URL = process.env.BINANCE_DSTREAM_URL ?? "wss://dstream.binance.com/market/ws";
// REST quotes are used for breadth (USDT, coin perpetual and quarterlies). A
// 30-second cadence keeps them fresh without continuously saturating the small
// production VM or hitting Binance timeouts under concurrent page traffic.
const POLL_INTERVAL_MS = Number(process.env.BINANCE_POLL_MS ?? 30_000);
const STALE_AFTER_MS = Math.max(POLL_INTERVAL_MS * 4, 90_000);
const REQUEST_TIMEOUT_MS = 8_000;
const FUNDING_INTERVAL_HOURS = 8;
// Coin-margined BTC contracts on Binance carry a fixed $100 notional per contract.
const COIN_CONTRACT_USD = 100;
const BACKFILL_BARS = 500; // 500 × 5m ≈ 41h, covers the 24h UI window with margin
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const COIN_PAIR = "BTCUSD";
const USDT_SYMBOL = "BTCUSDT";

interface InstrumentMeta {
  symbol: string;
  pair: string;
  contractType: FuturesContractType;
  label: string;
  expiryTs: number | null;
  marginAsset: string;
  margined: "USDT" | "COIN";
}

const USDT_PERP_META: InstrumentMeta = {
  symbol: USDT_SYMBOL,
  pair: "BTC-USDT",
  contractType: "PERPETUAL",
  label: "USDT Perp",
  expiryTs: null,
  marginAsset: "USDT",
  margined: "USDT"
};

interface InstrumentState {
  markPx: number | null;
  indexPx: number | null;
  fundingRate: number | null;
  nextFundingTime: number | null;
  lastPx: number | null;
  open24h: number | null;
  high24h: number | null;
  low24h: number | null;
  change24hPct: number | null;
  volume24hBtc: number | null;
  quoteVolume24hUsd: number | null;
  bidPx: number | null;
  askPx: number | null;
  bidSize: number | null;
  askSize: number | null;
  openInterestBtc: number | null;
  openInterestUsd: number | null;
  ts: number;
}

interface LiquidationStream {
  url: string;
  params: string[];
  margined: "USDT" | "COIN";
  ws: WebSocket | null;
  connected: boolean;
  reconnectDelay: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  events: number;
}

interface FeedState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  instruments: InstrumentMeta[];
  live: Map<string, InstrumentState>;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  connErrors: number;
  lastError: string | null;
  backfillDone: boolean;
  backfilledRows: number;
  liquidationStreams: LiquidationStream[];
}

export interface BinanceFuturesLive {
  curve: FuturesCurvePoint[];
  refreshedAt: number | null;
  connected: boolean;
}

const globalForFeed = globalThis as typeof globalThis & {
  __binanceFuturesFeed?: FeedState;
};

function getState(): FeedState {
  if (!globalForFeed.__binanceFuturesFeed) {
    globalForFeed.__binanceFuturesFeed = {
      started: false,
      timer: null,
      instruments: [USDT_PERP_META],
      live: new Map(),
      lastSuccessAt: null,
      lastAttemptAt: null,
      connErrors: 0,
      lastError: null,
      backfillDone: false,
      backfilledRows: 0,
      liquidationStreams: [
        {
          url: BINANCE_FSTREAM_URL,
          params: ["btcusdt@forceOrder"],
          margined: "USDT",
          ws: null,
          connected: false,
          reconnectDelay: RECONNECT_BASE_MS,
          reconnectTimer: null,
          events: 0
        },
        {
          url: BINANCE_DSTREAM_URL,
          params: ["btcusd_perp@forceOrder"],
          margined: "COIN",
          ws: null,
          connected: false,
          reconnectDelay: RECONNECT_BASE_MS,
          reconnectTimer: null,
          events: 0
        }
      ]
    };
  }
  return globalForFeed.__binanceFuturesFeed;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchBinance<T>(baseUrl: string, path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "crypto-option-board/0.1" }
    });
    if (!response.ok) {
      throw new Error(`Binance ${path} HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

// dapi endpoints wrap single-symbol responses in an array; fapi returns bare objects.
function unwrap<T>(payload: T | T[]): T {
  return Array.isArray(payload) ? payload[0] : payload;
}

interface PremiumIndexRow {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

interface Ticker24hRow {
  symbol: string;
  lastPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  priceChangePercent: string;
  volume: string;
  quoteVolume?: string;
  baseVolume?: string;
}

interface BookTickerRow {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
}

interface OpenInterestRow {
  openInterest: string;
  time: number;
}

// BTCUSD_260925 → delivery at 2026-09-25 08:00 UTC.
function parseDeliveryExpiry(symbol: string): number | null {
  const match = /^BTCUSD_(\d{2})(\d{2})(\d{2})$/.exec(symbol);
  if (!match) return null;
  return Date.UTC(2000 + Number(match[1]), Number(match[2]) - 1, Number(match[3]), 8, 0, 0);
}

function buildTickerState(
  meta: InstrumentMeta,
  premium: PremiumIndexRow,
  ticker: Ticker24hRow | undefined,
  book: BookTickerRow | undefined,
  oiRaw: number | null
): InstrumentState {
  const markPx = toNumber(premium.markPrice);
  const changePct = toNumber(ticker?.priceChangePercent);
  const isPerp = meta.contractType === "PERPETUAL";

  let openInterestBtc: number | null = null;
  let openInterestUsd: number | null = null;
  let volume24hBtc: number | null = null;
  let quoteVolume24hUsd: number | null = null;
  if (meta.margined === "USDT") {
    openInterestBtc = oiRaw;
    openInterestUsd = oiRaw !== null && markPx !== null ? oiRaw * markPx : null;
    volume24hBtc = toNumber(ticker?.volume);
    quoteVolume24hUsd = toNumber(ticker?.quoteVolume);
  } else {
    openInterestUsd = oiRaw !== null ? oiRaw * COIN_CONTRACT_USD : null;
    openInterestBtc = openInterestUsd !== null && markPx !== null && markPx > 0 ? openInterestUsd / markPx : null;
    volume24hBtc = toNumber(ticker?.baseVolume);
    const contractVolume = toNumber(ticker?.volume);
    quoteVolume24hUsd = contractVolume !== null ? contractVolume * COIN_CONTRACT_USD : null;
  }

  return {
    markPx,
    indexPx: toNumber(premium.indexPrice),
    fundingRate: isPerp ? toNumber(premium.lastFundingRate) : null,
    nextFundingTime: isPerp ? toNumber(premium.nextFundingTime) : null,
    lastPx: toNumber(ticker?.lastPrice),
    open24h: toNumber(ticker?.openPrice),
    high24h: toNumber(ticker?.highPrice),
    low24h: toNumber(ticker?.lowPrice),
    change24hPct: changePct !== null ? changePct / 100 : null,
    volume24hBtc,
    quoteVolume24hUsd,
    bidPx: toNumber(book?.bidPrice),
    askPx: toNumber(book?.askPrice),
    bidSize: toNumber(book?.bidQty),
    askSize: toNumber(book?.askQty),
    openInterestBtc,
    openInterestUsd,
    ts: toNumber(premium.time) ?? Date.now()
  };
}

async function pollUsdtPerp(state: FeedState) {
  const query = `symbol=${USDT_SYMBOL}`;
  const [premiumRaw, tickerRaw, bookRaw, oiRaw] = await Promise.all([
    fetchBinance<PremiumIndexRow | PremiumIndexRow[]>(BINANCE_FAPI_URL, `/fapi/v1/premiumIndex?${query}`),
    fetchBinance<Ticker24hRow | Ticker24hRow[]>(BINANCE_FAPI_URL, `/fapi/v1/ticker/24hr?${query}`),
    fetchBinance<BookTickerRow | BookTickerRow[]>(BINANCE_FAPI_URL, `/fapi/v1/ticker/bookTicker?${query}`),
    fetchBinance<OpenInterestRow | OpenInterestRow[]>(BINANCE_FAPI_URL, `/fapi/v1/openInterest?${query}`)
  ]);
  state.live.set(
    USDT_SYMBOL,
    buildTickerState(
      USDT_PERP_META,
      unwrap(premiumRaw),
      unwrap(tickerRaw),
      unwrap(bookRaw),
      toNumber(unwrap(oiRaw).openInterest)
    )
  );
}

// One pair-level sweep discovers the perp plus the live quarterly deliveries.
async function pollCoinContracts(state: FeedState): Promise<InstrumentMeta[]> {
  const query = `pair=${COIN_PAIR}`;
  const [premiumsRaw, tickersRaw, booksRaw] = await Promise.all([
    fetchBinance<PremiumIndexRow[]>(BINANCE_DAPI_URL, `/dapi/v1/premiumIndex?${query}`),
    fetchBinance<Ticker24hRow[]>(BINANCE_DAPI_URL, `/dapi/v1/ticker/24hr?${query}`),
    fetchBinance<BookTickerRow[]>(BINANCE_DAPI_URL, `/dapi/v1/ticker/bookTicker?${query}`)
  ]);

  // premiumIndex ignores the pair filter and returns every coin-margined symbol.
  const premiums = premiumsRaw.filter(
    (row) => row.symbol === `${COIN_PAIR}_PERP` || parseDeliveryExpiry(row.symbol) !== null
  );
  const tickerBySymbol = new Map(tickersRaw.map((row) => [row.symbol, row]));
  const bookBySymbol = new Map(booksRaw.map((row) => [row.symbol, row]));

  const dated = premiums
    .filter((row) => row.symbol !== `${COIN_PAIR}_PERP`)
    .map((row) => ({ row, expiryTs: parseDeliveryExpiry(row.symbol) as number }))
    .sort((a, b) => a.expiryTs - b.expiryTs);

  const allMetas: InstrumentMeta[] = [
    {
      symbol: `${COIN_PAIR}_PERP`,
      pair: "BTC-USD",
      contractType: "PERPETUAL",
      label: "Coin Perp",
      expiryTs: null,
      marginAsset: "BTC",
      margined: "COIN"
    },
    ...dated.map(
      (item, index): InstrumentMeta => ({
        symbol: item.row.symbol,
        pair: "BTC-USD",
        contractType: index === 0 ? "CURRENT_QUARTER" : "NEXT_QUARTER",
        label: index === 0 ? "当季" : "次季",
        expiryTs: item.expiryTs,
        marginAsset: "BTC",
        margined: "COIN"
      })
    )
  ];
  const metas = allMetas.filter((meta) => premiums.some((row) => row.symbol === meta.symbol));

  const oiRows = await Promise.all(
    metas.map((meta) =>
      fetchBinance<OpenInterestRow | OpenInterestRow[]>(BINANCE_DAPI_URL, `/dapi/v1/openInterest?symbol=${meta.symbol}`)
    )
  );

  metas.forEach((meta, index) => {
    const premium = premiums.find((row) => row.symbol === meta.symbol);
    if (!premium) return;
    state.live.set(
      meta.symbol,
      buildTickerState(
        meta,
        premium,
        tickerBySymbol.get(meta.symbol),
        bookBySymbol.get(meta.symbol),
        toNumber(unwrap(oiRows[index]).openInterest)
      )
    );
  });

  return metas;
}

async function pollOnce(state: FeedState) {
  state.lastAttemptAt = Date.now();
  const [usdtResult, coinResult] = await Promise.allSettled([pollUsdtPerp(state), pollCoinContracts(state)]);

  if (coinResult.status === "fulfilled") {
    const next = [USDT_PERP_META, ...coinResult.value];
    const changed =
      next.length !== state.instruments.length ||
      next.some((meta, index) => meta.symbol !== state.instruments[index]?.symbol);
    state.instruments = next;
    if (changed) persistInstruments(next);
  }

  for (const result of [usdtResult, coinResult]) {
    if (result.status === "rejected") {
      state.connErrors += 1;
      state.lastError = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(`[binance-futures] poll failed: ${state.lastError}`);
    }
  }
  if (usdtResult.status === "fulfilled" || coinResult.status === "fulfilled") {
    state.lastSuccessAt = Date.now();
  }
}

function persistInstruments(instruments: InstrumentMeta[]) {
  try {
    saveMarketInstruments(
      instruments.map((meta) => ({
        exchange: "Binance",
        symbol: meta.symbol,
        pair: meta.pair,
        marketType: "FUTURES",
        contractType: meta.contractType,
        baseAsset: "BTC",
        quoteAsset: meta.pair.endsWith("USDT") ? "USDT" : "USD",
        marginAsset: meta.marginAsset,
        expiryTs: meta.expiryTs,
        status: "live",
        raw: meta
      }))
    );
  } catch {
    // Instrument metadata persistence is best-effort; the live feed does not depend on it.
  }
}

interface OiHistRow {
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

type KlineRow = [number, string, string, string, string, ...unknown[]];

// Seed the SQLite history with Binance's own 5m OI series + index klines so the
// price × OI chart and the 24h OI delta work immediately instead of after a day
// of local sampling. Runs once per process; only fills timestamps older than the
// earliest locally recorded sample.
async function backfillHistory(state: FeedState) {
  const targets = [
    {
      symbol: USDT_SYMBOL,
      pair: "BTC-USDT",
      label: "USDT Perp",
      oiPath: `/futures/data/openInterestHist?symbol=${USDT_SYMBOL}&period=5m&limit=${BACKFILL_BARS}`,
      klinePath: `/fapi/v1/indexPriceKlines?pair=${USDT_SYMBOL}&interval=5m&limit=${BACKFILL_BARS}`,
      baseUrl: BINANCE_FAPI_URL,
      oiInBtc: (row: OiHistRow) => toNumber(row.sumOpenInterest)
    },
    {
      symbol: `${COIN_PAIR}_PERP`,
      pair: "BTC-USD",
      label: "Coin Perp",
      oiPath: `/futures/data/openInterestHist?pair=${COIN_PAIR}&contractType=PERPETUAL&period=5m&limit=${BACKFILL_BARS}`,
      klinePath: `/dapi/v1/indexPriceKlines?pair=${COIN_PAIR}&interval=5m&limit=${BACKFILL_BARS}`,
      baseUrl: BINANCE_DAPI_URL,
      // Coin-margined history reports contracts in sumOpenInterest and BTC in sumOpenInterestValue.
      oiInBtc: (row: OiHistRow) => toNumber(row.sumOpenInterestValue)
    }
  ];

  for (const target of targets) {
    try {
      const [oiRows, klines] = await Promise.all([
        fetchBinance<OiHistRow[]>(target.baseUrl, target.oiPath),
        fetchBinance<KlineRow[]>(target.baseUrl, target.klinePath)
      ]);
      const cutoff = getEarliestFuturesSymbolTs("Binance", target.symbol) ?? Date.now();
      const indexByTs = new Map(klines.map((row) => [row[0], toNumber(row[4])]));
      const rows = oiRows
        .filter((row) => row.timestamp < cutoff - 60_000)
        .map((row) => ({
          ts: row.timestamp,
          exchange: "Binance",
          pair: target.pair,
          symbol: target.symbol,
          contractType: "PERPETUAL" as const,
          label: target.label,
          indexPx: indexByTs.get(row.timestamp) ?? null,
          openInterest: target.oiInBtc(row)
        }))
        .filter((row) => row.openInterest !== null);
      insertFuturesBasisBackfill(rows);
      state.backfilledRows += rows.length;
      if (rows.length > 0) {
        console.log(`[binance-futures] backfilled ${rows.length} OI points for ${target.symbol}`);
      }
    } catch (error) {
      console.error(
        `[binance-futures] backfill ${target.symbol} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  state.backfillDone = true;
}

interface ForceOrderEvent {
  e?: string;
  o?: {
    s: string;
    S: "BUY" | "SELL";
    ap: string;
    l: string;
    T: number;
  };
}

function handleForceOrder(stream: LiquidationStream, raw: string) {
  let msg: ForceOrderEvent;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.e !== "forceOrder" || !msg.o) return;
  const order = msg.o;
  const expected = stream.margined === "USDT" ? USDT_SYMBOL : `${COIN_PAIR}_PERP`;
  if (order.s !== expected) return;

  const avgPrice = toNumber(order.ap);
  const lastQty = toNumber(order.l);
  const notionalUsd =
    stream.margined === "USDT"
      ? avgPrice !== null && lastQty !== null
        ? avgPrice * lastQty
        : null
      : lastQty !== null
        ? lastQty * COIN_CONTRACT_USD
        : null;

  stream.events += 1;
  try {
    recordFuturesLiquidation({
      exchange: "Binance",
      ts: toNumber(order.T) ?? Date.now(),
      symbol: order.s,
      // A forced SELL closes a long position; a forced BUY closes a short.
      side: order.S === "SELL" ? "long" : "short",
      price: avgPrice,
      qty: lastQty,
      notionalUsd
    });
  } catch (error) {
    console.error(
      `[binance-futures] liquidation persist failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function scheduleStreamReconnect(state: FeedState, stream: LiquidationStream) {
  if (stream.reconnectTimer) return;
  const delay = stream.reconnectDelay;
  stream.reconnectDelay = Math.min(stream.reconnectDelay * 2, RECONNECT_MAX_MS);
  stream.reconnectTimer = setTimeout(() => {
    stream.reconnectTimer = null;
    connectLiquidationStream(state, stream);
  }, delay);
  stream.reconnectTimer.unref?.();
}

function connectLiquidationStream(state: FeedState, stream: LiquidationStream) {
  let ws: WebSocket;
  try {
    ws = new WebSocket(stream.url);
  } catch (error) {
    state.connErrors += 1;
    console.error(
      `[binance-futures] liquidation ws construct failed: ${error instanceof Error ? error.message : String(error)}`
    );
    scheduleStreamReconnect(state, stream);
    return;
  }

  stream.ws = ws;

  ws.addEventListener("open", () => {
    stream.connected = true;
    stream.reconnectDelay = RECONNECT_BASE_MS;
    ws.send(JSON.stringify({ method: "SUBSCRIBE", params: stream.params, id: 1 }));
  });

  ws.addEventListener("message", (event) => {
    handleForceOrder(stream, typeof event.data === "string" ? event.data : String(event.data));
  });

  ws.addEventListener("error", () => {
    state.connErrors += 1;
  });

  ws.addEventListener("close", () => {
    stream.connected = false;
    if (stream.ws === ws) {
      stream.ws = null;
    }
    scheduleStreamReconnect(state, stream);
  });
}

export function startBinanceFuturesFeed() {
  const state = getState();
  if (state.started) {
    return;
  }
  state.started = true;

  persistInstruments(state.instruments);
  void pollOnce(state);
  void backfillHistory(state);
  for (const stream of state.liquidationStreams) {
    connectLiquidationStream(state, stream);
  }

  state.timer = setInterval(() => {
    void pollOnce(state);
  }, POLL_INTERVAL_MS);
  state.timer.unref?.();
}

export function getBinanceFuturesCurve(): BinanceFuturesLive {
  const state = getState();
  const now = Date.now();

  const curve: FuturesCurvePoint[] = [];
  for (const meta of state.instruments) {
    const live = state.live.get(meta.symbol);
    if (!live || live.markPx === null || now - live.ts > STALE_AFTER_MS) continue;

    const basisAbs = live.indexPx !== null ? live.markPx - live.indexPx : null;
    const basisPct = live.indexPx !== null && live.indexPx !== 0 ? live.markPx / live.indexPx - 1 : null;
    const midPx = live.bidPx !== null && live.askPx !== null ? (live.bidPx + live.askPx) / 2 : null;
    const spreadBps =
      midPx !== null && midPx > 0 && live.bidPx !== null && live.askPx !== null
        ? ((live.askPx - live.bidPx) / midPx) * 10_000
        : null;
    const dte =
      meta.expiryTs !== null ? Math.max((meta.expiryTs - now) / (24 * 60 * 60 * 1000), 0) : null;
    const annualizedBasis =
      meta.contractType === "PERPETUAL"
        ? null
        : basisPct !== null && dte !== null && dte > 0
          ? basisPct * (365 / dte)
          : null;

    curve.push({
      exchange: "Binance",
      pair: meta.pair,
      symbol: meta.symbol,
      contractType: meta.contractType,
      label: meta.label,
      expiryTs: meta.expiryTs,
      dte,
      indexPx: live.indexPx,
      markPx: live.markPx,
      basisAbs,
      basisPct,
      annualizedBasis,
      fundingRate: live.fundingRate,
      annualizedFunding:
        live.fundingRate !== null ? live.fundingRate * (24 / FUNDING_INTERVAL_HOURS) * 365 : null,
      nextFundingTime: live.nextFundingTime,
      openInterest: live.openInterestBtc,
      openInterestUsd: live.openInterestUsd,
      volume24h: live.volume24hBtc,
      quoteVolume24h: live.quoteVolume24hUsd,
      lastPx: live.lastPx,
      open24h: live.open24h,
      high24h: live.high24h,
      low24h: live.low24h,
      change24hPct: live.change24hPct,
      bidPx: live.bidPx,
      askPx: live.askPx,
      bidSize: live.bidSize,
      askSize: live.askSize,
      spreadBps,
      sourceTs: live.ts
    });
  }

  const refreshedAt = curve.reduce<number | null>(
    (latest, point) => (point.sourceTs !== null && (latest === null || point.sourceTs > latest) ? point.sourceTs : latest),
    null
  );

  return {
    curve,
    refreshedAt,
    connected: state.lastSuccessAt !== null && now - state.lastSuccessAt <= STALE_AFTER_MS
  };
}

export function getBinanceFeedHealth() {
  const state = getState();
  const now = Date.now();
  return {
    connected: state.lastSuccessAt !== null && now - state.lastSuccessAt <= STALE_AFTER_MS,
    lastSuccessAt: state.lastSuccessAt,
    lastAttemptAt: state.lastAttemptAt,
    instrumentCount: state.live.size,
    connErrors: state.connErrors,
    lastError: state.lastError,
    backfillDone: state.backfillDone,
    backfilledRows: state.backfilledRows,
    liquidationStreams: state.liquidationStreams.map((stream) => ({
      url: stream.url,
      connected: stream.connected,
      events: stream.events
    }))
  };
}
