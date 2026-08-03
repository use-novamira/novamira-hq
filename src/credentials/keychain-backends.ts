// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";

import {
  POWERSHELL_PREFIX,
  powerShellEnvironment,
  powerShellLiteral,
} from "../config/powershell.js";
import { CliError } from "../errors.js";

// HQ's keychain namespace is disjoint from the site CLI's `ai.novamira.cli`.
// Nothing in this package may ever read or write the site CLI's records.
export const CREDENTIAL_SERVICE = "ai.novamira.hq";
export const CREDENTIAL_LABEL = "Novamira HQ";

export interface CommandResult {
  /** Exit status, or `null` when the child was killed by a signal. */
  readonly code: number | null;
  /** Signal that killed the child, or `null` when it exited on its own. */
  readonly signal: NodeJS.Signals | null;
  /** True when stdout exceeded the buffer ceiling and the child was killed. */
  readonly truncated: boolean;
  readonly stdout: string;
}

export interface CommandExecutor {
  execute(
    command: string,
    args: readonly string[],
    stdin?: string,
    environment?: NodeJS.ProcessEnv,
  ): Promise<CommandResult>;
}

export class BackendUnavailableError extends Error {
  constructor() {
    super("Credential backend is unavailable.");
    this.name = "BackendUnavailableError";
  }
}

export class SpawnCommandExecutor implements CommandExecutor {
  constructor(private readonly timeoutMs = 5_000) {}

  async execute(
    command: string,
    args: readonly string[],
    stdin = "",
    environment?: NodeJS.ProcessEnv,
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        ...(environment === undefined ? {} : { env: environment }),
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size <= 1024 * 1024) chunks.push(chunk);
        else {
          truncated = true;
          child.kill();
        }
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (error.code === "ENOENT") reject(new BackendUnavailableError());
        else reject(new Error("Credential backend command failed to start."));
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        // A killed child MUST NOT look like a normal exit status. Reporting a
        // timed-out `secret-tool lookup` as status 1 would read as "no such
        // secret" and let a later rollback delete a credential that exists.
        resolve({
          code,
          signal: signal ?? (timedOut || truncated ? "SIGTERM" : null),
          truncated,
          stdout: Buffer.concat(chunks).toString("utf8"),
        });
      });
      child.stdin.end(stdin);
    });
  }
}

export type CredentialBackendKind =
  | "macos-keychain"
  | "linux-secret-service"
  | "windows-credential-manager"
  | "file";

export interface CredentialDiagnostic {
  readonly backend: CredentialBackendKind;
  readonly osBackedEncryption: boolean;
  readonly warning?: string;
}

export interface CredentialBackend {
  read(account: string): Promise<string | undefined>;
  replace(account: string, serialized: string): Promise<void>;
  delete(account: string): Promise<void>;
  diagnostic(): CredentialDiagnostic;
}

abstract class CommandCredentialBackend implements CredentialBackend {
  constructor(
    protected readonly executor: CommandExecutor = new SpawnCommandExecutor(),
  ) {}

  abstract read(account: string): Promise<string | undefined>;
  abstract replace(account: string, serialized: string): Promise<void>;
  abstract delete(account: string): Promise<void>;
  abstract diagnostic(): CredentialDiagnostic;
  abstract probe(): Promise<boolean>;

  /**
   * True only for a child that ran to completion on its own and exited with
   * `code`. A signalled, timed-out, or truncated child never matches, so a
   * status that means "no such secret" can never be inferred from one.
   */
  protected exitedWith(result: CommandResult, code: number): boolean {
    return result.signal === null && !result.truncated && result.code === code;
  }

  protected requireSuccess(result: CommandResult): void {
    if (this.exitedWith(result, 0)) return;
    throw new CliError(
      "integration_unavailable",
      result.truncated
        ? "The OS credential service returned an unexpectedly large response."
        : result.signal === null
          ? "The OS credential service could not complete the operation."
          : "The OS credential service did not respond within its time limit.",
    );
  }

  protected async available(
    command: string,
    args: readonly string[],
    environment?: NodeJS.ProcessEnv,
  ): Promise<boolean> {
    try {
      const result = await this.executor.execute(
        command,
        args,
        "",
        environment,
      );
      return this.exitedWith(result, 0);
    } catch {
      // ENOENT (BackendUnavailableError) and any spawn failure both mean the
      // backend cannot be used; probing must never throw.
      return false;
    }
  }
}

export class MacOsKeychainBackend extends CommandCredentialBackend {
  async probe(): Promise<boolean> {
    return this.available("security", ["help"]);
  }

  async read(account: string): Promise<string | undefined> {
    const result = await this.executor.execute("security", [
      "find-generic-password",
      "-s",
      CREDENTIAL_SERVICE,
      "-a",
      account,
      "-w",
    ]);
    // 44 is `security`'s "the item cannot be found", and only a clean exit
    // with that status means it.
    if (this.exitedWith(result, 44)) return undefined;
    this.requireSuccess(result);
    return result.stdout.replace(/\r?\n$/, "");
  }

  async replace(account: string, serialized: string): Promise<void> {
    // The secret MUST be passed as the inline value of `-w`. `security
    // add-generic-password -w` with no inline value does not read the secret
    // from stdin; it drops into the interactive "password data" / "retype
    // password" prompt, which is backed by readpassphrase(3) and silently
    // truncates input at 128 bytes. Provider API keys can exceed that (Pantheon
    // machine tokens and WP Engine passwords in particular), so any
    // prompt/stdin approach risks storing a truncated, unusable record — and
    // feeding it zero or one line instead stores an empty one. Inline
    // `-w <value>` has no length limit.
    //
    // Trade-off: the value is briefly visible in this process's argv (e.g. to
    // `ps`). That is unavoidable with the `security` CLI for secrets over 128
    // bytes, the exposure window is momentary, and macOS restricts argv
    // visibility to the same user. This is the OS keychain's own argv, never
    // HQ's: no HQ command accepts a secret-valued option. Linux (secret-tool)
    // and Windows (CredWrite) read the secret from stdin without a length cap
    // and keep using it.
    const result = await this.executor.execute("security", [
      "add-generic-password",
      "-U",
      "-s",
      CREDENTIAL_SERVICE,
      "-a",
      account,
      "-w",
      serialized,
    ]);
    this.requireSuccess(result);
  }

  async delete(account: string): Promise<void> {
    const result = await this.executor.execute("security", [
      "delete-generic-password",
      "-s",
      CREDENTIAL_SERVICE,
      "-a",
      account,
    ]);
    if (!this.exitedWith(result, 44)) this.requireSuccess(result);
  }

  diagnostic(): CredentialDiagnostic {
    return { backend: "macos-keychain", osBackedEncryption: true };
  }
}

export class LinuxSecretServiceBackend extends CommandCredentialBackend {
  async probe(): Promise<boolean> {
    return this.available("secret-tool", ["--version"]);
  }

  async read(account: string): Promise<string | undefined> {
    const result = await this.executor.execute("secret-tool", [
      "lookup",
      "service",
      CREDENTIAL_SERVICE,
      "account",
      account,
    ]);
    // `secret-tool lookup` exits 1 for "no such secret". A child killed by the
    // executor's timeout (a locked keyring blocking on its unlock prompt) or by
    // the stdout ceiling must surface as `integration_unavailable` instead:
    // reporting it as an absence would both hide an existing credential and let
    // a later rollback delete it.
    if (this.exitedWith(result, 1)) return undefined;
    this.requireSuccess(result);
    return result.stdout.replace(/\r?\n$/, "");
  }

  async replace(account: string, serialized: string): Promise<void> {
    const result = await this.executor.execute(
      "secret-tool",
      [
        "store",
        "--label",
        CREDENTIAL_LABEL,
        "service",
        CREDENTIAL_SERVICE,
        "account",
        account,
      ],
      serialized,
    );
    this.requireSuccess(result);
  }

  async delete(account: string): Promise<void> {
    const result = await this.executor.execute("secret-tool", [
      "clear",
      "service",
      CREDENTIAL_SERVICE,
      "account",
      account,
    ]);
    if (!this.exitedWith(result, 1)) this.requireSuccess(result);
  }

  diagnostic(): CredentialDiagnostic {
    return { backend: "linux-secret-service", osBackedEncryption: true };
  }
}

const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NovamiraHqCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize;
    public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWrite(ref CREDENTIAL c, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
  public static void Write(string target, string secret) {
    byte[] bytes=Encoding.Unicode.GetBytes(secret); IntPtr blob=Marshal.AllocCoTaskMem(bytes.Length);
    try { Marshal.Copy(bytes,0,blob,bytes.Length); var c=new CREDENTIAL { Type=1, TargetName=target, CredentialBlobSize=(uint)bytes.Length, CredentialBlob=blob, Persist=2, UserName=Environment.UserName }; if(!CredWrite(ref c,0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    finally { for(int i=0;i<bytes.Length;i++) Marshal.WriteByte(blob,i,0); Marshal.FreeCoTaskMem(blob); }
  }
  public static string Read(string target) { IntPtr ptr; if(!CredRead(target,1,0,out ptr)) { if(Marshal.GetLastWin32Error()==1168) return null; throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); } try { var c=(CREDENTIAL)Marshal.PtrToStructure(ptr,typeof(CREDENTIAL)); return Marshal.PtrToStringUni(c.CredentialBlob,(int)c.CredentialBlobSize/2); } finally { CredFree(ptr); } }
  public static void Delete(string target) { if(!CredDelete(target,1,0) && Marshal.GetLastWin32Error()!=1168) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
}`;

const WINDOWS_NOT_FOUND = "__NOVAMIRA_HQ_NOT_FOUND__";

export class WindowsCredentialManagerBackend extends CommandCredentialBackend {
  async probe(): Promise<boolean> {
    return this.available(
      "powershell.exe",
      [...POWERSHELL_PREFIX, "$PSVersionTable.PSVersion.ToString()"],
      powerShellEnvironment(),
    );
  }

  async read(account: string): Promise<string | undefined> {
    const result = await this.run("read", account);
    this.requireSuccess(result);
    const value = result.stdout.replace(/\r?\n$/, "");
    return value === WINDOWS_NOT_FOUND ? undefined : value;
  }

  async replace(account: string, serialized: string): Promise<void> {
    this.requireSuccess(await this.run("write", account, serialized));
  }

  async delete(account: string): Promise<void> {
    this.requireSuccess(await this.run("delete", account));
  }

  diagnostic(): CredentialDiagnostic {
    return { backend: "windows-credential-manager", osBackedEncryption: true };
  }

  private async run(
    action: "read" | "write" | "delete",
    account: string,
    stdin = "",
  ): Promise<CommandResult> {
    const target = `${CREDENTIAL_SERVICE}/${account}`;
    const command = [
      "Add-Type -TypeDefinition $env:NOVAMIRA_HQ_CREDENTIAL_SOURCE",
      `$action=${powerShellLiteral(action)}`,
      `$target=${powerShellLiteral(target)}`,
      "if($action -eq 'write'){[NovamiraHqCredential]::Write($target,[Console]::In.ReadToEnd())}",
      `elseif($action -eq 'read'){$v=[NovamiraHqCredential]::Read($target);if($null -eq $v){Write-Output '${WINDOWS_NOT_FOUND}'}else{[Console]::Out.Write($v)}}`,
      "else{[NovamiraHqCredential]::Delete($target)}",
    ].join(";");
    // Source is fixed code, not secret data. The secret is supplied only on stdin.
    return this.executor.execute(
      "powershell.exe",
      [
        ...POWERSHELL_PREFIX,
        `$env:NOVAMIRA_HQ_CREDENTIAL_SOURCE=@'\n${WINDOWS_CREDENTIAL_SCRIPT}\n'@;${command}`,
      ],
      stdin,
      powerShellEnvironment(),
    );
  }
}

export type OsCredentialBackend =
  | MacOsKeychainBackend
  | LinuxSecretServiceBackend
  | WindowsCredentialManagerBackend;

export function osCredentialBackend(
  platform: NodeJS.Platform,
  executor: CommandExecutor = new SpawnCommandExecutor(),
): OsCredentialBackend {
  if (platform === "darwin") return new MacOsKeychainBackend(executor);
  if (platform === "win32")
    return new WindowsCredentialManagerBackend(executor);
  return new LinuxSecretServiceBackend(executor);
}
