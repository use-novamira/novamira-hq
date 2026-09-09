// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one HQ export the desktop shell calls, declared here so Deno's type
 * checker does not have to resolve `dist/main.d.ts` and, through it, the
 * `@types/node` package that lives in the repository's `node_modules`. The real
 * signature is in `src/main.ts`; the argv-in, exit-code-out shape is the whole
 * of what the shell depends on.
 */
export function main(
  argv: readonly string[],
  streams?: undefined,
  environment?: undefined,
  overrides?: {
    readonly distribution: "desktop";
    readonly mcpLaunch: {
      readonly command: string;
      readonly args: readonly string[];
    };
  },
): Promise<number>;
