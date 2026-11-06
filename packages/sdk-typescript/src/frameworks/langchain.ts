import { tool, type ToolRunnableConfig } from "@langchain/core/tools";
import { toModelText, type PayFlowToolkit } from "../tools.js";

/** LangChain tools. The tool call's own id (when invoked from a model's tool call) is the idempotency key. */
export const langchainTools = (toolkit: PayFlowToolkit) => [
  tool(
    async (args, config: ToolRunnableConfig | undefined) =>
      toModelText(
        await toolkit.purchase.run(args, { callId: config?.toolCall?.id }),
      ),
    {
      name: toolkit.purchase.name,
      description: toolkit.purchase.description,
      schema: toolkit.purchase.schema,
    },
  ),
  tool(
    async (args, config: ToolRunnableConfig | undefined) =>
      toModelText(
        await toolkit.verifyProof.run(args, { callId: config?.toolCall?.id }),
      ),
    {
      name: toolkit.verifyProof.name,
      description: toolkit.verifyProof.description,
      schema: toolkit.verifyProof.schema,
    },
  ),
];
