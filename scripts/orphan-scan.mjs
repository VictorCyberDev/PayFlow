// Forward traceability (mandate section 20): find code that nothing reaches.
//
// A module can be complete, correct, well-tested and still dead. `src/missions/fx.ts` was exactly that: a careful
// integer-math FX converter with directional rounding and staleness refusal, imported by nothing. A green test suite
// says nothing about whether a module is reachable, because the test is itself an importer.
//
// So this looks for two things, and reports rather than guesses:
//   1. MODULES no non-test file imports (and which are not entry points).
//   2. EXPORTS referenced only by their own file and by tests.
//
// It is deliberately conservative: it reports, with a reason, and exits non-zero only when a module is reachable from
// nothing at all including tests. Everything else is a finding for a person to judge, because "only tests use it" is
// sometimes right (a verifier CLI) and sometimes a module that was built and never wired.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

const ROOT = resolve(".");
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js)$/u.test(e) && !/\.d\.ts$/u.test(e)) out.push(p);
  }
  return out;
};

const srcFiles = walk(join(ROOT, "src")).map((p) => relative(ROOT, p));
const testFiles = walk(join(ROOT, "tests")).map((p) => relative(ROOT, p));
const otherFiles = [
  "scripts",
  "examples",
  "api",
  "hosting",
  "packages",
  "plugins",
  "spec",
]
  .flatMap((d) => {
    try {
      return walk(join(ROOT, d));
    } catch {
      return [];
    }
  })
  .map((p) => relative(ROOT, p));

const read = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
const text = new Map(
  [...srcFiles, ...testFiles, ...otherFiles].map((f) => [f, read(f)]),
);

/** Resolve a relative import specifier to the repository-relative .ts path it means. */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(join(ROOT, fromFile)), spec);
  const candidates = [
    base.replace(/\.js$/u, ".ts"),
    base.replace(/\.js$/u, ".mjs"),
    base + ".ts",
    base + ".mjs",
    join(base, "index.ts"),
  ];
  for (const c of candidates) {
    const rel = relative(ROOT, c);
    if (text.has(rel)) return rel;
  }
  return null;
}

const IMPORT =
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;
const importersOf = new Map(
  srcFiles.map((f) => [f, { src: [], test: [], other: [] }]),
);
for (const [file, body] of text) {
  const kind = file.startsWith("tests/")
    ? "test"
    : file.startsWith("src/")
      ? "src"
      : "other";
  for (const m of body.matchAll(IMPORT)) {
    const target = resolveSpec(file, m[1] ?? m[2] ?? "");
    if (target && importersOf.has(target) && target !== file)
      importersOf.get(target)[kind].push(file);
  }
}

// Entry points: reached by the build, a script, or the serverless handler rather than by an import we can see.
const ENTRY = [
  /^src\/demo\.ts$/u,
  /^src\/console-hosted\.ts$/u,
  /^src\/bench\//u,
  /^src\/ops\//u,
  /\.generated\.ts$/u,
];

/**
 * Modules that are deliberately not reached, each with the reason. An orphan is allowed only with a stated reason, so
 * that "nothing imports this" is always either a finding or a decision someone wrote down.
 */
const PARKED = new Map([
  [
    "src/demo-projection.ts",
    "Unreferenced anywhere, including by tests and docs: an earlier demo surface superseded by the console. Parked rather than deleted because removing another author's module is the owner's call and there is no urgency. Parked rather than left failing because an unresolved finding that keeps CI red stops the check doing its real job, which is catching the NEXT orphan.",
  ],
  [
    "src/protocols/oauth-metadata.ts",
    "Deliberate: the file itself says to expose it only once the named authorization server is commissioned. Wiring it earlier would advertise a resource that does not exist.",
  ],
]);

const unreachable = [];
const parked = [];
const testOnly = [];
for (const f of srcFiles) {
  if (ENTRY.some((r) => r.test(f))) continue;
  const i = importersOf.get(f);
  if (i.src.length === 0 && i.other.length === 0 && i.test.length === 0) {
    if (PARKED.has(f)) parked.push(f);
    else unreachable.push(f);
  } else if (i.src.length === 0 && i.other.length === 0)
    testOnly.push({ file: f, tests: i.test.length });
}

const out = [];
out.push(`Scanned ${srcFiles.length} files under src/.`);
if (unreachable.length) {
  out.push(
    "",
    `UNREACHABLE — nothing imports these, not even a test (${unreachable.length}):`,
  );
  for (const f of unreachable) out.push(`  ${f}`);
}
if (testOnly.length) {
  out.push(
    "",
    `TEST-ONLY — imported by tests but by no shipping code (${testOnly.length}):`,
  );
  for (const t of testOnly)
    out.push(`  ${t.file}  (${t.tests} test file${t.tests === 1 ? "" : "s"})`);
  out.push(
    "",
    "  Test-only is a finding, not a verdict. A verifier CLI or a pure helper proven in isolation can be",
    "  legitimately test-only. A service built and never wired is not. Judge each one.",
  );
}
if (parked.length) {
  out.push(
    "",
    `PARKED \u2014 unreached on purpose, with a reason on record (${parked.length}):`,
  );
  for (const f of parked) out.push(`  ${f}`, `      ${PARKED.get(f)}`);
}
if (!unreachable.length && !testOnly.length) out.push("", "No orphans found.");
console.log(out.join("\n"));
// Fail only on the unambiguous case.
process.exit(unreachable.length ? 1 : 0);
