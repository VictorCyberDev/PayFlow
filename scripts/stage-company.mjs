import { cpSync, mkdirSync } from "node:fs";
// Consolidated static output; no deployment or new Vercel project is created.
mkdirSync("public", { recursive: true });
cpSync("apps/console/out", "public", { recursive: true });
console.log("Company production export staged in public; nothing deployed.");
