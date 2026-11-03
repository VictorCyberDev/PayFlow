/**
 * Replaceable brand configuration (BRAND-002). "PayFlow" is the project
 * codename. This is the single place customer-facing product copy reads the
 * product name from, so a commercial rename is a one-file change here.
 * Financial semantics, the X-PayFlow request headers, schema version
 * identifiers and persisted evidence never depend on this value.
 *
 * There is deliberately no environment lookup: the browser graph must not
 * read server configuration (see tests/boundary.test.mjs).
 */
export const BRAND = Object.freeze({
  name: "PayFlow",
  category: "Financial authority for autonomous systems",
});
