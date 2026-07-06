import { FuturesContractType, FuturesCurvePoint } from "@/lib/types";
import { saveMarketInstruments } from "@/lib/server/market-db";

const BINANCE_USDM_BASE_URL = process.env.BINANCE_USDM_BASE_URL ?? "https://fapi.binance.com";
const REQUEST_TIMEOUT_MS = 5000;
const BTC_PAIR = "BTCUSDT";
const FUNDING_INTERVAL_HOURS = 8;

interface BinanceExchangeInfo {
  symbols: BinanceInstrument[];
}

interface BinanceInstrument {
  symbol: string;
  pair: string;
  contractType: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  deliveryDate: number;
  status: string;
}

interface BinancePremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice: string;
  lastFundingRate: string;
  interestRate: string;
  nextFundingTime: number;
  time: number;
}

interface BinanceTicker24h {
  symbol: string;
  lastPrice: string;
  volume: string;
  quoteVolume: string;
  closeTime: number;
}

interface BinanceOpenInterest {
  symbol: string;
  openInterest: string;
  time: number;
}

interface BinanceBasisPoint {
  indexPrice: string;
  contractType: string;
  basisRate: string;
  futuresPrice: string;
  annualizedBasisRate: string;
  basis: string;
  pair: string;
  timestamp: number;
}

export interface BinanceFuturesFetchResult {
  curve: FuturesCurvePoint[];
  rawBySymbol: Map<string, unknown>;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchBinance<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${BINANCE_USDM_BASE_URL}${path}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "crypto-option-board/0.1"
      }
    });

    if (!response.ok) {
      throw new Error(`Binance ${path} HTTP ${response.status}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function isTrackedContractType(value: string): value is FuturesContractType {
  return value === "PERPETUAL" || value === "CURRENT_QUARTER" || value === "NEXT_QUARTER";
}

function labelForContract(type: FuturesContractType) {
  if (type === "PERPETUAL") return "Perp";
  if (type === "CURRENT_QUARTER") return "Current Q";
  return "Next Q";
}

function sortContractType(a: FuturesContractType, b: FuturesContractType) {
  const order: Record<FuturesContractType, number> = {
    PERPETUAL: 0,
    CURRENT_QUARTER: 1,
    NEXT_QUARTER: 2
  };

  return order[a] - order[b];
}

function annualizeFunding(rate: number | null) {
  if (rate === null) return null;
  return rate * (24 / FUNDING_INTERVAL_HOURS) * 365;
}

async function fetchBasis(contractType: FuturesContractType) {
  const data = await fetchBinance<BinanceBasisPoint[]>(
    `/futures/data/basis?pair=${BTC_PAIR}&contractType=${contractType}&period=5m&limit=1`
  );

  return data[0] ?? null;
}

async function fetchInstrumentMarketData(instrument: BinanceInstrument) {
  const [premium, ticker, openInterest] = await Promise.all([
    fetchBinance<BinancePremiumIndex>(`/fapi/v1/premiumIndex?symbol=${instrument.symbol}`),
    fetchBinance<BinanceTicker24h>(`/fapi/v1/ticker/24hr?symbol=${instrument.symbol}`),
    fetchBinance<BinanceOpenInterest>(`/fapi/v1/openInterest?symbol=${instrument.symbol}`)
  ]);

  return { premium, ticker, openInterest };
}

export async function fetchBinanceBtcFuturesSnapshot(): Promise<BinanceFuturesFetchResult> {
  const exchangeInfo = await fetchBinance<BinanceExchangeInfo>("/fapi/v1/exchangeInfo");
  const instruments = exchangeInfo.symbols
    .filter((item) => item.pair === BTC_PAIR)
    .filter((item) => item.status === "TRADING")
    .filter((item) => isTrackedContractType(item.contractType))
    .sort((a, b) => sortContractType(a.contractType as FuturesContractType, b.contractType as FuturesContractType));

  saveMarketInstruments(
    instruments.map((item) => ({
      exchange: "BINANCE",
      symbol: item.symbol,
      pair: "BTCUSDT",
      marketType: "FUTURES",
      contractType: item.contractType as FuturesContractType,
      baseAsset: item.baseAsset,
      quoteAsset: item.quoteAsset,
      marginAsset: item.marginAsset,
      expiryTs: item.contractType === "PERPETUAL" ? null : item.deliveryDate,
      status: item.status,
      raw: item
    }))
  );

  const basisResults = await Promise.all(
    instruments.map(async (instrument) => ({
      contractType: instrument.contractType as FuturesContractType,
      basis: await fetchBasis(instrument.contractType as FuturesContractType).catch(() => null)
    }))
  );
  const basisByContractType = new Map(basisResults.map((item) => [item.contractType, item.basis]));

  const rawBySymbol = new Map<string, unknown>();
  const curve = await Promise.all(
    instruments.map(async (instrument): Promise<FuturesCurvePoint> => {
      const contractType = instrument.contractType as FuturesContractType;
      const { premium, ticker, openInterest } = await fetchInstrumentMarketData(instrument);
      const basis = basisByContractType.get(contractType) ?? null;
      const markPx = toNumber(premium.markPrice) ?? toNumber(basis?.futuresPrice);
      const indexPx = toNumber(premium.indexPrice) ?? toNumber(basis?.indexPrice);
      const basisAbs = markPx !== null && indexPx !== null ? markPx - indexPx : toNumber(basis?.basis);
      const basisPct =
        markPx !== null && indexPx !== null && indexPx !== 0
          ? markPx / indexPx - 1
          : toNumber(basis?.basisRate);
      const sourceTs = premium.time || basis?.timestamp || ticker.closeTime || openInterest.time || null;
      const expiryTs = contractType === "PERPETUAL" ? null : instrument.deliveryDate;
      const dte =
        expiryTs !== null && sourceTs !== null
          ? Math.max((expiryTs - sourceTs) / (24 * 60 * 60 * 1000), 0)
          : null;
      const annualizedBasis =
        contractType === "PERPETUAL"
          ? null
          : toNumber(basis?.annualizedBasisRate) ??
            (basisPct !== null && dte !== null && dte > 0 ? basisPct * (365 / dte) : null);
      const fundingRate = contractType === "PERPETUAL" ? toNumber(premium.lastFundingRate) : null;
      const raw = { instrument, premium, ticker, openInterest, basis };

      rawBySymbol.set(instrument.symbol, raw);

      return {
        exchange: "BINANCE",
        pair: "BTCUSDT",
        symbol: instrument.symbol,
        contractType,
        label: labelForContract(contractType),
        expiryTs,
        dte,
        indexPx,
        markPx,
        basisAbs,
        basisPct,
        annualizedBasis,
        fundingRate,
        annualizedFunding: annualizeFunding(fundingRate),
        nextFundingTime: contractType === "PERPETUAL" ? premium.nextFundingTime || null : null,
        openInterest: toNumber(openInterest.openInterest),
        volume24h: toNumber(ticker.volume),
        quoteVolume24h: toNumber(ticker.quoteVolume),
        sourceTs
      };
    })
  );

  return {
    curve,
    rawBySymbol
  };
}
