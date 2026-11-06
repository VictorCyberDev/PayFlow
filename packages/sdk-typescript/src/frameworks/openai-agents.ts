import { tool } from "@openai/agents";
import { toModelText, type PayFlowToolkit } from "../tools.js";

/** OpenAI Agents SDK function tools. The function call's `callId` is the idempotency key. */
export const openAiAgentsTools = (toolkit: PayFlowToolkit) => [
  tool({
    name: toolkit.purchase.name,
    description: toolkit.purchase.description,
    parameters: toolkit.purchase.schema,
    execute: async (args, _context, details) =>
      toModelText(
        await toolkit.purchase.run(args, { callId: details?.toolCall?.callId }),
      ),
  }),
  tool({
    name: toolkit.verifyProof.name,
    description: toolkit.verifyProof.description,
    // A Proof is an open JSON object, which OpenAI's strict structured-output mode cannot express, and the Agents SDK
    // requires strict mode for Zod parameters. So this tool takes a JSON Schema and validates with the shared schema.
    parameters: {
      type: "object",
      properties: { proof: { type: "object", additionalProperties: true } },
      required: ["proof"],
      // The Agents SDK accepts only `true` here in non-strict mode; extra fields are rejected by our own schema below.
      additionalProperties: true,
    } as const,
    strict: false,
    execute: async (input: unknown, _context, details) => {
      const parsed = toolkit.verifyProof.schema.safeParse(input);
      if (!parsed.success)
        return "Invalid arguments. Nothing was sent to PayFlow.";
      return toModelText(
        await toolkit.verifyProof.run(parsed.data, {
          callId: details?.toolCall?.callId,
        }),
      );
    },
  }),
];
