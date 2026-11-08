import { existsSync } from "node:fs";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { configPath, loadConfig } from "./config.js";

export function findOnPath(command: string): string | null {
  if (command.includes("/") || command.includes("\\")) return existsSync(command) ? path.resolve(command) : null;
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** cmd.exe ends a command at a newline, so a multi-line prompt argument to a .cmd/.bat would be cut off silently. */
export function needsStdinOnWindows(promptVia: "arg" | "stdin", resolvedCommand: string | null): boolean {
  return process.platform === "win32" && promptVia === "arg" && resolvedCommand !== null && /\.(cmd|bat)$/i.test(resolvedCommand);
}

/** Prints the effective config and checks that each backend command can be found. Exit code 1 on problems. */
export function runDoctor(): number {
  let problems = 0;
  console.log(`Config file: ${configPath()}`);
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.log(`  ERROR ${(error as Error).message}`);
    return 1;
  }
  console.log(`Loaded from: ${config.source}`);
  console.log(`Jobs dir:    ${config.jobsDir}`);
  console.log(`Concurrency: ${config.maxConcurrent}`);
  console.log(`Default:     ${config.defaultBackend}\n`);

  for (const [name, backend] of Object.entries(config.backends)) {
    const found = findOnPath(backend.command);
    console.log(`[${name}] ${backend.command} ${backend.args.join(" ")}  (prompt via ${backend.promptVia}, timeout ${backend.timeoutSec}s)`);
    console.log(`  command: ${found ?? "NOT FOUND on PATH"}`);
    if (!found) {
      problems++;
      continue;
    }
    if (needsStdinOnWindows(backend.promptVia, found)) {
      console.log('  PROBLEM: a .cmd/.bat command cannot take a multi-line prompt as an argument. Set "promptVia": "stdin" or point "command" at the .exe.');
      problems++;
    }
    if (name === config.defaultBackend) {
      const help = crossSpawn.sync(backend.command, ["--help"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
      const out = `${help.stdout ?? ""}${help.stderr ?? ""}`.trim().split(/\r?\n/).slice(0, 40);
      console.log("  --help (first 40 lines; check that the args above match):");
      for (const line of out) console.log(`    ${line}`);
    }
  }
  console.log(problems ? `\n${problems} backend(s) not found.` : "\nAll backends found.");
  return problems ? 1 : 0;
}
