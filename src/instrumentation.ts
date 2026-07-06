export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  const { startBinanceBasisCollector } = await import("@/lib/server/binance-basis-cache");
  startBinanceBasisCollector();
}
