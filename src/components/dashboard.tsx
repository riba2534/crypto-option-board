"use client";

import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowDownUp,
  ArrowUpRight,
  BarChart3,
  Clock3,
  Database,
  Filter,
  LineChart,
  Minus,
  Moon,
  Radio,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  Scale,
  Sun,
  Target,
  TrendingUp,
  Zap,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  FuturesBasisHistoryPoint,
  FuturesBasisSnapshot,
  FuturesCurvePoint,
  OptionContract,
  OptionSnapshot,
  RiskFlag
} from "@/lib/types";

type SideFilter = "P" | "C" | "ALL";
type MetricMode = "apr" | "iv" | "delta" | "oi";
type ThemeMode = "light" | "dark";
type ViewMode = "options" | "futures";
type DeltaPreset = "ALL" | "10" | "20" | "30";
type SortMode = "score" | "apr" | "yield" | "delta" | "otm" | "spread" | "oi";

interface DashboardProps {
  initialSnapshot: OptionSnapshot;
}

const riskLabel: Record<RiskFlag, string> = {
  NO_BID: "无买价",
  NO_ASK: "无卖价",
  WIDE_SPREAD: "价差宽",
  LOW_OI: "OI低",
  LOW_VOLUME: "量低",
  NEAR_ATM: "近ATM",
  SHORT_DTE: "临到期",
  STALE_QUOTE: "报价旧"
};

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

const usdPremium = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1
});

const number = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2
});

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});

function pct(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }

  return `${(value * 100).toFixed(digits)}%`;
}

function signedPct(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }

  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

function money(value: number | null | undefined, compactMode = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }

  return compactMode ? usdCompact.format(value) : usd.format(value);
}

function premiumMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }

  return usdPremium.format(value);
}

function fmt(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }

  return value.toFixed(digits);
}

function optionApr(option: OptionContract) {
  return option.side === "P" ? option.cashSecuredApr : option.coveredCallApr;
}

function optionRiskDelta(option: OptionContract) {
  return option.deltaBS ?? option.delta;
}

function sortOptionValue(option: OptionContract, mode: SortMode) {
  if (mode === "apr") return optionApr(option) ?? -Infinity;
  if (mode === "yield") return option.premiumYield ?? -Infinity;
  if (mode === "delta") return -(Math.abs(optionRiskDelta(option) ?? Infinity));
  if (mode === "otm") return option.otmPct ?? -Infinity;
  if (mode === "spread") return -(option.spreadPct ?? Infinity);
  if (mode === "oi") return option.openInterestUsd ?? -Infinity;
  return option.score;
}

const sortLabels: Record<SortMode, string> = {
  score: "综合机会",
  apr: "卖方 APR",
  yield: "本期收益",
  delta: "低 Delta",
  otm: "OTM 距离",
  spread: "窄价差",
  oi: "持仓量"
};

function optionPxUsd(px: number | null | undefined, btcIndexPx: number | null | undefined) {
  if (
    px === null ||
    px === undefined ||
    btcIndexPx === null ||
    btcIndexPx === undefined ||
    !Number.isFinite(px) ||
    !Number.isFinite(btcIndexPx)
  ) {
    return null;
  }

  return px * btcIndexPx;
}

function displayMetric(option: OptionContract, mode: MetricMode) {
  if (mode === "apr") return pct(optionApr(option));
  if (mode === "iv") return pct(option.markVol);
  if (mode === "delta") return fmt(option.delta, 2);
  return money(option.openInterestUsd, true);
}

function metricValue(option: OptionContract, mode: MetricMode) {
  if (mode === "apr") return optionApr(option) ?? -1;
  if (mode === "iv") return option.markVol ?? -1;
  if (mode === "delta") return Math.abs(option.delta ?? 0);
  return Math.log10((option.openInterestUsd ?? 0) + 1) / 8;
}

function metricClass(option: OptionContract, mode: MetricMode) {
  const value = metricValue(option, mode);
  if (option.riskFlags.includes("NO_BID")) return "heat heat-muted";
  if (mode === "delta" && value > 0.45) return "heat heat-risk";
  if (value > 0.45) return "heat heat-high";
  if (value > 0.25) return "heat heat-mid";
  if (value > 0.1) return "heat heat-low";
  return "heat heat-muted";
}

function latestAge(snapshot: OptionSnapshot) {
  if (snapshot.ageMs === null) return "warming";
  if (snapshot.ageMs < 1000) return "刚刚";
  return `${Math.round(snapshot.ageMs / 1000)}s`;
}

function snapshotAge(ageMs: number | null | undefined) {
  if (ageMs === null || ageMs === undefined) return "warming";
  if (ageMs < 1000) return "刚刚";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  return `${Math.round(ageMs / 60_000)}m`;
}

function formatDateTime(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(value);
}

function tenorLabel(point: FuturesCurvePoint) {
  if (point.contractType === "PERPETUAL") return point.label;
  if (point.dte === null) return point.label;
  return `${point.label} · ${point.dte.toFixed(0)}D`;
}

function basisMetric(point: FuturesCurvePoint) {
  return point.contractType === "PERPETUAL"
    ? point.annualizedFunding ?? point.basisPct
    : point.annualizedBasis ?? point.basisPct;
}

function basisTone(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "neutral";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "neutral";
}

function nearestExpiry(snapshot: OptionSnapshot) {
  return snapshot.expiries.find((expiry) => expiry.dte >= 2)?.expiry ?? snapshot.expiries[0]?.expiry ?? "ALL";
}

export function Dashboard({ initialSnapshot }: DashboardProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [view, setView] = useState<ViewMode>("options");
  const [futuresSnapshot, setFuturesSnapshot] = useState<FuturesBasisSnapshot | null>(null);
  const [side, setSide] = useState<SideFilter>("P");
  const [metric, setMetric] = useState<MetricMode>("apr");
  const [expiry, setExpiry] = useState(() => nearestExpiry(initialSnapshot));
  const [minApr, setMinApr] = useState(0);
  const [maxSpread, setMaxSpread] = useState(25);
  const [hideIlliquid, setHideIlliquid] = useState(true);
  const [deltaPreset, setDeltaPreset] = useState<DeltaPreset>("20");
  const [sortMode, setSortMode] = useState<SortMode>("score");
  const [filterOpen, setFilterOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSnapshot.options.find((option) => option.side === "P" && !option.riskFlags.includes("NO_BID"))
      ?.instId ??
      initialSnapshot.options[0]?.instId ??
      null
  );

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("option-board-theme");
    if (savedTheme === "dark" || savedTheme === "light") {
      setTheme(savedTheme);
      document.documentElement.dataset.theme = savedTheme;
      return;
    }

    document.documentElement.dataset.theme = "light";
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("option-board-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!filterOpen && !detailOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFilterOpen(false);
        setDetailOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [detailOpen, filterOpen]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/options/snapshot", { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as OptionSnapshot;
        if (!cancelled) {
          setSnapshot(next);
        }
      } catch {
        // The status pill is driven by the last server snapshot.
      }
    }

    const timer = setInterval(load, 5_000);
    void load();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (view !== "futures") {
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/futures/basis", { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as FuturesBasisSnapshot;
        if (!cancelled) {
          setFuturesSnapshot(next);
        }
      } catch {
        // The futures tab keeps the previous SQLite snapshot if OKX is temporarily unavailable.
      }
    }

    const timer = setInterval(load, 15_000);
    void load();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [view]);

  useEffect(() => {
    if (
      expiry !== "ALL" &&
      snapshot.expiries.length > 0 &&
      !snapshot.expiries.some((item) => item.expiry === expiry)
    ) {
      setExpiry(nearestExpiry(snapshot));
    }
  }, [expiry, snapshot.expiries]);

  const expiries = snapshot.expiries.slice(0, 14);

  const filteredOptions = useMemo(() => {
    const maxDelta = deltaPreset === "ALL" ? null : Number(deltaPreset) / 100;

    return snapshot.options
      .filter((option) => side === "ALL" || option.side === side)
      .filter((option) => expiry === "ALL" || option.expiry === expiry)
      .filter((option) => {
        if (maxDelta === null) return true;
        const delta = optionRiskDelta(option);
        return delta !== null && Math.abs(delta) <= maxDelta;
      })
      .filter((option) => (optionApr(option) ?? -1) >= minApr / 100)
      .filter((option) => option.spreadPct !== null && option.spreadPct <= maxSpread / 100)
      .filter((option) => {
        if (!hideIlliquid) return true;
        return (
          !option.riskFlags.includes("NO_BID") &&
          !option.riskFlags.includes("NO_ASK") &&
          !option.riskFlags.includes("LOW_OI")
        );
      });
  }, [deltaPreset, expiry, hideIlliquid, maxSpread, minApr, side, snapshot.options]);

  const candidates = useMemo(() => {
    return [...filteredOptions]
      .sort((a, b) => sortOptionValue(b, sortMode) - sortOptionValue(a, sortMode))
      .slice(0, 24);
  }, [filteredOptions, sortMode]);

  useEffect(() => {
    if (selectedId && filteredOptions.some((option) => option.instId === selectedId)) {
      return;
    }

    setSelectedId(candidates[0]?.instId ?? filteredOptions[0]?.instId ?? null);
  }, [candidates, filteredOptions, selectedId]);

  const selected = useMemo(() => {
    return filteredOptions.find((option) => option.instId === selectedId) ?? null;
  }, [filteredOptions, selectedId]);

  const activeFilterCount =
    Number(side !== "ALL") +
    Number(expiry !== "ALL") +
    Number(deltaPreset !== "ALL") +
    Number(minApr > 0) +
    Number(maxSpread < 100) +
    Number(hideIlliquid);

  const resetFilters = () => {
    setSide("P");
    setExpiry(nearestExpiry(snapshot));
    setDeltaPreset("20");
    setMinApr(0);
    setMaxSpread(25);
    setHideIlliquid(true);
  };

  const heatmap = useMemo(() => {
    const byExpiry = new Map<string, OptionContract[]>();
    const activeExpiries = expiry === "ALL" ? expiries.slice(0, 8).map((item) => item.expiry) : [expiry];

    for (const item of filteredOptions) {
      if (!activeExpiries.includes(item.expiry)) continue;
      const list = byExpiry.get(item.expiry) ?? [];
      list.push(item);
      byExpiry.set(item.expiry, list);
    }

    return activeExpiries
      .map((date) => ({
        expiry: date,
        label: snapshot.expiries.find((item) => item.expiry === date)?.expiryLabel ?? date,
        contracts: (byExpiry.get(date) ?? [])
          .sort((a, b) => Math.abs(a.otmPct ?? 999) - Math.abs(b.otmPct ?? 999))
          .slice(0, 18)
          .sort((a, b) => a.strike - b.strike)
      }))
      .filter((row) => row.contracts.length > 0);
  }, [expiries, expiry, filteredOptions, snapshot.expiries]);

  const putCallOi = useMemo(() => {
    const puts = snapshot.options
      .filter((option) => option.side === "P")
      .reduce((sum, option) => sum + (option.openInterestUsd ?? 0), 0);
    const calls = snapshot.options
      .filter((option) => option.side === "C")
      .reduce((sum, option) => sum + (option.openInterestUsd ?? 0), 0);
    const total = puts + calls || 1;
    return { puts, calls, putPct: puts / total, callPct: calls / total };
  }, [snapshot.options]);
  const btcChange = snapshot.btcChange24hPct;
  const btcChangeClass =
    btcChange === null || btcChange === undefined ? "neutral" : btcChange > 0 ? "up" : btcChange < 0 ? "down" : "neutral";

  return (
    <main className="shell">
      <header className="topbar">
        <div className="title-block">
          <div className="brand-heading">
            <img alt="" className="brand-logo" src="/logo.svg" />
            <div>
            <p className="eyebrow">OKX BTC Options</p>
              <h1>BTC Option Board</h1>
            </div>
          </div>
          <button
            className="theme-toggle"
            type="button"
            aria-label={theme === "light" ? "切换到暗色模式" : "切换到亮色模式"}
            title={theme === "light" ? "切换到暗色模式" : "切换到亮色模式"}
            onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
            <span className="sr-only">{theme === "light" ? "暗色" : "亮色"}</span>
          </button>
        </div>
        <div className="market-strip">
          <div className="market-tile primary">
            <span>BTC Index</span>
            <strong>{money(snapshot.btcIndexPx)}</strong>
            <em className={btcChangeClass}>
              {btcChangeClass === "up" ? (
                <ArrowUpRight size={14} />
              ) : btcChangeClass === "down" ? (
                <ArrowDownRight size={14} />
              ) : (
                <Minus size={14} />
              )}
              {pct(btcChange)}
            </em>
          </div>
          <div className="market-tile">
            <span>24h Range</span>
            <strong>
              {money(snapshot.btcLow24h, true)} / {money(snapshot.btcHigh24h, true)}
            </strong>
          </div>
          <div className="market-tile">
            <span>Contracts</span>
            <strong>{compact.format(snapshot.contractCount)}</strong>
          </div>
          <div className={`market-tile status ${snapshot.status}`}>
            <span>Server Cache</span>
            <strong>
              <RefreshCw size={15} />
              {snapshot.status.toUpperCase()}
            </strong>
            <em>{latestAge(snapshot)}</em>
          </div>
        </div>
      </header>

      <nav className="view-tabs" aria-label="看板视图">
        <button
          type="button"
          aria-pressed={view === "options"}
          className={view === "options" ? "active" : ""}
          onClick={() => setView("options")}
        >
          <Target size={16} />
          <span>期权收益</span>
        </button>
        <button
          type="button"
          aria-pressed={view === "futures"}
          className={view === "futures" ? "active" : ""}
          onClick={() => setView("futures")}
        >
          <BarChart3 size={16} />
          <span>期货 Carry</span>
        </button>
      </nav>

      {view === "options" ? (
      <>
      <section className="mobile-options" aria-label="期权候选">
        <div className="mobile-filter-summary">
          <div>
            <strong>{side === "ALL" ? "Put + Call" : side === "P" ? "Put" : "Call"}</strong>
            <span>
              {expiry === "ALL" ? "全部期限" : snapshot.expiries.find((item) => item.expiry === expiry)?.expiryLabel}
              {deltaPreset === "ALL" ? " · 全 Delta" : ` · ≤ ${deltaPreset}Δ BS`}
            </span>
          </div>
          <button type="button" onClick={() => setFilterOpen(true)}>
            <SlidersHorizontal size={16} />
            筛选 {activeFilterCount}
          </button>
        </div>

        <div className="mobile-result-bar">
          <span><strong>{filteredOptions.length}</strong> 个可卖候选</span>
          <label>
            <ArrowDownUp size={15} />
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
              {Object.entries(sortLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="mobile-candidate-list">
          {candidates.length === 0 ? (
            <div className="empty-state mobile-empty">当前筛选没有匹配合约，试试放宽 Delta 或价差。</div>
          ) : candidates.map((option) => (
            <button
              type="button"
              className="option-card"
              key={option.instId}
              onClick={() => {
                setSelectedId(option.instId);
                setDetailOpen(true);
              }}
            >
              <span className="option-card-kicker">
                <b>{option.side === "P" ? "PUT" : "CALL"}</b>
                <em>{option.expiryLabel} · {option.dte.toFixed(0)}D</em>
              </span>
              <span className="option-card-strike">
                <strong>{money(option.strike)}</strong>
                <em>OTM {pct(option.otmPct)}</em>
              </span>
              <span className="option-card-yield">
                <span><small>本期收益</small><strong>{pct(option.premiumYield, 2)}</strong></span>
                <span><small>卖方 APR</small><strong>{pct(optionApr(option))}</strong></span>
              </span>
              <span className="option-card-data">
                BS Δ {fmt(option.deltaBS, 2)} · IV {pct(option.markVol)} · OI {compact.format(option.openInterest ?? 0)}
              </span>
              <span className="option-card-footer">
                <span>Bid {premiumMoney(option.premiumUsdPerBtc)}</span>
                <span className={option.spreadPct !== null && option.spreadPct > 0.15 ? "warn" : "good"}>
                  Spread {pct(option.spreadPct)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="workspace desktop-options-workspace">
        <aside className="sidebar panel">
          <div className="panel-title">
            <Filter size={17} />
            <span>筛选</span>
          </div>

          <div className="field side-field">
            <label>方向</label>
            <div className="segmented" role="group" aria-label="期权方向">
              <button
                type="button"
                aria-pressed={side === "P"}
                className={side === "P" ? "active" : ""}
                onClick={() => setSide("P")}
              >
                Put
              </button>
              <button
                type="button"
                aria-pressed={side === "C"}
                className={side === "C" ? "active" : ""}
                onClick={() => setSide("C")}
              >
                Call
              </button>
              <button
                type="button"
                aria-pressed={side === "ALL"}
                className={side === "ALL" ? "active" : ""}
                onClick={() => setSide("ALL")}
              >
                Both
              </button>
            </div>
          </div>

          <div className="field delta-field">
            <label>BS Delta 风险</label>
            <div className="segmented delta-presets" role="group" aria-label="BS Delta 最大值">
              {(["10", "20", "30", "ALL"] as DeltaPreset[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={deltaPreset === value}
                  className={deltaPreset === value ? "active" : ""}
                  onClick={() => setDeltaPreset(value)}
                >
                  {value === "ALL" ? "All" : `${value}Δ`}
                </button>
              ))}
            </div>
          </div>

          <div className="field metric-field">
            <label>指标</label>
            <div className="segmented vertical" role="group" aria-label="矩阵指标">
              <button
                type="button"
                aria-pressed={metric === "apr"}
                className={metric === "apr" ? "active" : ""}
                onClick={() => setMetric("apr")}
              >
                APR
              </button>
              <button
                type="button"
                aria-pressed={metric === "iv"}
                className={metric === "iv" ? "active" : ""}
                onClick={() => setMetric("iv")}
              >
                IV
              </button>
              <button
                type="button"
                aria-pressed={metric === "delta"}
                className={metric === "delta" ? "active" : ""}
                onClick={() => setMetric("delta")}
              >
                Delta
              </button>
              <button
                type="button"
                aria-pressed={metric === "oi"}
                className={metric === "oi" ? "active" : ""}
                onClick={() => setMetric("oi")}
              >
                OI
              </button>
            </div>
          </div>

          <div className="field expiry-field">
            <label>到期日</label>
            <div className="expiry-list" role="group" aria-label="到期日">
              <button
                type="button"
                aria-pressed={expiry === "ALL"}
                className={expiry === "ALL" ? "active" : ""}
                onClick={() => setExpiry("ALL")}
              >
                All
              </button>
              {expiries.map((item) => (
                <button
                  key={item.expiry}
                  type="button"
                  aria-pressed={expiry === item.expiry}
                  className={expiry === item.expiry ? "active" : ""}
                  onClick={() => setExpiry(item.expiry)}
                >
                  <span>{item.expiryLabel}</span>
                  <em>{item.dte.toFixed(0)}D</em>
                </button>
              ))}
            </div>
          </div>

          <div className="field range-field min-apr-field">
            <label htmlFor="min-apr">最低 APR</label>
            <div className="range-line">
              <input
                id="min-apr"
                min="0"
                max="200"
                step="5"
                type="range"
                value={minApr}
                onChange={(event) => setMinApr(Number(event.target.value))}
              />
              <strong>{minApr}%</strong>
            </div>
          </div>

          <div className="field range-field spread-field">
            <label htmlFor="max-spread">最大价差</label>
            <div className="range-line">
              <input
                id="max-spread"
                min="1"
                max="100"
                step="1"
                type="range"
                value={maxSpread}
                onChange={(event) => setMaxSpread(Number(event.target.value))}
              />
              <strong>{maxSpread}%</strong>
            </div>
          </div>

          <label className="toggle liquidity-toggle">
            <input
              checked={hideIlliquid}
              type="checkbox"
              onChange={(event) => setHideIlliquid(event.target.checked)}
            />
            <span>隐藏无 bid / 低 OI</span>
          </label>
        </aside>

        <section className="main-column">
          <section className="expiry-strip">
            {expiries.slice(0, 8).map((item) => (
              <button
                key={item.expiry}
                type="button"
                aria-pressed={expiry === item.expiry}
                className={expiry === item.expiry ? "expiry-card active" : "expiry-card"}
                onClick={() => setExpiry(item.expiry)}
              >
                <span>{item.expiryLabel}</span>
                <strong>{item.dte.toFixed(1)}D</strong>
                <em>ATM IV {pct(item.atmVol)}</em>
                <em>OI {money(item.putOiUsd + item.callOiUsd, true)}</em>
                <div className="mini-bars">
                  <i style={{ width: `${Math.min(item.putOiUsd / 1_000_000, 100)}%` }} />
                  <b style={{ width: `${Math.min(item.callOiUsd / 1_000_000, 100)}%` }} />
                </div>
              </button>
            ))}
          </section>

          <section className="panel heatmap-panel">
            <div className="panel-title spread">
              <span>
                <Target size={17} />
                收益矩阵
              </span>
              <em>{metric.toUpperCase()} view</em>
            </div>
            <div className="heatmap-grid">
              {heatmap.length === 0 ? (
                <div className="empty-state">当前筛选下没有可展示合约</div>
              ) : (
                heatmap.map((row) => (
                  <div className="heat-row" key={row.expiry}>
                    <div className="heat-expiry">
                      <strong>{row.label}</strong>
                      <span>{row.contracts[0]?.dte.toFixed(1)}D</span>
                    </div>
                    <div className="heat-cells">
                      {row.contracts.map((option) => (
                        <button
                          key={option.instId}
                          type="button"
                          aria-pressed={option.instId === selected?.instId}
                          aria-label={`${option.instId} ${displayMetric(option, metric)}`}
                          className={`${metricClass(option, metric)} ${
                            option.instId === selected?.instId ? "selected" : ""
                          }`}
                          onClick={() => setSelectedId(option.instId)}
                          title={`${option.instId} ${displayMetric(option, metric)}`}
                        >
                          <strong>{displayMetric(option, metric)}</strong>
                          <span>{option.strike.toLocaleString("en-US")}</span>
                          <em>{option.side}</em>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel table-panel">
            <div className="panel-title spread">
              <span>
                <TrendingUp size={17} />
                候选合约
              </span>
              <label className="desktop-sort">
                <ArrowDownUp size={14} />
                <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                  {Object.entries(sortLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <em>{candidates.length} / {filteredOptions.length}</em>
              </label>
            </div>
            <div className="contracts-table">
              <div className="table-head">
                <span>合约</span>
                <span>收益 / APR</span>
                <span>Bid / Ask</span>
                <span>BS Delta</span>
                <span>OTM</span>
                <span>权利金 USD</span>
                <span>OI</span>
                <span>风险</span>
              </div>
              {candidates.map((option) => (
                <button
                  key={option.instId}
                  type="button"
                  aria-pressed={option.instId === selected?.instId}
                  className={option.instId === selected?.instId ? "table-row active" : "table-row"}
                  onClick={() => setSelectedId(option.instId)}
                >
                  <span>
                    <strong>
                      {option.expiryLabel} {option.strike.toLocaleString("en-US")} {option.side}
                    </strong>
                    <em>{option.instId}</em>
                  </span>
                  <span className="yield-cell">
                    <strong>{pct(option.premiumYield, 2)}</strong>
                    <em>{pct(optionApr(option))} APR</em>
                  </span>
                  <span>
                    {fmt(option.bidPx, 4)} / {fmt(option.askPx, 4)}
                  </span>
                  <span>{fmt(option.deltaBS, 2)}</span>
                  <span>{pct(option.otmPct)}</span>
                  <span>
                    <strong>{premiumMoney(option.premiumUsdPerBtc)}</strong>
                    <em>每张 {premiumMoney(option.premiumUsd)}</em>
                  </span>
                  <span>{money(option.openInterestUsd, true)}</span>
                  <span className="flag-list">
                    {option.riskFlags.map((flag) => (
                      <i key={flag}>{riskLabel[flag]}</i>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </section>

        <aside className="detail panel">
          {selected ? (
            <>
              <div className="panel-title spread">
                <span>
                  <Activity size={17} />
                  合约详情
                </span>
                <em>{selected.side === "P" ? "Cash-secured Put" : "Covered Call"}</em>
              </div>

              <div className="selected-contract">
                <span>{selected.expiryLabel}</span>
                <strong>
                  {selected.strike.toLocaleString("en-US")} {selected.side}
                </strong>
                <em>{selected.instId}</em>
              </div>

              <div className="metric-grid">
                <Metric label="本期收益" value={pct(selected.premiumYield, 2)} strong />
                <Metric label="简单年化 APR" value={pct(optionApr(selected))} />
                <Metric label="Bid USD/BTC" value={premiumMoney(selected.premiumUsdPerBtc)} />
                <Metric label="Ask USD/BTC" value={premiumMoney(optionPxUsd(selected.askPx, snapshot.btcIndexPx))} />
                <Metric label="权利金/张" value={premiumMoney(selected.premiumUsd)} />
                <Metric label="盈亏平衡" value={money(selected.breakeven)} />
                <Metric label="OTM 距离" value={pct(selected.otmPct)} />
                <Metric label="DTE" value={`${selected.dte.toFixed(2)}D`} />
                <Metric label="Spread" value={pct(selected.spreadPct)} />
              </div>

              <div className="detail-section">
                <h2>盘口</h2>
                <div className="quote-line">
                  <span>Bid</span>
                  <strong>
                    {fmt(selected.bidPx, 4)}
                    <small>{premiumMoney(selected.premiumUsdPerBtc)}</small>
                  </strong>
                  <em>{number.format(selected.bidSize ?? 0)} 张</em>
                </div>
                <div className="quote-line ask">
                  <span>Ask</span>
                  <strong>
                    {fmt(selected.askPx, 4)}
                    <small>{premiumMoney(optionPxUsd(selected.askPx, snapshot.btcIndexPx))}</small>
                  </strong>
                  <em>{number.format(selected.askSize ?? 0)} 张</em>
                </div>
              </div>

              <div className="detail-section">
                <h2>风险</h2>
                <div className="greeks">
                  <Metric label="BS Delta" value={fmt(selected.deltaBS, 3)} />
                  <Metric label="PA Delta" value={fmt(selected.delta, 3)} />
                  <Metric label="Gamma" value={fmt(selected.gamma, 3)} />
                  <Metric label="Theta" value={fmt(selected.theta, 5)} />
                  <Metric label="Vega" value={fmt(selected.vega, 5)} />
                </div>
                <div className="flags">
                  {selected.riskFlags.length === 0 ? (
                    <span className="clean">
                      <ShieldAlert size={14} />
                      流动性过滤通过
                    </span>
                  ) : (
                    selected.riskFlags.map((flag) => (
                      <span key={flag}>
                        <AlertTriangle size={14} />
                        {riskLabel[flag]}
                      </span>
                    ))
                  )}
                </div>
              </div>

              <div className="detail-section">
                <h2>波动率</h2>
                <div className="vol-bars">
                  <Bar label="Bid IV" value={selected.bidVol} />
                  <Bar label="Mark IV" value={selected.markVol} />
                  <Bar label="Ask IV" value={selected.askVol} />
                  <Bar label="ATM IV" value={selected.atmVol} />
                </div>
              </div>

              <div className="detail-section">
                <h2>到期盈亏 / 张</h2>
                <PayoffPreview option={selected} indexPx={snapshot.btcIndexPx} />
              </div>

              <div className="detail-section">
                <h2>市场结构</h2>
                <div className="oi-balance">
                  <span>Put OI</span>
                  <div>
                    <i style={{ width: `${putCallOi.putPct * 100}%` }} />
                    <b style={{ width: `${putCallOi.callPct * 100}%` }} />
                  </div>
                  <span>Call OI</span>
                </div>
                <p className="micro">
                  Put {money(putCallOi.puts, true)} / Call {money(putCallOi.calls, true)}
                </p>
              </div>

              <div className="timestamp">
                <Clock3 size={14} />
                报价时间 {formatDateTime(selected.updatedAt)}
              </div>
            </>
          ) : (
            <div className="empty-state">等待 OKX 数据</div>
          )}
        </aside>
      </section>
      {filterOpen ? (
        <div className="mobile-sheet-backdrop" onMouseDown={() => setFilterOpen(false)}>
          <section
            className="mobile-sheet filter-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-filter-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" />
            <header className="sheet-header">
              <div>
                <span>OPTIONS SCREENER</span>
                <h2 id="mobile-filter-title">筛选条件</h2>
              </div>
              <button type="button" aria-label="关闭筛选" onClick={() => setFilterOpen(false)}><X size={20} /></button>
            </header>
            <div className="sheet-content">
              <div className="sheet-field">
                <label>方向</label>
                <div className="segmented">
                  {(["P", "C", "ALL"] as SideFilter[]).map((value) => (
                    <button key={value} type="button" className={side === value ? "active" : ""} onClick={() => setSide(value)}>
                      {value === "P" ? "Put" : value === "C" ? "Call" : "Both"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="sheet-field">
                <label>BS Delta 上限</label>
                <div className="segmented delta-presets">
                  {(["10", "20", "30", "ALL"] as DeltaPreset[]).map((value) => (
                    <button key={value} type="button" className={deltaPreset === value ? "active" : ""} onClick={() => setDeltaPreset(value)}>
                      {value === "ALL" ? "All" : `${value}Δ`}
                    </button>
                  ))}
                </div>
                <p>使用 BS Delta 作为方向风险筛选，不代表真实胜率。</p>
              </div>
              <div className="sheet-field">
                <label>到期日</label>
                <div className="sheet-expiries">
                  <button type="button" className={expiry === "ALL" ? "active" : ""} onClick={() => setExpiry("ALL")}>全部</button>
                  {expiries.slice(0, 8).map((item) => (
                    <button key={item.expiry} type="button" className={expiry === item.expiry ? "active" : ""} onClick={() => setExpiry(item.expiry)}>
                      {item.expiryLabel}<small>{item.dte.toFixed(0)}D</small>
                    </button>
                  ))}
                </div>
              </div>
              <div className="sheet-field range-field">
                <label htmlFor="mobile-min-apr">最低 APR <strong>{minApr}%</strong></label>
                <input id="mobile-min-apr" min="0" max="200" step="5" type="range" value={minApr} onChange={(event) => setMinApr(Number(event.target.value))} />
              </div>
              <div className="sheet-field range-field">
                <label htmlFor="mobile-max-spread">最大价差 <strong>{maxSpread}%</strong></label>
                <input id="mobile-max-spread" min="1" max="100" step="1" type="range" value={maxSpread} onChange={(event) => setMaxSpread(Number(event.target.value))} />
              </div>
              <label className="sheet-toggle">
                <span><strong>仅看可交易盘口</strong><small>排除无 Bid、无 Ask 和低 OI</small></span>
                <input checked={hideIlliquid} type="checkbox" onChange={(event) => setHideIlliquid(event.target.checked)} />
              </label>
            </div>
            <footer className="sheet-footer">
              <button type="button" className="secondary" onClick={resetFilters}>重置</button>
              <button type="button" className="primary" onClick={() => setFilterOpen(false)}>查看 {filteredOptions.length} 个结果</button>
            </footer>
          </section>
        </div>
      ) : null}

      {detailOpen && selected ? (
        <div className="mobile-sheet-backdrop" onMouseDown={() => setDetailOpen(false)}>
          <section
            className="mobile-sheet detail-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-detail-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" />
            <header className="sheet-header contract-sheet-header">
              <div>
                <span>{selected.side === "P" ? "CASH-SECURED PUT" : "COVERED CALL"} · {selected.expiryLabel}</span>
                <h2 id="mobile-detail-title">{money(selected.strike)} {selected.side}</h2>
                <p>{selected.dte.toFixed(1)}D · OTM {pct(selected.otmPct)} · {selected.instId}</p>
              </div>
              <button type="button" aria-label="关闭合约详情" onClick={() => setDetailOpen(false)}><X size={20} /></button>
            </header>
            <div className="sheet-content detail-sheet-content">
              <div className="detail-hero-metrics">
                <Metric label="本期收益" value={pct(selected.premiumYield, 2)} strong />
                <Metric label="简单年化" value={pct(optionApr(selected))} />
                <Metric label="权利金/张" value={premiumMoney(selected.premiumUsd)} />
              </div>
              <section className="mobile-detail-section payoff-mobile-section">
                <h3>到期盈亏 / 张</h3>
                <PayoffPreview option={selected} indexPx={snapshot.btcIndexPx} />
              </section>
              <section className="mobile-detail-section">
                <h3>收益与缓冲</h3>
                <div className="mobile-detail-grid">
                  <Metric label="盈亏平衡" value={money(selected.breakeven)} />
                  <Metric label="OTM 距离" value={pct(selected.otmPct)} />
                  <Metric label="DTE" value={`${selected.dte.toFixed(2)}D`} />
                  <Metric label="报价年龄" value={selected.updatedAt ? `${Math.max(0, Math.round(((snapshot.refreshedAt ?? snapshot.generatedAt) - selected.updatedAt) / 1000))}s` : "--"} />
                </div>
              </section>
              <section className="mobile-detail-section">
                <h3>盘口与流动性</h3>
                <div className="mobile-quote-row"><span>Bid</span><strong>{fmt(selected.bidPx, 4)}</strong><em>{number.format(selected.bidSize ?? 0)} 张</em></div>
                <div className="mobile-quote-row"><span>Ask</span><strong>{fmt(selected.askPx, 4)}</strong><em>{number.format(selected.askSize ?? 0)} 张</em></div>
                <div className="mobile-detail-grid">
                  <Metric label="Spread" value={pct(selected.spreadPct)} />
                  <Metric label="Open Interest" value={compact.format(selected.openInterest ?? 0)} />
                </div>
              </section>
              <section className="mobile-detail-section">
                <h3>波动率与 Greeks</h3>
                <div className="mobile-detail-grid">
                  <Metric label="Mark IV" value={pct(selected.markVol)} />
                  <Metric label="ATM IV" value={pct(selected.atmVol)} />
                  <Metric label="BS Delta" value={fmt(selected.deltaBS, 3)} />
                  <Metric label="PA Delta" value={fmt(selected.delta, 3)} />
                  <Metric label="Theta" value={fmt(selected.theta, 5)} />
                  <Metric label="Vega" value={fmt(selected.vega, 5)} />
                </div>
              </section>
              <section className="mobile-detail-section method-note">
                <h3>计算口径</h3>
                <p>APR 为基于可成交 Bid 的简单年化；未计手续费、滑点和真实账户保证金。BTC-USD 为币本位反向期权。</p>
              </section>
            </div>
          </section>
        </div>
      ) : null}
      </>
      ) : (
        <FuturesWorkspace snapshot={futuresSnapshot} />
      )}

      {snapshot.error ? <div className="error-toast">{snapshot.error}</div> : null}
    </main>
  );
}

function fundingCountdown(value: number | null | undefined) {
  if (value === null || value === undefined) return "--";
  const minutes = Math.max(Math.round((value - Date.now()) / 60_000), 0);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Compare each perp against its own history and only sum symbols that have data
// at both endpoints; otherwise a newly listed feed (e.g. an exchange added today)
// would fake a massive OI jump against a baseline that never contained it.
function aggregatePerpOiChange(history: FuturesBasisHistoryPoint[], hours: number) {
  const bySymbol = new Map<string, Array<{ ts: number; oi: number }>>();
  for (const point of history) {
    if (point.contractType !== "PERPETUAL" || point.openInterest === null) continue;
    const rows = bySymbol.get(point.symbol) ?? [];
    rows.push({ ts: point.ts, oi: point.openInterest });
    bySymbol.set(point.symbol, rows);
  }
  const windowMs = hours * 60 * 60 * 1000;
  const toleranceMs = Math.min(windowMs / 4, 60 * 60 * 1000);
  let latestSum = 0;
  let pastSum = 0;
  let matched = 0;
  for (const rows of bySymbol.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => a.ts - b.ts);
    const latest = rows[rows.length - 1];
    const targetTs = latest.ts - windowMs;
    const past = rows.reduce((nearest, row) =>
      Math.abs(row.ts - targetTs) < Math.abs(nearest.ts - targetTs) ? row : nearest
    );
    if (Math.abs(past.ts - targetTs) > toleranceMs || past.oi <= 0) continue;
    latestSum += latest.oi;
    pastSum += past.oi;
    matched += 1;
  }
  return matched > 0 && pastSum > 0 ? latestSum / pastSum - 1 : null;
}

function futuresRegime(priceChange: number | null, oiChange: number | null) {
  if (priceChange === null || oiChange === null) {
    return { tone: "neutral", label: "市场正在建立样本", note: "积累足够的价格与 OI 历史后生成杠杆状态。" };
  }
  if (priceChange >= 0 && oiChange >= 0) {
    return { tone: "up", label: "价格与杠杆同步增加", note: "新仓正在进入，趋势获得杠杆支持，但拥挤风险也在上升。" };
  }
  if (priceChange >= 0 && oiChange < 0) {
    return { tone: "up", label: "上涨伴随去杠杆", note: "更像空头回补或旧仓离场，不能只凭上涨判断新多资金。" };
  }
  if (priceChange < 0 && oiChange >= 0) {
    return { tone: "down", label: "下跌伴随新杠杆", note: "新仓逆势进入，可能偏空，也可能是抄底；需结合主动成交确认。" };
  }
  return { tone: "down", label: "价格与杠杆同步收缩", note: "市场正在去杠杆，常见于多头减仓或被动平仓阶段。" };
}

function FuturesWorkspace({ snapshot }: { snapshot: FuturesBasisSnapshot | null }) {
  const curve = snapshot?.curve ?? [];
  const history = snapshot?.history ?? [];
  const stats = snapshot?.marketStats ?? null;
  const binanceStats = snapshot?.binanceMarketStats ?? null;
  const perps = curve.filter((point) => point.contractType === "PERPETUAL");
  // The term-structure panel stays OKX-only: OKX carries 6 tenors while Binance
  // only lists two quarterlies, which would garble the curve shape.
  const dated = curve.filter((point) => point.contractType !== "PERPETUAL" && point.exchange === "OKX");
  const primaryPerp =
    perps.find((point) => point.exchange === "Binance" && point.symbol === "BTCUSDT") ??
    perps.find((point) => point.symbol === "BTC-USDT-SWAP") ??
    perps[0] ?? null;
  const fundingPerp = primaryPerp;
  const currentQuarter = dated.find((point) => point.contractType === "CURRENT_QUARTER") ?? null;
  const nextQuarter = dated.find((point) => point.contractType === "NEXT_QUARTER") ?? null;
  const totalPerpOiUsd = perps.reduce((sum, point) => sum + (point.openInterestUsd ?? 0), 0);
  const oiChange24h = aggregatePerpOiChange(history, 24);
  const priceChange24h = primaryPerp?.change24hPct ?? null;
  const regime = futuresRegime(priceChange24h, oiChange24h);
  const okxLiquidationTotal =
    (stats?.longLiquidations24hUsd ?? 0) + (stats?.shortLiquidations24hUsd ?? 0);
  const binanceLiquidationTotal =
    (binanceStats?.longLiquidations24hUsd ?? 0) + (binanceStats?.shortLiquidations24hUsd ?? 0);
  const longLiquidations =
    (stats?.longLiquidations24hUsd ?? 0) + (binanceStats?.longLiquidations24hUsd ?? 0);
  const shortLiquidations =
    (stats?.shortLiquidations24hUsd ?? 0) + (binanceStats?.shortLiquidations24hUsd ?? 0);
  const liquidationTotal = longLiquidations + shortLiquidations;
  const longLiquidationShare = liquidationTotal > 0 ? (longLiquidations / liquidationTotal) * 100 : 50;
  const heroTakerBuy = (stats?.takerBuyVolume24h ?? 0) + (binanceStats?.takerBuyVolume24h ?? 0);
  const heroTakerSell = (stats?.takerSellVolume24h ?? 0) + (binanceStats?.takerSellVolume24h ?? 0);
  const heroTakerTotal = heroTakerBuy + heroTakerSell;
  const heroTakerImbalance = heroTakerTotal > 0 ? (heroTakerBuy - heroTakerSell) / heroTakerTotal : null;
  const datedBasis = dated
    .map((point) => point.annualizedBasis)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const maxAbsBasis = Math.max(0.05, ...datedBasis.map((value) => Math.abs(value)));
  const steepness =
    currentQuarter?.annualizedBasis !== null && currentQuarter?.annualizedBasis !== undefined &&
    nextQuarter?.annualizedBasis !== null && nextQuarter?.annualizedBasis !== undefined
      ? nextQuarter.annualizedBasis - currentQuarter.annualizedBasis
      : null;
  const chartSymbol = perps
    .map((point) => ({ point, count: history.filter((row) => row.symbol === point.symbol).length }))
    .sort((a, b) => b.count - a.count)[0]?.point.symbol ?? primaryPerp?.symbol ?? "BTC-USD-SWAP";
  const status = snapshot?.status ?? "warming";

  return (
    <section className="futures-workspace futures-terminal">
      <section className="panel futures-command">
        <div className="futures-hero">
          <div className="futures-hero-copy">
            <div className="futures-kicker">
              <span>{primaryPerp?.exchange === "Binance" ? "BINANCE PRIMARY · OKX TERM & COMPARE" : "OKX FALLBACK · BTC DERIVATIVES"}</span>
              <em className={status}>{status.toUpperCase()} · {snapshotAge(snapshot?.ageMs)}</em>
            </div>
            <h2>杠杆、拥挤度与 Carry</h2>
            <div className="futures-price-line">
              <strong>{money(primaryPerp?.lastPx ?? snapshot?.indexPx)}</strong>
              <span className={basisTone(priceChange24h)}>{signedPct(priceChange24h)} · 24H</span>
            </div>
            <p>
              24h 区间 {money(primaryPerp?.low24h)} — {money(primaryPerp?.high24h)}
              <b> Mark / Index {money(primaryPerp?.markPx)} / {money(primaryPerp?.indexPx)}</b>
            </p>
          </div>

          <div className="futures-kpi-rail">
            <article className="futures-kpi">
              <span>预测 Funding</span>
              <strong className={basisTone(fundingPerp?.fundingRate)}>{signedPct(fundingPerp?.fundingRate, 4)}</strong>
              <em>{fundingCountdown(fundingPerp?.nextFundingTime)} 后结算 · 年化 {signedPct(fundingPerp?.annualizedFunding)}</em>
            </article>
            <article className="futures-kpi">
              <span>永续 OI</span>
              <strong>{money(totalPerpOiUsd || null, true)}</strong>
              <em className={basisTone(oiChange24h)}>24h {signedPct(oiChange24h)} · OKX + Binance 永续</em>
            </article>
            <article className="futures-kpi">
              <span>主动成交差</span>
              <strong className={basisTone(heroTakerImbalance)}>{signedPct(heroTakerImbalance)}</strong>
              <em>买 {money(heroTakerBuy || null, true)} / 卖 {money(heroTakerSell || null, true)} · 双所</em>
            </article>
            <article className="futures-kpi">
              <span>已报告爆仓</span>
              <strong>{money(liquidationTotal || null, true)}</strong>
              <em>多 {money(longLiquidations || null, true)} / 空 {money(shortLiquidations || null, true)} · 双所</em>
            </article>
          </div>
        </div>

        <div className={`market-regime ${regime.tone}`}>
          <span><Zap size={16} /> 当前状态</span>
          <strong>{regime.label}</strong>
          <p>{regime.note}</p>
        </div>
      </section>

      <section className="futures-primary-grid">
        <section className="panel futures-pulse-panel">
          <div className="panel-title spread">
            <span><Activity size={17} /> 价格 × OI</span>
            <em>{chartSymbol} · SQLite</em>
          </div>
          <FuturesPulseChart history={history.filter((point) => point.symbol === chartSymbol)} />
          <div className="chart-reading">
            <span><i className="price-dot" /> BTC Index</span>
            <span><i className="oi-dot" /> Open Interest</span>
            <p>OI 只表示未平仓杠杆规模，本身不区分多空方向。</p>
          </div>
        </section>

        <section className="panel positioning-panel">
          <div className="panel-title spread">
            <span><Scale size={17} /> 拥挤与压力</span>
            <em>24H WINDOW</em>
          </div>

          <div className="exchange-compare">
            <div className="compare-row compare-head">
              <span>指标 · 24H</span><span>OKX</span><span>Binance</span>
            </div>
            <div className="compare-row">
              <span>主动成交差</span>
              <strong className={basisTone(stats?.takerImbalance24h)}>{signedPct(stats?.takerImbalance24h)}</strong>
              <strong className={basisTone(binanceStats?.takerImbalance24h)}>{signedPct(binanceStats?.takerImbalance24h)}</strong>
            </div>
            <div className="compare-row">
              <span>多空账户比 L/S</span>
              <strong>{fmt(stats?.longShortAccountRatio, 2)}</strong>
              <strong>{fmt(binanceStats?.longShortAccountRatio, 2)}</strong>
            </div>
            <div className="compare-row">
              <span>大户持仓比 L/S</span>
              <strong>{fmt(stats?.topTraderLongShortRatio, 2)}</strong>
              <strong>{fmt(binanceStats?.topTraderLongShortRatio, 2)}</strong>
            </div>
            <div className="compare-row">
              <span>大户账户比 L/S</span>
              <strong>{fmt(stats?.topTraderAccountRatio, 2)}</strong>
              <strong>{fmt(binanceStats?.topTraderAccountRatio, 2)}</strong>
            </div>
            <div className="compare-row">
              <span>24h OI 变化</span>
              <strong>--</strong>
              <strong className={basisTone(binanceStats?.openInterestChange24h)}>{signedPct(binanceStats?.openInterestChange24h)}</strong>
            </div>
            <div className="compare-row">
              <span>OI / 流通市值</span>
              <strong>--</strong>
              <strong>{signedPct(binanceStats?.openInterestToMarketCap)}</strong>
            </div>
            <div className="compare-row">
              <span>24h 已报告爆仓</span>
              <strong>{money(okxLiquidationTotal || null, true)}</strong>
              <strong>{money(binanceLiquidationTotal || null, true)}</strong>
            </div>
            <div className="compare-row">
              <span>上期已结 Funding</span>
              <strong className={basisTone(stats?.lastRealizedFundingRate)}>{signedPct(stats?.lastRealizedFundingRate, 4)}</strong>
              <strong className={basisTone(binanceStats?.lastRealizedFundingRate)}>{signedPct(binanceStats?.lastRealizedFundingRate, 4)}</strong>
            </div>
            <div className="compare-row">
              <span>24h 累计 Funding</span>
              <strong className={basisTone(stats?.fundingSum24h)}>{signedPct(stats?.fundingSum24h, 4)}</strong>
              <strong className={basisTone(binanceStats?.fundingSum24h)}>{signedPct(binanceStats?.fundingSum24h, 4)}</strong>
            </div>
            <div className="compare-row">
              <span>7d 单期平均</span>
              <strong className={basisTone(stats?.fundingAverage7d)}>{signedPct(stats?.fundingAverage7d, 4)}</strong>
              <strong className={basisTone(binanceStats?.fundingAverage7d)}>{signedPct(binanceStats?.fundingAverage7d, 4)}</strong>
            </div>
          </div>

          <div className="exchange-risk-row">
            <span>Binance ADL 风险 <strong className={`risk-${binanceStats?.adlRisk?.toLowerCase() ?? "unknown"}`}>{binanceStats?.adlRisk ?? "--"}</strong></span>
            <span>稳定币保险基金 <strong>{money(binanceStats?.insuranceFundUsd, true)}</strong></span>
          </div>

          <div className="pressure-block">
            <div><span>多头爆仓</span><strong>{money(liquidationTotal || null, true)}</strong><span>空头爆仓</span></div>
            <div className="split-track"><i className="liquidations" style={{ width: `${longLiquidationShare}%` }} /></div>
          </div>

          <p className="data-caveat">
            账户多空比按账户数量计算，大户持仓比按 Top Trader 持仓量计算，均不代表全市场资金金额；OKX 爆仓来自公共已报告成交，Binance 爆仓由本站强平流自采集（自部署时刻起累积）；Binance 主动成交量按当前标记价折算为美元。
          </p>
        </section>
      </section>

      <section className="panel term-structure-panel">
        <div className="panel-title spread">
          <span><LineChart size={17} /> 交割合约期限结构</span>
          <em>OKX · {dated.length} TENORS · 斜率 {signedPct(steepness)} · {steepness !== null && steepness >= 0 ? "STEEPENING" : "FLATTENING"}</em>
        </div>
        {dated.length === 0 ? (
          <div className="empty-state">等待 OKX 交割合约数据</div>
        ) : (
          <div className="term-curve">
            {dated.map((point) => {
              const value = point.annualizedBasis;
              const width = value === null ? 0 : Math.min((Math.abs(value) / maxAbsBasis) * 50, 50);
              const style = value !== null && value < 0
                ? { right: "50%", width: `${width}%` }
                : { left: "50%", width: `${width}%` };
              return (
                <div className="term-row" key={point.symbol}>
                  <div><strong>{point.label}</strong><span>{point.dte?.toFixed(0) ?? "--"} 天到期</span></div>
                  <div className="basis-bar"><b /><i className={basisTone(value)} style={style} /></div>
                  <strong className={basisTone(value)}>{signedPct(value)}</strong>
                  <em>原始 {signedPct(point.basisPct)}</em>
                </div>
              );
            })}
          </div>
        )}
        <div className="carry-note">
          <span>Contango 正基差</span>
          <p>年化基差是毛 Carry，不等于无风险收益；手续费、滑点、借币与保证金占用尚未扣除。</p>
          <span>Backwardation 负基差</span>
        </div>
      </section>

      <section className="panel table-panel futures-table-panel">
        <div className="panel-title spread">
          <span><Radio size={17} /> 全合约监控</span>
          <em>{curve.length} CONTRACTS · LIVE QUOTES</em>
        </div>
        <div className="futures-table">
          <div className="futures-head">
            <span>合约</span><span>Mark</span><span>24h</span><span>Premium / Basis</span>
            <span>年化 Carry</span><span>OI</span><span>24h 成交额</span><span>Spread</span><span>到期</span>
          </div>
          {curve.length === 0 ? (
            <div className="empty-state">正在连接交易所实时行情</div>
          ) : curve.map((point) => (
            <div className="futures-row" key={`${point.exchange}-${point.symbol}`}>
              <span data-label="合约"><strong>{tenorLabel(point)}</strong><em>{point.exchange} · {point.symbol}</em></span>
              <span data-label="Mark">{money(point.markPx)}</span>
              <span data-label="24h" className={basisTone(point.change24hPct)}>{signedPct(point.change24hPct)}</span>
              <span data-label="Premium / Basis" className={basisTone(point.basisPct)}>{signedPct(point.basisPct)}</span>
              <span data-label="年化 Carry" className={basisTone(basisMetric(point))}>
                {point.contractType === "PERPETUAL" ? signedPct(point.annualizedFunding) : signedPct(point.annualizedBasis)}
              </span>
              <span data-label="OI">{money(point.openInterestUsd, true)}<em>{compact.format(point.openInterest ?? 0)} BTC</em></span>
              <span data-label="24h 成交额">{money(point.quoteVolume24h, true)}</span>
              <span data-label="Spread">{point.spreadBps === null ? "--" : `${fmt(point.spreadBps, 2)} bp`}</span>
              <span data-label="到期">{point.dte === null ? fundingCountdown(point.nextFundingTime) : `${point.dte.toFixed(0)}D`}</span>
            </div>
          ))}
        </div>
        <div className="db-line" title={snapshot?.dbPath ?? ""}>
          <Database size={15} /><span>本地历史样本</span><strong>{history.length} pts · {formatDateTime(stats?.updatedAt)}</strong>
        </div>
      </section>

      {snapshot?.error ? <div className="error-toast">{snapshot.error}</div> : null}
    </section>
  );
}

function FuturesPulseChart({ history }: { history: FuturesBasisHistoryPoint[] }) {
  const [hours, setHours] = useState<1 | 4 | 24>(24);
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const points = history
    .filter((point) => point.ts >= cutoff && point.indexPx !== null && point.openInterest !== null)
    .sort((a, b) => a.ts - b.ts);
  const sampled = points.filter((_, index) => index % Math.max(Math.ceil(points.length / 180), 1) === 0);

  if (sampled.length < 2) {
    return (
      <div className="pulse-empty">
        <LineChart size={24} /><strong>正在积累价格与 OI 历史</strong><span>首批样本约 30 秒后出现</span>
      </div>
    );
  }

  const width = 900;
  const height = 250;
  const padX = 16;
  const padY = 18;
  const prices = sampled.map((point) => point.indexPx as number);
  const oi = sampled.map((point) => point.openInterest as number);
  const priceMin = Math.min(...prices);
  const priceRange = Math.max(Math.max(...prices) - priceMin, 1);
  const oiMin = Math.min(...oi);
  const oiRange = Math.max(Math.max(...oi) - oiMin, 1);
  const x = (index: number) => padX + index * ((width - padX * 2) / (sampled.length - 1));
  const y = (value: number, min: number, range: number) => height - padY - ((value - min) / range) * (height - padY * 2);
  const pricePath = sampled.map((point, index) => `${x(index)},${y(point.indexPx as number, priceMin, priceRange)}`).join(" ");
  const oiPath = sampled.map((point, index) => `${x(index)},${y(point.openInterest as number, oiMin, oiRange)}`).join(" ");

  return (
    <div className="pulse-chart">
      <div className="horizon-tabs" aria-label="图表时间范围">
        {([1, 4, 24] as const).map((value) => (
          <button className={hours === value ? "active" : ""} key={value} onClick={() => setHours(value)}>{value}H</button>
        ))}
      </div>
      <svg role="img" aria-label={`${hours} 小时 BTC 价格与未平仓量走势`} viewBox={`0 0 ${width} ${height}`}>
        {[0.25, 0.5, 0.75].map((ratio) => <line key={ratio} x1="0" x2={width} y1={height * ratio} y2={height * ratio} />)}
        <polyline className="oi-line" points={oiPath} />
        <polyline className="price-line" points={pricePath} />
      </svg>
      <div className="pulse-axis"><span>{new Date(sampled[0].ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span>{new Date(sampled[sampled.length - 1].ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
    </div>
  );
}

function PayoffPreview({ option, indexPx }: { option: OptionContract; indexPx: number | null }) {
  if (indexPx === null || option.bidPx === null) {
    return <div className="payoff-empty">缺少可成交 Bid</div>;
  }

  const width = 300;
  const height = 96;
  const paddingX = 8;
  const paddingY = 10;
  const settlements = [0.8, 0.9, 1, 1.1, 1.2].map((ratio) => indexPx * ratio);
  const premiumBtc = option.bidPx * option.ctMult;
  const values = settlements.map((settlement) => {
    const liabilityBtc =
      option.side === "P"
        ? Math.max(option.strike / settlement - 1, 0) * option.ctMult
        : Math.max(1 - option.strike / settlement, 0) * option.ctMult;
    const optionPnlUsd = (premiumBtc - liabilityBtc) * settlement;
    return option.side === "C"
      ? optionPnlUsd + (settlement - indexPx) * option.ctMult
      : optionPnlUsd;
  });
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 1);
  const x = (index: number) => paddingX + index * ((width - paddingX * 2) / (values.length - 1));
  const y = (value: number) => height / 2 - (value / maxAbs) * (height / 2 - paddingY);
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");

  return (
    <div className="payoff-preview">
      <svg
        role="img"
        aria-label={`到期情景盈亏，最低 ${premiumMoney(Math.min(...values))}，最高 ${premiumMoney(Math.max(...values))}`}
        viewBox={`0 0 ${width} ${height}`}
      >
        <line x1={paddingX} x2={width - paddingX} y1={height / 2} y2={height / 2} />
        <polyline points={points} />
        {values.map((value, index) => (
          <circle key={settlements[index]} cx={x(index)} cy={y(value)} r="3" />
        ))}
      </svg>
      <div className="payoff-axis">
        <span>-20%</span>
        <span>BTC {money(indexPx)}</span>
        <span>+20%</span>
      </div>
      <div className="payoff-range">
        <span className="down">低 {premiumMoney(Math.min(...values))}</span>
        <span className="up">高 {premiumMoney(Math.max(...values))}</span>
      </div>
    </div>
  );
}

function Metric({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? "metric strong" : "metric"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number | null }) {
  const width = Math.min(Math.max((value ?? 0) * 100, 0), 100);

  return (
    <div className="bar-line">
      <span>{label}</span>
      <div>
        <i style={{ width: `${width}%` }} />
      </div>
      <strong>{pct(value)}</strong>
    </div>
  );
}
