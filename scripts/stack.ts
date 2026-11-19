/**
 * Starts / stops the Node services of the local stack (logs in .run/<name>.log, pids in .run/<name>.pid).
 *   pnpm stack:up [name...]     default: log-server collector grades-demo dashboard
 *   pnpm stack:down [name...]
 *   pnpm stack:status
 * The chain + DCAP.Web run in Docker (pnpm infra:up); Supabase is the cloud project.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUN = join(process.cwd(), ".run");
mkdirSync(RUN, { recursive: true });

const SERVICES: Record<string, { cmd: string; args: string[]; port?: number; after?: string }> = {
  "log-server": { cmd: "pnpm", args: ["--filter", "@vula/log-server", "start"], port: 4000 },
  collector: { cmd: "pnpm", args: ["--filter", "@vula/collector", "start"], after: "log-server" },
  "grades-demo": { cmd: "pnpm", args: ["--filter", "@vula/grades-demo", "start"], port: 3001 },
  dashboard: { cmd: "pnpm", args: ["--filter", "@vula/dashboard", "start"], port: 3000 },
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// <name>.stack.pid = the launcher's process tree (the collector writes its own collector.pid for attack 8).
const pidFile = (name: string) => join(RUN, `${name}.stack.pid`);
const pidOf = (name: string) => {
  const f = pidFile(name);
  return existsSync(f) ? Number(readFileSync(f, "utf8")) : null;
};

function stop(name: string): void {
  const pid = pidOf(name);
  if (pid && alive(pid)) {
    try {
      if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      else process.kill(-pid, "SIGTERM");
    } catch {
      /* gone */
    }
    console.log(`stopped ${name} (${pid})`);
  }
  rmSync(pidFile(name), { force: true });
}

async function waitPort(port: number, ms = 60_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

async function start(name: string): Promise<void> {
  const s = SERVICES[name];
  if (!s) throw new Error(`unknown service ${name}`);
  const pid = pidOf(name);
  if (pid && alive(pid)) return console.log(`${name} already running (${pid})`);
  if (s.after && SERVICES[s.after]?.port) await waitPort(SERVICES[s.after]!.port!);
  const log = join(RUN, `${name}.log`);
  // Detached children lose redirected stdio on Windows, so services append their own console output to
  // VULA_LOG_FILE (see @vula/db loadEnv).
  writeFileSync(log, "");
  const env = { ...process.env, VULA_LOG_FILE: log };
  const child = process.platform === "win32"
    ? spawn([s.cmd, ...s.args].join(" "), { detached: true, stdio: "ignore", shell: true, windowsHide: true, env })
    : spawn(s.cmd, s.args, { detached: true, stdio: "ignore", env });
  child.unref();
  writeFileSync(pidFile(name), String(child.pid));
  console.log(`started ${name} (${child.pid}) -> .run/${name}.log`);
  if (s.port) console.log((await waitPort(s.port)) ? `  ${name} listening on :${s.port}` : `  ${name} not up yet, see .run/${name}.log`);
}

const [cmd = "status", ...names] = process.argv.slice(2);
const list = names.length ? names : Object.keys(SERVICES);
if (cmd === "up") for (const n of list) await start(n);
else if (cmd === "down") for (const n of [...list].reverse()) stop(n);
else for (const n of Object.keys(SERVICES)) console.log(`${n.padEnd(12)} ${pidOf(n) && alive(pidOf(n)!) ? `running (${pidOf(n)})` : "stopped"}`);
