/**
 * Parser for the Antigravity CLI's `--output-format stream-json` (NDJSON, checked against agy 1.5.3).
 * Events: `init` (conversation_id), `step_update` (one per agent or tool step; a tool step arrives as
 * ACTIVE then DONE or ERROR), and a final `result` (status, response, usage, denied_actions, error).
 */

export interface StreamResult {
  status?: string;
  response?: string;
  error?: string;
  totalTokens?: number;
  deniedActions?: string[];
}

export interface StreamProgress {
  /** Tool calls finished so far. */
  toolCalls: number;
  /** "read_file api/v1/x.php", the latest tool step. */
  lastStep?: string;
  /** Epoch ms of the latest event. */
  lastEventAt: number;
}

/** Tools whose path parameter means "the worker read this file". */
const READ_TOOLS = new Set(["read_file", "view_file", "view_file_outline", "view_code_item"]);
const PATH_KEYS = ["Path", "AbsolutePath", "TargetFile", "File", "DirectoryPath", "SearchPath", "Query", "Pattern", "Url"];

export class AgyStream {
  conversationId?: string;
  result?: StreamResult;
  readonly progress: StreamProgress = { toolCalls: 0, lastEventAt: Date.now() };
  /** Absolute paths the worker opened with a file-reading tool. */
  readonly filesRead = new Set<string>();
  private buffer = "";

  constructor(private readonly onProgress?: () => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.line(line);
    }
  }

  /** Parses whatever is left once the process has exited. */
  end(): void {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) this.line(rest);
  }

  private line(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // agy prints a few non-JSON warnings; they stay in stdout.log.
    }
    this.progress.lastEventAt = Date.now();
    const kind = event["event"];
    if (kind === "init") {
      if (typeof event["conversation_id"] === "string") this.conversationId = event["conversation_id"];
    } else if (kind === "step_update") {
      const step = (event["step_update"] ?? {}) as Record<string, unknown>;
      this.conversationId ??= typeof step["conversation_id"] === "string" ? step["conversation_id"] : undefined;
      if (step["step_type"] === "tool" && step["state"] !== "ACTIVE") this.tool(step);
    } else if (kind === "result") {
      const r = (event["result"] ?? {}) as Record<string, unknown>;
      const usage = (r["usage"] ?? {}) as Record<string, unknown>;
      const total = typeof usage["total_tokens"] === "number"
        ? usage["total_tokens"]
        : (Number(usage["input_tokens"] ?? 0) + Number(usage["output_tokens"] ?? 0)) || undefined;
      const denied = Array.isArray(r["denied_actions"])
        ? (r["denied_actions"] as Record<string, unknown>[]).map(d => String(d["display_name"] ?? d["action"] ?? "?"))
        : [];
      this.result = {
        status: typeof r["status"] === "string" ? r["status"] : undefined,
        response: typeof r["response"] === "string" ? r["response"] : undefined,
        error: typeof r["error"] === "string" ? r["error"] : undefined,
        totalTokens: total,
        deniedActions: denied
      };
      if (typeof r["conversation_id"] === "string") this.conversationId ??= r["conversation_id"];
    }
    this.onProgress?.();
  }

  private tool(step: Record<string, unknown>): void {
    const name = String(step["tool_name"] ?? "tool");
    const params = (((step["tool_info"] ?? {}) as Record<string, unknown>)["parameters"] ?? {}) as Record<string, unknown>;
    const key = PATH_KEYS.find(k => typeof params[k] === "string");
    const target = key ? String(params[key]) : "";
    this.progress.toolCalls++;
    this.progress.lastStep = `${name}${target ? ` ${target}` : ""}${step["state"] === "ERROR" ? " (error)" : ""}`.slice(0, 200);
    if (READ_TOOLS.has(name) && step["state"] === "DONE" && target) this.filesRead.add(target);
  }
}
