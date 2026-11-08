import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Config } from "./config.js";
import { isFinal, type JobManager, type JobRecord } from "./jobs.js";
import { parseReport } from "./report.js";

const CHARACTER_LIMIT = 25_000;
const MAX_WAIT_SEC = 50; // Stay under the ~60 s per-call timeout many MCP clients apply.

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realDir(dir: string): string {
  const real = realpathSync.native(dir);
  if (!statSync(real).isDirectory()) throw new Error(`${dir} is not a directory.`);
  return real;
}

function resolveWorkspace(config: Config, requested?: string): string {
  const roots = [process.cwd(), ...config.allowedRoots].map(root => {
    try {
      return realDir(root);
    } catch {
      return null;
    }
  }).filter((root): root is string => root !== null);

  let workspace: string;
  try {
    workspace = realDir(requested ? path.resolve(requested) : process.cwd());
  } catch {
    throw new Error(`Workspace ${requested} does not exist or is not a directory.`);
  }
  if (!roots.some(root => isWithin(workspace, root))) {
    throw new Error(`Workspace ${workspace} is outside the allowed roots (${roots.join(", ")}). Add it to "allowedRoots" in the config, or omit workspace to use the current project.`);
  }
  return workspace;
}

function resolvePaths(workspace: string, paths: string[]): string[] {
  return paths.map(p => {
    let real: string;
    try {
      real = realpathSync.native(path.resolve(workspace, p));
    } catch {
      throw new Error(`Path "${p}" does not exist in ${workspace}. Pass paths relative to the workspace.`);
    }
    if (!isWithin(real, workspace)) throw new Error(`Path "${p}" is outside the workspace ${workspace}.`);
    return path.relative(workspace, real).split(path.sep).join("/") || ".";
  });
}

function elapsed(job: JobRecord): string {
  if (!job.startedAt) return "not started";
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return `${Math.round((end - Date.parse(job.startedAt)) / 1000)}s`;
}

function describeJob(job: JobRecord): string {
  const lines = [`Job ${job.id}: **${job.status}** (backend ${job.backend}, ${elapsed(job)})`];
  const facts = [];
  if (job.manifestTotal !== undefined) {
    facts.push(`${job.manifestTotal} file(s) in scope${job.manifestListed! < job.manifestTotal ? `, first ${job.manifestListed} listed to the worker` : ""}`);
  }
  if (job.workerTokens !== undefined) facts.push(`worker used ${job.workerTokens.toLocaleString("en-US")} tokens`);
  if (facts.length) lines.push(facts.join("; "));
  if (job.error) lines.push(`Error: ${job.error}`);
  if (job.changedFiles?.length) {
    lines.push(`Warning: git status changed during the job for ${job.changedFiles.length} file(s): ${job.changedFiles.slice(0, 10).join(", ")}. The worker should not write; check these (they may also be your own edits).`);
  }
  if (job.summary && job.stepCount) {
    if (job.stepLogged === false) {
      lines.push(`Brief check: the worker left out the Step log, so it is unknown whether all ${job.stepCount} steps were done. Read part="full".`);
    } else if (job.stepsOpen?.length) {
      lines.push(`Brief check: step(s) ${job.stepsOpen.join(", ")} of ${job.stepCount} not fully done. Read part="steps" and "uncertain", then do those steps yourself or resubmit a sharper brief.`);
    } else {
      lines.push(`Brief check: all ${job.stepCount} step(s) reported done.`);
    }
  }
  if (job.summary) {
    lines.push("", "## Summary (from the worker; verify before relying on it)", job.summary);
    if (job.formatOk === false) lines.push("", "(The worker ignored the report format; this is an excerpt. Read part=full.)");
    lines.push("", `Full report: ${job.reportChars ?? 0} chars. Call offload_get_result with part="full" only if the summary is not enough.`);
  } else if (!isFinal(job.status)) {
    lines.push(`Still working. Call offload_get_status again with wait_sec=${MAX_WAIT_SEC}.`);
  }
  return lines.join("\n");
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export function registerTools(server: McpServer, jobs: JobManager, config: Config): void {
  server.registerTool(
    "offload_submit_task",
    {
      title: "Offload a heavy read-only task",
      description: `Hand a heavy READ-ONLY task to a background worker agent (default: ${config.defaultBackend}) and get a job_id back immediately.

Use it when the work means reading a lot but the answer is small: scanning many files, filtering large logs, analyzing a big bundle or resource file, inventorying APIs/strings/config across a tree. The worker replies with a short Summary plus Findings with path:line evidence, so you read a few hundred words instead of the files.

Do NOT use it for edits, for small lookups you can do in one or two reads, or for anything security-sensitive you must verify line by line yourself. The worker is another model: treat its findings as leads and spot-check the ones you act on.

Write a complete BRIEF. The worker executes it literally and does nothing else, so anything you leave vague it will skip or guess:
- task: the goal as one concrete question.
- steps: ordered, concrete actions; each names what to open or search and what to record.
- output_hint: the exact shape of the Findings (columns, grouping, sort order, what goes in each column).
- done_when: the stop condition, so the worker neither stops early nor wanders.
- context (optional): what you already know (conventions, file roles), so the worker does not rediscover it.
- exclude (optional): files, folders or kinds of results to leave out.
The worker returns a Step log; the status tells you which steps it did not finish.

Next: call offload_get_status with the job_id and wait_sec=${MAX_WAIT_SEC} until it finishes.

Example:
task="Which HTTP endpoints does api/v1 register, and what auth does each require?"
steps=["List every .php file under api/v1 from FILES IN SCOPE.", "In each file, find each route: URL path and the HTTP methods it accepts.", "For each route, record the auth check it calls (function name), or 'none'."]
output_hint="table: url | methods | auth check | handler path:line, sorted by url"
done_when="Every file under api/v1 has been read and every route is in the table."
exclude=["api/v1/tests/"]`,
      inputSchema: z.strictObject({
        task: z.string().min(10).max(20_000).describe("The goal: one concrete question the report must answer, e.g. \"Which endpoints in api/v1 skip the CSRF check?\""),
        steps: z.array(z.string().min(10).max(2_000)).min(1).max(30).describe("Ordered actions for the worker, each concrete: what to open or search, what to record. The worker performs exactly these, in order, and logs each as done/partial/not done."),
        output_hint: z.string().min(5).max(2_000).describe("Exact shape of the Findings, e.g. \"table: name | path:line | purpose, sorted by path\"."),
        done_when: z.string().min(5).max(2_000).describe("Stop condition, e.g. \"every file under api/v1 is read and every route is listed\"."),
        context: z.string().max(10_000).optional().describe("Facts you already know that save the worker time: conventions, which file does what, names to look for."),
        exclude: z.array(z.string().min(1).max(500)).max(30).optional().describe("What to leave out: files, folders, or kinds of results, e.g. [\"tests/\", \"commented-out code\"]."),
        paths: z.array(z.string().min(1)).max(50).default([]).describe("Files or folders to focus on, relative to the workspace, e.g. [\"api/core\", \"dist/app.js\"]. Empty = whole workspace."),
        workspace: z.string().optional().describe("Absolute workspace path. Defaults to the current project; other paths must be listed in allowedRoots."),
        backend: z.string().optional().describe(`Backend name from the config. Available: ${Object.keys(config.backends).join(", ")}.`),
        timeout_sec: z.number().int().min(30).max(7_200).optional().describe("Kill the worker after this many seconds. Defaults to the backend's timeoutSec.")
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ task, steps, output_hint, done_when, context, exclude, paths, workspace, backend, timeout_sec }) => {
      const ws = resolveWorkspace(config, workspace);
      const job = jobs.submit({
        task,
        steps,
        outputHint: output_hint,
        doneWhen: done_when,
        context,
        exclude,
        workspace: ws,
        paths: resolvePaths(ws, paths),
        backend,
        timeoutSec: timeout_sec
      });
      return {
        content: [{
          type: "text",
          text: `Job ${job.id} ${job.status} on backend ${job.backend} (timeout ${job.timeoutSec}s).\nYou can keep working; call offload_get_status with job_id="${job.id}" and wait_sec=${MAX_WAIT_SEC} to collect it.`
        }],
        structuredContent: { job_id: job.id, status: job.status, backend: job.backend }
      };
    }
  );

  server.registerTool(
    "offload_get_status",
    {
      title: "Get offloaded job status",
      description: `Get the status of one offloaded job, optionally waiting up to ${MAX_WAIT_SEC}s for it to finish. When the job is done this already includes the worker's Summary, so you usually do not need offload_get_result.
Without job_id, lists the most recent jobs.`,
      inputSchema: z.strictObject({
        job_id: z.string().optional().describe("Job ID from offload_submit_task. Omit to list recent jobs."),
        wait_sec: z.number().int().min(0).max(MAX_WAIT_SEC).default(0).describe(`Seconds to wait for completion before answering (max ${MAX_WAIT_SEC}).`),
        limit: z.number().int().min(1).max(50).default(10).describe("How many recent jobs to list when job_id is omitted.")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ job_id, wait_sec, limit }, ctx) => {
      if (!job_id) {
        const recent = jobs.list(limit);
        if (recent.length === 0) return text("No offloaded jobs yet.");
        return text(recent.map(job => `- ${job.id} | ${job.status} | ${job.backend} | ${elapsed(job)} | ${job.task.slice(0, 80).replace(/\s+/g, " ")}`).join("\n"));
      }
      const job = await jobs.waitFor(job_id, wait_sec * 1000, ctx.mcpReq.signal);
      if (!job) throw new Error(`No job ${job_id}. Call offload_get_status without job_id to list jobs.`);
      return text(describeJob(job));
    }
  );

  server.registerTool(
    "offload_get_result",
    {
      title: "Read an offloaded job's report",
      description: `Read the worker's report for a finished job, in pages of up to ${CHARACTER_LIMIT} characters.
part="summary" (short answer), "findings" (evidence list), "steps" (Step log: done/partial/not done per step), "uncertain", "full" (whole report), "stderr" (backend error output, for debugging a failed job).`,
      inputSchema: z.strictObject({
        job_id: z.string().describe("Job ID from offload_submit_task."),
        part: z.enum(["summary", "findings", "steps", "uncertain", "full", "stderr"]).default("summary").describe("Which part of the report to read."),
        offset: z.number().int().min(0).default(0).describe("Character offset, for paging through long parts."),
        max_chars: z.number().int().min(500).max(CHARACTER_LIMIT).default(8_000).describe("Maximum characters to return.")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ job_id, part, offset, max_chars }) => {
      const job = jobs.get(job_id);
      if (!job) throw new Error(`No job ${job_id}. Call offload_get_status without job_id to list jobs.`);

      let body: string | undefined;
      if (part === "stderr") {
        body = jobs.readFile(job_id, "stderr.log");
      } else {
        const report = jobs.readFile(job_id, "report.md");
        if (report === undefined) {
          throw new Error(isFinal(job.status)
            ? `Job ${job_id} ended as ${job.status} without a report. ${job.error ?? ""} Try part="stderr".`
            : `Job ${job_id} is still ${job.status}. Call offload_get_status with wait_sec=${MAX_WAIT_SEC} first.`);
        }
        if (part === "full") {
          body = report;
        } else {
          body = parseReport(report, config.summaryWords).sections[part === "steps" ? "step log" : part]
            ?? `(No "${part}" section; the worker ignored the format. Read part="full".)`;
        }
      }
      if (!body) return text(`(${part} is empty)`);

      const chunk = body.slice(offset, offset + max_chars);
      const next = offset + chunk.length;
      const more = next < body.length ? `\n\n[${next}/${body.length} chars. More: call again with offset=${next}.]` : "";
      return text(chunk + more);
    }
  );

  server.registerTool(
    "offload_cancel_task",
    {
      title: "Cancel an offloaded job",
      description: "Stop a queued or running offloaded job and its worker process tree. Finished jobs are left as they are.",
      inputSchema: z.strictObject({ job_id: z.string().describe("Job ID from offload_submit_task.") }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ job_id }, ctx) => {
      if (!jobs.cancel(job_id)) throw new Error(`No job ${job_id}.`);
      const job = await jobs.waitFor(job_id, 10_000, ctx.mcpReq.signal);
      return text(describeJob(job!));
    }
  );
}
