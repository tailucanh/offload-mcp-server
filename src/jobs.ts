import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import crossSpawn from "cross-spawn";
import type { Backend, Config } from "./config.js";
import { findOnPath, missingAgentFile, needsStdinOnWindows } from "./doctor.js";
import { buildManifest } from "./manifest.js";
import { type Brief, buildFollowupPrompt, buildWorkerPrompt, checkSteps, extractOutput, getPath, parseEnvelope, parseReport, stripLinks } from "./report.js";
import { askedQuestion, type Coverage, coverage, filesFromReport, injectionFlags, redactSecrets } from "./sanitize.js";
import { AgyStream } from "./stream.js";

/** Extra time before the server kills a worker, so CLIs with their own time limit can stop cleanly first. */
const KILL_GRACE_SEC = 30;
/** Set on every worker; a server that sees it refuses new jobs, so a worker cannot delegate in turn. */
export const CHILD_ENV = "OFFLOAD_CHILD";
const QUOTA = /RESOURCE_EXHAUSTED|quota|rate.?limit|\b429\b/i;

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
const FINAL: ReadonlySet<JobStatus> = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

export interface JobRecord {
  id: string;
  /** "brief" for offload_submit_task, "followup" for offload_followup. */
  kind?: "brief" | "followup";
  /** The job a follow-up continues. */
  parentId?: string;
  backend: string;
  model?: string;
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
  /** Files listed in the worker prompt, how many matched in total, and their total size. */
  manifestListed?: number;
  manifestTotal?: number;
  scopeBytes?: number;
  /** Tokens the worker spent, when the backend reports it. */
  workerTokens?: number;
  /** Files whose git status changed while the job ran. Best effort: may include edits made by someone else. */
  changedFiles?: string[];
  /** Number of steps in the brief. */
  stepCount?: number;
  /** Whether the report had a Step log, and which steps it did not mark as done. */
  stepLogged?: boolean;
  stepsOpen?: number[];
  /** The worker's conversation, for follow-ups (stream backends). */
  conversationId?: string;
  /** Live progress (stream backends). */
  progress?: { toolCalls: number; lastStep?: string; lastEventAt: string };
  /** In-scope files the worker opened. */
  coverage?: Coverage;
  /** The worker's question, from a final "ASK:" line. */
  question?: string;
  /** Secret-looking values masked in the report. */
  redactions?: number;
  /** Report text that reads like instructions to an agent. */
  injectionFlags?: string[];
  /** Tool calls the worker's CLI refused. */
  deniedActions?: string[];
  /** Hash of the brief and the in-scope files' sizes and times, for reuse. */
  fingerprint?: string;
  /** The server process that owns the job; the dashboard uses it to spot jobs whose server has exited. */
  serverPid?: number;
}

/** Written into a job's folder by the dashboard; the owning server sees it and cancels the job. */
export const CANCEL_FILE = "cancel.request";
/** One JSON line per worker step (stream backends), for the dashboard. */
export const TIMELINE_FILE = "timeline.ndjson";

export interface SubmitInput extends Brief {
  workspace: string;
  paths: string[];
  backend?: string;
  timeoutSec?: number;
  model?: string;
  tier?: "low" | "medium" | "high";
  /** Return a finished job with the same brief and unchanged files instead of running again. Default true. */
  reuse?: boolean;
}

export interface SubmitResult {
  job: JobRecord;
  reused: boolean;
  warnings: string[];
}

export const isFinal = (status: JobStatus) => FINAL.has(status);

/** Job folder names: creation time (UTC, to the second) and 6 random hex digits. */
const JOB_ID = /^\d{14}-[0-9a-f]{6}$/;

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

export const pidAlive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly procs = new Map<string, ChildProcess>();
  private readonly killReason = new Map<string, "cancelled" | "timed_out" | "stalled">();
  private readonly queue: string[] = [];
  private readonly events = new EventEmitter();
  private cancelWatch?: NodeJS.Timeout;

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

  submit(input: SubmitInput): SubmitResult {
    refuseNested();
    const backendName = input.backend ?? this.config.defaultBackend;
    const backend = this.backend(backendName, input.workspace);
    const model = resolveModel(backend, backendName, input.model, input.tier);

    const manifest = buildManifest(input.workspace, input.paths, this.config.manifestLimit);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      v: 3, backend: backendName, model: model ?? null, task: input.task, steps: input.steps, outputHint: input.outputHint,
      doneWhen: input.doneWhen, context: input.context ?? null, exclude: input.exclude ?? [], workspace: input.workspace,
      paths: input.paths, files: manifest.files, stamps: manifest.stamps
    })).digest("hex");

    if (input.reuse !== false) {
      const previous = this.list(Number.MAX_SAFE_INTEGER)
        .find(job => job.fingerprint === fingerprint && job.status === "succeeded" && !job.changedFiles?.length);
      if (previous) return { job: previous, reused: true, warnings: [] };
    }

    const warnings: string[] = [];
    const kb = Math.ceil(manifest.bytes / 1024);
    if (manifest.total > this.config.manifestLimit || manifest.bytes > this.config.scopeWarnKB * 1024) {
      warnings.push(`Scope is large (${manifest.total} files, ${kb} KB): jobs this size often take 10 minutes or more. Consider splitting "paths" by folder into several jobs; they run in parallel.`);
    }

    const job = this.create({
      kind: "brief", backend: backendName, model, task: input.task, workspace: input.workspace, paths: input.paths,
      timeoutSec: input.timeoutSec ?? backend.timeoutSec, stepCount: input.steps.length, fingerprint,
      manifestListed: manifest.lines.length, manifestTotal: manifest.total, scopeBytes: manifest.bytes
    });
    writeFileSync(path.join(this.dir(job.id), "scope.json"), JSON.stringify(manifest.files), "utf8");
    this.enqueue(job, buildWorkerPrompt({ ...input, summaryWords: this.config.summaryWords, manifest }));
    return { job, reused: false, warnings };
  }

  /** Continues a finished job's conversation with a question or an answer to its ASK: line. */
  followup(parentId: string, message: string, outputHint?: string, timeoutSec?: number): JobRecord {
    refuseNested();
    const parent = this.get(parentId);
    if (!parent) throw new Error(`No job ${parentId}. Call offload_get_status without job_id to list jobs.`);
    if (!isFinal(parent.status)) throw new Error(`Job ${parentId} is still ${parent.status}. Wait for it to finish first.`);
    const backend = this.backend(parent.backend, parent.workspace);
    if (backend.resumeArgs.length === 0) throw new Error(`Backend "${parent.backend}" has no "resumeArgs", so it cannot continue a conversation. Submit a new task instead.`);
    if (!parent.conversationId) throw new Error(`Job ${parentId} has no conversation id (the worker did not start one, or the backend does not report it). Submit a new task instead.`);

    const job = this.create({
      kind: "followup", parentId, backend: parent.backend, model: parent.model, task: message, workspace: parent.workspace,
      paths: parent.paths, timeoutSec: timeoutSec ?? backend.timeoutSec, conversationId: parent.conversationId,
      manifestTotal: parent.manifestTotal, manifestListed: parent.manifestListed, scopeBytes: parent.scopeBytes
    });
    const scope = path.join(this.dir(parentId), "scope.json");
    if (existsSync(scope)) copyFileSync(scope, path.join(this.dir(job.id), "scope.json"));
    this.enqueue(job, buildFollowupPrompt(message, this.config.summaryWords, outputHint));
    return job;
  }

  /**
   * The latest record of a job. This server's own jobs come from memory. A job another server runs
   * (another session or client sharing the jobs folder) is re-read from disk while it is unfinished,
   * and one created after this server started is loaded from disk on first use.
   */
  get(id: string): JobRecord | undefined {
    const known = this.jobs.get(id);
    if (known && (isFinal(known.status) || known.serverPid === process.pid)) return known;
    if (!JOB_ID.test(id)) return known;
    let job: JobRecord;
    try {
      job = JSON.parse(readFileSync(path.join(this.dir(id), "job.json"), "utf8")) as JobRecord;
    } catch {
      return known; // Missing, or caught mid-write: keep what we had.
    }
    if (!isFinal(job.status) && job.serverPid !== process.pid && !pidAlive(job.serverPid)) {
      job.status = "interrupted";
      job.error = "The server stopped before this job finished.";
      this.save(job);
    }
    this.jobs.set(id, job);
    return job;
  }

  list(limit: number): JobRecord[] {
    // Pick up jobs other servers created since this one started, and refresh the ones they still run.
    try {
      for (const name of readdirSync(this.config.jobsDir)) {
        if (JOB_ID.test(name) && !this.jobs.has(name)) this.get(name);
      }
    } catch {
      // The folder is created at startup; if it vanished, list what is in memory.
    }
    for (const job of [...this.jobs.values()]) {
      if (!isFinal(job.status) && job.serverPid !== process.pid) this.get(job.id);
    }
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  /** Resolves when the job reaches a final state, the wait elapses, or the signal aborts. */
  async waitFor(id: string, ms: number, signal?: AbortSignal): Promise<JobRecord | undefined> {
    let job = this.get(id);
    if (!job || isFinal(job.status) || ms <= 0) return job;
    if (job.serverPid !== process.pid) {
      // Another server runs it, so no event will fire here: poll its record instead.
      const end = Date.now() + ms;
      while (Date.now() < end && !signal?.aborted) {
        await sleep(Math.min(1_000, end - Date.now()), signal);
        job = this.get(id);
        if (!job || isFinal(job.status)) break;
      }
      return job;
    }
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
    const job = this.get(id);
    if (!job || isFinal(job.status)) return job;
    if (job.serverPid !== process.pid) {
      // Another live server runs it: ask that server, the way the dashboard does. It stops the worker within ~1 s.
      writeFileSync(path.join(this.dir(id), CANCEL_FILE), new Date().toISOString(), "utf8");
      return job;
    }
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

  private backend(name: string, workspace: string): Backend {
    const backend = this.config.backends[name];
    if (!backend) throw new Error(`Unknown backend "${name}". Available: ${Object.keys(this.config.backends).join(", ")}.`);
    const agentFile = missingAgentFile(backend, workspace);
    if (agentFile) {
      throw new Error(`The read-only worker agent is not installed (${agentFile} is missing), so the worker would stop with an empty answer. Ask the user to run: npx -y offload-mcp-server setup`);
    }
    return backend;
  }

  private create(fields: Omit<JobRecord, "id" | "status" | "createdAt">): JobRecord {
    const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
    const job: JobRecord = { id, status: "queued", createdAt: new Date().toISOString(), serverPid: process.pid, ...fields };
    mkdirSync(this.dir(id), { recursive: true });
    return job;
  }

  private enqueue(job: JobRecord, prompt: string): void {
    writeFileSync(path.join(this.dir(job.id), "prompt.md"), prompt, "utf8");
    this.jobs.set(job.id, job);
    this.save(job);
    this.queue.push(job.id);
    this.pump();
    this.watchCancels();
  }

  /** While jobs are queued or running, polls their folders for a cancel request from the dashboard. */
  private watchCancels(): void {
    if (this.cancelWatch) return;
    this.cancelWatch = setInterval(() => {
      const active = [...this.queue, ...this.procs.keys()];
      if (active.length === 0) {
        clearInterval(this.cancelWatch);
        this.cancelWatch = undefined;
        return;
      }
      for (const id of active) {
        const request = path.join(this.dir(id), CANCEL_FILE);
        if (!existsSync(request)) continue;
        try {
          unlinkSync(request);
        } catch {
          // Already removed; cancel anyway.
        }
        this.cancel(id);
      }
    }, 1_000);
    this.cancelWatch.unref();
  }

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

  /**
   * Reloads job history. A queued or running job whose server has exited is marked interrupted; one
   * whose server is still alive (another client or session sharing the jobs folder) is left alone.
   */
  private loadExisting(): void {
    for (const entry of readdirSync(this.config.jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.config.jobsDir, entry.name, "job.json");
      if (!existsSync(file)) continue;
      try {
        const job = JSON.parse(readFileSync(file, "utf8")) as JobRecord;
        const ownerAlive = job.serverPid !== undefined && job.serverPid !== process.pid && pidAlive(job.serverPid);
        if (!isFinal(job.status) && !ownerAlive) {
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

    const fill = (value: string) => value
      .replaceAll("{prompt}", prompt)
      .replaceAll("{workspace}", job.workspace)
      .replaceAll("{timeoutSec}", String(job.timeoutSec))
      .replaceAll("{conversationId}", job.conversationId ?? "")
      .replaceAll("{model}", job.model ?? "");
    // Extra flags go after the configured args (a command such as `node script.js` must keep its script first).
    const args = [
      ...backend.args.map(fill),
      ...(job.kind === "followup" ? backend.resumeArgs.map(fill) : []),
      ...(job.model ? backend.modelArgs.map(fill) : [])
    ];
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
    const timelineLog = backend.streamFormat === "agy" ? createWriteStream(path.join(dir, TIMELINE_FILE)) : undefined;
    const endStream = (stream: ReturnType<typeof createWriteStream>) => new Promise<void>(resolve => stream.end(resolve));

    let child: ChildProcess;
    try {
      child = crossSpawn(backend.command, args, {
        cwd: job.workspace,
        env: { ...process.env, ...backend.env, [CHILD_ENV]: "1" },
        stdio: [backend.promptVia === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32"
      });
    } catch (error) {
      void Promise.all([endStream(stdoutLog), endStream(stderrLog), ...(timelineLog ? [endStream(timelineLog)] : [])]);
      this.update(job, { status: "failed", error: `Could not start "${backend.command}": ${(error as Error).message}`, finishedAt: new Date().toISOString() });
      this.events.emit(`done:${id}`);
      return;
    }

    this.procs.set(id, child);
    this.update(job, { status: "running", startedAt: new Date().toISOString() });

    // Live progress for stream backends, saved at most every 2 s.
    let lastSave = 0;
    const stream = backend.streamFormat === "agy" ? new AgyStream(() => {
      job.progress = { toolCalls: stream!.progress.toolCalls, lastStep: stream!.progress.lastStep, lastEventAt: new Date(stream!.progress.lastEventAt).toISOString() };
      job.conversationId ??= stream!.conversationId;
      if (Date.now() - lastSave > 2_000) {
        lastSave = Date.now();
        this.save(job);
      }
    }, entry => timelineLog?.write(`${JSON.stringify(entry)}\n`)) : undefined;
    const decoder = new StringDecoder("utf8");

    if (child.stdin) {
      child.stdin.on("error", () => {}); // The CLI may exit before reading all of stdin.
      child.stdin.end(prompt);
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutLog.write(chunk);
      stream?.feed(decoder.write(chunk));
    });
    child.stderr?.on("data", chunk => stderrLog.write(chunk));

    const timer = setTimeout(() => {
      this.killReason.set(id, "timed_out");
      killTree(child);
    }, (job.timeoutSec + KILL_GRACE_SEC) * 1000);
    const stallCheck = stream && backend.stallSec > 0 ? setInterval(() => {
      if (Date.now() - stream.progress.lastEventAt > backend.stallSec * 1000) {
        this.killReason.set(id, "stalled");
        killTree(child);
      }
    }, Math.min(5_000, backend.stallSec * 500)) : undefined;

    let spawnError: NodeJS.ErrnoException | undefined;
    let finished = false;
    const finish = async (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (stallCheck) clearInterval(stallCheck);
      await Promise.all([endStream(stdoutLog), endStream(stderrLog)]);
      this.procs.delete(id);
      stream?.feed(decoder.end());
      stream?.end();
      if (timelineLog) await endStream(timelineLog);

      const stdout = readFileSync(path.join(dir, "stdout.log"), "utf8");
      const stderr = readFileSync(path.join(dir, "stderr.log"), "utf8");
      const patch: Partial<JobRecord> = { exitCode: code, finishedAt: new Date().toISOString() };

      const raw = stream ? (stream.result?.response ?? "") : extractOutput(stdout, backend.outputJsonPath);
      const redacted = redactSecrets(stripLinks(raw).trim());
      const text = redacted.text;
      if (redacted.count) patch.redactions = redacted.count;
      if (stream) {
        if (stream.result?.totalTokens !== undefined) patch.workerTokens = stream.result.totalTokens;
        if (stream.conversationId) patch.conversationId = stream.conversationId;
        if (stream.result?.deniedActions?.length) patch.deniedActions = stream.result.deniedActions;
      } else if (backend.usageJsonPath) {
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
        const flags = injectionFlags(text);
        if (flags.length) patch.injectionFlags = flags;
        const question = askedQuestion(text);
        if (question) patch.question = question;
        if (job.kind !== "followup") {
          const scope = readScope(dir);
          if (scope.length) {
            patch.coverage = stream
              ? coverage(job.workspace, scope, stream.filesRead, "tool events")
              : coverage(job.workspace, scope, filesFromReport(parsed.sections["files read"]), "report");
          }
        }
      }

      const reason = this.killReason.get(id);
      this.killReason.delete(id);
      const workerError = stream?.result?.error ?? "";
      const quotaHit = QUOTA.test(`${workerError}\n${stderr.slice(-4000)}\n${stream ? "" : stdout.slice(-4000)}`);
      if (reason === "cancelled") {
        patch.status = "cancelled";
      } else if (reason === "timed_out") {
        patch.status = "timed_out";
        patch.error = `Stopped after ${job.timeoutSec}s. Narrow the task or pass a larger timeout_sec.`;
      } else if (reason === "stalled") {
        patch.status = "timed_out";
        patch.error = `Stopped: the worker sent no event for ${backend.stallSec}s (last step: ${job.progress?.lastStep ?? "none"}). It may be waiting on something it cannot do headless; narrow the task or check stderr.`;
      } else if (spawnError) {
        patch.status = "failed";
        patch.error = spawnError.code === "ENOENT"
          ? `Backend command "${backend.command}" was not found. Install it or set its full path in the config (run: offload-mcp-server doctor).`
          : `Could not run "${backend.command}": ${spawnError.message}`;
      } else if (!text && quotaHit) {
        patch.status = "failed";
        patch.error = `The worker's quota or rate limit was reached. Do not resubmit now: tell the user (subscription plans have a daily limit), then retry later or with another backend. Last output:\n${tail(`${workerError}\n${stderr}`, stdout)}`;
      } else if (code !== 0 && !(stream?.result?.status === "SUCCESS" && text)) {
        patch.status = "failed";
        patch.error = `Backend exited with code ${code}${text ? " (a partial report was kept)" : ""}. Last output:\n${tail(`${workerError}\n${stderr}`, stdout)}`;
      } else if (!text) {
        patch.status = "failed";
        const denied = patch.deniedActions?.length ? ` Denied: ${patch.deniedActions.join(", ")}.` : "";
        patch.error = `Backend gave no answer, often because a tool permission was denied in headless mode.${denied} Last output:\n${tail(`${workerError}\n${stderr}`, stdout)}`;
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

function refuseNested(): void {
  if (process.env[CHILD_ENV] === "1") {
    throw new Error("This offload server runs inside an offload worker, and nested delegation is refused. Do the reading yourself.");
  }
}

function resolveModel(backend: Backend, name: string, model?: string, tier?: "low" | "medium" | "high"): string | undefined {
  if (!model && !tier) return undefined;
  if (backend.modelArgs.length === 0) throw new Error(`Backend "${name}" has no "modelArgs", so it cannot choose a model per job.`);
  if (model) return model;
  const id = backend.tiers?.[tier!];
  if (!id) throw new Error(`Backend "${name}" has no model for tier "${tier}". Run "npx -y offload-mcp-server setup" to detect tiers, or pass "model".`);
  return id;
}

function readScope(dir: string): string[] {
  try {
    return JSON.parse(readFileSync(path.join(dir, "scope.json"), "utf8")) as string[];
  } catch {
    return [];
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
