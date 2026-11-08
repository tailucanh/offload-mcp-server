/** Checks applied to a worker report before the main agent sees it. */
import path from "node:path";

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b\d{8,10}:AA[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
];

/** Replaces values that look like credentials with their first 6 characters. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, match => {
      count++;
      return `${match.slice(0, 6)}…[redacted]`;
    });
  }
  return { text: out, count };
}

const INJECTION_PATTERNS: [string, RegExp][] = [
  ["ignore previous instructions", /\b(ignore|disregard|forget)\b[^\n]{0,20}\b(all |any |the )?(previous|prior|above|earlier)\b[^\n]{0,20}\b(instructions?|prompts?|rules)/i],
  ["new instructions for the agent", /\byou (must|should|will) now\b|\bnew instructions\b|\bsystem prompt\b/i],
  ["pipe-to-shell command", /\b(curl|wget|iwr|irm|Invoke-WebRequest)\b[^\n]*\|\s*(ba|z)?sh\b|\|\s*iex\b/i],
  ["destructive command", /\brm\s+-rf\b|\bdel\s+\/[sq]\b|\bformat\s+[a-z]:/i],
  ["request to run something", /\b(run|execute)\s+(the following|this|these)\s+(command|script|code)s?\b/i],
  ["fake role tags", /<\/?(system|assistant|instructions?)>/i]
];

/** Text in the report that reads like instructions to an agent rather than findings about code. */
export function injectionFlags(text: string): string[] {
  const flags: string[] = [];
  for (const [label, pattern] of INJECTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) flags.push(`${label}: "${match[0].replace(/\s+/g, " ").slice(0, 60)}"`);
  }
  return flags;
}

/** The worker's question when its last non-empty line starts with "ASK:". */
export function askedQuestion(text: string): string | undefined {
  const last = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
  return last && /^ASK:/i.test(last) ? last.replace(/^ASK:\s*/i, "").slice(0, 500) : undefined;
}

export interface Coverage {
  inScope: number;
  opened: number;
  /** In-scope files the worker did not open (first 10). */
  missed: string[];
  /** "tool events" when measured from the worker's tool calls, "report" when taken from its "Files read" section. */
  source: "tool events" | "report";
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/**
 * Compares the in-scope files with the files the worker opened. `opened` holds absolute or
 * workspace-relative paths; matching is by workspace-relative path, case-insensitive.
 */
export function coverage(workspace: string, scope: string[], opened: Iterable<string>, source: Coverage["source"]): Coverage {
  const seen = new Set<string>();
  for (const file of opened) {
    const rel = path.isAbsolute(file) ? path.relative(workspace, file) : file;
    seen.add(norm(rel));
  }
  const missed = scope.filter(file => !seen.has(norm(file)));
  return { inScope: scope.length, opened: scope.length - missed.length, missed: missed.slice(0, 10), source };
}

/** Paths listed in a report's "Files read" section (one per line, bullets and line numbers stripped). */
export function filesFromReport(section: string | undefined): string[] {
  if (!section) return [];
  return section.split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").replace(/`/g, "").trim())
    .map(line => line.replace(/[:#]\d+(?:-\d+)?$/, "").replace(/\s+\(.*\)$/, ""))
    .filter(line => line && !/\s/.test(line));
}
