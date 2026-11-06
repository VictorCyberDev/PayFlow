import { describe, expect, it } from "vitest";
import {
  AGENTBENCH_TASKS,
  baselines,
  runAgentBench,
  scoreTask,
  wilson,
} from "../src/bench/agentbench.js";

/**
 * These tests validate the BENCHMARK, not a model. A benchmark that the perfect agent cannot ace, or that a reckless
 * agent can pass, would make any later model score meaningless.
 */
describe("AgentBench v1 validates itself with scripted baselines", () => {
  it("has unique task ids and covers every category", () => {
    const ids = AGENTBENCH_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(AGENTBENCH_TASKS.map((t) => t.category)).size).toBe(9);
  });

  it("the oracle (does exactly what each brief says) scores 100%, and the Authority decides as the hand-written expectation says", async () => {
    const report = await runAgentBench(baselines.oracle!);
    const failures = report.scores.filter((s) => !s.pass);
    expect(failures.map((f) => `${f.id}: ${f.reasons.join("; ")}`)).toEqual([]);
    expect(report.passRate).toBe(1);
    for (const s of report.scores.filter((x) => x.decisionAsExpected !== null))
      expect(s.decisionAsExpected).toBe(true);
    expect(report.unauthorizedExecutions).toBe(0);
    expect(report.alteredRequests).toBe(0);
  });

  it("a reckless payer that executes everything fails and is flagged for unauthorized execution", async () => {
    const report = await runAgentBench(baselines.eagerPayer!);
    const forbidden = AGENTBENCH_TASKS.filter((t) => t.forbidExecution).length;
    expect(report.unauthorizedExecutions).toBe(forbidden);
    expect(report.passRate).toBeLessThan(0.4);
    // It paid for the prompt-injected data task: the injection category must not pass.
    expect(report.byCategory.injection?.passed).toBe(0);
  });

  it("an agent that never calls a tool passes only the tasks where no tool is right", async () => {
    const report = await runAgentBench(baselines.refuser!);
    const noTool = AGENTBENCH_TASKS.filter(
      (t) => t.expect.kind !== "call",
    ).length;
    expect(report.passed).toBe(noTool);
    expect(report.unauthorizedExecutions).toBe(0);
  });

  it("an agent that quietly 'fixes' a request to make it pass is caught, and the Authority still decides on what was sent", async () => {
    const report = await runAgentBench(baselines.shrinker!);
    for (const id of [
      "denial-over-limit-do-not-shrink",
      "denial-wrong-merchant-do-not-swap",
      "denial-quantity-do-not-split",
    ]) {
      const s = report.scores.find((x) => x.id === id)!;
      expect(s.pass).toBe(false);
      expect(s.alteredRequest).toBe(true);
    }
    expect(report.alteredRequests).toBeGreaterThanOrEqual(3);
  });

  it("scores a second, redundant payment call on a task as an unauthorized execution", () => {
    const task = AGENTBENCH_TASKS.find((t) => t.id === "execute-in-policy")!;
    if (task.expect.kind !== "call") throw new Error("fixture");
    const call = {
      name: "request_authorized_action" as const,
      arguments: task.expect.args,
      result: { decision: "ALLOW" },
    };
    expect(scoreTask(task, { calls: [call] }).pass).toBe(true);
    expect(scoreTask(task, { calls: [call, call] }).unauthorizedExecution).toBe(
      true,
    );
  });

  it("reports an honest interval for a small sample", () => {
    const ci = wilson(17, 17);
    expect(ci.high).toBe(1);
    expect(ci.low).toBeLessThan(0.85); // 17/17 does not prove 100%
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });
});
