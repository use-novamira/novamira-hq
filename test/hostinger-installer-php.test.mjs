// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostingerInstaller } from "../dist/hosting/providers/hostinger-installer.js";

const phpAvailable = spawnSync("php", ["-v"]).status === 0;

test(
  "generated PHP enables AI without requiring Novamira functions, writes receipt and cleans only itself",
  { skip: !phpAvailable },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hq-hostinger-helper-"));
    try {
      const plugins = join(root, "plugins"),
        helperDir = join(plugins, "temporary"),
        helper = join(helperDir, "temporary.php");
      await mkdir(join(root, "wp-admin/includes"), { recursive: true });
      await mkdir(join(plugins, "novamira"), { recursive: true });
      await mkdir(helperDir);
      await writeFile(join(root, "wp-admin/includes/plugin.php"), "<?php");
      await writeFile(
        join(plugins, "novamira/novamira.php"),
        "<?php /* untouched installed plugin */",
      );
      await writeFile(
        helper,
        hostingerInstaller({
          domain: "example.com",
          digest: null,
          enableAi: true,
          minimumVersion: "1.11.1",
          expires: Math.floor(Date.now() / 1000) + 60,
        }),
      );
      const harness = `<?php
define('ABSPATH', __DIR__ . '/');
define('WP_PLUGIN_DIR', __DIR__ . '/plugins');
$options = [];
function register_activation_hook($file, $fn) { $GLOBALS['activate'] = $fn; }
function register_deactivation_hook($file, $fn) { $GLOBALS['deactivate'] = $fn; }
function is_multisite() { return false; }
function get_bloginfo($field) { return '7.1'; }
function home_url() { return 'https://example.com'; }
function wp_parse_url($url, $component) { return parse_url($url, $component); }
function get_plugin_data($file, $markup, $translate) { return ['Version' => '1.12.4']; }
function is_plugin_active($file) { return true; }
function wp_die($message) { throw new Exception($message); }
function update_option($key, $value) { $GLOBALS['options'][$key] = $value; }
function get_option($key) { return $GLOBALS['options'][$key] ?? null; }
function wp_clean_plugins_cache() {}
require __DIR__ . '/plugins/temporary/temporary.php';
$GLOBALS['activate']();
if (!str_contains(file_get_contents(__DIR__ . '/plugins/temporary/temporary.php'), "Version: 1.0.0\\n")) { throw new Exception('missing receipt'); }
$GLOBALS['deactivate']();
echo json_encode($GLOBALS['options']);
`;
      await writeFile(join(root, "harness.php"), harness);
      const execution = spawnSync("php", [join(root, "harness.php")], {
        encoding: "utf8",
        timeout: 5000,
      });
      assert.equal(execution.status, 0, execution.stderr + execution.stdout);
      assert.deepEqual(JSON.parse(execution.stdout), {
        novamira_ai_abilities_domain: "example.com",
        novamira_ai_abilities_enabled: "1",
      });
      await assert.rejects(stat(helperDir), { code: "ENOENT" });
      assert.equal(
        await readFile(join(plugins, "novamira/novamira.php"), "utf8"),
        "<?php /* untouched installed plugin */",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "generated PHP does nothing when requested outside WordPress",
  { skip: !phpAvailable },
  () => {
    const source = hostingerInstaller({
      domain: "example.com",
      digest: null,
      enableAi: true,
      minimumVersion: "1.11.1",
      expires: 1,
    });
    const result = spawnSync("php", [], {
      input: source,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  },
);
