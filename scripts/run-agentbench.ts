// Runs AgentBench v1 against a REAL model. It spends the model owner's money, so it refuses to run unless asked.
//   PAYFLOW_MODEL_PROVIDER=claude|openai|gemini PAYFLOW_MODEL_NAME=<model id> PAYFLOW_ALLOW_MODEL_EVAL=true \
//   ANTHROPIC_API_KEY=... node --import tsx scripts/run-agentbench.ts
// At most 3 requests per task, no retries. The key is read from the environment and never printed or written.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  AGENTBENCH_TASKS,
  BENCH_CLOCK,
  runAgentBench,
  type AgentUnderTest,
} from "../src/bench/agentbench.js";
import {
  runModelToolFlow,
  type ModelProvider,
} from "../src/protocols/model-runtime.js";

const provider = process.env.PAYFLOW_MODEL_PROVIDER as ModelProvider;
if (!["openai", "claude", "gemini"].includes(provider))
  throw new Error("PAYFLOW_MODEL_PROVIDER must be openai, claude or gemini");
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
    "Set PAYFLOW_MODEL_PROVIDER, PAYFLOW_MODEL_NAME, the provider API key and PAYFLOW_ALLOW_MODEL_EVAL=true. This makes up to 3 paid requests per task.",
  );

const texts = (value: unknown): string[] => {
  if (typeof value === "string") return [];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const own =
      typeof o.text === "string" &&
      (o.type === "text" || o.type === "output_text" || o.type === undefined)
        ? [o.text]
        : [];
    return [...own, ...Object.values(o).flatMap(texts)];
  }
  return [];
};

const agent: AgentUnderTest = async (task, env) => {
  const flow = await runModelToolFlow(task.brief, {
    provider,
    model: model as string,
    apiKey: apiKey as string,
    services: env.services,
    context: {
      authenticated: true,
      requestId: task.id,
      scopes: [
        "authority:read",
        "action:request",
        "verify:read",
        "proof:read",
        "reconcile:request",
      ],
    },
    mode: "governed-action",
  });
  return {
    calls: flow.invocations.map((x) => ({
      name: x.name,
      arguments: x.arguments,
      result: x.result,
      blocked: x.blocked,
    })),
    finalText: texts(flow.completion).join("\n"),
  };
};

const report = await runAgentBench(agent);
const datasetHash = createHash("sha256")
  .update(JSON.stringify(AGENTBENCH_TASKS))
  .digest("hex");
const out = {
  ...report,
  provider,
  model,
  runAt: new Date().toISOString(),
  datasetSha256: datasetHash,
  benchClock: BENCH_CLOCK,
  environment: "SANDBOX: deterministic fake rail, no real money",
  note: "Single run, one sample per task, temperature not controlled. Not a stable ranking; see docs/AGENTBENCH.md.",
};
mkdirSync("docs/evidence/agentbench", { recursive: true });
const file = `docs/evidence/agentbench/${provider}-${String(model).replace(/[^\w.-]/gu, "_")}-${out.runAt.slice(0, 10)}.json`;
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `${report.passed}/${report.tasks} passed (95% CI ${(report.passRateCI95.low * 100).toFixed(0)}–${(report.passRateCI95.high * 100).toFixed(0)}%), unauthorized executions ${report.unauthorizedExecutions}, altered requests ${report.alteredRequests}. Wrote ${file}`,
);
