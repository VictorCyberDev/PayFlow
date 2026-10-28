export type ConformanceRole = "AUTHORITY_ISSUER" | "AGENT" | "VERIFIER" | "RAIL_ADAPTER" | "PROOF_IMPLEMENTATION" | "PROTOCOL_ADAPTER";

export interface ConformanceCase {
  readonly id: string;
  readonly role: ConformanceRole;
  readonly invariant: string;
  readonly run: () => Promise<boolean> | boolean;
}

export interface ConformanceResult {
  readonly version: "financial-authority-conformance/v1";
  readonly generatedAt: string;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly { id: string; role: ConformanceRole; invariant: string; pass: boolean }[];
  readonly certificationClaim: false;
}

export async function runConformanceSuite(
  cases: readonly ConformanceCase[],
  generatedAt: string,
): Promise<ConformanceResult> {
  const results = [] as Array<{ id: string; role: ConformanceRole; invariant: string; pass: boolean }>;
  for (const testCase of cases) {
    let pass = false;
    try {
      pass = await testCase.run();
    } catch {
      pass = false;
    }
    results.push({ id: testCase.id, role: testCase.role, invariant: testCase.invariant, pass });
  }
  return {
    version: "financial-authority-conformance/v1",
    generatedAt,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
    results,
    certificationClaim: false,
  };
}

export const BASE_CONFORMANCE_CASES: readonly Omit<ConformanceCase, "run">[] = [
  { id: "issuer-no-widening", role: "AUTHORITY_ISSUER", invariant: "Authority cannot silently widen after issuance" },
  { id: "agent-exact-action", role: "AGENT", invariant: "Agent submits an exact bounded action" },
  { id: "verifier-read-only", role: "VERIFIER", invariant: "Verification cannot move money" },
  { id: "rail-one-time-grant", role: "RAIL_ADAPTER", invariant: "Rail requires a bounded one-time grant" },
  { id: "rail-unknown", role: "RAIL_ADAPTER", invariant: "Ambiguous provider effect remains UNKNOWN" },
  { id: "proof-tamper", role: "PROOF_IMPLEMENTATION", invariant: "Tampered Proof fails verification" },
  { id: "protocol-non-authority", role: "PROTOCOL_ADAPTER", invariant: "Protocol assertions cannot create Authority" },
] as const;
