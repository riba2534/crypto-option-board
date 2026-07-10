import { FuturesContractType, FuturesCurvePoint } from "@/lib/types";
import { saveMarketInstruments } from "@/lib/server/market-db";

const OKX_BASE_URL = process.env.OKX_BASE_URL ?? "https://www.okx.com";
const OKX_WS_PUBLIC_URL = process.env.OKX_WS_PUBLIC_URL ?? "wss://ws.okx.com:8443/ws/v5/public";
const COIN_UNDERLYING = "BTC-USD";
const PERPETUALS = [
  { instId: "BTC-USDT-SWAP", pair: "BTC-USDT", label: "USDT Perp", marginAsset: "USDT" },
  { instId: "BTC-USD-SWAP", pair: "BTC-USD", label: "Coin Perp", marginAsset: "BTC" }
] as const;
const FUNDING_INTERVAL_HOURS = 8;
const REQUEST_TIMEOUT_MS = 5000;
const INSTRUMENT_REFRESH_MS = 6 * 60 * 60 * 1000;
const PING_INTERVAL_MS = 20_000;
const PING_IDLE_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

interface OkxWsInstrument {
  instId: string;
  instType: string;
  uly: string;
  alias: string;
  expTime: string;
  state: string;
}

interface InstrumentMeta {
  instId: string;
  pair: string;
  contractType: FuturesContractType;
  label: string;
  expiryTs: number | null;
  marginAsset: string;
}

interface MarkState {
  px: number;
  ts: number;
}

interface OiState {
  oiCcy: number;
  oiUsd: number;
  ts: number;
}

interface TickerState {
  volCcy24h: number | null;
  lastPx: number | null;
  open24h: number | null;
  high24h: number | null;
  low24h: number | null;
  bidPx: number | null;
  askPx: number | null;
  bidSize: number | null;
  askSize: number | null;
  ts: number;
}

interface IndexState {
  idxPx: number;
  ts: number;
}

interface FundingState {
  rate: number | null;
  nextFundingTime: number | null;
  intervalHours: number;
  ts: number;
}

interface LiveState {
  mark: Map<string, MarkState>;
  oi: Map<string, OiState>;
  ticker: Map<string, TickerState>;
  index: Map<string, IndexState>;
  funding: Map<string, FundingState>;
}

interface FeedState {
  started: boolean;
  ws: WebSocket | null;
  instruments: InstrumentMeta[];
  live: LiveState;
  lastMessageAt: number | null;
  reconnectDelay: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  instrumentTimer: ReturnType<typeof setInterval> | null;
  connErrors: number;
}

export interface OkxFuturesLive {
  curve: FuturesCurvePoint[];
  indexPx: number | null;
  refreshedAt: number | null;
  connected: boolean;
}

const globalForFeed = globalThis as typeof globalThis & {
  __okxFuturesFeed?: FeedState;
};

function createState(): FeedState {
  return {
    started: false,
    ws: null,
    instruments: [],
    live: { mark: new Map(), oi: new Map(), ticker: new Map(), index: new Map(), funding: new Map() },
    lastMessageAt: null,
    reconnectDelay: RECONNECT_BASE_MS,
    reconnectTimer: null,
    pingTimer: null,
    instrumentTimer: null,
    connErrors: 0
  };
}

function getState(): FeedState {
  if (!globalForFeed.__okxFuturesFeed) {
    globalForFeed.__okxFuturesFeed = createState();
  }
  return globalForFeed.__okxFuturesFeed;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function annualizeFunding(rate: number | null, intervalHours = FUNDING_INTERVAL_HOURS) {
  if (rate === null) return null;
  return rate * (24 / intervalHours) * 365;
}

function sortContractType(a: FuturesContractType, b: FuturesContractType) {
  const order: Record<FuturesContractType, number> = {
    PERPETUAL: 0,
    DATED: 1,
    CURRENT_QUARTER: 2,
    NEXT_QUARTER: 3
  };
  return order[a] - order[b];
}

async function fetchOkx<T>(path: string): Promise<T[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${OKX_BASE_URL}${path}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "crypto-option-board/0.1"
      }
    });

    if (!response.ok) {
      throw new Error(`OKX ${path} HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { code: string; msg: string; data: T[] };
    if (payload.code !== "0") {
      throw new Error(`OKX ${path} code ${payload.code}: ${payload.msg}`);
    }
    if (!Array.isArray(payload.data)) {
      throw new Error(`OKX ${path} returned invalid data`);
    }

    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFuturesInstruments(): Promise<InstrumentMeta[]> {
  const futures = await fetchOkx<OkxWsInstrument>(
    `/api/v5/public/instruments?instType=FUTURES&uly=${COIN_UNDERLYING}`
  );
  const aliasLabels: Record<string, string> = {
    this_week: "本周",
    next_week: "次周",
    this_month: "本月",
    next_month: "次月",
    quarter: "当季",
    next_quarter: "次季"
  };
  const dated = futures
    .filter((item) => /^BTC-USD-\d{6}$/.test(item.instId) && item.state === "live")
    .map((item): InstrumentMeta => ({
      instId: item.instId,
      pair: COIN_UNDERLYING,
      contractType:
        item.alias === "quarter"
          ? "CURRENT_QUARTER"
          : item.alias === "next_quarter"
            ? "NEXT_QUARTER"
            : "DATED",
      label: aliasLabels[item.alias] ?? item.alias,
      expiryTs: toNumber(item.expTime),
      marginAsset: "BTC"
    }))
    .sort((a, b) => (a.expiryTs ?? Infinity) - (b.expiryTs ?? Infinity));

  return [
    ...PERPETUALS.map((item): InstrumentMeta => ({
      ...item,
      contractType: "PERPETUAL",
      expiryTs: null
    })),
    ...dated
  ];
}

function persistInstruments(instruments: InstrumentMeta[]) {
  try {
    saveMarketInstruments(
      instruments.map((meta) => ({
        exchange: "OKX",
        symbol: meta.instId,
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

function subscriptionArgs(instruments: InstrumentMeta[]) {
  const args: Array<{ channel: string; instId: string }> = [];
  for (const meta of instruments) {
    args.push({ channel: "mark-price", instId: meta.instId });
    args.push({ channel: "tickers", instId: meta.instId });
    args.push({ channel: "open-interest", instId: meta.instId });
  }
  for (const pair of [...new Set(instruments.map((item) => item.pair))]) {
    args.push({ channel: "index-tickers", instId: pair });
  }
  for (const meta of instruments.filter((item) => item.contractType === "PERPETUAL")) {
    args.push({ channel: "funding-rate", instId: meta.instId });
  }
  return args;
}

function sendSubscribe(state: FeedState) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state.instruments.length === 0) {
    return;
  }
  state.ws.send(JSON.stringify({ op: "subscribe", args: subscriptionArgs(state.instruments) }));
}

function handleChannelData(state: FeedState, channel: string, instId: string, row: Record<string, string>) {
  const ts = toNumber(row.ts) ?? Date.now();

  switch (channel) {
    case "mark-price": {
      const px = toNumber(row.markPx);
      if (px !== null) state.live.mark.set(instId, { px, ts });
      break;
    }
    case "open-interest": {
      const oiCcy = toNumber(row.oiCcy);
      const oiUsd = toNumber(row.oiUsd);
      if (oiCcy !== null) state.live.oi.set(instId, { oiCcy, oiUsd: oiUsd ?? 0, ts });
      break;
    }
    case "tickers": {
      state.live.ticker.set(instId, {
        volCcy24h: toNumber(row.volCcy24h),
        lastPx: toNumber(row.last),
        open24h: toNumber(row.open24h),
        high24h: toNumber(row.high24h),
        low24h: toNumber(row.low24h),
        bidPx: toNumber(row.bidPx),
        askPx: toNumber(row.askPx),
        bidSize: toNumber(row.bidSz),
        askSize: toNumber(row.askSz),
        ts
      });
      break;
    }
    case "index-tickers": {
      const idxPx = toNumber(row.idxPx);
      if (idxPx !== null) state.live.index.set(instId, { idxPx, ts });
      break;
    }
    case "funding-rate": {
      const fundingTime = toNumber(row.fundingTime);
      const followingFundingTime = toNumber(row.nextFundingTime);
      const derivedIntervalHours =
        fundingTime !== null && followingFundingTime !== null && followingFundingTime > fundingTime
          ? (followingFundingTime - fundingTime) / (60 * 60 * 1000)
          : FUNDING_INTERVAL_HOURS;
      state.live.funding.set(instId, {
        rate: toNumber(row.fundingRate),
        nextFundingTime: fundingTime ?? followingFundingTime,
        intervalHours:
          derivedIntervalHours >= 0.5 && derivedIntervalHours <= 24
            ? derivedIntervalHours
            : FUNDING_INTERVAL_HOURS,
        ts
      });
      break;
    }
    default:
      break;
  }
}

function handleMessage(state: FeedState, raw: string) {
  state.lastMessageAt = Date.now();

  if (raw === "pong") {
    return;
  }

  let msg: {
    event?: string;
    code?: string;
    msg?: string;
    arg?: { channel: string; instId: string };
    data?: Array<Record<string, string>>;
  };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.event === "error") {
    state.connErrors += 1;
    console.error(`[okx-futures] subscribe error ${msg.code}: ${msg.msg}`);
    return;
  }
  if (msg.event) {
    return;
  }

  if (msg.arg && Array.isArray(msg.data)) {
    for (const row of msg.data) {
      handleChannelData(state, msg.arg.channel, msg.arg.instId, row);
    }
  }
}

function clearTimers(state: FeedState) {
  if (state.pingTimer) {
    clearInterval(state.pingTimer);
    state.pingTimer = null;
  }
}

function scheduleReconnect(state: FeedState) {
  if (state.reconnectTimer) {
    return;
  }
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(state.reconnectDelay * 2, RECONNECT_MAX_MS);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect(state);
  }, delay);
  state.reconnectTimer.unref?.();
}

function connect(state: FeedState) {
  clearTimers(state);

  let ws: WebSocket;
  try {
    ws = new WebSocket(OKX_WS_PUBLIC_URL);
  } catch (error) {
    state.connErrors += 1;
    console.error(`[okx-futures] ws construct failed: ${error instanceof Error ? error.message : String(error)}`);
    scheduleReconnect(state);
    return;
  }

  state.ws = ws;

  ws.addEventListener("open", () => {
    state.reconnectDelay = RECONNECT_BASE_MS;
    state.lastMessageAt = Date.now();
    sendSubscribe(state);

    state.pingTimer = setInterval(() => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        const idleFor = state.lastMessageAt ? Date.now() - state.lastMessageAt : Infinity;
        if (idleFor >= PING_IDLE_MS) {
          state.ws.send("ping");
        }
      }
    }, PING_INTERVAL_MS);
    state.pingTimer.unref?.();
  });

  ws.addEventListener("message", (event) => {
    handleMessage(state, typeof event.data === "string" ? event.data : String(event.data));
  });

  ws.addEventListener("error", () => {
    state.connErrors += 1;
  });

  ws.addEventListener("close", () => {
    clearTimers(state);
    if (state.ws === ws) {
      state.ws = null;
    }
    scheduleReconnect(state);
  });
}

async function refreshInstruments(state: FeedState) {
  try {
    const next = await fetchFuturesInstruments();
    if (next.length === 0) {
      return;
    }

    const changed =
      next.length !== state.instruments.length ||
      next.some((meta, index) => meta.instId !== state.instruments[index]?.instId);

    state.instruments = next;
    persistInstruments(next);

    if (changed && state.ws && state.ws.readyState === WebSocket.OPEN) {
      sendSubscribe(state);
    }
  } catch (error) {
    console.error(`[okx-futures] instrument refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function startOkxFuturesFeed() {
  const state = getState();
  if (state.started) {
    return;
  }
  state.started = true;

  void refreshInstruments(state).then(() => connect(state));

  state.instrumentTimer = setInterval(() => {
    void refreshInstruments(state);
  }, INSTRUMENT_REFRESH_MS);
  state.instrumentTimer.unref?.();
}

export function getOkxFuturesCurve(): OkxFuturesLive {
  const state = getState();
  const { live } = state;
  const indexPx = live.index.get(COIN_UNDERLYING)?.idxPx ?? live.index.get("BTC-USDT")?.idxPx ?? null;
  const now = Date.now();

  const curve = [...state.instruments]
    .sort((a, b) => {
      const typeOrder = sortContractType(a.contractType, b.contractType);
      if (typeOrder !== 0) return typeOrder;
      if (a.contractType === "PERPETUAL") return a.instId.localeCompare(b.instId);
      return (a.expiryTs ?? Infinity) - (b.expiryTs ?? Infinity);
    })
    .map((meta): FuturesCurvePoint => {
      const mark = live.mark.get(meta.instId) ?? null;
      const oi = live.oi.get(meta.instId) ?? null;
      const ticker = live.ticker.get(meta.instId) ?? null;
      const instrumentIndex = live.index.get(meta.pair) ?? null;
      const funding = live.funding.get(meta.instId) ?? null;
      const instrumentIndexPx = instrumentIndex?.idxPx ?? null;
      const markPx = mark?.px ?? null;
      const basisAbs = markPx !== null && instrumentIndexPx !== null ? markPx - instrumentIndexPx : null;
      const basisPct =
        markPx !== null && instrumentIndexPx !== null && instrumentIndexPx !== 0
          ? markPx / instrumentIndexPx - 1
          : null;
      const dte =
        meta.expiryTs !== null ? Math.max((meta.expiryTs - now) / (24 * 60 * 60 * 1000), 0) : null;
      const annualizedBasis =
        meta.contractType === "PERPETUAL"
          ? null
          : basisPct !== null && dte !== null && dte > 0
            ? basisPct * (365 / dte)
            : null;
      const fundingRate = meta.contractType === "PERPETUAL" ? funding?.rate ?? null : null;
      const volCcy24h = ticker?.volCcy24h ?? null;
      const quoteVolume24h = volCcy24h !== null && markPx !== null ? volCcy24h * markPx : null;
      const sourceTs = Math.max(mark?.ts ?? 0, ticker?.ts ?? 0, instrumentIndex?.ts ?? 0) || null;
      const lastPx = ticker?.lastPx ?? null;
      const open24h = ticker?.open24h ?? null;
      const change24hPct =
        lastPx !== null && open24h !== null && open24h !== 0 ? lastPx / open24h - 1 : null;
      const midPx =
        ticker?.bidPx !== null && ticker?.bidPx !== undefined && ticker?.askPx !== null && ticker?.askPx !== undefined
          ? (ticker.bidPx + ticker.askPx) / 2
          : null;
      const spreadBps =
        midPx !== null && midPx > 0 && ticker?.askPx !== null && ticker?.askPx !== undefined && ticker?.bidPx !== null && ticker?.bidPx !== undefined
          ? ((ticker.askPx - ticker.bidPx) / midPx) * 10_000
          : null;

      return {
        exchange: "OKX",
        pair: meta.pair,
        symbol: meta.instId,
        contractType: meta.contractType,
        label: meta.label,
        expiryTs: meta.expiryTs,
        dte,
        indexPx: instrumentIndexPx,
        markPx,
        basisAbs,
        basisPct,
        annualizedBasis,
        fundingRate,
        annualizedFunding: annualizeFunding(fundingRate, funding?.intervalHours),
        nextFundingTime: meta.contractType === "PERPETUAL" ? funding?.nextFundingTime ?? null : null,
        openInterest: oi?.oiCcy ?? null,
        openInterestUsd: oi?.oiUsd ?? null,
        volume24h: volCcy24h,
        quoteVolume24h,
        lastPx,
        open24h,
        high24h: ticker?.high24h ?? null,
        low24h: ticker?.low24h ?? null,
        change24hPct,
        bidPx: ticker?.bidPx ?? null,
        askPx: ticker?.askPx ?? null,
        bidSize: ticker?.bidSize ?? null,
        askSize: ticker?.askSize ?? null,
        spreadBps,
        sourceTs
      };
    });

  const priced = curve.filter((point) => point.markPx !== null);
  const refreshedAt = priced.reduce<number | null>(
    (latest, point) => (point.sourceTs !== null && (latest === null || point.sourceTs > latest) ? point.sourceTs : latest),
    null
  );

  return {
    curve: priced,
    indexPx,
    refreshedAt,
    connected: state.ws?.readyState === WebSocket.OPEN
  };
}

export function getOkxFeedHealth() {
  const state = getState();
  return {
    connected: state.ws?.readyState === WebSocket.OPEN,
    readyState: state.ws?.readyState ?? null,
    lastMessageAt: state.lastMessageAt,
    instrumentCount: state.instruments.length,
    markCount: state.live.mark.size,
    hasIndex: state.live.index.size > 0,
    hasFunding: state.live.funding.size > 0,
    connErrors: state.connErrors
  };
}
