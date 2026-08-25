// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".ralph/**",
      "test/**",
      // The dashboard's browser bundles: a vendored MIT Datastar build and two
      // small scripts of ours, copied verbatim from the Go program. They are
      // not HQ TypeScript, they target the browser globals, and reformatting or
      // "fixing" them would break the vendoring.
      "src/web/static/**",
      // The Deno desktop shell and its compiled output: Deno TypeScript against
      // the `Deno` globals, owned by `deno lint` / `deno fmt` / `deno check`
      // (`bun run desktop:check`), not by this Node toolchain.
      "desktop/**",
      "dist-desktop/**",
      "eslint.config.js",
    ],
  },
  eslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
);
