// Vercel AI SDK. Needs a model provider key of your own (for example `ANTHROPIC_API_KEY`) and a PayFlow credential.
// This file is type-checked in CI; it is not run there.
import { generateText, isStepCount } from "ai";
import { PayFlowClient } from "../src/index.js";
import { createPayFlowToolkit } from "../src/tools.js";
import { aiSdkTools } from "../src/frameworks/ai-sdk.js";

export async function main(model: Parameters<typeof generateText>[0]["model"]) {
  const toolkit = createPayFlowToolkit({
    client: new PayFlowClient({
      baseUrl: process.env.PAYFLOW_URL ?? "https://payflow.example",
      accessToken: process.env.PAYFLOW_TOKEN ?? "",
    }),
    authority: process.env.PAYFLOW_AUTHORITY ?? "",
    agent: process.env.PAYFLOW_AGENT ?? "",
  });
  const result = await generateText({
    model,
    tools: aiSdkTools(toolkit),
    stopWhen: isStepCount(4),
    prompt: "Buy one quiet keyboard for $84 from payflow.demo.merchant.",
  });
  return result.text;
}
