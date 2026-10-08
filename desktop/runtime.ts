// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Finder does not inherit the user's terminal PATH. Never persist it in MCP. */
export async function prepareCommandPath(): Promise<void> {
  if (Deno.build.os !== "darwin") return;
  const original = Deno.env.get("PATH") ?? "";
  const home = Deno.env.get("HOME");
  let loginPath = "";
  const shell = Deno.env.get("SHELL") ?? "/bin/zsh";
  if (["/bin/zsh", "/bin/bash"].includes(shell)) {
    let child: Deno.ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child = new Deno.Command(shell, {
        args: ["-ilc", "/usr/bin/printenv PATH"],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
        // An interactive shell sharing a terminal takes over its foreground
        // job and leaves the parent (e.g. a terminal MCP client) suspended.
        detached: true,
      }).spawn();
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            child?.kill("SIGKILL");
          } catch { /* already exited */ }
          reject(new Error("Shell environment lookup timed out"));
        }, 3000);
      });
      const output = await Promise.race([child.output(), deadline]);
      if (output.success && output.stdout.length <= 65536) {
        loginPath =
          new TextDecoder().decode(output.stdout).trim().split("\n").at(-1) ??
            "";
      }
    } catch {
      /* Standard locations below still work without shell startup. */
    } finally {
      clearTimeout(timer);
    }
  }
  const entries = [
    original,
    loginPath,
    ...(home ? [join(home, ".local/bin"), join(home, "bin")] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
    .flatMap((part) => part.split(":"))
    .filter((part) => part.startsWith("/") && !/[\r\n]/.test(part));
  Deno.env.set("PATH", [...new Set(entries)].join(":"));
}

/** Prepare native webview loading independently of the launch directory. */
export async function prepareBundledWebview(): Promise<() => void> {
  if (Deno.build.os === "windows") {
    // Upstream @webview/webview writes WebView2Loader.dll to `./` at import
    // time. Shortcuts and elevated launchers may start in System32, where a
    // regular user cannot write. Its native files must also work without a
    // network or a populated Deno cache.
    const previous = Deno.cwd();
    const stage = Deno.makeTempDirSync({ prefix: "novamira-hq-webview-" });
    try {
      const specifier =
        new URL("../dist/config/file-security.js", import.meta.url).href;
      const { defaultFileSecurity } = (await import(
        specifier
      )) as typeof import("../dist/config/file-security.js");
      await defaultFileSecurity().secureDirectory(stage);
      for (const filename of ["webview.dll", "WebView2Loader.dll"]) {
        const asset = new URL(
          `../dist-desktop/native-windows/${filename}`,
          import.meta.url,
        );
        Deno.writeFileSync(join(stage, filename), Deno.readFileSync(asset));
      }
      Deno.env.set("PLUGIN_URL", pathToFileURL(`${stage}/`).href);
      Deno.chdir(stage);
    } catch (error) {
      Deno.removeSync(stage, { recursive: true });
      throw error;
    }
    return () => {
      try {
        Deno.chdir(previous);
      } catch {
        try {
          Deno.chdir(dirname(stage));
        } catch { /* The process is exiting; never skip server shutdown. */ }
      }
      try {
        Deno.removeSync(stage, { recursive: true });
      } catch { /* A loaded DLL may remain locked until the process exits. */ }
    };
  }
  if (Deno.build.os !== "darwin") return () => {};
  const contents = dirname(dirname(Deno.execPath()));
  if (!contents.endsWith(".app/Contents")) return () => {};
  const frameworks = join(contents, "Frameworks");
  const file = join(frameworks, `libwebview.${Deno.build.arch}.dylib`);
  if (!Deno.statSync(file).isFile) {
    throw new Error(
      "The app's webview library is missing. Reinstall Novamira HQ.",
    );
  }
  Deno.env.set("PLUGIN_URL", pathToFileURL(`${frameworks}/`).href);
  return () => {};
}

/** Only this fixed local download is exposed to the webview, never arbitrary URLs. */
export function openMcpDownload(origin: string): void {
  const url = new URL("/mcp/novamira-hq.mcpb", origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Invalid local dashboard address");
  }
  const result = new Deno.Command("/usr/bin/open", {
    args: [url.href],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).outputSync();
  if (!result.success) {
    throw new Error("Could not open the download in your browser.");
  }
}

export const MCP_DOWNLOAD_SCRIPT =
  `document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[href="/mcp/novamira-hq.mcpb"]');
  if (!link || event.defaultPrevented || !event.isTrusted) return;
  event.preventDefault();
  const original = link.textContent;
  link.textContent = 'Opening download in your browser…';
  window.novamiraDownloadMcp().catch(() => { link.textContent = 'Download could not start. Try again.'; });
  setTimeout(() => { link.textContent = original; }, 8000);
}, true);`;

/** Open only HQ release links in the system browser, including download links. */
export function openDesktopRelease(target: unknown): void {
  if (
    typeof target !== "string" ||
    !/^https:\/\/github\.com\/use-novamira\/novamira-hq\/releases\/(?:tag|download)\/[A-Za-z0-9._%+/-]+$/
      .test(target)
  ) {
    throw new Error("Invalid desktop release link");
  }
  const command = Deno.build.os === "darwin"
    ? "/usr/bin/open"
    : Deno.build.os === "windows"
    ? "rundll32.exe"
    : "xdg-open";
  const args = Deno.build.os === "windows"
    ? ["url.dll,FileProtocolHandler", target]
    : [target];
  const result = new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).outputSync();
  if (!result.success) {
    throw new Error("Could not open the release in your browser.");
  }
}

export const DESKTOP_RELEASE_SCRIPT =
  `document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[href^="https://github.com/use-novamira/novamira-hq/releases/"]');
  if (!link || event.defaultPrevented || !event.isTrusted) return;
  event.preventDefault();
  window.novamiraOpenRelease(link.href).catch(() => { link.textContent = 'Could not open your browser. Try again.'; });
}, true);`;
