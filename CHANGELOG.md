# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version may change the tool inputs.

## [Unreleased]

## [0.4.2] - 2026-11-10

### Fixed

- A brief or prompt that holds `$&`, `` $` `` or `$'` (common in code, for example a `replace` call)
  now reaches the worker as written. Before, filling the `{prompt}` placeholder expanded them, so the
  worker got a changed prompt and nothing reported it. (#2, thanks @minhz)
- A prompt that holds a placeholder name (`{workspace}`, `{timeoutSec}`, `{conversationId}`, `{model}`)
  also reaches the worker as written. Before, backends that take the prompt as an argument (the default
  `agy` backend) filled those names inside the prompt too.

## [0.4.1] - 2026-11-09

### Fixed

- `offload-mcp-server dashboard` no longer fails with `ENOENT` on a fresh install, before any server
  has created the jobs folder. (#1, thanks @thanhnguyen293)
- A server that starts while another server sharing the jobs folder is still running (a second
  session or client) no longer marks that server's queued and running jobs as `interrupted`.
  (#1, thanks @thanhnguyen293)
- Jobs run by another session are now live in this one: `offload_get_status` re-reads their record
  (and waits on it) instead of showing the state from startup, jobs created after this server started
  are found, `offload_followup` can continue them, and `offload_cancel_task` asks the owning server to
  stop the worker (the same `cancel.request` the dashboard uses).

## [0.4.0] - 2026-11-08

### Added

- **Local web dashboard**: `npx -y offload-mcp-server dashboard` opens a page that shows every job from
  every session, live: status and elapsed time, a timeline of each file the worker opens (and its own
  remarks), coverage of the files in scope, the worker's question and warnings, the brief and the
  rendered report with `path:line` links that open in VS Code. Running jobs can be cancelled from it.
  - Listens on 127.0.0.1 only; a one-time token from the printed link becomes a `SameSite=Strict`
    cookie; a wrong `Host` header is refused; cancel also needs the page's `Origin` and an `X-Offload`
    header. No new dependencies, no build step for the page.
  - In the same 11 languages as the README (English, 简体中文, 繁體中文, 日本語, 한국어, Tiếng Việt,
    Español, Français, Deutsch, Português (Brasil), Русский): it follows the browser's language, and a
    picker in the header switches it (remembered per browser).
  - One dashboard per jobs folder: running the command again prints and opens the existing one.
  - Jobs whose server has exited are marked instead of showing "running" forever.
- `dashboard` config: `port` (default 7431, the next free port if busy) and `autoOpen` (start the
  dashboard with the first job; the submit result then carries the link for the user).
- Each stream job writes `timeline.ndjson` (one line per tool step, worker remark and final result).
- Jobs record the server's process id, and a server cancels its jobs when the dashboard asks
  (a `cancel.request` file in the job folder).

## [0.3.0] - 2026-11-08

Ideas from reviewing claude-antigravity-skill, agentmemory, caveman and local-llm-stack, re-implemented
here (no code copied).

### Added

- **Stream mode for agy** (`--output-format stream-json`, `streamFormat: "agy"`):
  - live progress in `offload_get_status` (tool calls so far and the latest one);
  - **coverage measured from the worker's tool events**: which in-scope files it never opened;
  - stall detection: a job with no event for `stallSec` (default 300) is stopped;
  - worker token count and refused tool calls from the final `result` event.
- **`offload_followup`**: continue a finished job's worker conversation (`--conversation <id>`) to ask
  about its report or answer its question. The worker keeps what it read, so a follow-up takes seconds.
- **`ASK:` channel**: a worker blocked on a decision ends with `ASK: <question>`; the status shows it.
- **Model tiers**: `tier: low | medium | high` (or `model`) per job. `setup` detects the newest Gemini
  Flash family from `agy models`.
- **Reuse**: an identical brief over unchanged files returns the finished job (`reuse: false` to rerun).
- **Scope warning** at submit time above `scopeWarnKB` (default 600 KB) or the manifest limit.
- **Report hygiene**: secret-looking values masked to 6 characters; instruction-like text flagged.
- **Nested delegation guard**: workers run with `OFFLOAD_CHILD=1`, and a server started under it refuses jobs.
- **Quota errors** (`RESOURCE_EXHAUSTED`, 429) are reported as "do not resubmit now".
- `doctor` shows the Antigravity account and billing mode, the output mode, follow-up support and tiers.
- `npm run try` takes `--tier` and `--followup`, and prints live progress.
- README: FAQ "why not just run `agy -p` from the shell?", new config keys and troubleshooting rows.

### Changed

- The built-in agy backend passes `--disable-slash-commands`, so URL paths such as `/api/v1/...` in a
  brief are not expanded as agy skills or slash commands.
- Stricter citations: `path:LINE` or `path:START-END`, only for lines actually read, and
  `no relevant locations found` instead of guessing.
- `setup` upgrades a 0.1/0.2 agy config (json output) to stream mode, keeping your command path and
  timeout, and adds detected tiers; the previous file is saved as `.bak`.
- The skill explains coverage, follow-ups, `ASK:`, tiers, reuse and the ~20k-token agy preamble.

### Notes

- agy's `init` event lists about 60 tools for every agent. In tests, `offload-reader` used only its
  file-reading tool and did not write a file even when asked to, in default and `--mode plan`.

## [0.2.1] - 2026-11-08

### Added

- `mcpName` in `package.json` and a `server.json`, for the official MCP Registry
  (`io.github.tailucanh/offload-mcp-server`).
- A job for an agy backend is refused, with the setup command in the error, when the worker agent file
  is missing. Before, agy fell back to its default agent and the job ended with an empty answer.
  `doctor` reports the same problem.
- npm version badge in the READMEs.

## [0.2.0] - 2026-11-08

First release on npm: `npx -y offload-mcp-server setup`.

### Added

- `setup` command: finds the Antigravity CLI, installs the `offload-reader` agent and the Claude Code
  skill, writes `~/.offload/config.json` with the full agy path when none exists, and registers the
  server with Claude Code at user scope. It finds the `claude` CLI on PATH or bundled in the Claude
  Code extension of VS Code, Antigravity, Cursor or Windsurf. Re-running is safe: files that are
  current are left alone, changed ones are saved as `.bak` first. Options: `--agy`, `--no-claude`,
  `--force`, `--dry-run`.
- `--help` and `--version`; unknown commands exit with code 2.

### Changed

- The version is read from `package.json` instead of being repeated in the code.
- The published package leaves out source maps and type declarations.
- README quick start uses `npx`; the step-by-step setup stays for doing it by hand.

## [0.1.0] - 2026-11-08

First public release.

### Added

- MCP server over stdio with four tools: `offload_submit_task`, `offload_get_status`,
  `offload_get_result`, `offload_cancel_task`.
- Background job queue with `maxConcurrent`, per-job timeout, cancellation of the whole worker process
  tree, and job records in `~/.offload/jobs/<job_id>/`.
- Built-in backend for the Antigravity CLI (`agy`) and a read-only worker agent, `offload-reader`.
  Any CLI with a non-interactive mode can be added as a backend.
- Structured brief: `task`, `steps`, `output_hint` and `done_when` are required, `context` and
  `exclude` optional. The worker executes the steps literally and returns a Step log; the status shows
  a "Brief check" line naming steps it did not finish.
- File manifest in the worker prompt (`git ls-files`), so the worker reads only the files in scope.
- Fixed report format (Summary, Findings, Step log, Uncertain, Files read); the status carries the
  Summary, the number of files in scope and the worker's token count.
- Safety: path containment with `realpath`, config read only from the home directory or
  `OFFLOAD_CONFIG`, no shell, `git status` change detection, `file://` links stripped from reports.
- `doctor` command, `npm run try` for a real run, smoke test against a mock worker, CI on Ubuntu and
  Windows.
- Claude Code skill `offload` with a brief template and checklist.
- README in 11 languages.

[Unreleased]: https://github.com/tailucanh/offload-mcp-server/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/tailucanh/offload-mcp-server/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/tailucanh/offload-mcp-server/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/tailucanh/offload-mcp-server/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tailucanh/offload-mcp-server/releases/tag/v0.1.0
