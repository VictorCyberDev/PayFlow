import {
  MerchantVerifierClient,
  gateMarkModel,
  requireVerifiedAuthority,
} from "../packages/merchant-sdk/src/index.js";

export async function verifyBeforeCheckout(
  baseUrl: string,
  merchantClientId: string,
  signedPresentation: unknown,
) {
  const verifier = new MerchantVerifierClient({
    baseUrl,
    clientId: merchantClientId,
  });
  const result = (await verifier.verifyPresentation(signedPresentation)) as {
    verdict?: string;
  };
  requireVerifiedAuthority(result);
  return {
    result,
    mark: gateMarkModel("VERIFIED", `${baseUrl}/verify`),
  };
}
