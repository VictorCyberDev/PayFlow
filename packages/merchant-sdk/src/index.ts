export type GateMarkState = "SUPPORTED" | "VERIFIED" | "REVOKED" | "EXPIRED" | "UNKNOWN";

export interface GateMarkModel {
  readonly state: GateMarkState;
  readonly geometry: "GATE_OUTLINE" | "GATE_COMMITTED" | "GATE_BLOCKED" | "GATE_UNRESOLVED";
  readonly label: string;
  readonly ariaLabel: string;
  readonly verificationUrl?: string;
}

export function gateMarkModel(
  state: GateMarkState,
  verificationUrl?: string,
): GateMarkModel {
  const table: Record<GateMarkState, Omit<GateMarkModel, "state" | "verificationUrl">> = {
    SUPPORTED: {
      geometry: "GATE_OUTLINE",
      label: "Authority verification supported",
      ariaLabel: "This integration supports PayFlow Authority verification; the mark itself is not proof.",
    },
    VERIFIED: {
      geometry: "GATE_COMMITTED",
      label: "Authority verified",
      ariaLabel: "Authority verified for the bound request. Open verification details for evidence.",
    },
    REVOKED: {
      geometry: "GATE_BLOCKED",
      label: "Authority revoked",
      ariaLabel: "Authority is revoked and must not be treated as permission to proceed.",
    },
    EXPIRED: {
      geometry: "GATE_BLOCKED",
      label: "Authority expired",
      ariaLabel: "Authority is expired and must not be treated as permission to proceed.",
    },
    UNKNOWN: {
      geometry: "GATE_UNRESOLVED",
      label: "Authority unresolved",
      ariaLabel: "Authority state is unresolved. Do not infer permission or retry a financial action.",
    },
  };
  return {
    state,
    ...table[state],
    ...(verificationUrl === undefined ? {} : { verificationUrl }),
  };
}

export interface MerchantVerifierOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class MerchantVerifierClient {
  private readonly request: typeof globalThis.fetch;
  constructor(private readonly options: MerchantVerifierOptions) {
    this.request = options.fetch ?? globalThis.fetch;
  }

  async verifyPresentation(presentation: unknown): Promise<unknown> {
    const response = await this.request(new URL("/v1/verify/presentations", this.options.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payflow-verifier-client": this.options.clientId,
      },
      body: JSON.stringify({ presentation }),
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) throw Object.assign(new Error("PAYFLOW_VERIFY_FAILED"), { status: response.status, body });
    return body;
  }
}

export function requireVerifiedAuthority(
  result: { verdict?: string },
): void {
  if (result.verdict !== "VALID") throw new Error(`AUTHORITY_NOT_VERIFIED:${result.verdict ?? "INVALID"}`);
}
