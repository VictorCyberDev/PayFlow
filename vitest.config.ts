import { defineConfig, coverageConfigDefaults } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    exclude: ["**/node_modules/**", "**/.git/**", "apps/console/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      exclude: [
        ...coverageConfigDefaults.exclude,
        "apps/console/**",
        "hosting/operator/**",
        "docs/**",
      ],
    },
  },
});
