import {
  readGuardedBody,
  RequestGuard,
  json,
  unavailable,
} from "../src/partner/endpoint.js";
import {
  Channel3Catalogue,
  discoverProducts,
  type DiscoveryFailure,
  type ProductCatalogue,
} from "../src/partner/product-discovery.js";

/**
 * POST /api/explore — live product discovery.
 *
 * Read-only. It searches a catalogue and returns observations. It cannot add to a basket, reserve stock, contact a merchant
 * or spend anything, because it has no code that could.
 */
const guard = new RequestGuard();

const MESSAGES: Readonly<Record<DiscoveryFailure, string>> = Object.freeze({
  CATALOGUE_NOT_CONFIGURED:
    "Product search is not switched on for this site yet. You can still walk the guided demo.",
  CATALOGUE_UNAVAILABLE:
    "The product catalogue is busy right now. Nothing was ordered. Please try again in a moment.",
  CATALOGUE_TIMEOUT:
    "That search took too long, so PayFlow stopped. Try again, or use fewer words.",
  CATALOGUE_REJECTED:
    "PayFlow could not search for that. Try describing the item in plain words.",
  INVALID_CATALOGUE_OUTPUT:
    "PayFlow could not read what came back, so it is not showing you prices it does not trust.",
  INVALID_INPUT:
    "Tell PayFlow what you are looking for — a few words is enough.",
});
const STATUS: Readonly<Record<DiscoveryFailure, number>> = Object.freeze({
  CATALOGUE_NOT_CONFIGURED: 503,
  CATALOGUE_UNAVAILABLE: 503,
  CATALOGUE_TIMEOUT: 504,
  CATALOGUE_REJECTED: 422,
  INVALID_CATALOGUE_OUTPUT: 502,
  INVALID_INPUT: 400,
});

export async function handleExploreRequest(
  request: Request,
  catalogue: ProductCatalogue | undefined,
  now: number = Date.now(),
  clock: () => string = () => new Date().toISOString(),
): Promise<Response> {
  const read = await readGuardedBody(request, guard, now);
  if ("refusal" in read) return read.refusal;
  const result = await discoverProducts(catalogue, read.body.query, clock);
  if (result.status !== "FOUND")
    return unavailable(STATUS[result.status], MESSAGES[result.status]);
  return json(200, {
    status: "FOUND",
    discovery: result.discovery,
    disclosure:
      "These are listings observed just now, not quotes. Delivery, tax and any checkout fees are not included, and PayFlow has not ordered anything.",
  });
}

export function POST(request: Request): Promise<Response> {
  return handleExploreRequest(request, Channel3Catalogue.fromEnvironment());
}
