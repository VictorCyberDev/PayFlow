import { z } from "zod";

/**
 * V4 — real talent discovery.
 *
 * The blocker on talent was never "no API". It was that the only data in the repository was fictional candidate
 * fixtures, and the mandate rightly forbids showing invented people as real hiring opportunities. The way around is a
 * source where the people are real, the portfolio is real, and — this is the part that matters — **availability is
 * declared by the person themselves rather than guessed by us.**
 *
 * GitHub's user API carries exactly that: a `hireable` flag the developer sets on their own profile. So:
 *
 *   - discovery is `GET /search/users`, which returns real accounts;
 *   - every candidate is then read from `GET /users/{login}`, and **only `hireable === true` survives**;
 *   - a profile PayFlow could not read is dropped, never shown with availability assumed.
 *
 * That last rule is the whole safety property. If enrichment fails for everyone, the result is an empty list and an
 * honest message — not a list of people who never said they were looking.
 *
 * What this is not: it finds people who write code and publish it. It will not find a motion designer. Saying so is
 * part of the product, and the interface says it.
 *
 * Nothing here contacts anybody. There is no outreach code on this host.
 */
export const TALENT_LIMITS = Object.freeze({
  queryCharacters: 120,
  timeoutMs: 20_000,
  responseBytes: 1_000_000,
  /** Profiles read per search. Each is one request, so this is also the rate-limit budget per search. */
  maxEnriched: 10,
  maxCandidates: 8,
});
const BASE = "https://api.github.com";

const SearchSchema = z
  .object({
    total_count: z.number().nonnegative().nullish(),
    items: z
      .array(z.object({ login: z.string().max(60) }).passthrough())
      .max(100)
      .nullish(),
  })
  .passthrough();

export const ProfileSchema = z
  .object({
    login: z.string().max(60),
    name: z.string().max(120).nullish(),
    hireable: z.boolean().nullish(),
    bio: z.string().max(400).nullish(),
    location: z.string().max(120).nullish(),
    company: z.string().max(120).nullish(),
    blog: z.string().max(400).nullish(),
    public_repos: z.number().int().nonnegative().max(1_000_000).nullish(),
    followers: z.number().int().nonnegative().max(100_000_000).nullish(),
    avatar_url: z.string().max(600).nullish(),
    html_url: z.string().max(600).nullish(),
    created_at: z.string().max(40).nullish(),
  })
  .passthrough();

export interface Candidate {
  readonly handle: string;
  readonly name: string | null;
  readonly summary: string | null;
  readonly location: string | null;
  readonly company: string | null;
  readonly portfolioUrl: string | null;
  readonly profileUrl: string;
  readonly avatarUrl: string | null;
  readonly publicProjects: number | null;
  readonly followers: number | null;
  readonly activeSince: string | null;
  /** Always true in a result: a candidate reaches a founder only when the person declared it. */
  readonly declaredAvailable: true;
}
export interface TalentSearch {
  readonly query: string;
  readonly candidates: readonly Candidate[];
  readonly observedAt: string;
  readonly evidence: "PROVIDER_OBSERVED";
  readonly source: "GitHub";
  /** How many profiles were read to produce the list, so a reader can see this is a filter rather than a ranking. */
  readonly profilesRead: number;
  /** Said plainly in the interface: this source finds people who publish code. */
  readonly covers: string;
  /** What PayFlow does NOT know about these people, however the list looks. */
  readonly unknowns: readonly string[];
}

export type TalentFailure =
  | "DIRECTORY_NOT_CONFIGURED"
  | "DIRECTORY_UNAVAILABLE"
  | "DIRECTORY_TIMEOUT"
  | "DIRECTORY_REJECTED"
  | "INVALID_DIRECTORY_OUTPUT"
  | "INVALID_INPUT";
export type TalentResult =
  { status: "FOUND"; search: TalentSearch } | { status: TalentFailure };

export interface TalentDirectory {
  searchHandles(
    query: string,
    signal: AbortSignal,
  ): Promise<{ status: "OK"; body: unknown } | { status: TalentFailure }>;
  readProfile(
    handle: string,
    signal: AbortSignal,
  ): Promise<{ status: "OK"; body: unknown } | { status: TalentFailure }>;
}

const safeUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || !value || value.length > 600) return null;
  const candidate = /^https?:\/\//iu.test(value) ? value : `https://${value}`;
  try {
    const u = new URL(candidate);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.toString()
      : null;
  } catch {
    return null;
  }
};
const clean = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters before a browser sees them is the point
  const t = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return t.length > 0 ? t.slice(0, max) : null;
};

/** Returns null for anyone who has not declared themselves available, whatever else their profile says. */
export function toCandidate(raw: unknown): Candidate | null {
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  // THE rule. No declaration, no listing.
  if (p.hireable !== true) return null;
  const handle = clean(p.login, 60);
  if (!handle || !/^[A-Za-z0-9-]{1,39}$/u.test(handle)) return null;
  return {
    handle,
    name: clean(p.name, 120),
    summary: clean(p.bio, 400),
    location: clean(p.location, 120),
    company: clean(p.company, 120),
    portfolioUrl: safeUrl(p.blog),
    profileUrl: safeUrl(p.html_url) ?? `https://github.com/${handle}`,
    avatarUrl: safeUrl(p.avatar_url),
    publicProjects: typeof p.public_repos === "number" ? p.public_repos : null,
    followers: typeof p.followers === "number" ? p.followers : null,
    activeSince: clean(p.created_at, 40),
    declaredAvailable: true,
  };
}

/** Skills a founder types become a bio search; the qualifiers are ours, never the caller's. */
export function buildQuery(raw: unknown, location?: unknown): string | null {
  const skills = clean(raw, TALENT_LIMITS.queryCharacters);
  if (!skills || skills.length < 2) return null;
  // Only letters, digits, spaces and a few separators reach the provider: no qualifier injection.
  const safe = skills
    .replace(/[^A-Za-z0-9 .+#/-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!safe) return null;
  const where = clean(location, 60)
    ?.replace(/[^A-Za-z0-9 ,.-]/gu, "")
    .trim();
  return [
    `${safe} in:bio`,
    "type:user",
    "repos:>4",
    ...(where ? [`location:"${where}"`] : []),
  ].join(" ");
}

export async function findTalent(
  directory: TalentDirectory | undefined,
  skills: unknown,
  location: unknown,
  now: () => string = () => new Date().toISOString(),
): Promise<TalentResult> {
  if (!directory) return { status: "DIRECTORY_NOT_CONFIGURED" };
  const query = buildQuery(skills, location);
  if (!query) return { status: "INVALID_INPUT" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TALENT_LIMITS.timeoutMs);
  try {
    const found = await directory.searchHandles(query, ctl.signal);
    if (found.status !== "OK") return { status: found.status };
    const parsed = SearchSchema.safeParse(found.body);
    if (!parsed.success) return { status: "INVALID_DIRECTORY_OUTPUT" };
    const handles = (parsed.data.items ?? [])
      .map((i) => i.login)
      .filter((h) => /^[A-Za-z0-9-]{1,39}$/u.test(h))
      .slice(0, TALENT_LIMITS.maxEnriched);
    // Read each profile. A profile that cannot be read is simply absent: availability is never assumed.
    const profiles = await Promise.all(
      handles.map(async (h) => {
        const r = await directory.readProfile(h, ctl.signal);
        return r.status === "OK" ? toCandidate(r.body) : null;
      }),
    );
    const candidates = profiles
      .filter((c): c is Candidate => c !== null)
      .slice(0, TALENT_LIMITS.maxCandidates);
    return {
      status: "FOUND",
      search: Object.freeze({
        query,
        candidates: Object.freeze(candidates),
        observedAt: now(),
        evidence: "PROVIDER_OBSERVED",
        source: "GitHub",
        profilesRead: handles.length,
        covers:
          "people who write and publish code, and who have set their own profile to say they are open to work",
        unknowns: Object.freeze([
          "their rate",
          "whether they are free on your dates",
          "whether they want this kind of work",
        ]),
      }),
    };
  } catch {
    return {
      status: ctl.signal.aborted
        ? "DIRECTORY_TIMEOUT"
        : "DIRECTORY_UNAVAILABLE",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GitHub's public user API. A token is optional and only raises the rate limit; without one the endpoint still works,
 * just far fewer times per hour, which is why the surface says so when it runs dry.
 */
export class GitHubTalentDirectory implements TalentDirectory {
  readonly #token: string;
  constructor(
    token: string | undefined,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.#token = token && !/[\r\n\s]/u.test(token) ? token : "";
  }
  static fromEnvironment(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): GitHubTalentDirectory {
    return new GitHubTalentDirectory(env["GITHUB_TALENT_TOKEN"]);
  }
  async #call(path: string, signal: AbortSignal) {
    let res: Response;
    try {
      res = await this.transport(BASE + path, {
        method: "GET",
        redirect: "error",
        signal,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          // A generic client name: never the founder's, never the user's, per this project's privacy rule.
          "user-agent": "payflow-talent",
          ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
        },
      });
    } catch {
      return {
        status: signal.aborted
          ? ("DIRECTORY_TIMEOUT" as const)
          : ("DIRECTORY_UNAVAILABLE" as const),
      };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return {
        status:
          res.status === 401
            ? ("DIRECTORY_NOT_CONFIGURED" as const)
            : res.status === 403 || res.status === 429 || res.status >= 500
              ? // 403 here is nearly always the rate limit, which is a "come back later", not a refusal of the query.
                ("DIRECTORY_UNAVAILABLE" as const)
              : ("DIRECTORY_REJECTED" as const),
      };
    }
    try {
      const raw = (await res.text()).slice(0, TALENT_LIMITS.responseBytes);
      return { status: "OK" as const, body: JSON.parse(raw) as unknown };
    } catch {
      return { status: "INVALID_DIRECTORY_OUTPUT" as const };
    }
  }
  searchHandles(query: string, signal: AbortSignal) {
    return this.#call(
      `/search/users?q=${encodeURIComponent(query)}&per_page=${TALENT_LIMITS.maxEnriched}`,
      signal,
    );
  }
  readProfile(handle: string, signal: AbortSignal) {
    return this.#call(`/users/${encodeURIComponent(handle)}`, signal);
  }
}
