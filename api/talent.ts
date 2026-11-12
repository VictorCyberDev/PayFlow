import {
  readGuardedBody,
  RequestGuard,
  json,
  unavailable,
} from "../src/partner/endpoint.js";
import {
  findTalent,
  GitHubTalentDirectory,
  type TalentDirectory,
  type TalentFailure,
} from "../src/partner/talent.js";

/**
 * POST /api/talent — real people who have said they are open to work.
 *
 * Read-only. There is no outreach here and no way to contact anyone: finding somebody and messaging them are different
 * permissions, and only the first is built.
 */
const guard = new RequestGuard({ perCaller: 4, perInstance: 40 });

const MESSAGES: Readonly<Record<TalentFailure, string>> = Object.freeze({
  DIRECTORY_NOT_CONFIGURED:
    "Talent search is not switched on for this site yet. You can still plan the hire and try the guided demo.",
  DIRECTORY_UNAVAILABLE:
    "The directory did not answer just now, or PayFlow has used up its allowance for the hour. Nobody was contacted. Try again shortly.",
  DIRECTORY_TIMEOUT:
    "That search took too long, so PayFlow stopped. Nobody was contacted. Try again, or use fewer words.",
  DIRECTORY_REJECTED:
    "PayFlow could not search for that. Try naming the skills in plain words.",
  INVALID_DIRECTORY_OUTPUT:
    "PayFlow could not read what came back, so it is not showing you people it cannot stand behind.",
  INVALID_INPUT:
    "Tell PayFlow what skills you need — a couple of words is enough.",
});
const STATUS: Readonly<Record<TalentFailure, number>> = Object.freeze({
  DIRECTORY_NOT_CONFIGURED: 503,
  DIRECTORY_UNAVAILABLE: 503,
  DIRECTORY_TIMEOUT: 504,
  DIRECTORY_REJECTED: 422,
  INVALID_DIRECTORY_OUTPUT: 502,
  INVALID_INPUT: 400,
});

export async function handleTalentRequest(
  request: Request,
  directory: TalentDirectory | undefined,
  now: number = Date.now(),
  clock: () => string = () => new Date().toISOString(),
): Promise<Response> {
  const read = await readGuardedBody(request, guard, now);
  if ("refusal" in read) return read.refusal;
  const result = await findTalent(
    directory,
    read.body.skills,
    read.body.location,
    clock,
  );
  if (result.status !== "FOUND")
    return unavailable(STATUS[result.status], MESSAGES[result.status]);
  return json(200, {
    status: "FOUND",
    search: result.search,
    disclosure:
      "Everyone here is a real person who set their own profile to say they are open to work. PayFlow has not contacted anyone, and it does not know their rate or whether they are free on your dates.",
  });
}

export function POST(request: Request): Promise<Response> {
  return handleTalentRequest(request, GitHubTalentDirectory.fromEnvironment());
}
