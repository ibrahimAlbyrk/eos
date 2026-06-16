// Flat config — single file at repo root. Each package can extend by
// importing this and adding overrides.
//
// Kept deliberately light: no formatter rules (Prettier territory), no
// stylistic rules (line length, semicolons), only correctness signals.

import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.eos/**",
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
  // ---------------------------------------------------------------------------
  // Dependency direction enforcement.
  //
  // Clean Architecture says the inner layers (domain → application) must not
  // depend on outer layers (infrastructure → adapters → entrypoints). The
  // rules below mechanically enforce this so a careless `import { fs } from
  // "node:fs"` inside core/ trips lint instead of quietly working.
  //
  // contracts/ — the innermost layer. Only zod + own files allowed.
  // core/      — pure domain + use-cases. No node:* / 3rd-party infra. Only
  //              contracts/ + its own files.
  // infra/     — adapter impls. May import node:*, 3rd-party libs, contracts/,
  //              core/ports. NOT allowed to import from manager/, spawner/,
  //              gateway/ (those are entrypoints, outermost ring).
  //
  // The `patterns` list uses simple substring matching against the resolved
  // import path (node:* + relative paths). When you add a new infra concern,
  // add it as a port in core/ first, then implement in infra/ — that flow is
  // what these rules enforce.
  // ---------------------------------------------------------------------------
  {
    // Tests are co-located in core/src/__tests__/ — they need node:test +
    // node:assert. Production source under core/src/ — domain/, ports/,
    // use-cases/, services/ — gets the strict rule applied via the file
    // glob below.
    files: ["core/src/domain/**/*.ts", "core/src/ports/**/*.ts", "core/src/use-cases/**/*.ts", "core/src/services/**/*.ts", "core/src/errors/**/*.ts", "core/src/index.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["node:*"], message: "core/ must not import node built-ins. Define a port in core/ports/ and implement it in infra/." },
          { group: ["chokidar", "@homebridge/node-pty-prebuilt-multiarch", "@modelcontextprotocol/sdk*", "yaml", "marked", "highlight.js", "dompurify", "diff", "ink", "react"], message: "core/ must not import 3rd-party infrastructure modules. Define a port and implement in infra/." },
          { group: ["../../infra/*", "../../../infra/*", "../../manager/*", "../../../manager/*", "../../spawner/*", "../../../spawner/*", "../../gateway/*", "../../../gateway/*"], message: "core/ must not depend on outer layers (infra/, manager/, spawner/, gateway/). Dependency direction is inward." },
        ],
      }],
    },
  },
  {
    files: ["contracts/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["node:*"], message: "contracts/ must not import node built-ins (pure schemas only)." },
          { group: ["../../core/*", "../../../core/*", "../../infra/*", "../../../infra/*", "../../manager/*", "../../../manager/*", "../../spawner/*", "../../../spawner/*", "../../gateway/*", "../../../gateway/*"], message: "contracts/ is the innermost layer — must not depend on anything but zod + its own files." },
        ],
      }],
    },
  },
  {
    files: ["infra/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["../../manager/*", "../../../manager/*", "../../spawner/*", "../../../spawner/*", "../../gateway/*", "../../../gateway/*"], message: "infra/ must not depend on entrypoint packages. Configuration is injected at the composition root." },
        ],
      }],
    },
  },
  // Co-located contracts tests need node:test + node:assert. The strict
  // contracts/ rule above bans node built-ins for the pure schemas; relax it
  // for the __tests__ tree only.
  {
    files: ["contracts/src/__tests__/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  // React rules for the web package. rules-of-hooks is pure correctness;
  // exhaustive-deps is advisory (warn) and the source uses explicit
  // disable comments where a stale-closure is intentional.
  {
    files: ["app/ui/src/**/*.{js,jsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
