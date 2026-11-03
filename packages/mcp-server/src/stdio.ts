#!/usr/bin/env node
import { createInterface } from "node:readline";
import { handleMcpMessage } from "../../../src/protocols/mcp-server.js";
import { createSandboxMcpServices } from "../../../src/protocols/mcp-sandbox.js";

/**
 * Sandbox MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Tool calls require PAYFLOW_MCP_ACCESS_TOKEN to be set (any non-empty value
 * authenticates the local sandbox only). It never touches a payment provider.
 */
const authenticated = (process.env.PAYFLOW_MCP_ACCESS_TOKEN ?? "").length > 0;
const services = createSandboxMcpServices(() => new Date().toISOString());

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim().length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
    );
    return;
  }
  void handleMcpMessage(parsed, { services, authenticated }).then((reply) => {
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
});
