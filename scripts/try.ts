/**
 * Runs one task through the built server exactly as an MCP client would, using your real config.
 *   npm run try -- <workspace> "<task>" [path ...] [--tier low|medium|high] [--followup "<question>"]
 * Prints live progress, the status (with Summary), the Findings section and token figures; with
 * --followup, then asks the worker a follow-up question in the same conversation.
 */
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const option = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};
const tier = option("--tier");
const followup = option("--followup");
const [workspace, task, ...paths] = argv;
if (!workspace || !task) {
  console.error('Usage: npm run try -- <workspace> "<task>" [path ...] [--tier low|medium|high] [--followup "<question>"]');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env: Record<string, string> = { ...getDefaultEnvironment() };
for (const key of ["OFFLOAD_CONFIG", "USERPROFILE", "HOME", "LOCALAPPDATA", "APPDATA"]) {
  if (process.env[key]) env[key] = process.env[key]!;
}

const client = new Client({ name: "offload-try", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  cwd: path.resolve(workspace),
  env
}));

type Result = { isError?: boolean; content: unknown; structuredContent?: unknown };
const textOf = (r: Result) => (r.content as { text: string }[]).map(c => c.text).join("\n");
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;

/** Polls a job to the end, printing the progress line while it runs; returns the final status text. */
async function collect(jobId: string, started: number): Promise<string> {
  while (true) {
    const status = textOf(await call("offload_get_status", { job_id: jobId, wait_sec: 20 }));
    if (!/\*\*(queued|running)\*\*/.test(status)) return status;
    const progress = /^Progress: .*$/m.exec(status)?.[0] ?? "no progress reported yet";
    console.log(`… ${Math.round((Date.now() - started) / 1000)}s  ${progress}`);
  }
}

const started = Date.now();
// A generic brief so a one-line task can be tried; a real agent writes specific steps.
const submitted = await call("offload_submit_task", {
  task,
  paths,
  ...(tier ? { tier } : {}),
  steps: [
    "Pick the files in scope that the task concerns and read them fully.",
    "Answer the task, recording each fact with its path:line."
  ],
  output_hint: "bullets: fact — path:line, grouped by file",
  done_when: "Every file the task concerns has been read and the task is answered."
});
if (submitted.isError) {
  console.error(textOf(submitted));
  process.exit(1);
}
const jobId = (submitted.structuredContent as { job_id: string }).job_id;
console.log(textOf(submitted));

const status = await collect(jobId, started);
console.log(`\n===== offload_get_status\n${status}`);

const findingsText = textOf(await call("offload_get_result", { job_id: jobId, part: "findings", max_chars: 25_000 }));
console.log(`\n===== offload_get_result part=findings\n${findingsText}`);
console.log(`\n===== what the main agent read: status ${status.length} chars + findings ${findingsText.length} chars (≈ ${Math.round((status.length + findingsText.length) / 4)} tokens)`);

if (followup) {
  const asked = await call("offload_followup", { job_id: jobId, message: followup });
  if (asked.isError) {
    console.error(`\nFollow-up refused: ${textOf(asked)}`);
  } else {
    const followId = (asked.structuredContent as { job_id: string }).job_id;
    console.log(`\n${textOf(asked)}`);
    console.log(`\n===== follow-up status\n${await collect(followId, Date.now())}`);
  }
}
await client.close();
