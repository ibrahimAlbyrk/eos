// Flat config — single file at repo root. Each package can extend by
// importing this and adding overrides.
//
// Kept deliberately light: no formatter rules (Prettier territory), no
// stylistic rules (line length, semicolons), only correctness signals.

import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.claude-mgr/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  {
    // ESLint 10 only picks up *.js by default. Tell it to also lint our .ts
    // and .tsx/.jsx sources. We accept that TS-specific rules aren't run
    // (would need @typescript-eslint) — this catches syntax + obvious
    // mistakes, not type errors.
    files: ["**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parser: tsParser,
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // Correctness only — no style debates.
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "warn",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-implicit-coercion": "warn",
      "no-throw-literal": "error",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // `let x = ""; try { x = ... } catch { x = ... }` is a common best-effort
      // pattern in this codebase. The initial assignment is technically dead
      // but the alternative (declare without initial value) is uglier.
      "no-useless-assignment": "warn",
      // CommonJS-isms aren't relevant here.
      "no-fallthrough": ["error", { commentPattern: "fallthrough" }],
      // React JSX uses lowercase intrinsics + uppercase components — JSX
      // tags are valid identifiers, so no-undef trips on the lowercase ones.
      // We disable the rule for files that look like JSX (handled per-pkg).
    },
  },
];
