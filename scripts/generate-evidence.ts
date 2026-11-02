import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildEvidenceArtifacts } from "../src/network/evidence-artifacts.js";

const directory = join(import.meta.dirname, "..", "docs", "evidence");
const check = process.argv.includes("--check");

const artifacts = await buildEvidenceArtifacts();
await mkdir(directory, { recursive: true });
let stale = 0;
for (const [name, content] of Object.entries(artifacts)) {
  const path = join(directory, name);
  if (check) {
    const existing = await readFile(path, "utf8").catch(() => null);
    if (existing !== content) {
      stale += 1;
      console.error(`STALE ${name}`);
    }
  } else {
    await writeFile(path, content);
    console.log(`wrote docs/evidence/${name}`);
  }
}
if (stale > 0) process.exit(1);
if (check)
  console.log(`evidence up to date (${Object.keys(artifacts).length} files)`);
