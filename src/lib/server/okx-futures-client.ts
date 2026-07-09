import { FuturesContractType, FuturesCurvePoint } from "@/lib/types";
import { saveMarketInstruments } from "@/lib/server/market-db";

const OKX_BASE_URL = process.env.OKX_BASE_URL ?? "https://www.okx.com";
const OKX_WS_PUBLIC_URL = process.env.OKX_WS_PUBLIC_URL ?? "wss://ws.okx.com:8443/ws/v5/public";
const UNDERLYING = "BTC-USD";
const SWAP_INST_ID = "BTC-USD-SWAP";
const INDEX_INST_ID = "BTC-USD";
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
  contractType: FuturesContractType;
  label: string;
  expiryTs: number | null;
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
  ts: number;
}

interface IndexState {
  idxPx: number;
  ts: number;
}

interface FundingState {
  rate: number | null;
  nextFundingTime: number | null;
  ts: number;
}

interface LiveState {
  mark: Map<string, MarkState>;
  oi: Map<string, OiState>;
  ticker: Map<string, TickerState>;
  index: IndexState | null;
  funding: FundingState | null;
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
    live: { mark: new Map(), oi: new Map(), ticker: new Map(), index: null, funding: null },
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

function annualizeFunding(rate: number | null) {
  if (rate === null) return null;
  return rate * (24 / FUNDING_INTERVAL_HOURS) * 365;
}

function sortContractType(a: FuturesContractType, b: FuturesContractType) {
  const order: Record<FuturesContractType, number> = {
    PERPETUAL: 0,
    CURRENT_QUARTER: 1,
    NEXT_QUARTER: 2
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
    `/api/v5/public/instruments?instType=FUTURES&uly=${UNDERLYING}`
  );
  const isStandardCoinM = (item: OkxWsInstrument) => /^BTC-USD-\d{6}$/.test(item.instId) && item.state === "live";
  const pickAlias = (alias: string) => futures.find((item) => item.alias === alias && isStandardCoinM(item));

  const metas: InstrumentMeta[] = [
    { instId: SWAP_INST_ID, contractType: "PERPETUAL", label: "Perp", expiryTs: null }
  ];

  const quarter = pickAlias("quarter");
  if (quarter) {
    metas.push({
      instId: quarter.instId,
      contractType: "CURRENT_QUARTER",
      label: "Current Q",
      expiryTs: toNumber(quarter.expTime)
    });
  }

  const nextQuarter = pickAlias("next_quarter");
  if (nextQuarter) {
    metas.push({
      instId: nextQuarter.instId,
      contractType: "NEXT_QUARTER",
      label: "Next Q",
      expiryTs: toNumber(nextQuarter.expTime)
    });
  }

  return metas;
}

function persistInstruments(instruments: InstrumentMeta[]) {
  try {
    saveMarketInstruments(
      instruments.map((meta) => ({
        exchange: "OKX",
        symbol: meta.instId,
        pair: UNDERLYING,
        marketType: "FUTURES",
        contractType: meta.contractType,
        baseAsset: "BTC",
        quoteAsset: "USD",
        marginAsset: "BTC",
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
  args.push({ channel: "index-tickers", instId: INDEX_INST_ID });
  args.push({ channel: "funding-rate", instId: SWAP_INST_ID });
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
      state.live.ticker.set(instId, { volCcy24h: toNumber(row.volCcy24h), ts });
      break;
    }
    case "index-tickers": {
      const idxPx = toNumber(row.idxPx);
      if (idxPx !== null) state.live.index = { idxPx, ts };
      break;
    }
    case "funding-rate": {
      state.live.funding = {
        rate: toNumber(row.fundingRate),
        nextFundingTime: toNumber(row.fundingTime),
        ts
      };
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
  const indexPx = live.index?.idxPx ?? null;
  const now = Date.now();

  const curve = [...state.instruments]
    .sort((a, b) => sortContractType(a.contractType, b.contractType))
    .map((meta): FuturesCurvePoint => {
      const mark = live.mark.get(meta.instId) ?? null;
      const oi = live.oi.get(meta.instId) ?? null;
      const ticker = live.ticker.get(meta.instId) ?? null;
      const markPx = mark?.px ?? null;
      const basisAbs = markPx !== null && indexPx !== null ? markPx - indexPx : null;
      const basisPct = markPx !== null && indexPx !== null && indexPx !== 0 ? markPx / indexPx - 1 : null;
      const dte =
        meta.expiryTs !== null ? Math.max((meta.expiryTs - now) / (24 * 60 * 60 * 1000), 0) : null;
      const annualizedBasis =
        meta.contractType === "PERPETUAL"
          ? null
          : basisPct !== null && dte !== null && dte > 0
            ? basisPct * (365 / dte)
            : null;
      const fundingRate = meta.contractType === "PERPETUAL" ? live.funding?.rate ?? null : null;
      const volCcy24h = ticker?.volCcy24h ?? null;
      const quoteVolume24h = volCcy24h !== null && markPx !== null ? volCcy24h * markPx : oi?.oiUsd ?? null;
      const sourceTs = mark?.ts ?? live.index?.ts ?? null;

      return {
        exchange: "OKX",
        pair: UNDERLYING,
        symbol: meta.instId,
        contractType: meta.contractType,
        label: meta.label,
        expiryTs: meta.expiryTs,
        dte,
        indexPx,
        markPx,
        basisAbs,
        basisPct,
        annualizedBasis,
        fundingRate,
        annualizedFunding: annualizeFunding(fundingRate),
        nextFundingTime: meta.contractType === "PERPETUAL" ? live.funding?.nextFundingTime ?? null : null,
        openInterest: oi?.oiCcy ?? null,
        volume24h: volCcy24h,
        quoteVolume24h,
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
    hasIndex: state.live.index !== null,
    hasFunding: state.live.funding !== null,
    connErrors: state.connErrors
  };
}
