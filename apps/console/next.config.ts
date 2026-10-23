import type { NextConfig } from "next";
const config: NextConfig = {
  output: "export",
  turbopack: { root: process.cwd() },
  poweredByHeader: false,
};
export default config;
