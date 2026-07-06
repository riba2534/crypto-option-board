import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const standaloneDir = join(root, ".next", "standalone");
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

const child = spawn(process.execPath, [serverEntry], {
  cwd: standaloneDir,
  stdio: "inherit",
  env: {
    ...process.env,
    HOSTNAME: hostname,
    PORT: process.env.PORT ?? "3000"
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
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
