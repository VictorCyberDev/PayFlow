// OpenAI Agents SDK. Needs an OpenAI key of your own and a PayFlow credential. Type-checked in CI; not run there.
import { Agent, run } from "@openai/agents";
import { PayFlowClient } from "../src/index.js";
import { createPayFlowToolkit } from "../src/tools.js";
import { openAiAgentsTools } from "../src/frameworks/openai-agents.js";

export async function main() {
  const toolkit = createPayFlowToolkit({
    client: new PayFlowClient({
      baseUrl: process.env.PAYFLOW_URL ?? "https://payflow.example",
      accessToken: process.env.PAYFLOW_TOKEN ?? "",
    }),
    authority: process.env.PAYFLOW_AUTHORITY ?? "",
    agent: process.env.PAYFLOW_AGENT ?? "",
  });
  const agent = new Agent({
    name: "Procurement agent",
    instructions:
      "Buy only what you are asked to buy. If PayFlow says the outcome is UNKNOWN, do not retry; report it.",
    tools: openAiAgentsTools(toolkit),
  });
  const result = await run(
    agent,
    "Buy one quiet keyboard for $84 from payflow.demo.merchant.",
  );
  return result.finalOutput;
}
