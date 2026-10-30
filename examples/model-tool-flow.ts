import {
  runModelToolFlow,
  type ModelProvider,
} from "../src/protocols/model-runtime.js";
import { createSandboxMcpServices } from "../src/protocols/mcp-sandbox.js";
const provider = process.env.PAYFLOW_MODEL_PROVIDER as ModelProvider;
if (!["openai", "claude", "gemini"].includes(provider))
  throw new Error("Set PAYFLOW_MODEL_PROVIDER to openai, claude or gemini");
const key =
  process.env[
    provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "claude"
        ? "ANTHROPIC_API_KEY"
        : "GEMINI_API_KEY"
  ];
if (!key || !process.env.PAYFLOW_MODEL_NAME)
  throw new Error(
    "Provider key and PAYFLOW_MODEL_NAME required; no default paid model is selected",
  );
if (process.env.PAYFLOW_ALLOW_MODEL_CALL !== "true")
  throw new Error(
    "Set PAYFLOW_ALLOW_MODEL_CALL=true only after confirming quota and cost",
  );
const result = await runModelToolFlow(
  process.argv.slice(2).join(" ") || "What is compound interest?",
  {
    provider,
    model: process.env.PAYFLOW_MODEL_NAME,
    apiKey: key,
    services: createSandboxMcpServices(() => new Date().toISOString()),
    context: {
      authenticated: true,
      requestId: crypto.randomUUID(),
      scopes: ["authority:read", "verify:read", "proof:read"],
    },
    mode: "read-only",
  },
);
// Do not print raw provider completions or arguments; they can contain user data.
console.log(
  JSON.stringify({
    provider: result.provider,
    model: result.model,
    turns: result.turns,
    invocations: result.invocations.map((x) => ({
      name: x.name,
      blocked: x.blocked,
    })),
  }),
);
