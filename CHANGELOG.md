# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version may change the tool inputs.

## [Unreleased]

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

[Unreleased]: https://github.com/tailucanh/offload-mcp-server/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tailucanh/offload-mcp-server/releases/tag/v0.1.0
