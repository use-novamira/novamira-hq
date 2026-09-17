// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Fixed, one-purpose activation hook; never an HTTP command endpoint. */
export function hostingerInstaller(options: {
  readonly domain: string;
  readonly digest: string | null;
  readonly enableAi: boolean;
  readonly minimumVersion: string;
  readonly expires: number;
}): string {
  // All variable values cross PHP's boundary as base64 JSON, not source text.
  const encoded = Buffer.from(JSON.stringify(options)).toString("base64");
  return `<?php
// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later
/* Plugin Name: Novamira HQ temporary setup
Version: 0.0.0
*/
if (!defined('ABSPATH')) { exit; }
register_activation_hook(__FILE__, function () {
    $o = json_decode(base64_decode('${encoded}'), true);
    if (time() > $o['expires'] || is_multisite() || version_compare(PHP_VERSION, '8.0', '<') || version_compare(get_bloginfo('version'), '6.9', '<')) { wp_die('Novamira setup requirements not met.'); }
    if (wp_parse_url(home_url(), PHP_URL_HOST) !== $o['domain']) { wp_die('Novamira setup target mismatch.'); }
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    $target = WP_PLUGIN_DIR . '/novamira';
    if ($o['digest'] !== null) {
        if (file_exists($target) || is_link($target)) { wp_die('Novamira already exists; no overwrite performed.'); }
        $archive = __DIR__ . '/novamira.zip';
        if (is_link($archive) || !is_file($archive) || hash_file('sha256', $archive) !== $o['digest']) { wp_die('Novamira archive verification failed.'); }
        if (!class_exists('ZipArchive')) { wp_die('ZIP extension is required.'); }
        $zip = new ZipArchive();
        if ($zip->open($archive) !== true || $zip->numFiles > 5000) { wp_die('Invalid Novamira archive.'); }
        $total = 0;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $entry = $zip->statIndex($i);
            $name = $entry['name'];
            $total += $entry['size'];
            if ($total > 52428800 || !str_starts_with($name, 'novamira/') || str_contains($name, '\\\\') || str_contains($name, "\\0") || preg_match('~(^|/)\\.\\.?(/|$)~', $name)) { wp_die('Unsafe Novamira archive.'); }
            $opsys = 0; $attributes = 0;
            if ($zip->getExternalAttributesIndex($i, $opsys, $attributes) && (($attributes >> 16) & 0170000) === 0120000) { wp_die('Archive links are not allowed.'); }
        }
        $zip->close();
        require_once ABSPATH . 'wp-admin/includes/file.php';
        if (file_exists(__DIR__ . '/payload') || !WP_Filesystem()) { wp_die('Setup filesystem unavailable.'); }
        $result = unzip_file($archive, __DIR__ . '/payload');
        if (is_wp_error($result)) { wp_die('Novamira extraction failed.'); }
        $main = __DIR__ . '/payload/novamira/novamira.php';
        if (!is_file($main)) { wp_die('Novamira entry point missing.'); }
        $data = get_plugin_data($main, false, false);
        if (version_compare($data['Version'], $o['minimumVersion'], '<')) { wp_die('Novamira archive is too old.'); }
        if (file_exists($target) || !rename(__DIR__ . '/payload/novamira', $target)) { wp_die('Novamira destination unavailable.'); }
        unlink($archive);
        rmdir(__DIR__ . '/payload');
        wp_clean_plugins_cache();
    }
    if (!is_file($target . '/novamira.php') || is_link($target)) { wp_die('Novamira installation missing.'); }
    $data = get_plugin_data($target . '/novamira.php', false, false);
    if (version_compare($data['Version'], $o['minimumVersion'], '<')) { wp_die('Update Novamira before setup.'); }
    if (!is_plugin_active('novamira/novamira.php')) {
        $result = activate_plugin('novamira/novamira.php');
        if (is_wp_error($result) || !is_plugin_active('novamira/novamira.php')) { wp_die('Novamira activation failed.'); }
    }
    if ($o['enableAi']) {
        update_option('novamira_ai_abilities_domain', $o['domain']);
        update_option('novamira_ai_abilities_enabled', '1');
        if ((string) get_option('novamira_ai_abilities_enabled') !== '1' || get_option('novamira_ai_abilities_domain') !== $o['domain']) { wp_die('Novamira AI setup verification failed.'); }
    }
    // Provider inventory observes this receipt; HTTP 200 alone is not success.
    $source = file_get_contents(__FILE__);
    if (file_put_contents(__FILE__, str_replace('Version: 0.0.0', 'Version: 1.0.0', $source)) === false) { wp_die('Setup receipt could not be written.'); }
    wp_clean_plugins_cache();
});
register_deactivation_hook(__FILE__, function () {
    // Remove only our own files after a successful receipt. No recursive delete.
    if (!str_contains(file_get_contents(__FILE__), "Version: 1.0.0\\n")) { return; }
    if (is_file(__DIR__ . '/novamira.zip') && !is_link(__DIR__ . '/novamira.zip')) { unlink(__DIR__ . '/novamira.zip'); }
    unlink(__FILE__);
    @rmdir(__DIR__);
});
`;
}
