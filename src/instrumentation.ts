export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  const { startFuturesBasisCollector } = await import("@/lib/server/futures-basis-cache");
  startFuturesBasisCollector();
}
