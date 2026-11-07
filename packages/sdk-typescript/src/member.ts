import type { Credential, StatusList } from "../../verifier/src/authority.js";

/**
 * Client for the organization-member API of a PayFlow host: issuing, listing and revoking portable Authority
 * credentials. It uses a MEMBER token (never an agent credential, never the operator token): the server decides what the
 * member's role allows. The client sends a holder PUBLIC key and a narrowing request; it cannot ask for more than the
 * stored Authority allows, and a refusal is returned as data with the server's reason.
 */
export interface PayFlowMemberClientOptions {
  readonly baseUrl: string;
  readonly memberToken: string;
  readonly fetch?: typeof globalThis.fetch;
}
export interface IssueCredentialInput {
  /** The agent's Ed25519 public key (JWK). Never send a private key. */
  readonly holder: { kty: "OKP"; crv: "Ed25519"; x: string };
  /** Retrying with the same key and request returns the same credential. 16-128 characters. */
  readonly idempotencyKey: string;
  readonly audience?: readonly string[];
  readonly counterpartyIds?: readonly string[];
  readonly maxAmountMinor?: number;
  readonly ttlSeconds?: number;
  readonly maxDepth?: number;
}
export type IssueCredentialResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly credentialId: string;
      readonly authorityId: string;
      readonly expiresAt: string;
      readonly credential: Credential;
    }
  | {
      readonly ok: false;
      readonly httpStatus: number;
      readonly reason: string;
      readonly recoverable: boolean;
    };
export interface CredentialSummary {
  readonly credentialId: string;
  readonly authorityId: string;
  readonly agentId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly status: "ACTIVE" | "REVOKED" | "EXPIRED" | "AUTHORITY_REVOKED";
  readonly audience: readonly string[] | null;
  readonly maxAmountMinor: number;
}

export class PayFlowMemberClient {
  private readonly request: typeof globalThis.fetch;
  constructor(private readonly options: PayFlowMemberClientOptions) {
    this.request = options.fetch ?? globalThis.fetch;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await this.request(new URL(path, this.options.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.options.memberToken}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    };
  }

  readonly credentials = {
    /** Issue a credential from a STORED Authority. The server reads the Authority; the request can only narrow it. */
    issue: async (
      authorityId: string,
      input: IssueCredentialInput,
    ): Promise<IssueCredentialResult> => {
      const { status, json } = await this.call(
        "POST",
        `/v1/admin/org/authorities/${encodeURIComponent(authorityId)}/credentials`,
        input,
      );
      if (status === 200 || status === 201)
        return {
          ok: true,
          replayed: json.replayed === true,
          credentialId: String(json.credentialId),
          authorityId: String(json.authorityId),
          expiresAt: String(json.expiresAt),
          credential: json.credential as Credential,
        };
      return {
        ok: false,
        httpStatus: status,
        reason: typeof json.reason === "string" ? json.reason : "UNKNOWN",
        recoverable: json.recoverable === true,
      };
    },
    list: async (
      authorityId?: string,
    ): Promise<readonly CredentialSummary[]> => {
      const { json } = await this.call(
        "GET",
        authorityId
          ? `/v1/admin/org/authorities/${encodeURIComponent(authorityId)}/credentials`
          : "/v1/admin/org/credentials",
      );
      return (json.credentials ?? []) as CredentialSummary[];
    },
    revoke: async (
      credentialId: string,
      reason: string,
    ): Promise<{ found: boolean; alreadyRevoked: boolean }> => {
      const { status, json } = await this.call(
        "POST",
        `/v1/admin/org/credentials/${encodeURIComponent(credentialId)}/revoke`,
        { reason },
      );
      return {
        found: status === 200,
        alreadyRevoked: json.alreadyRevoked === true,
      };
    },
  };
}

/** The issuer's signed revocation list. Public: no token. Verify its signature before trusting it. */
export async function fetchIssuerStatus(
  baseUrl: string,
  fetcher: typeof globalThis.fetch = fetch,
): Promise<StatusList> {
  const response = await fetcher(new URL("/v1/issuer/status", baseUrl));
  if (!response.ok) throw new Error(`ISSUER_STATUS_${response.status}`);
  return (await response.json()) as StatusList;
}
