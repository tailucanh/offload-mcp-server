# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/tailucanh/offload-mcp-server/security/advisories/new).

Include what you found, how to reproduce it, and the version or commit you tested. You will get an
answer within 7 days. Once a fix is released, the advisory is published with credit to you unless you
prefer otherwise.

## Scope

In scope: anything that lets a task, a workspace or a file read by the worker make the server run a
command, read or write outside the workspace, or load a config the user did not choose.

Out of scope: what a worker CLI or its model provider does with the files it is given (see
"Security model" in the README), and prompt injection that only changes the worker's report, which the
main agent is told to verify.
