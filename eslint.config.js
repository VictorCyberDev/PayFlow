import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["public/**/*.js"],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
      globals: {
        document: "readonly",
        window: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        AbortController: "readonly",
        fetch: "readonly",
      },
    },
  },
  { ignores: ["dist/**", "coverage/**", "apps/console/**", "docs/brand/**"] },
);
