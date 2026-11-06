import { z } from "zod";
import {
  toModelText,
  type PayFlowToolkit,
  type PayFlowToolSpec,
} from "../tools.js";

/**
 * Dispatchers for the three model-API wire formats. They parse the model's tool call, run the shared spec, and return
 * the result in that API's own envelope. Model arguments are untrusted: they are validated against the same strict
 * schema every framework uses, and an invalid call returns an error result without contacting PayFlow.
 */
type AnySpec = PayFlowToolkit["all"][number];

const jsonSchemaOf = (spec: AnySpec): Record<string, unknown> =>
  z.toJSONSchema(spec.schema);

async function dispatch(
  toolkit: PayFlowToolkit,
  name: string,
  rawArgs: unknown,
  callId: string | undefined,
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  const spec = toolkit.all.find((candidate) => candidate.name === name);
  if (!spec) return { ok: false, text: `Unknown tool: ${name}` };
  const parsed = (spec.schema as z.ZodType).safeParse(rawArgs);
  if (!parsed.success)
    return {
      ok: false,
      text: "Invalid arguments. Nothing was sent to PayFlow.",
    };
  const outcome = await (spec as PayFlowToolSpec<z.ZodType>).run(parsed.data, {
    callId,
  });
  return { ok: true, text: toModelText(outcome) };
}

/** OpenAI Responses API function tools. */
export const openAiTools = (toolkit: PayFlowToolkit) =>
  toolkit.all.map((spec) => ({
    type: "function" as const,
    name: spec.name,
    description: spec.description,
    parameters: jsonSchemaOf(spec),
    strict: false,
  }));
export async function handleOpenAiCall(
  toolkit: PayFlowToolkit,
  call: { call_id: string; name: string; arguments: string },
): Promise<{ type: "function_call_output"; call_id: string; output: string }> {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    args = undefined;
  }
  const result = await dispatch(toolkit, call.name, args, call.call_id);
  return {
    type: "function_call_output",
    call_id: call.call_id,
    output: result.text,
  };
}

/** Anthropic Messages API tools. */
export const anthropicTools = (toolkit: PayFlowToolkit) =>
  toolkit.all.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: jsonSchemaOf(spec),
  }));
export async function handleAnthropicToolUse(
  toolkit: PayFlowToolkit,
  block: { id: string; name: string; input: unknown },
): Promise<{
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: true;
}> {
  const result = await dispatch(toolkit, block.name, block.input, block.id);
  return {
    type: "tool_result",
    tool_use_id: block.id,
    content: result.text,
    ...(result.ok ? {} : { is_error: true as const }),
  };
}

/** Gemini function declarations. */
export const geminiTools = (toolkit: PayFlowToolkit) => [
  {
    functionDeclarations: toolkit.all.map((spec) => ({
      name: spec.name,
      description: spec.description,
      parametersJsonSchema: jsonSchemaOf(spec),
    })),
  },
];
export async function handleGeminiCall(
  toolkit: PayFlowToolkit,
  call: { id?: string; name: string; args?: unknown },
): Promise<{
  functionResponse: { id?: string; name: string; response: { output: string } };
}> {
  const result = await dispatch(toolkit, call.name, call.args, call.id);
  return {
    functionResponse: {
      ...(call.id ? { id: call.id } : {}),
      name: call.name,
      response: { output: result.text },
    },
  };
}
