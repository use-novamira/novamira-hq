// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Fixed programs only. Inputs travel via the site CLI's stdin, never argv. */
function literal(value: string): string {
  return `base64_decode('${Buffer.from(value).toString("base64")}')`;
}

export const PRO_PREFLIGHT = `
if (!defined('NOVAMIRA_VERSION')) return ['code'=>'free_missing'];
if (version_compare(NOVAMIRA_VERSION,'1.6.0','<')) return ['code'=>'free_outdated'];
if (!current_user_can('install_plugins') || !current_user_can('activate_plugins') || !current_user_can('manage_options')) return ['code'=>'permission_denied'];
if (is_multisite()) return ['code'=>'multisite_unsupported'];
if (defined('DISALLOW_FILE_MODS') && DISALLOW_FILE_MODS) return ['code'=>'file_mods_disabled'];
return ['code'=>'ready','url'=>get_bloginfo('wpurl'),'existing'=>file_exists(WP_PLUGIN_DIR.'/novamira-pro/novamira-pro.php')];`;

export function proInstallPhp(domain: string, signedUrl: string): string {
  return `
if (str_replace(['https://','http://'],'',get_bloginfo('wpurl')) !== ${literal(domain)}) return ['code'=>'site_changed'];
if (!defined('NOVAMIRA_VERSION') || !current_user_can('install_plugins') || !current_user_can('activate_plugins')) return ['code'=>'permission_denied'];
if (is_multisite()) return ['code'=>'multisite_unsupported'];
if (defined('DISALLOW_FILE_MODS') && DISALLOW_FILE_MODS) return ['code'=>'file_mods_disabled'];
require_once ABSPATH.'wp-admin/includes/plugin.php';
if (!file_exists(WP_PLUGIN_DIR.'/novamira-pro/novamira-pro.php')) {
  require_once ABSPATH.'wp-admin/includes/file.php';
  require_once ABSPATH.'wp-admin/includes/class-wp-upgrader.php';
  $upgrader = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
  $installed = $upgrader->install(${literal(signedUrl)});
  if (is_wp_error($installed) || $installed !== true) return ['code'=>'install_failed'];
}
$activated = activate_plugin('novamira-pro/novamira-pro.php');
if (is_wp_error($activated)) return ['code'=>'activation_failed'];
return ['code'=>'installed'];`;
}

export function proConfigurePhp(domain: string, key: string): string {
  return `
if (str_replace(['https://','http://'],'',get_bloginfo('wpurl')) !== ${literal(domain)}) return ['code'=>'site_changed'];
if (!current_user_can('manage_options') || !function_exists('Novamira\\Pro\\activate_new_license_key')) return ['code'=>'configuration_unavailable'];
$result = \\Novamira\\Pro\\activate_new_license_key(${literal(key)});
return ['code'=>($result[0] === true ? 'configured' : 'license_configuration_failed')];`;
}
