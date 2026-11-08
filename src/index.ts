#!/usr/bin/env node
/**
 * offload-mcp-server: lets an MCP client hand heavy read-only work to a background agent CLI
 * and read back only a compact report. Serves stdio.
 *
 *   offload-mcp-server          run the MCP server
 *   offload-mcp-server setup    install the worker agent, skill and config; register with Claude Code
 *   offload-mcp-server doctor   check the config and backend commands
 *   offload-mcp-server dashboard  watch jobs live in a local web page
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type Config, loadConfig } from "./config.js";
import { DASHBOARD_USAGE, parseDashboardArgs, runDashboard } from "./dashboard.js";
import { runDoctor } from "./doctor.js";
import { JobManager } from "./jobs.js";
import { parseSetupArgs, runSetup, SETUP_USAGE } from "./setup.js";
import { registerTools } from "./tools.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION: string = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;

const USAGE = `offload-mcp-server ${VERSION}

Usage:
  offload-mcp-server            Run the MCP server on stdio (this is what Claude Code starts)
  offload-mcp-server setup      Install the worker agent, skill and config; register with Claude Code
  offload-mcp-server doctor     Check the config and the backend commands
  offload-mcp-server dashboard  Watch jobs live in a local web page (127.0.0.1 only)
  offload-mcp-server --version

Docs: https://github.com/tailucanh/offload-mcp-server#readme`;

const [command, ...rest] = process.argv.slice(2);
if (command === "--help" || command === "-h" || command === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (command === "--version" || command === "-v") {
  console.log(VERSION);
  process.exit(0);
}
if (command === "doctor") {
  process.exit(runDoctor());
}
if (command === "setup") {
  try {
    const options = parseSetupArgs(rest);
    if (options === "help") {
      console.log(SETUP_USAGE);
      process.exit(0);
    }
    process.exit(runSetup(options, PACKAGE_ROOT, VERSION));
  } catch (error) {
    console.error(`offload-mcp-server setup: ${(error as Error).message}`);
    process.exit(2);
  }
}
if (command === "dashboard") {
  try {
    const options = parseDashboardArgs(rest);
    if (options === "help") {
      console.log(DASHBOARD_USAGE);
      process.exit(0);
    }
    await runDashboard(options, loadConfig(), PACKAGE_ROOT, VERSION);
  } catch (error) {
    console.error(`offload-mcp-server dashboard: ${(error as Error).message}`);
    process.exit(2);
  }
} else if (command !== undefined) {
  console.error(`Unknown command "${command}".\n\n${USAGE}`);
  process.exit(2);
} else {
  startServer();
}

function startServer(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`offload-mcp-server: ${(error as Error).message}`);
    process.exit(1);
  }
  const jobs = new JobManager(config);
  const createServer = () => {
    const server = new McpServer({ name: "offload-mcp-server", version: VERSION });
    registerTools(server, jobs, config);
    return server;
  };
  serveStdio(createServer);
  console.error(`offload-mcp-server ${VERSION} on stdio (config: ${config.source}, default backend: ${config.defaultBackend})`);
}
