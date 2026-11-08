#!/usr/bin/env node
// Stand-in for a real agent CLI, used by the smoke test. Reads the worker prompt from stdin
// (or the last argument) and prints a report in the expected format.
//   task contains "SLOW_MODE"   -> sleeps 60 s (for cancel/timeout tests)
//   task contains "BAD_FORMAT"  -> ignores the section format
//   task contains "WRITE_FILE"  -> writes a file into the workspace (to test change detection)
import { writeFileSync } from "node:fs";

let prompt = process.argv[2] ?? "";
if (!prompt) {
  for await (const chunk of process.stdin) prompt += chunk;
}

const focus = /FOCUS PATHS[^\n]*\n([\s\S]*?)\n\n/.exec(prompt)?.[1]?.split("\n").filter(Boolean) ?? [];
const files = /FILES IN SCOPE \((\d+) file/.exec(prompt)?.[1] ?? "?";

if (prompt.includes("SLOW_MODE")) await new Promise(resolve => setTimeout(resolve, 60_000));
if (prompt.includes("WRITE_FILE")) writeFileSync("written-by-worker.txt", "oops\n");

if (prompt.includes("BAD_FORMAT")) {
  console.log("Here is some free-form text without the required headings. ".repeat(20));
} else {
  console.log(`## Summary
Mock worker read ${focus.length} focus path(s) and saw ${files} file(s) in scope. See [a.txt](file:///C:/ws/a.txt#L1).
## Findings
- ${focus.join("\n- ")}
## Uncertain
None
## Files read
${focus.join("\n")}`);
}
