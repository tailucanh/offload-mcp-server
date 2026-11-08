#!/usr/bin/env node
/**
 * offload-mcp-server: lets an MCP client hand heavy read-only work to a background agent CLI
 * and read back only a compact report. Serves stdio.
 *
 *   offload-mcp-server          run the MCP server
 *   offload-mcp-server doctor   check the config and backend commands
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type Config, loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { JobManager } from "./jobs.js";
import { registerTools } from "./tools.js";

const VERSION = "0.1.0";

if (process.argv[2] === "doctor") {
  process.exit(runDoctor());
}

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`offload-mcp-server: ${(error as Error).message}`);
  process.exit(1);
}
const jobs = new JobManager(config);

function createServer(): McpServer {
  const server = new McpServer({ name: "offload-mcp-server", version: VERSION });
  registerTools(server, jobs, config);
  return server;
}

serveStdio(createServer);
console.error(`offload-mcp-server ${VERSION} on stdio (config: ${config.source}, default backend: ${config.defaultBackend})`);
