import { cpSync, mkdirSync, rmSync } from "node:fs";
// Consolidated static output; no deployment or new Vercel project is created.
mkdirSync("public", { recursive: true });
rmSync("public/_next", { recursive: true, force: true });
cpSync("apps/console/out", "public", { recursive: true });
console.log("Company production export staged in public; nothing deployed.");
