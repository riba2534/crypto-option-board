import { OptionContract, OptionSnapshot, RiskFlag } from "@/lib/types";

const OKX_BASE_URL = process.env.OKX_BASE_URL ?? "https://www.okx.com";
const REQUEST_TIMEOUT_MS = 4500;
const INSTRUMENT_FAMILY = "BTC-USD";

interface OkxResponse<T> {
  code: string;
  msg: string;
  data: T[];
}

interface OkxInstrument {
  instId: string;
  instType: string;
  instFamily: string;
  uly: string;
  settleCcy: string;
  ctMult: string;
  ctVal: string;
  ctType: string;
  optType: "C" | "P";
  stk: string;
  expTime: string;
  state: string;
}

interface OkxTicker {
  instId: string;
  last: string;
  askPx: string;
  askSz: string;
  bidPx: string;
  bidSz: string;
  vol24h: string;
  volCcy24h: string;
  ts: string;
}

interface OkxOptSummary {
  instId: string;
  delta?: string;
  gamma?: string;
  theta?: string;
  vega?: string;
  deltaBS?: string;
  gammaBS?: string;
  thetaBS?: string;
  vegaBS?: string;
  markVol?: string;
  bidVol?: string;
  askVol?: string;
  volLv?: string;
  fwdPx?: string;
  buyApr?: string;
  sellApr?: string;
  ts?: string;
}

interface OkxOpenInterest {
  instId: string;
  oi: string;
  oiCcy: string;
  oiUsd: string;
  ts: string;
}

interface OkxIndexTicker {
  instId: string;
  idxPx: string;
  open24h: string;
  high24h: string;
  low24h: string;
  ts: string;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveNumber(value: string | number | null | undefined): number | null {
  const parsed = toNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
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

    const payload = (await response.json()) as OkxResponse<T>;
    if (payload.code !== "0") {
      throw new Error(`OKX ${path} code ${payload.code}: ${payload.msg}`);
    }

    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchIndexTicker(): Promise<OkxIndexTicker | null> {
  const candidates = ["BTC-USD", "BTC-USDT"];

  for (const instId of candidates) {
    const data = await fetchOkx<OkxIndexTicker>(
      `/api/v5/market/index-tickers?instId=${instId}`
    );
    if (data[0]) {
      return data[0];
    }
  }

  return null;
}

function formatExpiry(expiryMs: number): { expiry: string; expiryLabel: string } {
  const date = new Date(expiryMs);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");

  return {
    expiry: `${yyyy}-${mm}-${dd}`,
    expiryLabel: `${mm}-${dd}`
  };
}

function spreadPct(bidPx: number | null, askPx: number | null): number | null {
  if (bidPx === null || askPx === null || bidPx <= 0 || askPx <= 0) {
    return null;
  }

  const mid = (bidPx + askPx) / 2;
  return mid > 0 ? (askPx - bidPx) / mid : null;
}

function average(values: Array<number | null | undefined>): number | null {
  const valid = values.filter(
    (value): value is number => value !== null && value !== undefined && Number.isFinite(value)
  );

  if (valid.length === 0) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function computeRiskFlags(contract: {
  bidPx: number | null;
  askPx: number | null;
  spreadPct: number | null;
  openInterest: number | null;
  volume24h: number | null;
  otmPct: number | null;
  dte: number;
  updatedAt: number | null;
}): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const ageMs = contract.updatedAt ? Date.now() - contract.updatedAt : null;

  if (!contract.bidPx) flags.push("NO_BID");
  if (!contract.askPx) flags.push("NO_ASK");
  if (contract.spreadPct !== null && contract.spreadPct > 0.15) flags.push("WIDE_SPREAD");
  if ((contract.openInterest ?? 0) < 25) flags.push("LOW_OI");
  if ((contract.volume24h ?? 0) < 10) flags.push("LOW_VOLUME");
  if (contract.otmPct !== null && Math.abs(contract.otmPct) < 0.03) flags.push("NEAR_ATM");
  if (contract.dte < 1) flags.push("SHORT_DTE");
  if (ageMs !== null && ageMs > 30_000) flags.push("STALE_QUOTE");

  return flags;
}

function computeScore(contract: {
  side: "C" | "P";
  cashSecuredApr: number | null;
  coveredCallApr: number | null;
  otmPct: number | null;
  spreadPct: number | null;
  openInterestUsd: number | null;
  volume24h: number | null;
  riskFlags: RiskFlag[];
}): number {
  const apr = contract.side === "P" ? contract.cashSecuredApr : contract.coveredCallApr;
  const aprScore = Math.min(Math.max((apr ?? 0) * 10, 0), 6);
  const otmScore = Math.min(Math.max((contract.otmPct ?? 0) * 12, -2), 3);
  const liquidityScore = Math.min(Math.log10((contract.openInterestUsd ?? 0) + 1), 6) / 2;
  const volumeScore = Math.min(Math.log10((contract.volume24h ?? 0) + 1), 4) / 2;
  const spreadPenalty = contract.spreadPct === null ? 1.5 : Math.min(contract.spreadPct * 8, 4);
  const riskPenalty = contract.riskFlags.length * 0.35;

  return aprScore + otmScore + liquidityScore + volumeScore - spreadPenalty - riskPenalty;
}

function buildSnapshot(params: {
  instruments: OkxInstrument[];
  tickers: OkxTicker[];
  summaries: OkxOptSummary[];
  interests: OkxOpenInterest[];
  indexTicker: OkxIndexTicker | null;
}): OptionSnapshot {
  const now = Date.now();
  const tickerById = new Map(params.tickers.map((ticker) => [ticker.instId, ticker]));
  const summaryById = new Map(params.summaries.map((summary) => [summary.instId, summary]));
  const interestById = new Map(params.interests.map((interest) => [interest.instId, interest]));

  const btcIndexPx = toPositiveNumber(params.indexTicker?.idxPx) ?? null;
  const btcOpen24h = toPositiveNumber(params.indexTicker?.open24h) ?? null;
  const btcChange24hPct =
    btcIndexPx !== null && btcOpen24h !== null ? (btcIndexPx - btcOpen24h) / btcOpen24h : null;

  const options = params.instruments
    .filter((instrument) => instrument.state === "live")
    .map((instrument): OptionContract | null => {
      const ticker = tickerById.get(instrument.instId);
      const summary = summaryById.get(instrument.instId);
      const interest = interestById.get(instrument.instId);
      const strike = toPositiveNumber(instrument.stk);
      const expiryMs = toPositiveNumber(instrument.expTime);
      const ctMult = toPositiveNumber(instrument.ctMult) ?? 0.01;
      const quoteTs =
        toNumber(ticker?.ts) ?? toNumber(summary?.ts) ?? toNumber(interest?.ts) ?? null;

      if (!strike || !expiryMs || !btcIndexPx) {
        return null;
      }

      const dte = Math.max((expiryMs - now) / 86_400_000, 0);
      if (dte <= 0) {
        return null;
      }

      const bidPx = toPositiveNumber(ticker?.bidPx);
      const askPx = toPositiveNumber(ticker?.askPx);
      const midPx = bidPx !== null && askPx !== null ? (bidPx + askPx) / 2 : null;
      const premiumUsd = bidPx !== null ? bidPx * btcIndexPx * ctMult : null;
      const premiumUsdPerBtc = bidPx !== null ? bidPx * btcIndexPx : null;
      const putCapital = strike * ctMult;
      const callCapital = btcIndexPx * ctMult;
      const cashSecuredApr =
        instrument.optType === "P" && premiumUsd !== null
          ? (premiumUsd / putCapital) * (365 / dte)
          : null;
      const coveredCallApr =
        instrument.optType === "C" && premiumUsd !== null
          ? (premiumUsd / callCapital) * (365 / dte)
          : null;
      const premiumYield =
        premiumUsd !== null ? premiumUsd / (instrument.optType === "P" ? putCapital : callCapital) : null;
      const fwdPx = toPositiveNumber(summary?.fwdPx) ?? btcIndexPx;
      const otmPct =
        instrument.optType === "P" ? (fwdPx - strike) / fwdPx : (strike - fwdPx) / fwdPx;
      const breakeven =
        premiumUsdPerBtc === null
          ? null
          : instrument.optType === "P"
            ? strike - premiumUsdPerBtc
            : strike + premiumUsdPerBtc;
      const computedSpreadPct = spreadPct(bidPx, askPx);
      const openInterest = toNumber(interest?.oi);
      const volume24h = toNumber(ticker?.vol24h);
      const partial = {
        bidPx,
        askPx,
        spreadPct: computedSpreadPct,
        openInterest,
        volume24h,
        otmPct,
        dte,
        updatedAt: quoteTs
      };
      const riskFlags = computeRiskFlags(partial);
      const openInterestUsd = toNumber(interest?.oiUsd);

      const { expiry, expiryLabel } = formatExpiry(expiryMs);
      const score = computeScore({
        side: instrument.optType,
        cashSecuredApr,
        coveredCallApr,
        otmPct,
        spreadPct: computedSpreadPct,
        openInterestUsd,
        volume24h,
        riskFlags
      });

      return {
        instId: instrument.instId,
        side: instrument.optType,
        strike,
        expiry,
        expiryLabel,
        dte,
        ctMult,
        state: instrument.state,
        bidPx,
        askPx,
        midPx,
        lastPx: toNumber(ticker?.last),
        bidSize: toNumber(ticker?.bidSz),
        askSize: toNumber(ticker?.askSz),
        volume24h,
        volumeCcy24h: toNumber(ticker?.volCcy24h),
        openInterest,
        openInterestUsd,
        delta: toNumber(summary?.delta),
        gamma: toNumber(summary?.gamma),
        theta: toNumber(summary?.theta),
        vega: toNumber(summary?.vega),
        deltaBS: toNumber(summary?.deltaBS),
        gammaBS: toNumber(summary?.gammaBS),
        thetaBS: toNumber(summary?.thetaBS),
        vegaBS: toNumber(summary?.vegaBS),
        markVol: toNumber(summary?.markVol),
        bidVol: toNumber(summary?.bidVol),
        askVol: toNumber(summary?.askVol),
        atmVol: toNumber(summary?.volLv),
        fwdPx,
        okxSellApr: toNumber(summary?.sellApr),
        okxBuyApr: toNumber(summary?.buyApr),
        spreadPct: computedSpreadPct,
        premiumUsd,
        premiumUsdPerBtc,
        notionalBtc: ctMult,
        cashSecuredApr,
        coveredCallApr,
        premiumYield,
        breakeven,
        otmPct,
        score,
        riskFlags,
        updatedAt: quoteTs
      };
    })
    .filter((contract): contract is OptionContract => contract !== null)
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.side.localeCompare(b.side));

  const expiries = Array.from(new Map(options.map((option) => [option.expiry, option])).values()).map(
    (sample) => {
      const contracts = options.filter((option) => option.expiry === sample.expiry);
      const puts = contracts.filter((option) => option.side === "P");
      const calls = contracts.filter((option) => option.side === "C");

      return {
        expiry: sample.expiry,
        expiryLabel: sample.expiryLabel,
        dte: sample.dte,
        count: contracts.length,
        atmVol: average(contracts.map((option) => option.atmVol)),
        avgPutApr: average(puts.map((option) => option.cashSecuredApr)),
        avgCallApr: average(calls.map((option) => option.coveredCallApr)),
        putOiUsd: puts.reduce((sum, option) => sum + (option.openInterestUsd ?? 0), 0),
        callOiUsd: calls.reduce((sum, option) => sum + (option.openInterestUsd ?? 0), 0)
      };
    }
  );

  return {
    status: "ok",
    generatedAt: now,
    refreshedAt: now,
    nextRefreshAt: now + 5_000,
    ageMs: 0,
    source: OKX_BASE_URL,
    error: null,
    btcIndexPx,
    btcOpen24h,
    btcHigh24h: toPositiveNumber(params.indexTicker?.high24h),
    btcLow24h: toPositiveNumber(params.indexTicker?.low24h),
    btcChange24hPct,
    contractCount: options.length,
    expiries,
    options
  };
}

export async function fetchBtcOptionSnapshot(): Promise<OptionSnapshot> {
  const [instruments, tickers, summaries, interests, indexTicker] = await Promise.all([
    fetchOkx<OkxInstrument>(
      `/api/v5/public/instruments?instType=OPTION&instFamily=${INSTRUMENT_FAMILY}`
    ),
    fetchOkx<OkxTicker>(`/api/v5/market/tickers?instType=OPTION&instFamily=${INSTRUMENT_FAMILY}`),
    fetchOkx<OkxOptSummary>(`/api/v5/public/opt-summary?instFamily=${INSTRUMENT_FAMILY}`),
    fetchOkx<OkxOpenInterest>(
      `/api/v5/public/open-interest?instType=OPTION&instFamily=${INSTRUMENT_FAMILY}`
    ),
    fetchIndexTicker()
  ]);

  return buildSnapshot({
    instruments,
    tickers,
    summaries,
    interests,
    indexTicker
  });
}

export function createEmptySnapshot(status: "warming" | "error", error: string | null): OptionSnapshot {
  const now = Date.now();

  return {
    status,
    generatedAt: now,
    refreshedAt: null,
    nextRefreshAt: now + 5_000,
    ageMs: null,
    source: OKX_BASE_URL,
    error,
    btcIndexPx: null,
    btcOpen24h: null,
    btcHigh24h: null,
    btcLow24h: null,
    btcChange24hPct: null,
    contractCount: 0,
    expiries: [],
    options: []
  };
}
