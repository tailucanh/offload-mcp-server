/**
 * Self-check: starts the built server over stdio against a mock agent CLI and exercises every tool.
 * Run with: npm run build && npm run smoke
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mock = path.join(root, "scripts", "mock-agent.mjs");
const temp = mkdtempSync(path.join(tmpdir(), "offload-smoke-"));
const workspace = path.join(temp, "workspace");
mkdirSync(path.join(workspace, "sub"), { recursive: true });
writeFileSync(path.join(workspace, "a.txt"), "alpha\n");
writeFileSync(path.join(workspace, "sub", "b.txt"), "beta\n");
writeFileSync(path.join(temp, "outside.txt"), "secret\n");
execFileSync("git", ["init", "-q"], { cwd: workspace });

const configFile = path.join(temp, "config.json");
writeFileSync(configFile, JSON.stringify({
  defaultBackend: "mock",
  jobsDir: path.join(temp, "jobs"),
  maxConcurrent: 2,
  backends: {
    mock: { command: process.execPath, args: [mock], promptVia: "stdin", timeoutSec: 60 },
    mockarg: { command: process.execPath, args: [mock, "{prompt}"], promptVia: "arg", timeoutSec: 60 },
    missing: { command: "definitely-not-a-real-agent-cli", args: [], timeoutSec: 60 },
    ...(process.platform === "win32"
      ? { cmdarg: { command: path.join(temp, "agent.cmd"), args: ["{prompt}"], promptVia: "arg", timeoutSec: 60 } }
      : {})
  }
}));
if (process.platform === "win32") writeFileSync(path.join(temp, "agent.cmd"), `@"${process.execPath}" "${mock}" %*\r\n`);

const client = new Client({ name: "offload-smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  cwd: workspace,
  env: { ...getDefaultEnvironment(), OFFLOAD_CONFIG: configFile }
}));

type Result = { isError?: boolean; content: unknown; structuredContent?: unknown };
const textOf = (result: Result) => (result.content as { type: string; text: string }[]).map(c => c.text).join("\n");
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
const submit = async (args: Record<string, unknown>) => {
  const result = await call("offload_submit_task", args);
  assert.ok(!result.isError, `submit failed: ${textOf(result)}`);
  return (result.structuredContent as { job_id: string }).job_id;
};
const check = (label: string) => console.error(`  ok  ${label}`);

try {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ["offload_cancel_task", "offload_get_result", "offload_get_status", "offload_submit_task"]);
  check("lists 4 tools");

  // Happy path, prompt via stdin
  const id = await submit({ task: "Summarize the two text files please", paths: ["a.txt", "sub"] });
  const done = textOf(await call("offload_get_status", { job_id: id, wait_sec: 30 }));
  assert.match(done, /\*\*succeeded\*\*/, done);
  assert.match(done, /Mock worker read 2 focus path\(s\) and saw 2 file\(s\) in scope/, done);
  assert.match(done, /2 file\(s\) in scope/, done);
  assert.match(done, /See a\.txt\./, done);
  assert.doesNotMatch(done, /file:\/\//, done);
  check("stdin backend succeeds; status carries summary, file manifest, and strips file:// links");

  const findings = textOf(await call("offload_get_result", { job_id: id, part: "findings" }));
  assert.match(findings, /- sub/, findings);
  const page = textOf(await call("offload_get_result", { job_id: id, part: "full", max_chars: 500, offset: 0 }));
  assert.match(page, /## Summary/, page);
  check("reads findings section and full report");

  // Prompt passed as an argument
  const argId = await submit({ task: "Same task, prompt as argument", paths: ["a.txt"], backend: "mockarg" });
  assert.match(textOf(await call("offload_get_status", { job_id: argId, wait_sec: 30 })), /succeeded[\s\S]*read 1 focus/);
  check("arg backend succeeds");

  // Path containment
  const escape = await call("offload_submit_task", { task: "Read a file outside the workspace", paths: ["../outside.txt"] });
  assert.equal(escape.isError, true);
  assert.match(textOf(escape), /outside the workspace/);
  const outsideWs = await call("offload_submit_task", { task: "Use a workspace outside the roots", workspace: temp });
  assert.equal(outsideWs.isError, true);
  check("rejects paths and workspaces outside the allowed roots");

  // Missing backend command
  const missingId = await submit({ task: "This backend does not exist", backend: "missing" });
  assert.match(textOf(await call("offload_get_status", { job_id: missingId, wait_sec: 30 })), /failed[\s\S]*not found/);
  check("reports a missing backend command");

  if (process.platform === "win32") {
    const cmdId = await submit({ task: "Multi-line prompt into a .cmd script", backend: "cmdarg" });
    assert.match(textOf(await call("offload_get_status", { job_id: cmdId, wait_sec: 30 })), /failed[\s\S]*promptVia": "stdin"/);
    check("refuses multi-line prompt arguments to .cmd scripts on Windows");
  }

  // Worker ignores the format
  const badId = await submit({ task: "BAD_FORMAT free text answer" });
  assert.match(textOf(await call("offload_get_status", { job_id: badId, wait_sec: 30 })), /ignored the report format/);
  check("flags a report without sections");

  // Worker writes into the workspace
  const writeId = await submit({ task: "WRITE_FILE although it should not" });
  assert.match(textOf(await call("offload_get_status", { job_id: writeId, wait_sec: 30 })), /Warning: git status changed[\s\S]*written-by-worker\.txt/);
  check("detects files changed during the job");

  // Cancel a running job
  const slowId = await submit({ task: "SLOW_MODE take a long time" });
  await new Promise(resolve => setTimeout(resolve, 1_500));
  assert.match(textOf(await call("offload_cancel_task", { job_id: slowId })), /\*\*cancelled\*\*/);
  check("cancels a running job");

  const list = textOf(await call("offload_get_status", {}));
  assert.ok(list.split("\n").length >= 6, list);
  check("lists recent jobs");

  const unknown = await call("offload_get_result", { job_id: "nope" });
  assert.equal(unknown.isError, true);
  check("unknown job is a tool error");

  console.error("Smoke test passed");
} finally {
  await client.close();
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
