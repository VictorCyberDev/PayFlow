import { tool } from "ai";
import { toModelText, type PayFlowToolkit } from "../tools.js";

/** Vercel AI SDK tools. `toolCallId` becomes the idempotency key. */
export const aiSdkTools = (toolkit: PayFlowToolkit) => ({
  [toolkit.purchase.name]: tool({
    description: toolkit.purchase.description,
    inputSchema: toolkit.purchase.schema,
    execute: async (args, options) =>
      toModelText(
        await toolkit.purchase.run(args, { callId: options.toolCallId }),
      ),
  }),
  [toolkit.verifyProof.name]: tool({
    description: toolkit.verifyProof.description,
    inputSchema: toolkit.verifyProof.schema,
    execute: async (args, options) =>
      toModelText(
        await toolkit.verifyProof.run(args, { callId: options.toolCallId }),
      ),
  }),
});
