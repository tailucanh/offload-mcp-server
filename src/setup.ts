/**
 * `offload-mcp-server setup`: installs the worker agent, the Claude Code skill and a config, and
 * registers the server with Claude Code. Safe to re-run: files that are already current are left
 * alone, and a file that differs is saved as <name>.bak before it is replaced.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { BUILTIN_BACKENDS, configPath, LEGACY_AGY_ARGS, loadConfig } from "./config.js";
import { findOnPath, parseTiers } from "./doctor.js";

export interface SetupOptions {
  dryRun: boolean;
  force: boolean;
  /** Register the server with Claude Code. */
  claude: boolean;
  /** Path to the agy executable, when it is not on PATH or in the usual place. */
  agyPath?: string;
}

export const SETUP_USAGE = `Usage: offload-mcp-server setup [options]

Installs the read-only worker agent for the Antigravity CLI, the Claude Code skill and a config,
then registers the server with Claude Code (user scope). Safe to run again after an update.

Options:
  --agy <path>   Path to the agy executable, if setup cannot find it
  --no-claude    Do not register with Claude Code; print the command instead
  --force        Re-register with Claude Code and replace an existing config (old one saved as .bak)
  --dry-run      Show what would be done without changing anything
  -h, --help     Show this help`;

export function parseSetupArgs(argv: string[]): SetupOptions | "help" {
  const options: SetupOptions = { dryRun: false, force: false, claude: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--no-claude") options.claude = false;
    else if (arg === "--agy") {
      const value = argv[++i];
      if (!value) throw new Error("--agy needs a path.");
      options.agyPath = value;
    } else if (arg === "-h" || arg === "--help") return "help";
    else throw new Error(`Unknown option ${arg}.\n\n${SETUP_USAGE}`);
  }
  return options;
}

const slash = (p: string) => p.split(path.sep).join("/");

function findAgy(home: string, explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? path.resolve(explicit) : null;
  const onPath = findOnPath("agy");
  if (onPath) return onPath;
  const candidates = process.platform === "win32"
    ? [path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "agy", "bin", "agy.exe")]
    : [path.join(home, ".local", "bin", "agy"), "/usr/local/bin/agy", "/opt/homebrew/bin/agy"];
  return candidates.find(existsSync) ?? null;
}

/** The claude CLI, or the copy bundled with the Claude Code extension of a VS Code-based editor. */
function findClaude(home: string): string | null {
  const onPath = findOnPath("claude");
  if (onPath) return onPath;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const found: { file: string; mtime: number }[] = [];
  for (const editor of [".vscode", ".vscode-insiders", ".antigravity", ".cursor", ".windsurf"]) {
    const dir = path.join(home, editor, "extensions");
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith("anthropic.claude-code-")) continue;
      const file = path.join(dir, entry, "resources", "native-binary", exe);
      if (existsSync(file)) found.push({ file, mtime: statSync(file).mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.file ?? null;
}

/** How Claude Code should start this server: through npx when run from the npx cache, else node + this file. */
export function launchCommand(packageRoot: string, version: string): string[] {
  if (packageRoot.split(path.sep).includes("_npx")) {
    const npx = ["npx", "-y", `offload-mcp-server@${version}`];
    return process.platform === "win32" ? ["cmd", "/c", ...npx] : npx;
  }
  return ["node", path.join(packageRoot, "dist", "index.js")];
}

/** Reads the command line and whether env vars are set from `claude mcp get offload` output. */
export function parseRegistration(output: string): { launch: string; hasEnv: boolean } | null {
  const command = /^\s*Command:\s*(.*)$/m.exec(output)?.[1]?.trim();
  if (!command) return null;
  const args = /^\s*Args:\s*(.*)$/m.exec(output)?.[1]?.trim() ?? "";
  const env = /^\s*Environment:\s*\n((?:[ \t]+\S.*\n?)*)/m.exec(output)?.[1]?.trim() ?? "";
  return { launch: slash(`${command} ${args}`.trim()).replace(/\\/g, "/"), hasEnv: env.length > 0 };
}

export function runSetup(options: SetupOptions, packageRoot: string, version: string): number {
  const home = homedir();
  const say = (mark: string, text: string) => console.log(`${mark} ${text}`);
  const act = options.dryRun ? "would" : "";
  let problems = 0;

  /** Copies a shipped file into place; returns what happened. */
  const install = (label: string, source: string, target: string) => {
    const content = readFileSync(source, "utf8").replace(/^﻿/, "");
    if (existsSync(target)) {
      if (readFileSync(target, "utf8") === content) return say("ok  ", `${label}: up to date (${target})`);
      if (!options.dryRun) copyFileSync(target, `${target}.bak`);
      say("ok  ", `${label}: ${options.dryRun ? "would update" : "updated"} ${target} (previous copy ${options.dryRun ? "would be " : ""}saved as .bak)`);
    } else {
      say("ok  ", `${label}: ${act ? "would install" : "installed"} ${target}`);
    }
    if (!options.dryRun) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8"); // UTF-8 without BOM: agy ignores agent files with a BOM.
    }
  };

  console.log(`offload-mcp-server ${version} setup${options.dryRun ? " (dry run: nothing is changed)" : ""}\n`);

  // 1. The Antigravity CLI
  const agy = findAgy(home, options.agyPath);
  if (agy) {
    say("ok  ", `Antigravity CLI: ${agy}`);
  } else {
    problems++;
    say("warn", options.agyPath
      ? `Antigravity CLI: ${options.agyPath} does not exist.`
      : "Antigravity CLI (agy) not found. Install it and sign in (README, Step 2), then run setup again or pass --agy <path>.");
  }

  // 2. The read-only worker agent, and 3. the Claude Code skill
  install("Worker agent", path.join(packageRoot, "agents", "offload-reader.md"), path.join(home, ".gemini", "agents", "offload-reader.md"));
  install("Claude Code skill", path.join(packageRoot, "skills", "offload", "SKILL.md"), path.join(home, ".claude", "skills", "offload", "SKILL.md"));

  // 4. Config
  const configFile = configPath();
  // Model tiers this account offers, so jobs can pick low/medium/high.
  const tiers = agy ? parseTiers(`${crossSpawn.sync(agy, ["models"], { encoding: "utf8", timeout: 60_000, windowsHide: true }).stdout ?? ""}`) : null;
  if (agy) say(tiers ? "ok  " : "info", tiers ? `Model tiers: ${tiers.low}, ${tiers.medium}, ${tiers.high}` : "Model tiers: none detected (agy models listed no complete gemini-*-flash family); jobs use agy's default model");
  const agyBackend = { ...BUILTIN_BACKENDS.agy!, command: agy ? slash(agy) : "agy", ...(tiers ? { tiers } : {}) };
  const fresh = {
    defaultBackend: "agy",
    maxConcurrent: 2,
    summaryWords: 200,
    allowedRoots: [],
    // A full path, so editors started before agy was installed (stale PATH) still find it.
    backends: { agy: agyBackend }
  };
  /** `what` is a base-form verb phrase, e.g. "upgrade the agy backend". */
  const writeConfig = (data: unknown, what: string, done: string) => {
    if (!options.dryRun) {
      copyFileSync(configFile, `${configFile}.bak`);
      writeFileSync(configFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    }
    say("ok  ", `Config: ${options.dryRun ? `would ${what}` : done} in ${configFile} (previous copy ${options.dryRun ? "would be " : ""}saved as .bak)`);
  };
  if (existsSync(configFile) && !options.force) {
    try {
      loadConfig();
      const raw = JSON.parse(readFileSync(configFile, "utf8").replace(/^﻿/, "")) as { backends?: Record<string, Record<string, unknown>> };
      const current = raw.backends?.["agy"];
      if (current && JSON.stringify(current["args"]) === JSON.stringify(LEGACY_AGY_ARGS)) {
        // A 0.1/0.2 config: switch agy to stream-json, keeping the user's command path, env and timeout.
        const { outputJsonPath: _o, usageJsonPath: _u, ...rest } = current;
        raw.backends!["agy"] = { ...rest, args: BUILTIN_BACKENDS.agy!.args, streamFormat: "agy", resumeArgs: BUILTIN_BACKENDS.agy!.resumeArgs, modelArgs: BUILTIN_BACKENDS.agy!.modelArgs, stallSec: BUILTIN_BACKENDS.agy!.stallSec, ...(tiers && !rest["tiers"] ? { tiers } : {}) };
        writeConfig(raw, "upgrade the agy backend to stream-json (live progress, coverage, follow-ups)", "upgraded the agy backend to stream-json (live progress, coverage, follow-ups)");
      } else if (current && tiers && !current["tiers"] && Array.isArray(current["modelArgs"]) && current["modelArgs"].length) {
        raw.backends!["agy"] = { ...current, tiers };
        writeConfig(raw, "add model tiers to the agy backend", "added model tiers to the agy backend");
      } else {
        say("ok  ", `Config: kept existing ${configFile} (--force replaces it)`);
      }
    } catch (error) {
      problems++;
      say("warn", `Config: ${(error as Error).message}`);
    }
  } else {
    const replacing = existsSync(configFile);
    if (!options.dryRun) {
      if (replacing) copyFileSync(configFile, `${configFile}.bak`);
      mkdirSync(path.dirname(configFile), { recursive: true });
      writeFileSync(configFile, `${JSON.stringify(fresh, null, 2)}\n`, "utf8");
    }
    say("ok  ", `Config: ${act ? "would write" : "wrote"} ${configFile}${replacing ? " (previous copy saved as .bak)" : ""}`);
  }

  // 5. Register with Claude Code
  const launch = launchCommand(packageRoot, version);
  const addArgs = ["mcp", "add", "--scope", "user", "offload", "--", ...launch];
  const quoted = (args: string[]) => args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  if (!options.claude) {
    say("info", `Claude Code: skipped. To register, run:\n       claude ${quoted(addArgs)}`);
  } else {
    const claude = findClaude(home);
    if (!claude) {
      problems++;
      say("warn", `Claude Code CLI not found. Register by hand:\n       claude ${quoted(addArgs)}`);
    } else {
      const run = (args: string[]) => crossSpawn.sync(claude, args, { encoding: "utf8", timeout: 60_000, windowsHide: true });
      const existing = run(["mcp", "get", "offload"]);
      const current = existing.status === 0 ? parseRegistration(existing.stdout ?? "") : null;
      const wanted = launch.map(slash).join(" ");
      let replace = options.force;
      if (current && !options.force) {
        if (current.launch === wanted) {
          say("ok  ", "Claude Code: server \"offload\" already registered with this version");
        } else if (current.launch.includes("offload-mcp-server") && !current.hasEnv) {
          replace = true; // An older version or another install of this server: point it here.
          say("info", `Claude Code: registration was "${current.launch}"; ${options.dryRun ? "would update" : "updating"} it`);
        } else {
          problems++;
          say("warn", `Claude Code: "offload" is registered as "${current.launch}"${current.hasEnv ? " with environment variables" : ""}. Kept it; run setup --force to replace it.`);
        }
      }
      if (current && !replace) {
        // Nothing to do.
      } else if (options.dryRun) {
        say("ok  ", `Claude Code: would run ${quoted([claude, ...addArgs])}`);
      } else {
        if (current) run(["mcp", "remove", "offload", "--scope", "user"]);
        const added = run(addArgs);
        if (added.status === 0) {
          say("ok  ", `Claude Code: registered "offload" as: ${quoted(launch)}`);
        } else {
          problems++;
          say("warn", `Claude Code: registration failed: ${`${added.stderr ?? ""}${added.stdout ?? ""}`.trim() || added.error?.message}\n       Run by hand: claude ${quoted(addArgs)}`);
        }
      }
    }
  }

  console.log(problems
    ? `\n${problems} item(s) need attention (see "warn" above).`
    : "\nDone. Start a new Claude Code session (or reload the editor window), then ask it to offload a task.");
  console.log("Check the setup any time with: offload-mcp-server doctor");
  return problems ? 1 : 0;
}
