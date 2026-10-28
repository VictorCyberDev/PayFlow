#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
}).split("\0").filter(Boolean);

const binaryExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2", ".ico", ".pdf", ".zip",
]);
const secretAssignment = /\b(?:PAYPAL_CLIENT_SECRET|GROQ_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|SUPABASE_SERVICE_ROLE_KEY|VERCEL_TOKEN|AWS_SECRET_ACCESS_KEY|DATABASE_URL)\s*[=:]\s*["']?(?!\.\.\.|<|REPLACE|postgres:\/\/payflow:payflow_test@)[A-Za-z0-9_./:+\-=]{16,}/giu;
const patterns = [
  { name: "private-key-pem", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/gu },
  { name: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/gu },
  { name: "secret-assignment", pattern: secretAssignment },
];

const findings = [];
for (const file of files) {
  const dot = file.lastIndexOf(".");
  const extension = dot >= 0 ? file.slice(dot).toLowerCase() : "";
  if (binaryExtensions.has(extension)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const { name, pattern } of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(0, match.index ?? 0);
      const line = before.split("\n").length;
      findings.push({ file, line, rule: name });
    }
  }
}

if (findings.length > 0) {
  console.error("Potential committed secrets detected (values redacted):");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.rule}`);
  }
  process.exit(1);
}
console.log(`Secret scan PASS: ${files.length} tracked files checked; 0 findings.`);
