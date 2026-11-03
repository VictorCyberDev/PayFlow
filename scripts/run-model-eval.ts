import { writeFileSync } from "node:fs";
import {
  runModelToolFlow,
  type ModelProvider,
} from "../src/protocols/model-runtime.js";
import {
  MODEL_EVAL_DATASET,
  scoreModelEval,
  type EvalObservation,
} from "../src/protocols/model-eval.js";
import { createSandboxMcpServices } from "../src/protocols/mcp-sandbox.js";
const provider = process.env.PAYFLOW_MODEL_PROVIDER as ModelProvider;
if (!["openai", "claude", "gemini"].includes(provider))
  throw new Error("MODEL_PROVIDER_REQUIRED");
const model = process.env.PAYFLOW_MODEL_NAME;
const apiKey =
  process.env[
    provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "claude"
        ? "ANTHROPIC_API_KEY"
        : "GEMINI_API_KEY"
  ];
if (!model || !apiKey || process.env.PAYFLOW_ALLOW_MODEL_EVAL !== "true")
  throw new Error(
    "Explicit provider/model/key and PAYFLOW_ALLOW_MODEL_EVAL=true required. This runner makes at most three requests per prompt. Confirm quota/cost first.",
  );
const observations: EvalObservation[] = [];
const records = [];
for (const entry of MODEL_EVAL_DATASET) {
  const flow = await runModelToolFlow(entry.prompt, {
    provider,
    model,
    apiKey,
    services: createSandboxMcpServices(() => new Date().toISOString()),
    context: {
      authenticated: true,
      requestId: entry.id,
      scopes: [
        "authority:read",
        "action:request",
        "verify:read",
        "proof:read",
        "reconcile:request",
      ],
    },
    mode: entry.mode,
  });
  const first = flow.invocations[0];
  const completionText = JSON.stringify(flow.completion ?? {});
  const actual =
    first?.name ??
    (/\b(clarify|which authority|provide the|missing details|need more)\b/i.test(
      completionText,
    )
      ? "CLARIFY"
      : "NO_TOOL");
  const observation: EvalObservation = {
    id: entry.id,
    actual,
    argumentsCorrect: null,
    unauthorizedExecutionAttempt: flow.invocations.some((x) => x.blocked),
    verificationExecutionConfusion:
      entry.mode === "read-only" &&
      flow.invocations.some((x) => x.name === "request_authorized_action"),
  };
  observations.push(observation);
  records.push({
    id: entry.id,
    observation,
    invocations: flow.invocations.map((x) => ({
      name: x.name,
      blocked: x.blocked,
    })),
    argumentReview: "PENDING_HUMAN_ADJUDICATION",
  });
}
const report = {
  provider,
  model,
  date: new Date().toISOString(),
  evidence: "LIVE_PROVIDER",
  classification:
    "tool choice exact; no-tool clarification classified by disclosed text heuristic; argument correctness unscored",
  metrics: scoreModelEval(MODEL_EVAL_DATASET, observations),
  records,
};
writeFileSync(
  `docs/evidence/model-eval-${provider}.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    provider,
    model,
    prompts: observations.length,
    metrics: report.metrics,
  }),
);
