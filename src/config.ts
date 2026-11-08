import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as z from "zod/v4";

/**
 * A backend is any agent CLI that takes a prompt and prints its answer.
 * Placeholders in `args`: {prompt} (the full worker prompt), {workspace} (absolute workspace path),
 * {timeoutSec} (the job's time budget, for CLIs with their own time limit flag).
 */
export const BackendSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  promptVia: z.enum(["arg", "stdin"]).default("arg"),
  /** Dot path into a JSON stdout, e.g. "response" for CLIs run with a JSON output flag. */
  outputJsonPath: z.string().optional(),
  /** Dot path to the worker's token count in the JSON stdout, e.g. "usage.total_tokens". */
  usageJsonPath: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  timeoutSec: z.number().int().min(10).max(7200).default(900)
});
export type Backend = z.infer<typeof BackendSchema>;

const FileSchema = z.strictObject({
  $schema: z.string().optional(),
  defaultBackend: z.string().optional(),
  backends: z.record(z.string(), BackendSchema).optional(),
  maxConcurrent: z.number().int().min(1).max(8).optional(),
  jobsDir: z.string().optional(),
  allowedRoots: z.array(z.string()).optional(),
  summaryWords: z.number().int().min(30).max(1000).optional(),
  manifestLimit: z.number().int().min(0).max(5000).optional()
});

export interface Config {
  defaultBackend: string;
  backends: Record<string, Backend>;
  maxConcurrent: number;
  jobsDir: string;
  /** Extra directories (besides the server's cwd) a job may use as its workspace. */
  allowedRoots: string[];
  summaryWords: number;
  /** Maximum number of files listed in the worker prompt. */
  manifestLimit: number;
  source: string;
}

/**
 * Headless Antigravity CLI (checked against agy 1.5.3). `offload-reader` is the read-only custom agent
 * shipped in agents/; install it into ~/.gemini/agents/ first. See README.
 */
export const BUILTIN_BACKENDS: Record<string, Backend> = {
  agy: {
    command: "agy",
    args: ["--agent", "offload-reader", "--output-format", "json", "--print-timeout", "{timeoutSec}s", "-p", "{prompt}"],
    promptVia: "arg",
    outputJsonPath: "response",
    usageJsonPath: "usage.total_tokens",
    env: {},
    timeoutSec: 600
  }
};

/**
 * The config is read only from OFFLOAD_CONFIG or the user's home directory, never from the
 * workspace: a config file inside a cloned repo could otherwise make the server run any command.
 */
export function configPath(): string {
  return process.env.OFFLOAD_CONFIG ?? path.join(homedir(), ".offload", "config.json");
}

export function loadConfig(): Config {
  const file = configPath();
  let raw: z.infer<typeof FileSchema> = {};
  let source = "built-in defaults";

  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    } catch (error) {
      throw new Error(`Cannot parse ${file}: ${(error as Error).message}`);
    }
    const result = FileSchema.safeParse(parsed);
    if (!result.success) throw new Error(`Invalid config ${file}:\n${z.prettifyError(result.error)}`);
    raw = result.data;
    source = file;
  } else if (process.env.OFFLOAD_CONFIG) {
    throw new Error(`OFFLOAD_CONFIG points to ${file}, which does not exist.`);
  }

  const backends = { ...BUILTIN_BACKENDS, ...(raw.backends ?? {}) };
  const defaultBackend = raw.defaultBackend ?? "agy";
  if (!backends[defaultBackend]) {
    throw new Error(`defaultBackend "${defaultBackend}" is not defined. Known backends: ${Object.keys(backends).join(", ")}`);
  }

  return {
    defaultBackend,
    backends,
    maxConcurrent: raw.maxConcurrent ?? 2,
    jobsDir: path.resolve(raw.jobsDir ?? path.join(homedir(), ".offload", "jobs")),
    allowedRoots: (raw.allowedRoots ?? []).map(root => path.resolve(root)),
    summaryWords: raw.summaryWords ?? 200,
    manifestLimit: raw.manifestLimit ?? 400,
    source
  };
}
