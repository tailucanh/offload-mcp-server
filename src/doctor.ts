import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { type Backend, configPath, loadConfig } from "./config.js";

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

/**
 * For an agy backend that names a custom agent (`--agent <name>`), returns where the agent file was
 * expected when it is missing, or null. Without the file, agy silently uses its default agent, which
 * asks for permissions it cannot get headless and ends with an empty answer.
 */
export function missingAgentFile(backend: Backend, workspace?: string): string | null {
  if (!/^agy(\.exe)?$/i.test(path.basename(backend.command))) return null;
  const at = backend.args.indexOf("--agent");
  const name = at >= 0 ? backend.args[at + 1] : undefined;
  if (!name || name.includes("{")) return null;
  const dirs = [path.join(homedir(), ".gemini", "agents"), ...(workspace ? [path.join(workspace, ".gemini", "agents")] : [])];
  return dirs.some(dir => existsSync(path.join(dir, `${name}.md`))) ? null : path.join(dirs[0]!, `${name}.md`);
}

/**
 * The Antigravity account in use, from the last `applyAuthResult` line of agy's log (more reliable than
 * ~/.gemini/google_accounts.json, which can name a stale account).
 */
export function agyAccount(home = homedir()): { email: string; authMethod: string; quotaProject: string } | null {
  const log = path.join(home, ".gemini", "antigravity-cli", "cli.log");
  if (!existsSync(log)) return null;
  const matches = [...readFileSync(log, "utf8").matchAll(/applyAuthResult: email=([^,\s]*), authMethod=([^,\s]*), quotaProject=(\S*)/g)];
  const last = matches.at(-1);
  return last ? { email: last[1]!, authMethod: last[2]!, quotaProject: last[3]! } : null;
}

/** Picks the newest `gemini-X.Y-flash` family that offers low, medium and high from `agy models` output. */
export function parseTiers(output: string): { low: string; medium: string; high: string } | null {
  const families = new Map<string, Set<string>>();
  for (const match of output.matchAll(/^(gemini-(\d+(?:\.\d+)*)-flash)-(low|medium|high)\b/gm)) {
    const set = families.get(match[1]!) ?? new Set<string>();
    set.add(match[3]!);
    families.set(match[1]!, set);
  }
  const version = (family: string) => family.replace(/^gemini-|-flash$/g, "").split(".").map(Number);
  const newer = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return false;
  };
  let best: string | undefined;
  for (const [family, tiers] of families) {
    if (tiers.size === 3 && (!best || newer(version(family), version(best)))) best = family;
  }
  return best ? { low: `${best}-low`, medium: `${best}-medium`, high: `${best}-high` } : null;
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
    console.log(`  output:  ${backend.streamFormat ? `${backend.streamFormat} stream (live progress, coverage, stall after ${backend.stallSec}s)` : "single answer"}; follow-ups: ${backend.resumeArgs.length ? "yes" : "no"}; tiers: ${backend.tiers ? Object.entries(backend.tiers).map(([k, v]) => `${k}=${v}`).join(", ") : "none"}`);
    if (backend.streamFormat === "agy" && JSON.stringify(backend.args).includes('"json"')) {
      console.log("  NOTE: streamFormat is agy but args ask for --output-format json; use stream-json (run setup --force to rewrite the config).");
    }
    if (!found) {
      problems++;
      continue;
    }
    const agentFile = missingAgentFile(backend);
    if (agentFile) {
      console.log(`  PROBLEM: worker agent file ${agentFile} is missing. Run: npx -y offload-mcp-server setup`);
      problems++;
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
  const account = agyAccount();
  if (account) {
    const email = account.email.replace(/^(.{2}).*(@.*)$/, "$1…$2");
    const billing = account.quotaProject
      ? `pay-as-you-go through GCP project ${account.quotaProject} (no daily quota wall)`
      : account.authMethod === "consumer" ? "personal subscription (a daily quota can run out mid-task)" : `authMethod ${account.authMethod}`;
    console.log(`\nAntigravity account: ${email}, ${billing}`);
  } else if (Object.values(config.backends).some(b => /agy/i.test(path.basename(b.command)))) {
    console.log("\nAntigravity account: unknown (no sign-in recorded; run agy once and sign in)");
  }
  console.log(problems ? `\n${problems} backend problem(s).` : "\nAll backends found.");
  return problems ? 1 : 0;
}
