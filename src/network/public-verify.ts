import {
  createHash,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

export interface VerifyQuotaResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: string;
}

export interface PublicVerifyDependencies {
  consumeQuota(clientId: string, now: string): Promise<VerifyQuotaResult>;
  verifyPresentation(input: unknown): Promise<unknown>;
}

export interface PublicVerifyResponse {
  readonly status: 200 | 400 | 429;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export async function publicVerify(
  request: { clientId: string; presentation: unknown; now: string },
  deps: PublicVerifyDependencies,
): Promise<PublicVerifyResponse> {
  if (!request.clientId || !Number.isFinite(Date.parse(request.now))) {
    return {
      status: 400,
      headers: { "cache-control": "no-store" },
      body: { error: "MALFORMED_VERIFY_REQUEST" },
    };
  }
  const quota = await deps.consumeQuota(request.clientId, request.now);
  const headers = {
    "cache-control": "no-store",
    "x-ratelimit-remaining": String(quota.remaining),
    "x-ratelimit-reset": quota.resetAt,
  };
  if (!quota.allowed) {
    return {
      status: 429,
      headers,
      body: { error: "VERIFY_RATE_LIMITED" },
    };
  }
  return {
    status: 200,
    headers,
    body: await deps.verifyPresentation(request.presentation),
  };
}

export interface SignedVerifierRequest {
  readonly verifierId: string;
  readonly keyId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly bodyDigest: string;
  readonly signature: string;
}

export function digestVerificationBody(body: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(body)), "utf8")
    .digest("hex");
}

export function verifySignedVerifierRequest(
  request: SignedVerifierRequest,
  body: unknown,
  publicKey: KeyObject,
  now: string,
  maxClockSkewSeconds = 300,
): boolean {
  if (!/^[a-f0-9]{64}$/u.test(request.bodyDigest)) return false;
  if (request.bodyDigest !== digestVerificationBody(body)) return false;
  const requestTime = Date.parse(request.timestamp);
  const nowTime = Date.parse(now);
  if (!Number.isFinite(requestTime) || !Number.isFinite(nowTime)) return false;
  if (Math.abs(nowTime - requestTime) > maxClockSkewSeconds * 1000) {
    return false;
  }
  const canonical = [
    request.verifierId,
    request.keyId,
    request.timestamp,
    request.nonce,
    request.bodyDigest,
  ].join("\n");
  return cryptoVerify(
    null,
    Buffer.from(canonical, "utf8"),
    publicKey,
    Buffer.from(request.signature, "base64url"),
  );
}
