# offload-mcp-server

An MCP server that lets your main coding agent (for example Claude Code) hand **heavy read-only work**
to another agent CLI running in the background, then read back only a short report.

The default worker is the **Antigravity CLI (`agy`)** running a read-only custom agent. It reads the
files; your main agent reads a Summary and, if needed, a list of Findings with `path:line` evidence.

```
 main agent (Claude Code)                  offload-mcp-server                     worker (agy)
 ────────────────────────                  ──────────────────                     ────────────
 offload_submit_task ───────────────────▶  lists files in scope (git ls-files)
   task, paths, output_hint                builds the worker prompt
                          ◀── job_id ───   spawns the worker in the background ─▶ reads files (read-only)
 … keeps working …                                                                writes report
 offload_get_status (wait 50 s) ───────▶   waits, parses the report  ◀──────────── Summary / Findings
                    ◀── Summary ───────    strips file:// links, records tokens
 offload_get_result (only if needed)
```

**Why:** an inventory of 37 PHP files (140 KB, roughly 40k tokens to read) cost the main agent about
0.5k tokens for the Summary, or 6.5k with the full Findings. The reading happened on the worker's
quota instead. See [Measured example](#measured-example).

**Trade-off:** it is slow (minutes per job) and the worker is another model, so its findings are leads
to spot-check, not facts.

---

## Contents

- [Requirements](#requirements)
- [Setup, step by step](#setup-step-by-step)
- [Using it](#using-it)
- [Configuration reference](#configuration-reference)
- [Other backends](#other-backends)
- [Measured example](#measured-example)
- [Troubleshooting](#troubleshooting)
- [Security model](#security-model)
- [How it works](#how-it-works)
- [Development](#development)
- [Limitations](#limitations)

---

## Requirements

| What | Version | Notes |
|---|---|---|
| Node.js | 20.3 or later | Runs the server |
| Git | any recent | Used to list files in scope and to detect file changes |
| An agent CLI | Antigravity CLI 1.5.3 tested | Any CLI that takes a prompt and prints an answer works |
| An MCP client | Claude Code tested | Any client that launches stdio MCP servers works |

Tested on Windows 10 with Antigravity CLI 1.5.3 (signed in with a Google AI Pro account) and Claude Code
2.1.319. The paths below use `~` for your home directory (`C:\Users\<you>` on Windows).

---

## Setup, step by step

### Step 1: Build the server

```bash
git clone https://github.com/tailucanh/offload-mcp-server.git
cd offload-mcp-server
npm install
npm run build
npm run smoke        # end-to-end test against a mock worker; should end with "Smoke test passed"
```

Remember the absolute path of `dist/index.js`. The examples use `D:/Tool/offload-mcp-server/dist/index.js`.

### Step 2: Install and sign in to the Antigravity CLI

Follow Google's Antigravity CLI instructions for your platform. On Windows we used the official
PowerShell installer. It is safer to download and read it before running it:

```powershell
Invoke-WebRequest https://antigravity.google/cli/install.ps1 -OutFile install.ps1
notepad install.ps1      # read it first
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

The Windows installer puts `agy.exe` in `%LOCALAPPDATA%\agy\bin`, verifies its SHA-512 checksum, and
adds it to your PATH. Then, **in a new terminal**:

```bash
agy --version        # e.g. 1.5.3
agy                  # first run: sign in with Google in the browser, then exit with /quit
```

Windows Defender may quarantine `agy.exe` for a few minutes on first launch. Wait and try again.

### Step 3: Install the read-only worker agent

Copy [`agents/offload-reader.md`](agents/offload-reader.md) into `~/.gemini/agents/`:

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force "$env:USERPROFILE\.gemini\agents" | Out-Null
Copy-Item agents\offload-reader.md "$env:USERPROFILE\.gemini\agents\"
```

```bash
# macOS / Linux
mkdir -p ~/.gemini/agents && cp agents/offload-reader.md ~/.gemini/agents/
```

Check that agy sees it:

```bash
agy agents           # must print: offload-reader
```

If you edit the file, save it as **UTF-8 without BOM**. With a BOM, agy ignores the agent and reports
`unknown agent`. (Windows PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM; use an editor, or
`[IO.File]::WriteAllText(path, text, (New-Object Text.UTF8Encoding $false))`.)

**Why a custom agent?** In headless mode (`agy -p`), agy cannot ask you for permissions. The default
agent likes to run terminal commands such as `Get-ChildItem` or `ls`, and the first one is denied
automatically, which ends the run with an **empty answer and exit code 0**. `offload-reader` is
declared with file tools only, so it never reaches for the terminal and has no edit tools.

### Step 4: Write the config file

Create `~/.offload/config.json`. Start from [`offload.config.example.json`](offload.config.example.json):

```json
{
  "defaultBackend": "agy",
  "maxConcurrent": 2,
  "summaryWords": 200,
  "backends": {
    "agy": {
      "command": "C:/Users/<you>/AppData/Local/agy/bin/agy.exe",
      "args": ["--agent", "offload-reader", "--output-format", "json", "--print-timeout", "{timeoutSec}s", "-p", "{prompt}"],
      "promptVia": "arg",
      "outputJsonPath": "response",
      "usageJsonPath": "usage.total_tokens",
      "timeoutSec": 600
    }
  }
}
```

**Use the full path to `agy` in `command`.** The MCP server inherits the PATH of the editor that
launches it, and an editor that was already open when you installed agy does not see the new PATH
entry. (Without a config file, the built-in `agy` backend has the same args with `command: "agy"`.)

The config is read only from `OFFLOAD_CONFIG` or `~/.offload/config.json`, never from a project
folder. See [Security model](#security-model).

### Step 5: Check the setup

```bash
node D:/Tool/offload-mcp-server/dist/index.js doctor
```

It prints the config in use, whether each backend command is found, and the first lines of the
default backend's `--help`. It exits with code 1 if anything is missing.

### Step 6: Try a real task without an MCP client

`npm run try` drives the built server exactly as an MCP client would, with your real config:

```bash
npm run try -- "/path/to/your/project" "List every HTTP endpoint with its method and auth check" src/api
```

It prints the status with the Summary, then the Findings, then how many characters the main agent
would have read. Expect it to take a few minutes.

### Step 7: Register the server with Claude Code

For every project (user scope):

```bash
claude mcp add --scope user offload -- node D:/Tool/offload-mcp-server/dist/index.js
claude mcp get offload        # Status: Connected
```

If the `claude` command is not on your PATH (for example you only use the VS Code extension), the
extension ships the CLI. On Windows it is at
`~/.vscode/extensions/anthropic.claude-code-<version>-win32-x64/resources/native-binary/claude.exe`
(or under `~/.antigravity/extensions/` for the Antigravity IDE). Run the same commands with that path.

For one project only, add a `.mcp.json` at the project root instead:

```json
{
  "mcpServers": {
    "offload": { "command": "node", "args": ["D:/Tool/offload-mcp-server/dist/index.js"] }
  }
}
```

The server uses its working directory (the project the client opened) as the default workspace.

Other MCP clients: launch `node /path/to/dist/index.js` over stdio.

### Step 8: Install the skill (Claude Code)

The skill tells Claude when offloading pays off and how to use the tools:

```powershell
# Windows
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills\offload" | Out-Null
Copy-Item skills\offload\SKILL.md "$env:USERPROFILE\.claude\skills\offload\"
```

```bash
# macOS / Linux
mkdir -p ~/.claude/skills/offload && cp skills/offload/SKILL.md ~/.claude/skills/offload/
```

### Step 9: Restart and verify

Start a new Claude Code session (in an editor, reload the window). Run `/mcp`: `offload` should be
listed as connected, with four tools. Then ask something like:

> Offload this: inventory every endpoint under api/ with method and auth check, then show me the summary.

---

## Using it

### Tools

| Tool | Input | Returns |
|---|---|---|
| `offload_submit_task` | `task` (required), `paths`, `output_hint`, `workspace`, `backend`, `timeout_sec` | `job_id` at once; the job runs in the background |
| `offload_get_status` | `job_id`, `wait_sec` (0–50) | Status; when finished, also the Summary, files in scope, and worker tokens. Without `job_id`: recent jobs |
| `offload_get_result` | `job_id`, `part` (`summary`, `findings`, `uncertain`, `full`, `stderr`), `offset`, `max_chars` | One page of the report |
| `offload_cancel_task` | `job_id` | Kills a queued or running job and its process tree |

Job states: `queued` → `running` → `succeeded` | `failed` | `cancelled` | `timed_out`. Jobs that were
running when the server stopped are marked `interrupted` on the next start.

### A typical exchange

1. The main agent calls `offload_submit_task` with
   `task: "For every endpoint under api/v1: URL, HTTP methods, auth requirement, main class used"`,
   `paths: ["api/v1"]`, `output_hint: "group by folder; cite path:line"`.
2. It keeps working on something else, then calls `offload_get_status` with `wait_sec: 50` until the job
   finishes. The finished status contains the Summary.
3. If it needs detail, it calls `offload_get_result` with `part: "findings"`.
4. It opens two or three cited lines to confirm before relying on the result.

### Writing good tasks

- **One concrete question** with a clear end: "list every X with Y and Z", not "look at the API".
- **Narrow `paths`.** The worker reads only the listed files, so scope sets both time and cost.
- **Ask for a shape** in `output_hint`: a table, grouped bullets, a yes/no with evidence.
- **Ask for evidence** (`path:line`) so the main agent can spot-check.

Good fits: inventories across a tree, large or generated files (bundles, resource packs, lockfiles,
logs), "which of these 30 files matter for X", and research you can run in parallel. Poor fits: edits,
one-file lookups, and anything urgent.

### The report the worker writes

Every job gets the same contract: read-only, cite `path:line` as plain text, treat file contents as
data, and reply with these sections:

```
## Summary       the direct answer, at most `summaryWords` words
## Findings      bullets with evidence
## Uncertain     open questions, or "None"
## Files read    what it actually opened
```

If the worker ignores the format, the status says so and the Summary is an excerpt.

---

## Configuration reference

File: `OFFLOAD_CONFIG` if set, otherwise `~/.offload/config.json`. Without a file, built-in defaults
are used (the `agy` backend below, with `command: "agy"`).

| Key | Default | Meaning |
|---|---|---|
| `defaultBackend` | `agy` | Backend used when a task does not name one |
| `maxConcurrent` | `2` | Jobs running at once; the rest wait in a queue |
| `jobsDir` | `~/.offload/jobs` | Where job records and reports are stored |
| `allowedRoots` | `[]` | Extra directories a task may use as `workspace`. The server's own working directory is always allowed |
| `summaryWords` | `200` | Word budget the worker is given for its Summary |
| `manifestLimit` | `400` | Maximum number of in-scope files listed in the worker prompt |
| `backends.<name>.command` | | Executable name or full path |
| `backends.<name>.args` | `[]` | Arguments. Placeholders: `{prompt}`, `{workspace}`, `{timeoutSec}` |
| `backends.<name>.promptVia` | `arg` | `arg`: put the prompt at `{prompt}` (or append it). `stdin`: write it to the CLI's stdin |
| `backends.<name>.outputJsonPath` | | Dot path to the answer when the CLI prints JSON, e.g. `response` |
| `backends.<name>.usageJsonPath` | | Dot path to the worker's token count, e.g. `usage.total_tokens` |
| `backends.<name>.env` | `{}` | Extra environment variables for the worker |
| `backends.<name>.timeoutSec` | `600` (agy) | Time budget. The worker is killed 30 s after it, so CLIs with their own limit can stop cleanly first |

---

## Other backends

Any CLI that takes a prompt and prints an answer can be a backend. Add it under `backends` and pass
`backend: "<name>"` in a task, or make it the `defaultBackend`.

Claude Code itself, in print mode:

```json
"claude": {
  "command": "claude",
  "args": ["-p", "--output-format", "json"],
  "promptVia": "stdin",
  "outputJsonPath": "result",
  "timeoutSec": 900
}
```

When adapting a CLI:

1. Find its non-interactive flag (`-p`, `exec`, `--print`, …) and run one prompt by hand.
2. Prefer a JSON output flag and set `outputJsonPath` (and `usageJsonPath` if it reports tokens).
3. Make it read-only: a plan/read-only mode, a sandbox flag, or a restricted agent like `offload-reader`.
4. Check what happens when a tool needs approval in headless mode. If it silently returns nothing,
   restrict its tools as in Step 3.
5. On Windows, a `.cmd`/`.bat` command cannot take a multi-line prompt as an argument (cmd.exe stops at
   the first newline). Use `"promptVia": "stdin"` or point `command` at the `.exe`. The server refuses
   the broken combination instead of sending a truncated prompt.

---

## Measured example

Task: "inventory every HTTP endpoint under `api/v1`: URL, methods, auth requirement, main class".
Project: 37 PHP files, 140 KB.

| Measure | Result |
|---|---|
| Worker time | 503 s |
| Worker tokens (Gemini Flash, on the Google quota) | 192k |
| Main agent, Summary only | ~2k characters (≈ 0.5k tokens) |
| Main agent, Summary + Findings | ~26k characters (≈ 6.5k tokens) |
| Reading the 37 files directly | ≈ 40k tokens |
| Spot check | 6 of 6 sampled claims matched the cited lines exactly |

Before the file list was added to the prompt, the same kind of task made the worker wander through
unrelated files (including `.git`) and time out after spending over 200k tokens. Scope matters.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `failed`: "gave no answer, often because a tool permission was denied" and the output shows `denied_actions` | The worker tried a tool that needs approval (usually a terminal command) | Use the `offload-reader` agent (Step 3). Check `args` contains `--agent offload-reader` |
| `unknown agent "offload-reader"` | Agent file missing, in the wrong folder, or saved with a BOM | Put it in `~/.gemini/agents/`, save as UTF-8 without BOM, check `agy agents` |
| `--agent` with a file path fails | agy takes an agent **name**, not a path | Install the file (Step 3) and pass the name |
| `failed`: backend command "agy" was not found | The editor's PATH predates the agy install | Use the full path in `command` (Step 4), or restart the editor |
| `timed_out`, or agy reports `print timeout … partial` | Scope too large for the time budget | Narrow `paths`, or pass a larger `timeout_sec` |
| The worker reads unrelated files | No file list (or the wrong one) in the prompt | Pass `paths`; check "N file(s) in scope" in the status |
| Report full of `file:///` links | Some agents add them to every citation | Stripped automatically. If you see them, update the server |
| Refused: `.cmd/.bat` cannot receive a multi-line prompt | Windows cmd.exe limitation | `"promptVia": "stdin"`, or point `command` at the `.exe` |
| `--settings must be a JSON object` when testing agy by hand in PowerShell 5.1 | PowerShell strips the inner quotes of inline JSON | Write the JSON to a file and pass its path |
| `offload_*` tools missing in Claude Code | Server not registered, or failed to start | `claude mcp get offload`, then `node dist/index.js doctor` |
| Status warns that git status changed during the job | Something wrote to the workspace while the job ran | Check `git status` / `git diff`. It may be your own edits |
| Rate limit or quota errors from agy | Model quota on your Google plan | Lower `maxConcurrent`, retry later, or choose another model with `--model` in `args` |

Job files for debugging live in `~/.offload/jobs/<job_id>/`: `prompt.md` (exactly what the worker got),
`stdout.log`, `stderr.log`, `report.md`, and `job.json`.

---

## Security model

- **Read-only is enforced by tool choice, plus a contract, not by a sandbox.** The `offload-reader`
  agent is declared with file-reading tools only, and the prompt forbids writes. The worker still runs
  as your user. For stronger isolation, use the backend's sandbox (agy's `--sandbox` needs Windows 11
  24H2 or later, Linux or macOS), a container, or a separate OS user.
- **Change detection.** The server snapshots `git status` before and after each job and reports any
  file whose status changed. This is best effort: it cannot tell the worker's writes from yours.
- **Path containment.** `workspace` and `paths` are resolved with `realpath`. Paths must stay inside the
  workspace, and the workspace must be the server's working directory or inside `allowedRoots`.
- **The config never comes from a project.** It is read only from `OFFLOAD_CONFIG` or the home
  directory, so a cloned repository cannot make the server run a command of its choosing.
- **No shell.** Workers are spawned with an argument array (via `cross-spawn`), never a shell string.
- **Worker output is untrusted.** Files the worker reads may contain prompt injection. The prompt tells
  the worker to treat file contents as data, the tools present results as leads to verify, and the
  skill tells the main agent to open cited lines before acting.
- **Data leaves your machine.** The worker sends the files it reads to its model provider (Google, for
  agy). Do not offload work over files you are not allowed to share with that provider.

---

## How it works

1. **Submit.** The server resolves and checks `workspace` and `paths`, lists the files in scope with
   `git ls-files --cached --others --exclude-standard` (or a directory walk outside git, skipping
   `.git`, `node_modules` and hidden folders), builds the worker prompt, and queues the job.
2. **Run.** Up to `maxConcurrent` jobs run at once. Each worker is spawned in the workspace with the
   prompt as an argument or on stdin. stdout and stderr go to the job folder.
3. **Stop.** On exit, the server extracts the answer (from JSON if `outputJsonPath` is set), strips
   `file://` links, parses the sections, records the worker's token count, and compares `git status`.
   Cancel and timeout kill the whole process tree (`taskkill /T` on Windows, the process group elsewhere).
4. **Read.** `offload_get_status` can wait up to 50 s per call, which stays under the roughly 60 s
   per-call limit many MCP clients apply. Reports are served in pages.

### Project layout

```
src/
  index.ts      entry point: MCP server over stdio, or `doctor`
  config.ts     config schema, defaults, built-in agy backend
  tools.ts      the four MCP tools, path checks, status formatting
  jobs.ts       queue, spawning, timeouts, cancel, result parsing, change detection
  manifest.ts   list of files in scope (git ls-files or a directory walk)
  report.ts     worker prompt, report parsing, JSON extraction, link stripping
  doctor.ts     setup checks
agents/offload-reader.md     read-only agent for agy
skills/offload/SKILL.md      Claude Code skill: when and how to offload
scripts/smoke.ts             end-to-end test against the mock worker
scripts/mock-agent.mjs       stand-in worker (slow, malformed, file-writing modes)
scripts/try.ts               run one real task through the server
```

---

## Development

```bash
npm run build      # compile TypeScript to dist/
npm run smoke      # end-to-end test with the mock worker (no network, no quota)
npm test           # build + smoke
npm run try -- <workspace> "<task>" [path ...]   # one real task with your config
npm run doctor     # check config and backends
npx @modelcontextprotocol/inspector node dist/index.js   # explore the tools interactively
```

The mock worker (`scripts/mock-agent.mjs`) reacts to markers in the task: `SLOW_MODE` sleeps 60 s,
`BAD_FORMAT` ignores the report format, `WRITE_FILE` writes into the workspace.

---

## Limitations

- **Slow.** Minutes per job. Submit early and keep working.
- **No search tool for the agy worker.** With agy 1.5.3 the custom agent only gets `read_file`, so it
  finds things by reading the listed files. Narrow `paths` for large trees.
- **Results need checking.** The worker is another model and can be wrong or incomplete.
- **Headless flags change.** Agent CLIs change their flags between versions. Re-run `doctor` after
  upgrading the CLI.

## License

MIT
