#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  // stdout carries the protocol, so every human-facing line goes to stderr.
  console.error(`${SERVER_NAME} ${SERVER_VERSION} watching ${config.n8nUrl}`);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(`${SERVER_NAME} failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
