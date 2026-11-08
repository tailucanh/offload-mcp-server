/**
 * Runs one task through the built server exactly as an MCP client would, using your real config.
 *   npm run try -- <workspace> "<task>" [path ...]
 * Prints the status (with Summary), then the Findings section, then token and size figures.
 */
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [workspace, task, ...paths] = process.argv.slice(2);
if (!workspace || !task) {
  console.error('Usage: npm run try -- <workspace> "<task>" [path ...]');
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

const started = Date.now();
// A generic brief so a one-line task can be tried; a real agent writes specific steps.
const submitted = await call("offload_submit_task", {
  task,
  paths,
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

let status = "";
let statusChars = 0;
while (true) {
  const result = await call("offload_get_status", { job_id: jobId, wait_sec: 50 });
  status = textOf(result);
  statusChars = status.length;
  if (!/\*\*(queued|running)\*\*/.test(status)) break;
  console.log(`… still running (${Math.round((Date.now() - started) / 1000)}s)`);
}
console.log(`\n===== offload_get_status\n${status}`);

const findings = await call("offload_get_result", { job_id: jobId, part: "findings", max_chars: 25_000 });
const findingsText = textOf(findings);
console.log(`\n===== offload_get_result part=findings\n${findingsText}`);
console.log(`\n===== what the main agent read: status ${statusChars} chars + findings ${findingsText.length} chars (≈ ${Math.round((statusChars + findingsText.length) / 4)} tokens)`);
await client.close();
