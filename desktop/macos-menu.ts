// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Native responder-chain actions: never read clipboard contents into HQ. */
export function installMacMenus(): void {
  if (Deno.build.os !== "darwin") return;
  const objc = Deno.dlopen(
    "/usr/lib/libobjc.A.dylib",
    {
      objc_getClass: { parameters: ["buffer"], result: "pointer" },
      sel_registerName: { parameters: ["buffer"], result: "pointer" },
      get: {
        name: "objc_msgSend",
        parameters: ["pointer", "pointer"],
        result: "pointer",
      },
      get1: {
        name: "objc_msgSend",
        parameters: ["pointer", "pointer", "pointer"],
        result: "pointer",
      },
      set1: {
        name: "objc_msgSend",
        parameters: ["pointer", "pointer", "pointer"],
        result: "void",
      },
      release: {
        name: "objc_msgSend",
        parameters: ["pointer", "pointer"],
        result: "void",
      },
      add: {
        name: "objc_msgSend",
        parameters: ["pointer", "pointer", "pointer", "pointer", "pointer"],
        result: "pointer",
      },
    } as const,
  );
  const bytes = (text: string) => new TextEncoder().encode(text + "\0");
  const cls = (name: string) => objc.symbols.objc_getClass(bytes(name));
  const sel = (name: string) => objc.symbols.sel_registerName(bytes(name));
  const get = (target: Deno.PointerValue, name: string) =>
    objc.symbols.get(target, sel(name));
  const string = (text: string) => {
    const buffer = bytes(text);
    return objc.symbols.get1(
      cls("NSString"),
      sel("stringWithUTF8String:"),
      Deno.UnsafePointer.of(buffer),
    );
  };
  const app = get(cls("NSApplication"), "sharedApplication");
  if (!app) throw new Error("Native macOS application is unavailable");
  const menu = get(app, "mainMenu") ?? get(get(cls("NSMenu"), "alloc"), "init");
  const addItem = (
    target: Deno.PointerValue,
    title: string,
    action: string | null,
    key = "",
  ) =>
    objc.symbols.add(
      target,
      sel("addItemWithTitle:action:keyEquivalent:"),
      string(title),
      action ? sel(action) : null,
      string(key),
    );
  for (
    const [title, actions] of [
      ["Novamira HQ", [["Quit Novamira HQ", "terminate:", "q"]]],
      ["Edit", [
        ["Undo", "undo:", "z"],
        ["Redo", "redo:", "Z"],
        ["Cut", "cut:", "x"],
        ["Copy", "copy:", "c"],
        ["Paste", "paste:", "v"],
        ["Select All", "selectAll:", "a"],
      ]],
    ] as const
  ) {
    const submenu = objc.symbols.get1(
      get(cls("NSMenu"), "alloc"),
      sel("initWithTitle:"),
      string(title),
    );
    const item = addItem(menu, title, null);
    objc.symbols.set1(item, sel("setSubmenu:"), submenu);
    for (const [label, action, key] of actions) {
      addItem(submenu, label, action, key);
    }
    // The parent item now retains its submenu.
    objc.symbols.release(submenu, sel("release"));
  }
  objc.symbols.set1(app, sel("setMainMenu:"), menu);
  // libobjc is part of the running AppKit process. No callbacks point at Deno.
  objc.close();
}
