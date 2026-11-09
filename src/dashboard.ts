/**
 * Local web dashboard: watch offload jobs live in a browser.
 *
 *   offload-mcp-server dashboard [--port N] [--no-open]
 *
 * It reads the jobs folder that every offload server writes to, so it shows jobs from all sessions,
 * finished ones included, and keeps working while servers come and go. It listens on 127.0.0.1 only.
 * Every request needs a random token (given once in the URL, then kept in a SameSite=Strict cookie)
 * and a 127.0.0.1/localhost Host header; the one write action, cancel, also needs a same-origin Origin
 * header and a custom header that cross-site pages cannot send without a CORS preflight.
 */
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { CANCEL_FILE, isFinal, type JobRecord, pidAlive, TIMELINE_FILE } from "./jobs.js";

/** Written into the jobs folder while a dashboard runs, so servers and later `dashboard` calls can find it. */
export const INFO_FILE = ".dashboard.json";
const JOB_ID = /^\d{14}-[0-9a-f]{6}$/;
const MAX_TIMELINE = 2_000;

export interface DashboardInfo {
  url: string;
  port: number;
  pid: number;
  startedAt: string;
}

export interface DashboardOptions {
  jobsDir: string;
  /** 0 picks a free port. A busy port is followed by the next nine. */
  port: number;
  /** Folder that holds dashboard/index.html, app.js and app.css. */
  packageRoot: string;
  version: string;
  /** Fixed token, for tests. */
  token?: string;
  /** Exit after this many minutes with no requests and no active jobs (auto-started dashboards). */
  idleExitMin?: number;
}

export interface Dashboard {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

/** The dashboard already serving this jobs folder, if any. */
export function runningDashboard(jobsDir: string): DashboardInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(path.join(jobsDir, INFO_FILE), "utf8")) as DashboardInfo;
    return pidAlive(info.pid) ? info : undefined;
  } catch {
    return undefined;
  }
}

/** A job as the dashboard shows it: the record plus whether its server is gone. */
type JobView = JobRecord & { stale?: boolean };

function view(job: JobRecord): JobView {
  if (!isFinal(job.status) && job.serverPid !== undefined && job.serverPid !== process.pid && !pidAlive(job.serverPid)) {
    return { ...job, stale: true };
  }
  return job;
}

class JobReader {
  private readonly cache = new Map<string, { mtime: number; job: JobRecord }>();

  constructor(private readonly jobsDir: string) {}

  list(limit: number): JobView[] {
    let ids: string[];
    try {
      ids = readdirSync(this.jobsDir).filter(name => JOB_ID.test(name)).sort().reverse().slice(0, limit);
    } catch {
      return [];
    }
    return ids.map(id => this.get(id)).filter((job): job is JobView => job !== undefined);
  }

  get(id: string): JobView | undefined {
    if (!JOB_ID.test(id)) return undefined;
    const file = path.join(this.jobsDir, id, "job.json");
    try {
      const mtime = statSync(file).mtimeMs;
      const cached = this.cache.get(id);
      if (cached && cached.mtime === mtime) return view(cached.job);
      const job = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as JobRecord;
      this.cache.set(id, { mtime, job });
      return view(job);
    } catch {
      return undefined; // Missing, or caught mid-write: the next poll gets it.
    }
  }

  file(id: string, name: string, maxChars?: number): string | undefined {
    const file = path.join(this.jobsDir, id, name);
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, "utf8").replace(/^﻿/, "");
    return maxChars !== undefined && text.length > maxChars ? text.slice(-maxChars) : text;
  }

  timeline(id: string): { entries: unknown[]; total: number } {
    const text = this.file(id, TIMELINE_FILE) ?? "";
    const lines = text.split("\n").filter(Boolean);
    const entries: unknown[] = [];
    for (const line of lines.slice(-MAX_TIMELINE)) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A line still being written.
      }
    }
    return { entries, total: lines.length };
  }

  followups(id: string): string[] {
    return this.list(500).filter(job => job.parentId === id).map(job => job.id).reverse();
  }
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

const STATIC: Record<string, [string, string]> = {
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/i18n.js": ["i18n.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"]
};

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2f6feb"/><path d="M9 11h14M9 16h10M9 21h6" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle cx="23" cy="21" r="3" fill="#7ee2a8"/></svg>`;

export async function startDashboard(options: DashboardOptions): Promise<Dashboard> {
  const token = options.token ?? randomBytes(18).toString("base64url");
  const jobs = new JobReader(options.jobsDir);
  const assets = path.join(options.packageRoot, "dashboard");
  let port = 0;
  let lastRequest = Date.now();
  const cookieName = () => `offload_dash_${port}`;

  const sameToken = (value: string | undefined) => {
    if (!value) return false;
    const a = Buffer.from(value);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const cookie = (req: http.IncomingMessage) => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === cookieName()) return rest.join("=");
    }
    return undefined;
  };

  const send = (res: http.ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...extra });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, value: unknown) => send(res, status, JSON.stringify(value), "application/json; charset=utf-8");

  const handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    lastRequest = Date.now();
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      send(res, 403, "Forbidden host", "text/plain; charset=utf-8");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const route = url.pathname;

    if (req.method === "GET" && STATIC[route]) {
      const [file, type] = STATIC[route]!;
      send(res, 200, readFileSync(path.join(assets, file)), type);
      return;
    }
    if (req.method === "GET" && route === "/favicon.svg") {
      send(res, 200, ICON, "image/svg+xml");
      return;
    }
    if (req.method === "GET" && route === "/") {
      if (sameToken(url.searchParams.get("t") ?? undefined)) {
        // Swap the token in the URL for a cookie, so it does not stay in the address bar or history.
        send(res, 302, "", "text/plain", {
          Location: "/",
          "Set-Cookie": `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`
        });
        return;
      }
      if (!sameToken(cookie(req))) {
        send(res, 401, "<!doctype html><meta charset=utf-8><title>offload dashboard</title><p>Open the link printed by <code>offload-mcp-server dashboard</code> (it carries a one-time token).</p>", "text/html; charset=utf-8");
        return;
      }
      send(res, 200, readFileSync(path.join(assets, "index.html")), "text/html; charset=utf-8");
      return;
    }

    if (!route.startsWith("/api/")) {
      send(res, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    if (!sameToken(cookie(req))) {
      json(res, 401, { error: "Missing or wrong token. Reopen the link printed by offload-mcp-server dashboard." });
      return;
    }

    if (req.method === "GET" && route === "/api/jobs") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 1_000);
      json(res, 200, { version: options.version, jobsDir: options.jobsDir, now: new Date().toISOString(), jobs: jobs.list(limit) });
      return;
    }

    const match = /^\/api\/jobs\/([^/]+)(\/cancel)?$/.exec(route);
    const job = match ? jobs.get(match[1]!) : undefined;
    if (!match || !job) {
      json(res, 404, { error: "No such job." });
      return;
    }

    if (req.method === "GET" && !match[2]) {
      let scope: string[] = [];
      try {
        scope = JSON.parse(jobs.file(job.id, "scope.json") ?? "[]") as string[];
      } catch {
        // Older jobs have no scope file.
      }
      json(res, 200, {
        now: new Date().toISOString(),
        job,
        prompt: jobs.file(job.id, "prompt.md") ?? "",
        report: jobs.file(job.id, "report.md"),
        stderr: jobs.file(job.id, "stderr.log", 6_000) ?? "",
        scope,
        timeline: jobs.timeline(job.id),
        followups: jobs.followups(job.id)
      });
      return;
    }

    if (req.method === "POST" && match[2]) {
      if (req.headers.origin !== `http://${host}` || req.headers["x-offload"] !== "1") {
        json(res, 403, { error: "Cross-site request refused." });
        return;
      }
      if (isFinal(job.status)) {
        json(res, 409, { error: `Job is already ${job.status}.` });
        return;
      }
      if (job.stale) {
        json(res, 409, { error: "The server that ran this job has exited, so nothing is running." });
        return;
      }
      writeFileSync(path.join(options.jobsDir, job.id, CANCEL_FILE), new Date().toISOString(), "utf8");
      json(res, 202, { ok: true, message: "Cancel requested; the server stops the worker within a few seconds." });
      return;
    }

    json(res, 405, { error: "Method not allowed." });
  };

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: (error as Error).message });
      else res.end();
    }
  });

  const listen = (p: number) => new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(p, "127.0.0.1");
  });

  const candidates = options.port === 0 ? [0] : [...Array.from({ length: 10 }, (_, i) => options.port + i), 0];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      port = await listen(candidate);
      break;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  if (!port) throw lastError instanceof Error ? lastError : new Error("No free port for the dashboard.");

  let idleTimer: NodeJS.Timeout | undefined;
  if (options.idleExitMin) {
    const idleMs = options.idleExitMin * 60_000;
    idleTimer = setInterval(() => {
      const busy = jobs.list(50).some(job => !isFinal(job.status) && !job.stale);
      if (!busy && Date.now() - lastRequest > idleMs) void close().then(() => process.exit(0));
    }, 30_000);
  }

  const close = () => new Promise<void>(resolve => {
    if (idleTimer) clearInterval(idleTimer);
    server.closeAllConnections();
    server.close(() => resolve());
  });

  return { url: `http://127.0.0.1:${port}/?t=${token}`, port, token, close };
}

/** Opens a URL in the default browser; failures are ignored (the URL is printed too). */
export function openBrowser(url: string): void {
  const [command, args] = process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser available (SSH, container): the printed URL still works with a port forward.
  }
}

export const DASHBOARD_USAGE = `Usage: offload-mcp-server dashboard [options]

Serves a local web page that shows offload jobs live: status, progress, the files the worker
opens, coverage, the brief and the report. Listens on 127.0.0.1 only; stop it with Ctrl+C.

Options:
  --port <n>        Port to listen on (default from the config, 7431; 0 = any free port)
  --no-open         Print the URL without opening a browser
  --idle-exit <min> Exit after <min> minutes with no page requests and no running jobs
  -h, --help        Show this help`;

interface DashboardArgs {
  port?: number;
  open: boolean;
  idleExitMin?: number;
}

export function parseDashboardArgs(args: string[]): DashboardArgs | "help" {
  const result: DashboardArgs = { open: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${arg} needs a whole number.`);
      return value;
    };
    if (arg === "-h" || arg === "--help") return "help";
    else if (arg === "--no-open") result.open = false;
    else if (arg === "--port") result.port = next();
    else if (arg === "--idle-exit") result.idleExitMin = next();
    else throw new Error(`Unknown option "${arg}".\n\n${DASHBOARD_USAGE}`);
  }
  return result;
}

/** CLI entry: reuses a running dashboard for the same jobs folder, or starts one and keeps running. */
export async function runDashboard(args: DashboardArgs, config: Config, packageRoot: string, version: string): Promise<void> {
  const existing = runningDashboard(config.jobsDir);
  if (existing) {
    console.log(`Dashboard already running: ${existing.url}`);
    if (args.open) openBrowser(existing.url);
    return;
  }
  // The jobs folder only exists once a server has run; on a fresh install the dashboard may come first.
  mkdirSync(config.jobsDir, { recursive: true });
  const dashboard = await startDashboard({
    jobsDir: config.jobsDir, port: args.port ?? config.dashboard.port, packageRoot, version, idleExitMin: args.idleExitMin
  });
  const infoFile = path.join(config.jobsDir, INFO_FILE);
  const info: DashboardInfo = { url: dashboard.url, port: dashboard.port, pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(infoFile, JSON.stringify(info, null, 2), "utf8");
  const cleanup = () => {
    try {
      const current = JSON.parse(readFileSync(infoFile, "utf8")) as DashboardInfo;
      if (current.pid === process.pid) unlinkSync(infoFile);
    } catch {
      // Already gone.
    }
  };
  process.once("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      cleanup();
      process.exit(0);
    });
  }
  console.log(`offload dashboard ${version}\nJobs:      ${config.jobsDir}\nDashboard: ${dashboard.url}\nPress Ctrl+C to stop.`);
  if (args.open) openBrowser(dashboard.url);
}

/**
 * Starts a dashboard in the background for a server whose config has dashboard.autoOpen, once per
 * server process. Returns the URL of the dashboard that is (or will shortly be) running.
 */
let launched = false;
export function ensureDashboard(config: Config): string | undefined {
  const running = runningDashboard(config.jobsDir);
  if (running) return running.url;
  if (!config.dashboard.autoOpen || launched) return undefined;
  launched = true;
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  try {
    const child = spawn(process.execPath, [entry, "dashboard", "--idle-exit", "30"], {
      stdio: "ignore", detached: true, windowsHide: true
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The jobs still run; the dashboard is a convenience.
  }
  return undefined;
}
