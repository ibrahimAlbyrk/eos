// Correctness signals only: no formatter or stylistic rules.

import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["node_modules/**", "dist/**", "coverage/**", "**/*.d.ts"] },
  js.configs.recommended,
  {
    // The TypeScript parser reads the plain-TypeScript modules in src/shared too;
    // no type-aware rules run.
    files: ["**/*.js", "**/*.jsx", "**/*.ts", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parser: tsParser,
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "warn",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-implicit-coercion": "warn",
      "no-throw-literal": "error",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // `let x = ""; try { x = … } catch { x = … }` is a common best-effort pattern here.
      "no-useless-assignment": "warn",
      "no-fallthrough": ["error", { commentPattern: "fallthrough" }],
    },
  },
  {
    // rules-of-hooks is correctness; exhaustive-deps is advisory, and the source
    // disables it where a stale closure is intended.
    files: ["src/**/*.{js,jsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
