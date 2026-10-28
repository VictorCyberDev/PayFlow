import { z } from "zod";
import {
  publicVerify,
  type PublicVerifyDependencies,
  type PublicVerifyResponse,
} from "./public-verify.js";

const VerifyBodySchema = z
  .object({
    presentation: z.unknown(),
  })
  .strict();

export interface PublicVerifyRestRequest {
  readonly method: "POST";
  readonly path: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

export interface PublicVerifyRestDependencies extends PublicVerifyDependencies {
  now(): string;
}

function normalizedHeaders(
  headers: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

export function createPublicVerifyRestHandler(
  deps: PublicVerifyRestDependencies,
) {
  return async (
    request: PublicVerifyRestRequest,
  ): Promise<PublicVerifyResponse | { status: 404; headers: Readonly<Record<string, string>>; body: unknown }> => {
    if (request.method !== "POST" || request.path !== "/v1/verify/presentations") {
      return {
        status: 404,
        headers: { "cache-control": "no-store" },
        body: { error: "ROUTE_NOT_FOUND" },
      };
    }
    const parsed = VerifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return {
        status: 400,
        headers: { "cache-control": "no-store" },
        body: { error: "MALFORMED_VERIFY_REQUEST" },
      };
    }
    const headers = normalizedHeaders(request.headers);
    const clientId = headers["x-payflow-verifier-client"] ?? "";
    return publicVerify(
      {
        clientId,
        presentation: parsed.data.presentation,
        now: deps.now(),
      },
      deps,
    );
  };
}
