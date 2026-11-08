import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface Manifest {
  /** "path (N KB)" lines, workspace-relative with forward slashes. */
  lines: string[];
  total: number;
  /** Every file in scope, workspace-relative with forward slashes. */
  files: string[];
  /** Total size of the files in scope, in bytes. */
  bytes: number;
  /** "size:mtime" per file, for recognising an unchanged scope. */
  stamps: string[];
}

const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn", "__pycache__", ".venv", "venv"]);

/**
 * Lists the files a job may read, so the worker does not have to explore (some agent CLIs have no
 * directory-listing tool in headless mode and wander otherwise). Uses `git ls-files`, which honours
 * .gitignore, and falls back to a directory walk outside git repositories.
 */
export function buildManifest(workspace: string, paths: string[], limit: number): Manifest {
  const scopes = paths.length > 0 ? paths : ["."];
  let files = gitFiles(workspace, scopes);
  if (files === null) {
    files = [];
    for (const scope of scopes) walk(workspace, path.resolve(workspace, scope), files, limit * 4);
  }
  files = [...new Set(files)].sort();
  let bytes = 0;
  const sizes = new Map<string, number>();
  const stamps = files.map(file => {
    try {
      const stat = statSync(path.join(workspace, file));
      bytes += stat.size;
      sizes.set(file, stat.size);
      return `${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
      return "?"; // Listed but unreadable; keep the name.
    }
  });
  const lines = files.slice(0, limit).map(file => {
    const size = sizes.get(file);
    return size === undefined ? file : `${file} (${Math.max(1, Math.ceil(size / 1024))} KB)`;
  });
  return { lines, total: files.length, files, bytes, stamps };
}

function gitFiles(workspace: string, scopes: string[]): string[] | null {
  const result = spawnSync(
    "git",
    ["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scopes],
    { cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.split("\0").filter(file => file && existsSync(path.join(workspace, file)));
}

function walk(workspace: string, target: string, out: string[], max: number): void {
  if (out.length >= max || !existsSync(target)) return;
  const stat = statSync(target);
  if (stat.isFile()) {
    out.push(path.relative(workspace, target).split(path.sep).join("/"));
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (out.length >= max) return;
    if (entry.isDirectory() && (SKIP_DIRS.has(entry.name) || entry.name.startsWith("."))) continue;
    walk(workspace, path.join(target, entry.name), out, max);
  }
}
