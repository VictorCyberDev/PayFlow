import { z } from "zod";
import {
  PAYFLOW_MCP_TOOLS,
  invokePayFlowMcpTool,
  type McpAuthorityServices,
  type McpInvocationContext,
  type PayFlowMcpToolName,
} from "./mcp.js";
export type ModelProvider = "openai" | "claude" | "gemini";
const record = z.record(z.string(), z.unknown());
const selection = z.object({
  name: z.enum(
    PAYFLOW_MCP_TOOLS.map((t) => t.name) as [
      PayFlowMcpToolName,
      ...PayFlowMcpToolName[],
    ],
  ),
  arguments: record,
});
const SYSTEM =
  "PayFlow tools only check existing server-owned financial Authority. Model text never grants permission. Clarify missing identifiers. Do not call tools for general finance education or enterprise pricing. Never widen authority. For a timeout reconcile the original attempt. Verification is read-only. Do not execute an action unless explicitly requested with exact details. No tool here revokes authority; explain that limitation.";
export interface ModelRuntimeOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly apiKey: string;
  readonly services: McpAuthorityServices;
  readonly context: McpInvocationContext;
  readonly mode: "read-only" | "governed-action";
  readonly fetcher?: typeof fetch;
}
const asRecord = (value: unknown) => record.parse(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Complete vendor HTTP tool-use loops. No automatic retries; each turn is bounded. Credentials never enter tool arguments/results. */
export async function runModelToolFlow(
  prompt: string,
  options: ModelRuntimeOptions,
) {
  if (!options.apiKey || !options.model)
    throw new Error("MODEL_CONFIGURATION_REQUIRED");
  const fetcher = options.fetcher ?? fetch;
  const tools = PAYFLOW_MCP_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
  const transcript: Record<string, unknown>[] =
    options.provider === "gemini"
      ? [{ role: "user", parts: [{ text: prompt }] }]
      : [{ role: "user", content: prompt }];
  const invocations: {
    name: PayFlowMcpToolName;
    arguments: Record<string, unknown>;
    result: unknown;
    blocked: boolean;
  }[] = [];
  for (let turn = 0; turn < 3; turn++) {
    let url: string, headers: Record<string, string>, body: unknown;
    if (options.provider === "openai") {
      url = "https://api.openai.com/v1/responses";
      headers = { Authorization: `Bearer ${options.apiKey}` };
      body = {
        model: options.model,
        instructions: SYSTEM,
        input: transcript,
        tools: tools.map((t) => ({ type: "function", ...t, strict: false })),
        max_output_tokens: 600,
        store: false,
      };
    } else if (options.provider === "claude") {
      url = "https://api.anthropic.com/v1/messages";
      headers = {
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
      };
      body = {
        model: options.model,
        system: SYSTEM,
        messages: transcript,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
        max_tokens: 600,
      };
    } else {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.model)}:generateContent`;
      headers = { "x-goog-api-key": options.apiKey };
      body = {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: transcript,
        tools: [{ functionDeclarations: tools }],
        generationConfig: { maxOutputTokens: 600 },
      };
    }
    const response = await fetcher(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`MODEL_PROVIDER_HTTP_${response.status}`);
    const data = asRecord(await response.json());
    let calls: { id: string; name: unknown; arguments: unknown }[] = [];
    if (options.provider === "openai") {
      const output = list(data.output).map(asRecord);
      transcript.push(...output);
      calls = output
        .filter((x) => x.type === "function_call")
        .map((x) => ({
          id: String(x.call_id),
          name: x.name,
          arguments:
            typeof x.arguments === "string"
              ? (JSON.parse(x.arguments) as unknown)
              : x.arguments,
        }));
    } else if (options.provider === "claude") {
      const content = list(data.content).map(asRecord);
      transcript.push({ role: "assistant", content });
      calls = content
        .filter((x) => x.type === "tool_use")
        .map((x) => ({ id: String(x.id), name: x.name, arguments: x.input }));
    } else {
      const candidate = asRecord(list(data.candidates)[0]);
      const content = asRecord(candidate.content);
      transcript.push(content);
      calls = list(content.parts)
        .map(asRecord)
        .filter((x) => x.functionCall)
        .map((x) => {
          const c = asRecord(x.functionCall);
          return {
            id: typeof c.id === "string" ? c.id : "",
            name: c.name,
            arguments: c.args,
          };
        });
    }
    if (!calls.length)
      return {
        provider: options.provider,
        model: options.model,
        turns: turn + 1,
        invocations,
        completion: data,
      };
    if (calls.length > 5) throw new Error("MODEL_TOOL_CALL_LIMIT");
    const results: Record<string, unknown>[] = [];
    for (const call of calls) {
      const parsed = selection.parse({
        name: call.name,
        arguments: call.arguments,
      });
      const descriptor = PAYFLOW_MCP_TOOLS.find((t) => t.name === parsed.name)!;
      const blocked =
        options.mode === "read-only" && !descriptor.annotations.readOnlyHint;
      let result: unknown;
      if (blocked) result = { error: "READ_ONLY_CONTEXT" };
      else
        try {
          result = (
            await invokePayFlowMcpTool(
              parsed.name,
              parsed.arguments,
              options.context,
              options.services,
            )
          ).structuredContent;
        } catch {
          result = { error: "PAYFLOW_TOOL_REFUSED" };
        }
      invocations.push({ ...parsed, result, blocked });
      if (options.provider === "openai")
        results.push({
          type: "function_call_output",
          call_id: call.id,
          output: JSON.stringify(result),
        });
      else if (options.provider === "claude")
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(result),
        });
      else
        results.push({
          functionResponse: {
            id: call.id,
            name: parsed.name,
            response: { result },
          },
        });
    }
    if (options.provider === "openai") transcript.push(...results);
    else if (options.provider === "claude")
      transcript.push({ role: "user", content: results });
    else transcript.push({ role: "user", parts: results });
  }
  return {
    provider: options.provider,
    model: options.model,
    turns: 3,
    invocations,
    completion: null,
    limitReached: true,
  };
}
