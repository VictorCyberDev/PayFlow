import summaryJson from "./break-authority-summary.json";

export interface BreakAuthoritySummary {
  readonly version: string;
  readonly scope: {
    readonly railKind: string;
    readonly providerEffectsExercised: boolean;
    readonly realModelRun: boolean;
    readonly independentReproduction: boolean;
    readonly certificationClaim: boolean;
  };
  readonly integrated: {
    readonly scenarios: number;
    readonly uncontained: number;
    readonly attackFamilies: number;
    readonly distinctContainmentOutcomes: number;
    readonly validControls: { readonly passed: number; readonly total: number };
    readonly categories: readonly {
      readonly category: string;
      readonly scenarios: number;
      readonly contained: number;
      readonly distinctOutcomes: number;
    }[];
  };
  readonly kernelOnly: {
    readonly scenarios: number;
    readonly unauthorizedAllows: number;
    readonly families: number;
  };
  readonly faultInjection: { readonly total: number; readonly passed: number };
  readonly conformance: { readonly passed: number; readonly failed: number };
  readonly toolSelection: { readonly total: number; readonly passed: number };
  readonly sourceFileSha256: Readonly<Record<string, string>>;
}

/** Generated from the real runs and verified byte-for-byte in CI (`npm run evidence:check`). */
export const breakAuthority = summaryJson as BreakAuthoritySummary;

/** "IDENTITY" -> "Identity", "PROVIDER_AMBIGUITY" -> "Provider ambiguity". */
export const categoryLabel = (c: string): string =>
  (c.charAt(0) + c.slice(1).toLowerCase()).replace(/_/g, " ");
