import { z } from "zod";
import {
  CAPABILITIES,
  PROVIDER_TYPES,
  type Capability,
  type MissionContract,
} from "./contract.js";

/**
 * Mission plans (V3 M27). A plan is a dependency-aware list of tasks. It is BOOKKEEPING ABOUT WORK:
 *  - an estimate is a labelled estimate, never a quote; only the quote engine (M34) may mark VERIFIED_QUOTE, so a planner cannot;
 *  - a task a granted agent cannot actually perform with what is connected is PREPARED_HANDOFF or UNAVAILABLE, never silently
 *    "automated";
 *  - nothing here widens the Mission Contract: tasks are checked against the capabilities the contract granted.
 */
export const TASK_TYPES = [
  "SOURCING",
  "QUALIFICATION",
  "QUOTE_COMPARISON",
  "SOURCING_OPTIMIZATION",
  "NEGOTIATION",
  "PURCHASE",
  "FULFILLMENT_TRACKING",
  "TALENT_SOURCING",
  "CONTRACT_COORDINATION",
  "DRAFTING",
  "OWNER_DECISION",
  "OTHER",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * Task types that are pure computation or drafting over data the mission already holds: no external provider is needed, so a
 * granted agent can do them today. Everything else needs a connected provider (M31+) and is PREPARED_HANDOFF until one exists.
 */
const INTERNAL: readonly TaskType[] = [
  "QUOTE_COMPARISON",
  "SOURCING_OPTIMIZATION",
  "DRAFTING",
  "OWNER_DECISION",
];

const Key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const Text = (n: number) => z.string().trim().min(1).max(n);

export const PlanTaskSchema = z
  .object({
    key: Key,
    title: Text(200),
    intendedOutcome: Text(500),
    taskType: z.enum(TASK_TYPES),
    requiredCapabilities: z
      .array(z.enum(CAPABILITIES))
      .min(1)
      .max(CAPABILITIES.length),
    providerTypes: z
      .array(z.enum(PROVIDER_TYPES))
      .max(PROVIDER_TYPES.length)
      .default([]),
    estimatedCostMinor: z
      .number()
      .int()
      .safe()
      .min(0)
      .max(1_000_000_000_000)
      .optional(),
    estimateSource: z
      .enum(["NONE", "HUMAN_ESTIMATE", "AI_ESTIMATE"])
      .default("NONE"),
    expectedDurationMinutes: z.number().int().min(1).max(525_600).optional(),
    requiredEvidence: z.array(Text(80)).max(10).default([]),
    assignedAgentId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
      .optional(),
    priority: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL"),
    deadline: z.string().datetime().optional(),
    requiresOwnerApproval: z.boolean().default(false),
    dependsOn: z
      .array(
        z
          .object({
            key: Key,
            kind: z.enum(["HARD", "CONDITIONAL"]).default("HARD"),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    /** Why this task exists. A plan that cannot say why is not accepted. */
    explanation: Text(500),
  })
  .strict();
export type PlanTask = z.infer<typeof PlanTaskSchema>;

export const PlanDraftSchema = z
  .object({
    rationale: z.string().trim().max(2000).default(""),
    tasks: z.array(PlanTaskSchema).min(1).max(60),
  })
  .strict();
export type PlanDraft = z.infer<typeof PlanDraftSchema>;

export interface ConnectorCatalog {
  /** Is a provider of this type commissioned and connected for this capability? (M31 supplies the real one.) */
  supports(providerType: string, capability: Capability): boolean;
}
/** Until connectors exist, nothing external is connected. */
export const NO_CONNECTORS: ConnectorCatalog = { supports: () => false };

export interface PlannedTask extends PlanTask {
  readonly readiness: "EXECUTABLE" | "PREPARED_HANDOFF" | "UNAVAILABLE";
  readonly readinessReason: string;
  readonly requiresOwnerApproval: boolean;
}

export type PlanProblem =
  | { code: "DUPLICATE_KEY"; key: string }
  | { code: "UNKNOWN_DEPENDENCY"; key: string; dependsOn: string }
  | { code: "SELF_DEPENDENCY"; key: string }
  | { code: "CYCLE"; keys: string[] }
  | { code: "AGENT_NOT_ASSIGNED_TO_MISSION"; key: string; agentId: string }
  | {
      code: "CAPABILITY_NOT_GRANTED";
      key: string;
      agentId: string;
      capability: string;
    }
  | { code: "PROVIDER_TYPE_NOT_APPROVED"; key: string; providerType: string }
  | { code: "DEADLINE_AFTER_MISSION"; key: string };

/** Topological check. Returns the keys on a cycle, or null. Iterative (no recursion limit on a 60-task plan, and no stack risk). */
export function findCycle(
  tasks: readonly Pick<PlanTask, "key" | "dependsOn">[],
): string[] | null {
  const deps = new Map(
    tasks.map((t) => [t.key, t.dependsOn.map((d) => d.key)]),
  );
  const indegree = new Map<string, number>();
  for (const [k, ds] of deps)
    indegree.set(k, ds.filter((d) => deps.has(d)).length);
  const queue = [...indegree].filter(([, n]) => n === 0).map(([k]) => k);
  let seen = 0;
  while (queue.length) {
    const k = queue.shift()!;
    seen++;
    for (const [other, ds] of deps)
      if (ds.includes(k)) {
        const n = indegree.get(other)! - 1;
        indegree.set(other, n);
        if (n === 0) queue.push(other);
      }
  }
  return seen === deps.size
    ? null
    : [...indegree]
        .filter(([, n]) => n > 0)
        .map(([k]) => k)
        .sort();
}

/**
 * Validates a draft against the contract in force and annotates each task with readiness. A plan that fails validation is
 * refused whole: a partially valid plan could hide the invalid part.
 */
export function validatePlan(
  contract: MissionContract,
  draft: PlanDraft,
  connectors: ConnectorCatalog = NO_CONNECTORS,
):
  | {
      ok: true;
      tasks: PlannedTask[];
      estimatedTotalMinor: number;
      overBudget: boolean;
    }
  | { ok: false; problems: PlanProblem[] } {
  const problems: PlanProblem[] = [];
  const keys = new Set<string>();
  for (const t of draft.tasks) {
    if (keys.has(t.key)) problems.push({ code: "DUPLICATE_KEY", key: t.key });
    keys.add(t.key);
  }
  const grants = new Map(
    contract.agents.map((a) => [a.agentId, new Set<string>(a.capabilities)]),
  );
  for (const t of draft.tasks) {
    for (const d of t.dependsOn) {
      if (d.key === t.key)
        problems.push({ code: "SELF_DEPENDENCY", key: t.key });
      else if (!keys.has(d.key))
        problems.push({
          code: "UNKNOWN_DEPENDENCY",
          key: t.key,
          dependsOn: d.key,
        });
    }
    if (t.assignedAgentId) {
      const g = grants.get(t.assignedAgentId);
      if (!g)
        problems.push({
          code: "AGENT_NOT_ASSIGNED_TO_MISSION",
          key: t.key,
          agentId: t.assignedAgentId,
        });
      else
        for (const c of t.requiredCapabilities)
          if (!g.has(c))
            problems.push({
              code: "CAPABILITY_NOT_GRANTED",
              key: t.key,
              agentId: t.assignedAgentId,
              capability: c,
            });
    }
    for (const p of t.providerTypes)
      if (!contract.approvedProviderTypes.includes(p))
        problems.push({
          code: "PROVIDER_TYPE_NOT_APPROVED",
          key: t.key,
          providerType: p,
        });
    if (t.deadline && Date.parse(t.deadline) > Date.parse(contract.expiresAt))
      problems.push({ code: "DEADLINE_AFTER_MISSION", key: t.key });
  }
  const cycle = findCycle(draft.tasks);
  if (cycle) problems.push({ code: "CYCLE", keys: cycle });
  if (problems.length) return { ok: false, problems };

  const tasks: PlannedTask[] = draft.tasks.map((t) => {
    let readiness: PlannedTask["readiness"] = "EXECUTABLE";
    let reason =
      "Granted agent can do this with data the mission already holds.";
    if (!t.assignedAgentId) {
      readiness = "PREPARED_HANDOFF";
      reason = "NO_AGENT_ASSIGNED: a person must assign or perform this task.";
    } else if (!INTERNAL.includes(t.taskType)) {
      const connected =
        t.providerTypes.length > 0 &&
        t.providerTypes.every((p) =>
          t.requiredCapabilities.every((c) => connectors.supports(p, c)),
        );
      if (!connected) {
        readiness = "PREPARED_HANDOFF";
        reason =
          t.providerTypes.length === 0
            ? "NO_PROVIDER_TYPE: the task names no provider, so nothing can be connected to it."
            : "NO_CONNECTOR_COMMISSIONED: no connected provider supports this task today; the work is prepared for a person.";
      } else
        reason = "A connected provider supports every required capability.";
    }
    const needsApproval =
      t.requiresOwnerApproval ||
      (t.requiredCapabilities.includes("NEGOTIATE") &&
        contract.approvalConditions.requireApprovalToNegotiate) ||
      (t.requiredCapabilities.includes("CONTRACT") &&
        contract.approvalConditions.requireApprovalToContract) ||
      t.requiredCapabilities.some(
        (c) => c === "PURCHASE" || c === "RESERVE" || c === "REFUND_REQUEST",
      );
    return {
      ...t,
      readiness,
      readinessReason: reason,
      requiresOwnerApproval: needsApproval,
    };
  });
  const estimatedTotalMinor = tasks.reduce(
    (n, t) => n + (t.estimatedCostMinor ?? 0),
    0,
  );
  return {
    ok: true,
    tasks,
    estimatedTotalMinor,
    overBudget: estimatedTotalMinor > contract.totalBudgetMinor,
  };
}

/**
 * The deterministic template planner: a fixed, inspectable decomposition derived only from what the CONTRACT says. It invents no
 * prices, suppliers or capabilities; it assigns work only to agents that already hold the needed capability. It is not a model
 * and does not pretend to be one.
 */
export function templatePlan(contract: MissionContract): PlanDraft {
  const holder = (cap: Capability) =>
    contract.agents.find((a) => a.capabilities.includes(cap))?.agentId;
  const providers = contract.approvedProviderTypes.filter(
    (p) => p === "COMMERCE_MARKETPLACE" || p === "DIRECT_SUPPLIER",
  );
  const talent = contract.approvedProviderTypes.includes("TALENT_MARKETPLACE");
  const workspaces =
    contract.approvedProviderTypes.includes("WORKSPACE_PROVIDER");
  const services = contract.approvedProviderTypes.includes(
    "PROFESSIONAL_SERVICES",
  );
  const tasks: PlanTask[] = [];
  const add = (
    t: Partial<PlanTask> &
      Pick<
        PlanTask,
        | "key"
        | "title"
        | "intendedOutcome"
        | "taskType"
        | "requiredCapabilities"
        | "explanation"
      >,
  ) =>
    tasks.push(
      PlanTaskSchema.parse({ providerTypes: [], dependsOn: [], ...t }),
    );
  add({
    key: "clarify-requirements",
    title: "Turn the objective into checkable requirements",
    intendedOutcome:
      "A written list of requirements the owner can review against the success criteria",
    taskType: "DRAFTING",
    requiredCapabilities: ["DRAFT"],
    assignedAgentId: holder("DRAFT"),
    requiredEvidence: ["requirements-document"],
    explanation: `The success criteria (${contract.successCriteria.length}) must be checkable before anyone spends.`,
  });
  if (providers.length) {
    add({
      key: "source-offers",
      title: "Find real offers from approved providers",
      intendedOutcome: "A source-backed list of offers with provenance",
      taskType: "SOURCING",
      requiredCapabilities: ["SEARCH", "READ"],
      providerTypes: providers,
      assignedAgentId: holder("SEARCH"),
      requiredEvidence: ["offer-provenance"],
      dependsOn: [{ key: "clarify-requirements", kind: "HARD" }],
      explanation:
        "Approved provider types are the only places this mission may look.",
    });
    add({
      key: "compare-offers",
      title: "Compare offers on total landed cost",
      intendedOutcome:
        "A side-by-side comparison with the winner and the alternatives explained",
      taskType: "QUOTE_COMPARISON",
      requiredCapabilities: ["COMPARE"],
      assignedAgentId: holder("COMPARE"),
      requiredEvidence: ["comparison"],
      dependsOn: [{ key: "source-offers", kind: "HARD" }],
      explanation: "Lowest advertised price is not lowest total cost.",
    });
  }
  if (talent) {
    add({
      key: "source-talent",
      title: "Find candidates through the approved talent marketplace",
      intendedOutcome: "A source-backed candidate list for the scope",
      taskType: "TALENT_SOURCING",
      requiredCapabilities: ["SEARCH", "READ"],
      providerTypes: ["TALENT_MARKETPLACE"],
      assignedAgentId: holder("SEARCH"),
      requiredEvidence: ["candidate-provenance"],
      dependsOn: [{ key: "clarify-requirements", kind: "HARD" }],
      explanation: "The contract approves a talent marketplace.",
    });
  }
  // A mission whose only approved providers are workspaces or professional services used to get no discovery work at
  // all: the plan went straight from "write the requirements" to "decide on the shortlist", and nothing in between ever
  // produced a shortlist. PayFlow has the discovery for both (M51 workspaces, M54 service packages), so the planner
  // plans it.
  if (workspaces) {
    add({
      key: "find-workspaces",
      title: "Find workspaces that fit the requirements",
      intendedOutcome: "A source-backed list of workspaces with provenance",
      taskType: "SOURCING",
      requiredCapabilities: ["SEARCH", "READ"],
      providerTypes: ["WORKSPACE_PROVIDER"],
      assignedAgentId: holder("SEARCH"),
      requiredEvidence: ["workspace-provenance"],
      dependsOn: [{ key: "clarify-requirements", kind: "HARD" }],
      explanation: "The contract approves a workspace provider.",
    });
    add({
      key: "compare-workspaces",
      title: "Compare workspaces on total cost of the stay",
      intendedOutcome:
        "A side-by-side comparison including deposit and cancellation terms",
      taskType: "QUOTE_COMPARISON",
      requiredCapabilities: ["COMPARE"],
      assignedAgentId: holder("COMPARE"),
      requiredEvidence: ["comparison"],
      dependsOn: [{ key: "find-workspaces", kind: "HARD" }],
      explanation:
        "A monthly rate is not the cost: the deposit and the minimum term are part of it.",
    });
  }
  if (services) {
    add({
      key: "find-services",
      title: "Find service packages that cover the requirements",
      intendedOutcome: "A source-backed list of packages with provenance",
      taskType: "SOURCING",
      requiredCapabilities: ["SEARCH", "READ"],
      providerTypes: ["PROFESSIONAL_SERVICES"],
      assignedAgentId: holder("SEARCH"),
      requiredEvidence: ["service-provenance"],
      dependsOn: [{ key: "clarify-requirements", kind: "HARD" }],
      explanation: "The contract approves professional services.",
    });
    add({
      key: "compare-services",
      title: "Compare packages on what is actually delivered",
      intendedOutcome:
        "A side-by-side comparison of scope, revisions and refund terms",
      taskType: "QUOTE_COMPARISON",
      requiredCapabilities: ["COMPARE"],
      assignedAgentId: holder("COMPARE"),
      requiredEvidence: ["comparison"],
      dependsOn: [{ key: "find-services", kind: "HARD" }],
      explanation:
        "Two packages at the same price can deliver very different things.",
    });
  }
  // The owner decides on whatever was actually compared. Without this, a mission with only workspace or services
  // providers asked for a decision on a shortlist no task had been planned to produce.
  const DECIDE_AFTER = [
    "compare-offers",
    "source-talent",
    "compare-workspaces",
    "compare-services",
  ];
  const upstream = tasks
    .filter((t) => DECIDE_AFTER.includes(t.key))
    .map((t) => ({ key: t.key, kind: "HARD" as const }));
  add({
    key: "owner-decision",
    title: "Owner reviews the shortlist and decides what to commit to",
    intendedOutcome:
      "An explicit owner decision recorded against specific terms",
    taskType: "OWNER_DECISION",
    requiredCapabilities: ["REQUEST_APPROVAL"],
    assignedAgentId: holder("REQUEST_APPROVAL"),
    requiresOwnerApproval: true,
    dependsOn: upstream.length
      ? upstream
      : [{ key: "clarify-requirements", kind: "HARD" }],
    explanation:
      "Nothing is committed without a human decision on exact terms.",
  });
  return PlanDraftSchema.parse({
    rationale:
      "Deterministic template derived from the Mission Contract; contains no estimates and no supplier data.",
    tasks,
  });
}
