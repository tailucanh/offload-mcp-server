/**
 * Self-check: starts the built server over stdio against a mock agent CLI and exercises every tool.
 * Run with: npm run build && npm run smoke
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const jobsDir = path.join(temp, "jobs");
writeFileSync(configFile, JSON.stringify({
  defaultBackend: "mock",
  jobsDir,
  maxConcurrent: 2,
  scopeWarnKB: 0,
  backends: {
    mock: { command: process.execPath, args: [mock], promptVia: "stdin", timeoutSec: 60 },
    stream: {
      command: process.execPath, args: [mock, "--stream", "{prompt}"], promptVia: "arg", timeoutSec: 60,
      streamFormat: "agy", resumeArgs: ["--conversation", "{conversationId}"], modelArgs: ["--model", "{model}"],
      tiers: { low: "mock-low", medium: "mock-medium", high: "mock-high" }, stallSec: 5
    },
    mockarg: { command: process.execPath, args: [mock, "{prompt}"], promptVia: "arg", timeoutSec: 60 },
    missing: { command: "definitely-not-a-real-agent-cli", args: [], timeoutSec: 60 },
    noagent: { command: "agy", args: ["--agent", "offload-smoke-missing-agent", "-p", "{prompt}"], timeoutSec: 60 },
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
// The required parts of a brief; tests override what they exercise.
const brief = {
  steps: ["Read every file in scope.", "List each focus path as one finding."],
  output_hint: "bullets: focus path",
  done_when: "Every focus path is listed."
};
const submit = async (args: Record<string, unknown>) => {
  const result = await call("offload_submit_task", { ...brief, ...args });
  assert.ok(!result.isError, `submit failed: ${textOf(result)}`);
  return (result.structuredContent as { job_id: string }).job_id;
};
const check = (label: string) => console.error(`  ok  ${label}`);

try {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ["offload_cancel_task", "offload_followup", "offload_get_result", "offload_get_status", "offload_submit_task"]);
  check("lists 5 tools");

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
  assert.match(done, /Coverage \(report\): opened 1 of 2 file\(s\) in scope; not opened: sub\/b\.txt/, done);
  assert.match(done, /child=1/, done);
  check("coverage from the report's Files read section; workers run with OFFLOAD_CHILD=1");

  // ---- 0.3.0: stream backend ----
  const status = async (id: string) => textOf(await call("offload_get_status", { job_id: id, wait_sec: 30 }));
  const streamWarn = await call("offload_submit_task", { ...brief, task: "Stream brief PARTIAL coverage", paths: ["a.txt", "sub"], backend: "stream", tier: "low" });
  assert.ok(!streamWarn.isError, textOf(streamWarn));
  assert.match(textOf(streamWarn), /Warning: Scope is large \(2 files/, textOf(streamWarn));
  const streamId = (streamWarn.structuredContent as { job_id: string }).job_id;
  const streamDone = await status(streamId);
  assert.match(streamDone, /\*\*succeeded\*\*[\s\S]*model mock-low/, streamDone);
  assert.match(streamDone, /worker used 1,234 tokens/, streamDone);
  assert.match(streamDone, /Coverage \(tool events\): opened 1 of 2 file\(s\) in scope; not opened: sub\/b\.txt/, streamDone);
  assert.match(streamDone, /model=mock-low/, streamDone);
  check("stream backend: tier picks the model, scope warning, tokens and coverage from tool events");

  const followRes = await call("offload_followup", { job_id: streamId, message: "What does a.txt line 1 say?" });
  assert.ok(!followRes.isError, textOf(followRes));
  const followId = (followRes.structuredContent as { job_id: string }).job_id;
  const parentConv = JSON.parse(readFileSync(path.join(jobsDir, streamId, "job.json"), "utf8")).conversationId as string;
  const followDone = await status(followId);
  assert.match(followDone, new RegExp(`follow-up to ${streamId}[\\s\\S]*Follow-up answered in conversation ${parentConv}`), followDone);
  assert.match(readFileSync(path.join(jobsDir, followId, "prompt.md"), "utf8"), /^FOLLOW-UP from the orchestrator/);
  const noResume = await call("offload_followup", { job_id: id, message: "This backend cannot resume" });
  assert.equal(noResume.isError, true);
  check("offload_followup continues the worker's conversation; refused for backends without resumeArgs");

  const askDone = await status(await submit({ task: "ASK_ME blocked on a decision", paths: ["a.txt"], backend: "stream" }));
  assert.match(askDone, /Worker asks: Which auth helper should count as a login check\?[\s\S]*offload_followup/, askDone);
  check("an ASK: line becomes a question for the orchestrator");

  const dirtyId = await submit({ task: "LEAK_SECRET and INJECT in the report", paths: ["a.txt"], backend: "stream" });
  const dirtyDone = await status(dirtyId);
  assert.match(dirtyDone, /1 secret-looking value\(s\) were masked/, dirtyDone);
  assert.match(dirtyDone, /reads like instructions to an agent \(ignore previous instructions[\s\S]*pipe-to-shell/, dirtyDone);
  const dirtyFindings = textOf(await call("offload_get_result", { job_id: dirtyId, part: "findings" }));
  // Same fake key as scripts/mock-agent.mjs, assembled so the source holds no key-shaped string.
  const fakeKey = ["AI", "za", "FAKE", "TESTONLY".repeat(4)].join("");
  assert.match(dirtyFindings, new RegExp(`${fakeKey.slice(0, 6)}…\\[redacted\\]`), dirtyFindings);
  assert.ok(!dirtyFindings.includes(fakeKey), dirtyFindings);
  check("masks secrets and flags instruction-like text in reports");

  const quotaDone = await status(await submit({ task: "QUOTA exhausted", backend: "stream" }));
  assert.match(quotaDone, /\*\*failed\*\*[\s\S]*quota or rate limit was reached\. Do not resubmit/, quotaDone);
  check("reports an exhausted worker quota without suggesting a retry");

  const stallDone = textOf(await call("offload_get_status", { job_id: await submit({ task: "STALL forever", backend: "stream" }), wait_sec: 40 }));
  assert.match(stallDone, /\*\*timed_out\*\*[\s\S]*sent no event for 5s/, stallDone);
  check("stops a stream worker that goes silent (stallSec)");

  const reuseBrief = { task: "Reuse this finished brief", paths: ["a.txt"], backend: "stream" };
  const firstId = await submit(reuseBrief);
  await status(firstId);
  const again = await call("offload_submit_task", { ...brief, ...reuseBrief });
  assert.equal((again.structuredContent as { job_id: string; reused: boolean }).reused, true, textOf(again));
  assert.equal((again.structuredContent as { job_id: string }).job_id, firstId);
  assert.match(textOf(again), /Reused job/);
  const forced = await call("offload_submit_task", { ...brief, ...reuseBrief, reuse: false });
  assert.notEqual((forced.structuredContent as { job_id: string }).job_id, firstId);
  await status((forced.structuredContent as { job_id: string }).job_id);
  check("reuses a finished job for the same brief over unchanged files; reuse=false runs again");

  const noTier = await call("offload_submit_task", { ...brief, task: "Tier on a backend without modelArgs", tier: "high" });
  assert.equal(noTier.isError, true);
  assert.match(textOf(noTier), /no "modelArgs"/);
  check("tier needs a backend with modelArgs");

  const nested = new Client({ name: "offload-smoke-nested", version: "1.0.0" });
  await nested.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    cwd: workspace,
    env: { ...getDefaultEnvironment(), OFFLOAD_CONFIG: configFile, OFFLOAD_CHILD: "1" }
  }));
  const nestedRes = (await nested.callTool({ name: "offload_submit_task", arguments: { ...brief, task: "Nested delegation attempt" } })) as Result;
  await nested.close();
  assert.equal(nestedRes.isError, true);
  assert.match(textOf(nestedRes), /nested delegation is refused/);
  check("refuses jobs when the server itself runs inside a worker");

  const { parseTiers } = await import(pathToFileURL(path.join(root, "dist", "doctor.js")).href);
  assert.deepEqual(parseTiers("gemini-3.8-flash-high\tx\ngemini-3.8-flash-medium\tx\ngemini-3.8-flash-low\tx\ngemini-3.10-flash-low\tx\ngemini-3.10-flash-medium\tx\ngemini-3.10-flash-high\tx\nclaude-sonnet-4-6\tx\n"),
    { low: "gemini-3.10-flash-low", medium: "gemini-3.10-flash-medium", high: "gemini-3.10-flash-high" });
  assert.deepEqual(parseTiers("gemini-3.10-flash-low\nx\ngemini-3.9-flash-low\ngemini-3.9-flash-medium\ngemini-3.9-flash-high\n")?.low, "gemini-3.9-flash-low");
  assert.equal(parseTiers("claude-sonnet-4-6\n"), null);
  check("picks the newest complete Gemini Flash tier family (numeric version order)");

  // The brief: required parts, prompt layout, and the Step log check
  const noSteps = await call("offload_submit_task", { task: "A task without steps or output shape" });
  assert.equal(noSteps.isError, true, textOf(noSteps));
  assert.match(done, /Brief check: all 2 step\(s\) reported done/, done);
  const promptFile = readFileSync(path.join(jobsDir, id, "prompt.md"), "utf8");
  assert.match(promptFile, /GOAL:\nSummarize the two text files please\n[\s\S]*STEPS:\n1\. Read every file in scope\.\n2\. List each focus path as one finding\.\n[\s\S]*DONE WHEN:\nEvery focus path is listed\.\n[\s\S]*OUTPUT SHAPE[^\n]*\nbullets: focus path\n[\s\S]*## Step log/, promptFile);
  const ctxId = await submit({
    task: "SKIP_STEP brief with context and exclusions",
    steps: ["Read a.txt.", "Read the file named missing.txt."],
    context: "a.txt holds one line.",
    exclude: ["sub/"]
  });
  const ctxStatus = textOf(await call("offload_get_status", { job_id: ctxId, wait_sec: 30 }));
  assert.match(ctxStatus, /step\(s\) 2 of 2 not fully done/, ctxStatus);
  const ctxPrompt = readFileSync(path.join(jobsDir, ctxId, "prompt.md"), "utf8");
  assert.match(ctxPrompt, /CONTEXT[^\n]*\na\.txt holds one line\.\n[\s\S]*EXCLUDE[^\n]*\n- sub\//, ctxPrompt);
  assert.match(textOf(await call("offload_get_result", { job_id: ctxId, part: "steps" })), /2\. not done/);
  check("requires a full brief, lays it out for the worker, and flags steps not done");

  // Prompt passed as an argument
  const argId = await submit({ task: "Same task, prompt as argument", paths: ["a.txt"], backend: "mockarg" });
  assert.match(textOf(await call("offload_get_status", { job_id: argId, wait_sec: 30 })), /succeeded[\s\S]*read 1 focus/);
  check("arg backend succeeds");

  // Path containment
  const escape = await call("offload_submit_task", { ...brief, task: "Read a file outside the workspace", paths: ["../outside.txt"] });
  assert.equal(escape.isError, true);
  assert.match(textOf(escape), /outside the workspace/);
  const outsideWs = await call("offload_submit_task", { ...brief, task: "Use a workspace outside the roots", workspace: temp });
  assert.equal(outsideWs.isError, true);
  check("rejects paths and workspaces outside the allowed roots");

  // Missing backend command
  const missingId = await submit({ task: "This backend does not exist", backend: "missing" });
  assert.match(textOf(await call("offload_get_status", { job_id: missingId, wait_sec: 30 })), /failed[\s\S]*not found/);
  check("reports a missing backend command");

  const noAgent = await call("offload_submit_task", { ...brief, task: "agy without its worker agent installed", backend: "noagent" });
  assert.equal(noAgent.isError, true, textOf(noAgent));
  assert.match(textOf(noAgent), /offload-smoke-missing-agent\.md is missing[\s\S]*npx -y offload-mcp-server setup/);
  check("refuses an agy job when the worker agent is not installed");

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

  // A second server sharing the jobs folder must not mark another live server's job as interrupted
  const liveId = "20200101000000-a11ve0";
  const deadId = "20200101000000-dead00";
  for (const [id, serverPid] of [[liveId, process.pid], [deadId, 2147483646]] as const) {
    mkdirSync(path.join(jobsDir, id));
    writeFileSync(path.join(jobsDir, id, "job.json"), JSON.stringify({ id, status: "running", task: "shared", backend: "mock", workspace, paths: [], timeoutSec: 60, createdAt: "2020-01-01T00:00:00.000Z", serverPid }));
  }
  const peer = new Client({ name: "offload-smoke-second", version: "1.0.0" });
  await peer.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    cwd: workspace,
    env: { ...getDefaultEnvironment(), OFFLOAD_CONFIG: configFile }
  }));
  await peer.close();
  const statusOf = (id: string) => JSON.parse(readFileSync(path.join(jobsDir, id, "job.json"), "utf8")).status;
  assert.equal(statusOf(liveId), "running");
  assert.equal(statusOf(deadId), "interrupted");
  rmSync(path.join(jobsDir, liveId), { recursive: true });
  check("a new server leaves jobs of a live server alone and interrupts those of a dead one");

  // The dashboard CLI on a fresh install, before any server has created the jobs folder
  const freshJobs = path.join(temp, "fresh-jobs");
  const freshConfig = path.join(temp, "fresh-config.json");
  writeFileSync(freshConfig, JSON.stringify({ jobsDir: freshJobs }));
  const fresh = spawn(process.execPath, [path.join(root, "dist", "index.js"), "dashboard", "--no-open", "--port", "0"], {
    env: { ...process.env, OFFLOAD_CONFIG: freshConfig }, stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    const output = await new Promise<string>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error(`dashboard did not start: ${text}`)), 10_000);
      const onData = (chunk: Buffer) => {
        text += chunk.toString();
        if (/http:\/\/127\.0\.0\.1:\d+/.test(text)) { clearTimeout(timer); resolve(text); }
      };
      fresh.stdout.on("data", onData);
      fresh.stderr.on("data", onData);
      fresh.on("exit", code => { clearTimeout(timer); reject(new Error(`dashboard exited with ${code}: ${text}`)); });
    });
    assert.doesNotMatch(output, /ENOENT/);
    assert.ok(existsSync(path.join(freshJobs, ".dashboard.json")));
  } finally {
    fresh.removeAllListeners("exit");
    fresh.kill();
  }
  check("dashboard CLI creates a missing jobs folder");

  // ---- 0.4.0: dashboard ----
  const { startDashboard, runningDashboard } = await import(pathToFileURL(path.join(root, "dist", "dashboard.js")).href);
  const dash = await startDashboard({ jobsDir, port: 0, packageRoot: root, version: "test", token: "smoke-token-123" });
  const origin = `http://127.0.0.1:${dash.port}`;
  const req = (method: string, route: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: dash.port, path: route, method, headers: { Host: `127.0.0.1:${dash.port}`, ...headers } }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      });
      r.on("error", reject);
      r.end();
    });
  try {
    assert.equal((await req("GET", "/")).status, 401);
    assert.equal((await req("GET", "/api/jobs")).status, 401);
    assert.equal((await req("GET", "/?t=wrong-token")).status, 401);
    const login = await req("GET", "/?t=smoke-token-123");
    assert.equal(login.status, 302);
    assert.match(String(login.headers["set-cookie"]), /HttpOnly; SameSite=Strict/);
    const cookie = String(login.headers["set-cookie"]?.[0]).split(";")[0]!;
    const page = await req("GET", "/", { Cookie: cookie });
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);
    assert.equal((await req("GET", "/api/jobs", { Cookie: cookie, Host: "evil.example" })).status, 403);
    assert.equal((await req("GET", "/app.js")).status, 200);
    assert.equal((await req("GET", "/i18n.js")).status, 200);
    const listed = JSON.parse((await req("GET", "/api/jobs", { Cookie: cookie })).body) as { jobs: { id: string; stale?: boolean }[] };
    assert.ok(listed.jobs.some(job => job.id === streamId), "dashboard list misses the stream job");
    check("dashboard: one-time token becomes a cookie; 127.0.0.1 Host only; lists jobs");

    type Entry = { kind: string; name?: string; target?: string; state?: string; text?: string };
    const det = JSON.parse((await req("GET", `/api/jobs/${streamId}`, { Cookie: cookie })).body) as { scope: string[]; report: string; timeline: { entries: Entry[] } };
    assert.deepEqual(det.scope, ["a.txt", "sub/b.txt"]);
    assert.ok(det.timeline.entries.some(e => e.kind === "tool" && e.name === "read_file" && /a\.txt$/.test(e.target ?? "")), JSON.stringify(det.timeline));
    assert.ok(det.timeline.entries.some(e => e.kind === "say" && e.text === "Reading the files in scope."), JSON.stringify(det.timeline));
    assert.ok(det.timeline.entries.some(e => e.kind === "end" && e.state === "SUCCESS"), JSON.stringify(det.timeline));
    assert.match(det.report, /## Summary/);
    assert.equal((await req("GET", "/api/jobs/..%2F..%2Fconfig.json", { Cookie: cookie })).status, 404);
    check("dashboard: job detail carries scope, timeline (tool steps, prose, result) and report; odd ids are 404");

    const dashSlow = await submit({ task: "SLOW_MODE cancelled from the dashboard" });
    await new Promise(resolve => setTimeout(resolve, 1_500));
    assert.equal((await req("POST", `/api/jobs/${dashSlow}/cancel`, { Cookie: cookie, "X-Offload": "1" })).status, 403);
    assert.equal((await req("POST", `/api/jobs/${dashSlow}/cancel`, { Cookie: cookie, Origin: origin })).status, 403);
    assert.equal((await req("POST", `/api/jobs/${dashSlow}/cancel`, { Cookie: cookie, Origin: origin, "X-Offload": "1" })).status, 202);
    assert.match(textOf(await call("offload_get_status", { job_id: dashSlow, wait_sec: 20 })), /\*\*cancelled\*\*/);
    assert.equal((await req("POST", `/api/jobs/${dashSlow}/cancel`, { Cookie: cookie, Origin: origin, "X-Offload": "1" })).status, 409);
    check("dashboard: cancel needs the page's Origin and X-Offload header; the owning server stops the job");

    const ghost = "20200101000000-abcdef";
    mkdirSync(path.join(jobsDir, ghost));
    writeFileSync(path.join(jobsDir, ghost, "job.json"), JSON.stringify({ id: ghost, status: "running", task: "ghost", backend: "mock", workspace, paths: [], timeoutSec: 60, createdAt: "2020-01-01T00:00:00.000Z", serverPid: 2147483646 }));
    const ghostList = JSON.parse((await req("GET", "/api/jobs?limit=1000", { Cookie: cookie })).body) as { jobs: { id: string; stale?: boolean }[] };
    assert.equal(ghostList.jobs.find(job => job.id === ghost)?.stale, true);
    check("dashboard: marks running jobs whose server has exited");
  } finally {
    await dash.close();
  }

  // The page's translations: every language has every English key, with the same {placeholders}.
  await import(pathToFileURL(path.join(root, "dashboard", "i18n.js")).href);
  const dictionaries = (globalThis as unknown as { OFFLOAD_I18N: Record<string, Record<string, string>> }).OFFLOAD_I18N;
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(",");
  const LANGS = ["en", "zh", "zh-TW", "ja", "ko", "vi", "es", "fr", "de", "pt-BR", "ru"];
  assert.deepEqual(Object.keys(dictionaries).sort(), [...LANGS].sort());
  for (const [lang, dict] of Object.entries(dictionaries)) {
    for (const [key, english] of Object.entries(dictionaries.en!)) {
      assert.ok(typeof dict[key] === "string" && dict[key]!.length > 0, `${lang} lacks "${key}"`);
      assert.equal(placeholders(dict[key]!), placeholders(english), `${lang}.${key} placeholders differ from English`);
    }
    assert.deepEqual(Object.keys(dict).filter(key => !(key in dictionaries.en!)), [], `${lang} has keys English lacks`);
  }
  const appSource = readFileSync(path.join(root, "dashboard", "app.js"), "utf8") + readFileSync(path.join(root, "dashboard", "index.html"), "utf8");
  for (const m of appSource.matchAll(/\bt(?:Nodes)?\("(\w+)"|data-i18n(?:-placeholder|-title)?="(\w+)"/g)) {
    assert.ok((m[1] ?? m[2])! in dictionaries.en!, `dashboard uses an unknown string key "${m[1] ?? m[2]}"`);
  }
  check("dashboard page: 11 languages, each with every string and the same placeholders");

  // The CLI: starts once per jobs folder, prints the URL, and servers mention it on submit.
  const dashCli = spawn(process.execPath, [path.join(root, "dist", "index.js"), "dashboard", "--port", "0", "--no-open"], {
    env: { ...process.env, OFFLOAD_CONFIG: configFile }, stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`dashboard CLI printed no URL: ${out}`)), 15_000);
      dashCli.stdout.on("data", chunk => {
        out += chunk;
        const m = /Dashboard: (http:\/\/127\.0\.0\.1:\d+\/\?t=\S+)/.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      dashCli.on("exit", code => reject(new Error(`dashboard CLI exited (${code}): ${out}`)));
    });
    assert.equal(runningDashboard(jobsDir)?.url, url);
    const again = spawnSync(process.execPath, [path.join(root, "dist", "index.js"), "dashboard", "--no-open"], { env: { ...process.env, OFFLOAD_CONFIG: configFile }, encoding: "utf8" });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, new RegExp(`already running: ${url.replace(/[?]/g, "\\?")}`), again.stdout);
    const liveRes = await call("offload_submit_task", { ...brief, task: "Submit while the dashboard runs", paths: ["a.txt"] });
    assert.match(textOf(liveRes), new RegExp(`Live view \\(for the user\\): ${url.replace(/[?]/g, "\\?")}`), textOf(liveRes));
    await call("offload_get_status", { job_id: (liveRes.structuredContent as { job_id: string }).job_id, wait_sec: 30 });
    check("dashboard CLI: one per jobs folder (a second call reuses it); submit points the user to it");
  } finally {
    dashCli.kill();
  }

  const list = textOf(await call("offload_get_status", {}));
  assert.ok(list.split("\n").length >= 6, list);
  check("lists recent jobs");

  const unknown = await call("offload_get_result", { job_id: "nope" });
  assert.equal(unknown.isError, true);
  check("unknown job is a tool error");

  // setup, in a throwaway home directory
  const home = path.join(temp, "home");
  mkdirSync(home);
  const setupEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete setupEnv.OFFLOAD_CONFIG;
  const setup = (...args: string[]) => {
    const run = spawnSync(process.execPath, [path.join(root, "dist", "index.js"), "setup", "--no-claude", "--agy", process.execPath, ...args], { env: setupEnv, encoding: "utf8" });
    return { code: run.status, out: `${run.stdout}${run.stderr}` };
  };
  const agentFile = path.join(home, ".gemini", "agents", "offload-reader.md");
  const skillFile = path.join(home, ".claude", "skills", "offload", "SKILL.md");
  const userConfig = path.join(home, ".offload", "config.json");

  const dry = setup("--dry-run");
  assert.equal(dry.code, 0, dry.out);
  assert.ok(!existsSync(agentFile) && !existsSync(userConfig), "dry run wrote files");
  const first = setup();
  assert.equal(first.code, 0, first.out);
  assert.equal(readFileSync(agentFile, "utf8"), readFileSync(path.join(root, "agents", "offload-reader.md"), "utf8"));
  assert.equal(readFileSync(skillFile, "utf8"), readFileSync(path.join(root, "skills", "offload", "SKILL.md"), "utf8"));
  const written = JSON.parse(readFileSync(userConfig, "utf8"));
  assert.equal(written.backends.agy.command, process.execPath.split(path.sep).join("/"));
  assert.match(first.out, /claude mcp add --scope user offload -- node /, first.out);
  writeFileSync(agentFile, "edited by hand\n");
  const second = setup();
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /Claude Code skill: up to date/, second.out);
  assert.match(second.out, /Config: kept existing/, second.out);
  assert.equal(readFileSync(`${agentFile}.bak`, "utf8"), "edited by hand\n");
  assert.equal(setup("--bogus").code, 2);
  check("setup installs agent, skill and config, is idempotent, backs up changed files");

  const legacy = { defaultBackend: "agy", backends: { agy: { command: "C:/x/agy.exe", args: ["--agent", "offload-reader", "--output-format", "json", "--print-timeout", "{timeoutSec}s", "-p", "{prompt}"], promptVia: "arg", outputJsonPath: "response", usageJsonPath: "usage.total_tokens", timeoutSec: 777 } } };
  writeFileSync(userConfig, JSON.stringify(legacy));
  const upgrade = setup();
  assert.equal(upgrade.code, 0, upgrade.out);
  assert.match(upgrade.out, /upgraded the agy backend to stream-json/, upgrade.out);
  const upgraded = JSON.parse(readFileSync(userConfig, "utf8")).backends.agy;
  assert.equal(upgraded.streamFormat, "agy");
  assert.equal(upgraded.command, "C:/x/agy.exe");
  assert.equal(upgraded.timeoutSec, 777);
  assert.ok(upgraded.args.includes("--disable-slash-commands") && upgraded.args.includes("stream-json"));
  assert.equal(upgraded.outputJsonPath, undefined);
  assert.equal(JSON.parse(readFileSync(`${userConfig}.bak`, "utf8")).backends.agy.timeoutSec, 777);
  check("setup upgrades a 0.2 agy config to stream-json, keeping the user's command and timeout");

  // Reading an existing Claude Code registration (format of `claude mcp get offload`)
  const { parseRegistration } = await import(pathToFileURL(path.join(root, "dist", "setup.js")).href);
  const plain = "offload:\n  Scope: User config\n  Status: ✔ Connected\n  Type: stdio\n  Command: node\n  Args: D:\\Tool\\offload-mcp-server\\dist\\index.js\n  Environment:\n\nTo remove this server, run: claude mcp remove offload -s user\n";
  assert.deepEqual(parseRegistration(plain), { launch: "node D:/Tool/offload-mcp-server/dist/index.js", hasEnv: false });
  const withEnv = plain.replace("  Environment:\n", "  Environment:\n    OFFLOAD_CONFIG=C:/x.json\n");
  assert.equal(parseRegistration(withEnv).hasEnv, true);
  assert.equal(parseRegistration("No MCP server found"), null);
  check("reads an existing Claude Code registration");

  console.error("Smoke test passed");
} finally {
  await client.close();
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
