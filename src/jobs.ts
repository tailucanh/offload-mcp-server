import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import crossSpawn from "cross-spawn";
import type { Config } from "./config.js";
import { findOnPath, needsStdinOnWindows } from "./doctor.js";
import { buildManifest } from "./manifest.js";
import { type Brief, buildWorkerPrompt, checkSteps, extractOutput, getPath, parseEnvelope, parseReport, stripLinks } from "./report.js";

/** Extra time before the server kills a worker, so CLIs with their own time limit can stop cleanly first. */
const KILL_GRACE_SEC = 30;

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
const FINAL: ReadonlySet<JobStatus> = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

export interface JobRecord {
  id: string;
  backend: string;
  task: string;
  workspace: string;
  paths: string[];
  timeoutSec: number;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  error?: string;
  summary?: string;
  formatOk?: boolean;
  reportChars?: number;
  /** Files listed in the worker prompt, and how many matched in total. */
  manifestListed?: number;
  manifestTotal?: number;
  /** Tokens the worker spent, when the backend reports it (usageJsonPath). */
  workerTokens?: number;
  /** Files whose git status changed while the job ran. Best effort: may include edits made by someone else. */
  changedFiles?: string[];
  /** Number of steps in the brief. */
  stepCount?: number;
  /** Whether the report had a Step log, and which steps it did not mark as done. */
  stepLogged?: boolean;
  stepsOpen?: number[];
}

export interface SubmitInput extends Brief {
  workspace: string;
  paths: string[];
  backend?: string;
  timeoutSec?: number;
}

export const isFinal = (status: JobStatus) => FINAL.has(status);

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly procs = new Map<string, ChildProcess>();
  private readonly killReason = new Map<string, "cancelled" | "timed_out">();
  private readonly queue: string[] = [];
  private readonly events = new EventEmitter();

  constructor(private readonly config: Config) {
    this.events.setMaxListeners(0);
    mkdirSync(config.jobsDir, { recursive: true });
    this.loadExisting();
    const stopAll = () => {
      for (const child of this.procs.values()) killTree(child);
    };
    process.once("exit", stopAll);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        stopAll();
        process.exit(130);
      });
    }
  }

  submit(input: SubmitInput): JobRecord {
    const backendName = input.backend ?? this.config.defaultBackend;
    const backend = this.config.backends[backendName];
    if (!backend) {
      throw new Error(`Unknown backend "${backendName}". Available: ${Object.keys(this.config.backends).join(", ")}.`);
    }
    const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
    const job: JobRecord = {
      id,
      backend: backendName,
      task: input.task,
      workspace: input.workspace,
      paths: input.paths,
      timeoutSec: input.timeoutSec ?? backend.timeoutSec,
      stepCount: input.steps.length,
      status: "queued",
      createdAt: new Date().toISOString()
    };
    mkdirSync(this.dir(id), { recursive: true });
    const manifest = buildManifest(input.workspace, input.paths, this.config.manifestLimit);
    job.manifestListed = manifest.lines.length;
    job.manifestTotal = manifest.total;
    const prompt = buildWorkerPrompt({ ...input, summaryWords: this.config.summaryWords, manifest });
    writeFileSync(path.join(this.dir(id), "prompt.md"), prompt, "utf8");
    this.jobs.set(id, job);
    this.save(job);
    this.queue.push(id);
    this.pump();
    return job;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(limit: number): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  /** Resolves when the job reaches a final state, the wait elapses, or the signal aborts. */
  async waitFor(id: string, ms: number, signal?: AbortSignal): Promise<JobRecord | undefined> {
    const job = this.jobs.get(id);
    if (!job || isFinal(job.status) || ms <= 0) return job;
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.events.off(`done:${id}`, done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.events.on(`done:${id}`, done);
      signal?.addEventListener("abort", done, { once: true });
    });
    return this.jobs.get(id);
  }

  cancel(id: string): JobRecord | undefined {
    const job = this.jobs.get(id);
    if (!job || isFinal(job.status)) return job;
    if (job.status === "queued") {
      this.queue.splice(this.queue.indexOf(id), 1);
      this.update(job, { status: "cancelled", finishedAt: new Date().toISOString() });
      this.events.emit(`done:${id}`);
      return job;
    }
    const child = this.procs.get(id);
    if (child) {
      this.killReason.set(id, "cancelled");
      killTree(child);
    }
    return job;
  }

  readFile(id: string, name: "report.md" | "stderr.log" | "prompt.md"): string | undefined {
    const file = path.join(this.dir(id), name);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  // ---- internals ----

  private dir(id: string): string {
    return path.join(this.config.jobsDir, id);
  }

  private save(job: JobRecord): void {
    writeFileSync(path.join(this.dir(job.id), "job.json"), JSON.stringify(job, null, 2), "utf8");
  }

  private update(job: JobRecord, patch: Partial<JobRecord>): void {
    Object.assign(job, patch);
    this.save(job);
  }

  /** Reloads job history; anything still queued or running belonged to a server that has exited. */
  private loadExisting(): void {
    for (const entry of readdirSync(this.config.jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.config.jobsDir, entry.name, "job.json");
      if (!existsSync(file)) continue;
      try {
        const job = JSON.parse(readFileSync(file, "utf8")) as JobRecord;
        if (!isFinal(job.status)) {
          job.status = "interrupted";
          job.error = "The server stopped before this job finished.";
          this.save(job);
        }
        this.jobs.set(job.id, job);
      } catch {
        // A corrupt record is skipped rather than blocking startup.
      }
    }
  }

  private pump(): void {
    while (this.procs.size < this.config.maxConcurrent && this.queue.length > 0) {
      this.start(this.queue.shift()!);
    }
  }

  private start(id: string): void {
    const job = this.jobs.get(id)!;
    const backend = this.config.backends[job.backend]!;
    const dir = this.dir(id);
    const prompt = readFileSync(path.join(dir, "prompt.md"), "utf8");
    const before = gitSnapshot(job.workspace);

    const fill = (value: string) =>
      value.replaceAll("{prompt}", prompt).replaceAll("{workspace}", job.workspace).replaceAll("{timeoutSec}", String(job.timeoutSec));
    const args = backend.args.map(fill);
    if (backend.promptVia === "arg" && !backend.args.some(arg => arg.includes("{prompt}"))) args.push(prompt);

    if (needsStdinOnWindows(backend.promptVia, findOnPath(backend.command))) {
      this.update(job, {
        status: "failed",
        error: `"${backend.command}" is a .cmd/.bat script, which cannot receive a multi-line prompt as an argument. Set "promptVia": "stdin" for this backend, or point "command" at the .exe.`,
        finishedAt: new Date().toISOString()
      });
      this.events.emit(`done:${id}`);
      queueMicrotask(() => this.pump());
      return;
    }

    const stdoutLog = createWriteStream(path.join(dir, "stdout.log"));
    const stderrLog = createWriteStream(path.join(dir, "stderr.log"));
    const endStream = (stream: ReturnType<typeof createWriteStream>) => new Promise<void>(resolve => stream.end(resolve));

    let child: ChildProcess;
    try {
      child = crossSpawn(backend.command, args, {
        cwd: job.workspace,
        env: { ...process.env, ...backend.env },
        stdio: [backend.promptVia === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32"
      });
    } catch (error) {
      void Promise.all([endStream(stdoutLog), endStream(stderrLog)]);
      this.update(job, { status: "failed", error: `Could not start "${backend.command}": ${(error as Error).message}`, finishedAt: new Date().toISOString() });
      this.events.emit(`done:${id}`);
      return;
    }

    this.procs.set(id, child);
    this.update(job, { status: "running", startedAt: new Date().toISOString() });

    if (child.stdin) {
      child.stdin.on("error", () => {}); // The CLI may exit before reading all of stdin.
      child.stdin.end(prompt);
    }
    child.stdout?.on("data", chunk => stdoutLog.write(chunk));
    child.stderr?.on("data", chunk => stderrLog.write(chunk));

    const timer = setTimeout(() => {
      this.killReason.set(id, "timed_out");
      killTree(child);
    }, (job.timeoutSec + KILL_GRACE_SEC) * 1000);

    let spawnError: NodeJS.ErrnoException | undefined;
    let finished = false;
    const finish = async (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      await Promise.all([endStream(stdoutLog), endStream(stderrLog)]);
      this.procs.delete(id);

      const stdout = readFileSync(path.join(dir, "stdout.log"), "utf8");
      const stderr = readFileSync(path.join(dir, "stderr.log"), "utf8");
      const patch: Partial<JobRecord> = { exitCode: code, finishedAt: new Date().toISOString() };

      const text = stripLinks(extractOutput(stdout, backend.outputJsonPath)).trim();
      if (backend.usageJsonPath) {
        const tokens = getPath(parseEnvelope(stdout), backend.usageJsonPath);
        if (typeof tokens === "number") patch.workerTokens = tokens;
      }
      if (text) {
        writeFileSync(path.join(dir, "report.md"), text, "utf8");
        const parsed = parseReport(text, this.config.summaryWords);
        Object.assign(patch, { summary: parsed.summary, formatOk: parsed.formatOk, reportChars: text.length });
        if (job.stepCount) {
          const steps = checkSteps(parsed.sections, job.stepCount);
          Object.assign(patch, { stepLogged: steps.logged, stepsOpen: steps.open });
        }
      }

      const reason = this.killReason.get(id);
      this.killReason.delete(id);
      if (reason === "cancelled") {
        patch.status = "cancelled";
      } else if (reason === "timed_out") {
        patch.status = "timed_out";
        patch.error = `Stopped after ${job.timeoutSec}s. Narrow the task or pass a larger timeout_sec.`;
      } else if (spawnError) {
        patch.status = "failed";
        patch.error = spawnError.code === "ENOENT"
          ? `Backend command "${backend.command}" was not found. Install it or set its full path in the config (run: offload-mcp-server doctor).`
          : `Could not run "${backend.command}": ${spawnError.message}`;
      } else if (code !== 0) {
        patch.status = "failed";
        patch.error = `Backend exited with code ${code}${text ? " (a partial report was kept)" : ""}. Last output:\n${tail(stderr, stdout)}`;
      } else if (!text) {
        patch.status = "failed";
        patch.error = `Backend exited successfully but gave no answer, often because a tool permission was denied in headless mode. Last output:\n${tail(stderr, stdout)}`;
      } else {
        patch.status = "succeeded";
      }

      const after = gitSnapshot(job.workspace);
      if (before && after) {
        const changed = [...after].filter(entry => !before.has(entry)).map(entry => entry.slice(3));
        if (changed.length > 0) patch.changedFiles = changed;
      }

      this.update(job, patch);
      this.events.emit(`done:${id}`);
      this.pump();
    };

    child.on("error", error => {
      spawnError = error as NodeJS.ErrnoException;
      void finish(null);
    });
    child.on("close", code => void finish(code));
  }
}

function tail(stderr: string, stdout: string): string {
  const parts = [stderr.trim().slice(-1000), stdout.trim().slice(-800)].filter(Boolean);
  return parts.join("\n---\n") || "(empty)";
}

/** `git status` entries ("XY path"), or null when the workspace is not a git repository. */
function gitSnapshot(cwd: string): Set<string> | null {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return new Set(result.stdout.split("\0").filter(entry => entry.length > 3));
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}
