"use client";

import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Clock3,
  Filter,
  Minus,
  Moon,
  RefreshCw,
  ShieldAlert,
  Sun,
  Target,
  TrendingUp
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { OptionContract, OptionSnapshot, RiskFlag } from "@/lib/types";

type SideFilter = "P" | "C" | "ALL";
type MetricMode = "apr" | "iv" | "delta" | "oi";
type ThemeMode = "light" | "dark";

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

function nearestExpiry(snapshot: OptionSnapshot) {
  return snapshot.expiries.find((expiry) => expiry.dte >= 2)?.expiry ?? snapshot.expiries[0]?.expiry ?? "ALL";
}

export function Dashboard({ initialSnapshot }: DashboardProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [side, setSide] = useState<SideFilter>("P");
  const [metric, setMetric] = useState<MetricMode>("apr");
  const [expiry, setExpiry] = useState(() => nearestExpiry(initialSnapshot));
  const [minApr, setMinApr] = useState(0);
  const [maxSpread, setMaxSpread] = useState(25);
  const [hideIlliquid, setHideIlliquid] = useState(true);
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
    return snapshot.options
      .filter((option) => side === "ALL" || option.side === side)
      .filter((option) => expiry === "ALL" || option.expiry === expiry)
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
  }, [expiry, hideIlliquid, maxSpread, minApr, side, snapshot.options]);

  const candidates = useMemo(() => {
    return [...filteredOptions].sort((a, b) => b.score - a.score).slice(0, 18);
  }, [filteredOptions]);

  useEffect(() => {
    if (selectedId && filteredOptions.some((option) => option.instId === selectedId)) {
      return;
    }

    setSelectedId(candidates[0]?.instId ?? filteredOptions[0]?.instId ?? null);
  }, [candidates, filteredOptions, selectedId]);

  const selected = useMemo(() => {
    return filteredOptions.find((option) => option.instId === selectedId) ?? null;
  }, [filteredOptions, selectedId]);

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

      <section className="workspace">
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
                <em>Put {pct(item.avgPutApr)}</em>
                <em>Call {pct(item.avgCallApr)}</em>
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
              <em>{candidates.length} / {filteredOptions.length}</em>
            </div>
            <div className="contracts-table">
              <div className="table-head">
                <span>合约</span>
                <span>APR</span>
                <span>Bid / Ask</span>
                <span>Delta</span>
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
                  <span>{pct(optionApr(option))}</span>
                  <span>
                    {fmt(option.bidPx, 4)} / {fmt(option.askPx, 4)}
                  </span>
                  <span>{fmt(option.delta, 2)}</span>
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
                <Metric label="可卖 APR" value={pct(optionApr(selected))} strong />
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
                  <Metric label="Delta" value={fmt(selected.delta, 3)} />
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
                报价时间 {selected.updatedAt ? new Date(selected.updatedAt).toLocaleTimeString() : "--"}
              </div>
            </>
          ) : (
            <div className="empty-state">等待 OKX 数据</div>
          )}
        </aside>
      </section>

      {snapshot.error ? <div className="error-toast">{snapshot.error}</div> : null}
    </main>
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
