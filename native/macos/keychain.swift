// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import AppKit
import Foundation
import Security

// A one-request, unprivileged helper. No listener, URL handler, shell, file
// storage, arbitrary keychain namespace or persistent caller-approval list.
let service = "ai.novamira.hq"
let helperIdentifier = "ai.novamira.hq.credentials"
let maximumInput = 524_288
let parentPID = getppid()

func fail(_ code: Int32 = 1) -> Never {
    // Never print Security errors, request bodies, process arguments or secrets.
    exit(code)
}

func codeForPID(_ pid: pid_t) -> SecCode? {
    var code: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary,
                                        [], &code) == errSecSuccess else { return nil }
    return code
}

func valid(_ code: SecCode, _ requirement: String) -> Bool {
    var compiled: SecRequirement?
    guard SecRequirementCreateWithString(requirement as CFString, [], &compiled) == errSecSuccess,
          let compiled else { return false }
    return SecCodeCheckValidity(code, [], compiled) == errSecSuccess
}

// Derive the team from our own valid Developer ID signature, never from argv,
// an environment variable, the request, an executable name or its directory.
func ownTeam() -> String? {
    var own: SecCode?
    guard SecCodeCopySelf([], &own) == errSecSuccess, let own,
          valid(own, "anchor apple generic and identifier \"\(helperIdentifier)\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists") else { return nil }
    var information: CFDictionary?
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(own, [], &staticCode) == errSecSuccess, let staticCode,
          SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation),
                                       &information) == errSecSuccess,
          let values = information as? [String: Any],
          let team = values[kSecCodeInfoTeamIdentifier as String] as? String,
          team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { return nil }
    return team
}

func trustedParent() -> Bool {
    guard parentPID > 1, getppid() == parentPID, let team = ownTeam(),
          let parent = codeForPID(parentPID) else { return false }
    // Only our compiled entry point, not Node, Deno, Terminal or other signed
    // applications from the same publisher. The signer pins this identifier.
    return valid(parent, "anchor apple generic and identifier \"ai.novamira.hq.desktop\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(team)\"")
}

func parentPath() -> String {
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(parentPID, &buffer, UInt32(buffer.count)) > 0 else { return "Unidentified process" }
    return String(cString: buffer)
}

@MainActor func authorize(_ operation: String) -> Bool {
    guard parentPID > 1, getppid() == parentPID else { return false }
    if trustedParent() { return true }
    // Interpreted/npm/development callers remain usable, but are NEVER silently
    // trusted. A path cannot authenticate the script a Node process executes.
    // Approval is one operation only, even if Keychain itself trusts the helper.
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Allow access to a Novamira HQ hosting credential?"
    alert.informativeText = "This request is not from the verified Novamira HQ app.\n\nRequesting program: \(parentPath())\nProcess: \(parentPID)\nOperation: \(operation)\n\nOnly allow this if you just requested this operation in HQ's terminal or development dashboard. This authorizes one operation, not every script this program can run."
    alert.addButton(withTitle: "Deny")
    alert.addButton(withTitle: "Allow once")
    app.activate(ignoringOtherApps: true)
    return alert.runModal() == .alertSecondButtonReturn && getppid() == parentPID
}

func writeJSON(_ value: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
          data.count <= maximumInput * 2 else { fail() }
    FileHandle.standardOutput.write(data)
}

@MainActor func runHelper() {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments == ["probe"] {
        // Offline/non-interactive: no Keychain reads and no authorization alert.
        writeJSON(["protocol": 1])
        return
    }
    guard arguments.count == 2,
          ["read", "write", "delete"].contains(arguments[0]),
          arguments[1].utf8.count == 64,
          arguments[1].range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
          parentPID > 1 else { fail(64) }
    let operation = arguments[0]
    var input = Data()
    if operation == "write" {
        // Bound memory even for a direct hostile invocation; no readToEnd().
        while true {
            do {
                guard let chunk = try FileHandle.standardInput.read(upToCount: min(8192, maximumInput + 1 - input.count)) else { break }
                if chunk.isEmpty { break }
                input.append(chunk)
                if input.count > maximumInput { fail(64) }
            } catch { fail(74) }
        }
        guard !input.isEmpty, String(data: input, encoding: .utf8) != nil else { fail(64) }
    }
    let verifiedCaller = trustedParent()
    guard authorize(operation), getppid() == parentPID else { fail(77) }

    // Deliberately no lookup/migration of legacy osascript-owned records.
    var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: "native-v1/" + arguments[1],
    ]
    switch operation {
    case "read":
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard getppid() == parentPID, !verifiedCaller || trustedParent() else { fail(77) }
        if status == errSecItemNotFound { writeJSON(NSNull()); return }
        guard status == errSecSuccess, let data = result as? Data,
              data.count <= maximumInput, let text = String(data: data, encoding: .utf8) else { fail() }
        writeJSON(text)
    case "write":
        let update = [kSecValueData as String: input] as CFDictionary
        var status = SecItemUpdate(query as CFDictionary, update)
        if status == errSecItemNotFound {
            query[kSecValueData as String] = input
            query[kSecAttrLabel as String] = "Novamira HQ"
            // Default Keychain ACL trusts the creating helper, not all apps.
            status = SecItemAdd(query as CFDictionary, nil)
        }
        guard status == errSecSuccess else { fail() }
    case "delete":
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { fail() }
    default: fail(64)
    }
}

@main struct KeychainHelper {
    @MainActor static func main() { runHelper() }
}
