// The raw model APIs (OpenAI Responses, Anthropic Messages, Gemini). Type-checked in CI; not run there.
import { PayFlowClient } from "../src/index.js";
import { createPayFlowToolkit } from "../src/tools.js";
import {
  anthropicTools,
  geminiTools,
  handleAnthropicToolUse,
  handleGeminiCall,
  handleOpenAiCall,
  openAiTools,
} from "../src/frameworks/wire.js";

const toolkit = createPayFlowToolkit({
  client: new PayFlowClient({
    baseUrl: process.env.PAYFLOW_URL ?? "https://payflow.example",
    accessToken: process.env.PAYFLOW_TOKEN ?? "",
  }),
  authority: process.env.PAYFLOW_AUTHORITY ?? "",
  agent: process.env.PAYFLOW_AGENT ?? "",
});

// 1. Send the tool definitions with your request:   openAiTools(toolkit) | anthropicTools(toolkit) | geminiTools(toolkit)
export const definitions = {
  openai: openAiTools(toolkit),
  anthropic: anthropicTools(toolkit),
  gemini: geminiTools(toolkit),
};
// 2. When the model returns a tool call, hand it to the matching handler and send the result back unchanged.
export const handlers = {
  openai: (call: { call_id: string; name: string; arguments: string }) =>
    handleOpenAiCall(toolkit, call),
  anthropic: (block: { id: string; name: string; input: unknown }) =>
    handleAnthropicToolUse(toolkit, block),
  gemini: (call: { id?: string; name: string; args?: unknown }) =>
    handleGeminiCall(toolkit, call),
};
