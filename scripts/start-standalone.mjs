import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const localStandaloneDir = join(root, ".next", "standalone");
const standaloneDir = existsSync(join(localStandaloneDir, "server.js")) ? localStandaloneDir : root;
const serverEntry = join(standaloneDir, "server.js");
const staticTarget = join(standaloneDir, ".next", "static");
const publicTarget = join(standaloneDir, "public");

if (!existsSync(serverEntry)) {
  console.error("Missing .next/standalone/server.js. Run `npm run build` first.");
  process.exit(1);
}

if (!existsSync(staticTarget) || !existsSync(publicTarget)) {
  console.error("Missing standalone assets. Run `npm run build` before `npm run start`.");
  process.exit(1);
}

const hostname = process.env.BIND_HOST ?? process.env.APP_HOST ?? "0.0.0.0";
const port = process.env.PORT ?? "3000";

const child = spawn(process.execPath, [serverEntry], {
  cwd: standaloneDir,
  stdio: "inherit",
  env: {
    ...process.env,
    HOSTNAME: hostname,
    PORT: port
  }
});

let marketPoller = null;

async function warmMarketCollector() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    await fetch(`http://127.0.0.1:${port}/api/futures/basis`, {
      cache: "no-store",
      signal: controller.signal
    });
  } catch {
    // The next tick will retry. The web server may still be binding its port.
  } finally {
    clearTimeout(timeout);
  }
}

if (process.env.MARKET_COLLECTOR_ENABLED !== "false") {
  const refreshMs = Number(process.env.BINANCE_BASIS_REFRESH_MS ?? 30_000);
  const safeRefreshMs = Number.isFinite(refreshMs) && refreshMs >= 10_000 ? refreshMs : 30_000;

  setTimeout(() => {
    void warmMarketCollector();
    marketPoller = setInterval(() => {
      void warmMarketCollector();
    }, safeRefreshMs);
    marketPoller.unref?.();
  }, 1_500).unref?.();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (marketPoller) {
      clearInterval(marketPoller);
    }
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
