/** How the instance cards show versions. No DOM here, so the tests can import it. */

import type { ChildBridgeSummary, HomebridgeSummary, PluginSummary } from '../shared/types.ts'

type Versioned = Pick<HomebridgeSummary, 'version' | 'latestVersion' | 'updateAvailable'>

/** Only an update with a known target counts, so the highlight always comes with the version to update to. */
export function hasUpdate(item: Versioned): boolean {
  return item.updateAvailable && item.latestVersion !== null
}

/** A plugin that is turned off offers no update. */
export function hasPluginUpdate(plugin: PluginSummary): boolean {
  return !plugin.disabled && hasUpdate(plugin)
}

/** "2.0.0", or "2.0.0 → 2.1.0" when an update is available. */
export function formatVersion(item: Versioned): string {
  const installed = item.version ?? '–'
  return hasUpdate(item) ? `${installed} → ${item.latestVersion}` : installed
}

/** The version, or "disabled". */
export function formatPluginVersion(plugin: PluginSummary): string {
  return plugin.disabled ? 'disabled' : formatVersion(plugin)
}

/** The plugins that no child bridge runs. Those that one does show their version on the bridge's row instead. */
export function pluginsOutsideBridges(installed: readonly PluginSummary[], childBridges: readonly ChildBridgeSummary[]): PluginSummary[] {
  const bridged = new Set(childBridges.map((bridge) => bridge.plugin))
  return installed.filter((plugin) => !bridged.has(plugin.name))
}
