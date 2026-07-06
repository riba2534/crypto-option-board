export type OptionSide = "C" | "P";

export type SnapshotStatus = "warming" | "ok" | "stale" | "error";

export type RiskFlag =
  | "NO_BID"
  | "NO_ASK"
  | "WIDE_SPREAD"
  | "LOW_OI"
  | "LOW_VOLUME"
  | "NEAR_ATM"
  | "SHORT_DTE"
  | "STALE_QUOTE";

export interface OptionContract {
  instId: string;
  side: OptionSide;
  strike: number;
  expiry: string;
  expiryLabel: string;
  dte: number;
  ctMult: number;
  state: string;
  bidPx: number | null;
  askPx: number | null;
  midPx: number | null;
  lastPx: number | null;
  bidSize: number | null;
  askSize: number | null;
  volume24h: number | null;
  volumeCcy24h: number | null;
  openInterest: number | null;
  openInterestUsd: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  deltaBS: number | null;
  gammaBS: number | null;
  thetaBS: number | null;
  vegaBS: number | null;
  markVol: number | null;
  bidVol: number | null;
  askVol: number | null;
  atmVol: number | null;
  fwdPx: number | null;
  okxSellApr: number | null;
  okxBuyApr: number | null;
  spreadPct: number | null;
  premiumUsd: number | null;
  premiumUsdPerBtc: number | null;
  notionalBtc: number;
  cashSecuredApr: number | null;
  coveredCallApr: number | null;
  premiumYield: number | null;
  breakeven: number | null;
  otmPct: number | null;
  score: number;
  riskFlags: RiskFlag[];
  updatedAt: number | null;
}

export interface ExpirySummary {
  expiry: string;
  expiryLabel: string;
  dte: number;
  count: number;
  atmVol: number | null;
  avgPutApr: number | null;
  avgCallApr: number | null;
  putOiUsd: number;
  callOiUsd: number;
}

export interface OptionSnapshot {
  status: SnapshotStatus;
  generatedAt: number;
  refreshedAt: number | null;
  nextRefreshAt: number | null;
  ageMs: number | null;
  source: string;
  error: string | null;
  btcIndexPx: number | null;
  btcOpen24h: number | null;
  btcHigh24h: number | null;
  btcLow24h: number | null;
  btcChange24hPct: number | null;
  contractCount: number;
  expiries: ExpirySummary[];
  options: OptionContract[];
}

export type FuturesContractType = "PERPETUAL" | "CURRENT_QUARTER" | "NEXT_QUARTER";

export interface FuturesCurvePoint {
  exchange: "BINANCE";
  pair: "BTCUSDT";
  symbol: string;
  contractType: FuturesContractType;
  label: string;
  expiryTs: number | null;
  dte: number | null;
  indexPx: number | null;
  markPx: number | null;
  basisAbs: number | null;
  basisPct: number | null;
  annualizedBasis: number | null;
  fundingRate: number | null;
  annualizedFunding: number | null;
  nextFundingTime: number | null;
  openInterest: number | null;
  volume24h: number | null;
  quoteVolume24h: number | null;
  sourceTs: number | null;
}

export interface FuturesBasisHistoryPoint {
  ts: number;
  symbol: string;
  contractType: FuturesContractType;
  basisPct: number | null;
  annualizedBasis: number | null;
  fundingRate: number | null;
  annualizedFunding: number | null;
  markPx: number | null;
  indexPx: number | null;
}

export interface FuturesBasisSnapshot {
  status: SnapshotStatus;
  generatedAt: number;
  refreshedAt: number | null;
  nextRefreshAt: number | null;
  ageMs: number | null;
  source: string;
  error: string | null;
  dbPath: string;
  indexPx: number | null;
  curve: FuturesCurvePoint[];
  history: FuturesBasisHistoryPoint[];
}
