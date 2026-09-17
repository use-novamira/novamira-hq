// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";

/** Open a caller-validated URL, without a shell or forwarding browser output. */
export async function openInBrowser(target: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? (["open", [target]] as const)
      : process.platform === "win32"
        ? (["rundll32", ["url.dll,FileProtocolHandler", target]] as const)
        : (["xdg-open", [target]] as const);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      detached: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
