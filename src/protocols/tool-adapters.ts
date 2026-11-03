import { PAYFLOW_MCP_TOOLS } from "./mcp.js";

export function openAiFunctionTools() {
  return PAYFLOW_MCP_TOOLS.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: true,
  }));
}

export function anthropicCompatibleTools() {
  return PAYFLOW_MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export function geminiCompatibleFunctionDeclarations() {
  return PAYFLOW_MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}
