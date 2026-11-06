// LangChain. Bind the tools to any tool-calling chat model of your choice. Type-checked in CI; not run there.
import { PayFlowClient } from "../src/index.js";
import { createPayFlowToolkit } from "../src/tools.js";
import { langchainTools } from "../src/frameworks/langchain.js";

export function payflowToolsForLangChain() {
  const toolkit = createPayFlowToolkit({
    client: new PayFlowClient({
      baseUrl: process.env.PAYFLOW_URL ?? "https://payflow.example",
      accessToken: process.env.PAYFLOW_TOKEN ?? "",
    }),
    authority: process.env.PAYFLOW_AUTHORITY ?? "",
    agent: process.env.PAYFLOW_AGENT ?? "",
  });
  // model.bindTools(payflowToolsForLangChain()) -- the tool call id from the model becomes the idempotency key.
  return langchainTools(toolkit);
}
