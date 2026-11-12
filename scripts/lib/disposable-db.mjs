/**
 * Guard for scripts that CREATE and DROP databases (the acceptance runs and the schema-fingerprint snapshot). They must only ever act on a
 * disposable PostgreSQL on this machine. A configurable URL is not enough to prove that, so every one of these must hold, otherwise the script stops
 * before it connects:
 *   1. an explicit opt-in: PAYFLOW_ALLOW_DESTRUCTIVE_TEST_DB=1 (so a stray ACCEPT_ADMIN_URL in a shell can never be enough on its own);
 *   2. the host is localhost, 127.0.0.1 or ::1 (nothing remote, nothing on a private network, nothing named like a cloud database);
 *   3. the URL does not smuggle another host through a query parameter (host, hostaddr, service, options);
 *   4. the database in the URL has a disposable name (it contains `test`, `scratch`, `accept`, `acceptance` or `tmp` as a whole word);
 *   5. the database that is dropped is one of this repository's own scratch names, never anything else.
 */
export const OPT_IN_VARIABLE = "PAYFLOW_ALLOW_DESTRUCTIVE_TEST_DB";
const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);
const DISPOSABLE_NAME =
  /(^|[_-])(test|scratch|accept|acceptance|tmp)($|[_-])/iu;
const SCRATCH_NAME =
  /^(b1b2_acceptance|journey_acceptance|fp_[a-z0-9]{6}|fp_test_[a-z0-9]{6}|fpx_[a-z0-9]{5})$/u;

export function assertDisposableDatabase(rawUrl, env = process.env) {
  const refuse = (why) => {
    throw new Error(
      `REFUSED: this script creates and drops databases and will not run against ${why}. ` +
        `Point ACCEPT_ADMIN_URL at a disposable local PostgreSQL (for example postgres://payflow:payflow_test@localhost:5432/payflow_test) and set ${OPT_IN_VARIABLE}=1.`,
    );
  };
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return refuse("a URL that cannot be parsed");
  }
  if (!/^postgres(ql)?:$/u.test(u.protocol)) refuse("a non-PostgreSQL URL");
  const host = u.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!LOCAL.has(host)) refuse("a database that is not on this machine");
  for (const k of ["host", "hostaddr", "service", "options"])
    if (u.searchParams.has(k)) refuse(`a URL that overrides its host (${k}=)`);
  const db = decodeURIComponent(u.pathname.replace(/^\//u, ""));
  if (!DISPOSABLE_NAME.test(db))
    refuse("a database whose name does not look disposable");
  if (env[OPT_IN_VARIABLE] !== "1")
    refuse(`a run without ${OPT_IN_VARIABLE}=1`);
  return { host, database: db };
}

export function assertScratchName(name) {
  if (!SCRATCH_NAME.test(String(name)))
    throw new Error(
      `REFUSED: "${String(name)}" is not one of this repository's scratch database names; it will not be created or dropped.`,
    );
  return name;
}
