import type { ChildBridgeSummary, HostStats, InstanceSnapshot, LogCount, Overview, PluginSummary } from '../shared/types.ts'
import { h, icon } from './dom.ts'
import type { Filters } from './filters.ts'
import { formatAgo, formatDuration, formatMbps, plural } from './format.ts'
import { formatPluginVersion, formatVersion, hasPluginUpdate, hasUpdate, pluginsOutsideBridges } from './plugins.ts'

type Tone = 'ok' | 'warn' | 'err' | 'muted'

export interface OverviewHandlers {
  /** Show the log for this instance, narrowed as given. */
  focus(filters: Partial<Filters>): void
  colourOf(instance: string): number
}

const TOP_PLUGINS = 3

/** The last card drawn per instance, with what it showed. */
const drawn = new Map<string, { key: string, element: HTMLElement }>()

/**
 * Draw one card per instance. A card is rebuilt only when what it shows
 * changed, so keyboard focus and hover survive the frequent host stat updates.
 */
export function renderInstances(container: HTMLElement, overview: Overview, handlers: OverviewHandlers, now = Date.now()): void {
  const elements = overview.instances.map((instance) => {
    const counts = overview.logCounts.filter((count) => count.instance === instance.name)
    const key = cardKey(instance, counts, handlers.colourOf(instance.name), now)
    const previous = drawn.get(instance.name)
    if (previous?.key === key) {
      return previous.element
    }
    const element = card(instance, counts, handlers, now)
    drawn.set(instance.name, { key, element })
    return element
  })
  const isSame = elements.length === container.children.length && elements.every((element, index) => container.children[index] === element)
  if (!isSame) {
    container.replaceChildren(...elements)
  }
}

/** Everything a card shows: the snapshot without the host stats, which live in the top bar, and the ages as displayed. */
function cardKey(instance: InstanceSnapshot, counts: readonly LogCount[], colour: number, now: number): string {
  const ages = [formatAgo(instance.api.since, now), instance.updatedAt === null ? '' : formatAgo(instance.updatedAt, now)]
  return JSON.stringify([{ ...instance, host: null }, counts, colour, ages])
}

const UNKNOWN_HOST: HostStats = {
  cpuLoad: null, memoryTotal: null, memoryAvailable: null, uptime: null, networkReceive: null, networkTransmit: null,
}

/** Every stat shows "–" while the instance's Homebridge UI is not connected. */
export function renderHost(container: HTMLElement, stats: HostStats | null): void {
  const host = stats ?? UNKNOWN_HOST
  const memory = host.memoryTotal && host.memoryAvailable !== null
    ? Math.round((1 - host.memoryAvailable / host.memoryTotal) * 100)
    : null
  container.replaceChildren(
    stat('CPU', host.cpuLoad === null ? '–' : `${Math.round(host.cpuLoad)}%`),
    stat('Memory', memory === null ? '–' : `${memory}%`),
    stat('Network', networkRate(host)),
    stat('Up', host.uptime === null ? '–' : formatDuration(host.uptime)),
  )
}

/** "↓ 15 ↑ 1.9 Mbps": received, then sent. */
function networkRate(host: HostStats): string {
  if (host.networkReceive === null || host.networkTransmit === null) {
    return '–'
  }
  return `↓ ${formatMbps(host.networkReceive)} ↑ ${formatMbps(host.networkTransmit)} Mbps`
}

function stat(label: string, value: string): HTMLElement {
  return h('span', { class: 'stat' }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value' }, value))
}

function card(instance: InstanceSnapshot, counts: readonly LogCount[], handlers: OverviewHandlers, now: number): HTMLElement {
  const [tone, label] = runState(instance)
  return h('section', { class: `card c${handlers.colourOf(instance.name)}`, 'aria-label': instance.name },
    h('header', { class: 'card-head' },
      h('button', { class: 'card-title', type: 'button', title: `Show only ${instance.name} in the log`, onclick: () => handlers.focus({ instances: [instance.name] }) },
        h('span', { class: 'swatch' }), instance.name),
      h('span', { class: `pill ${tone}` }, label)),
    subtitle(instance),
    connectionNotice(instance, now),
    bridges(instance.childBridges, instance.plugins),
    plugins(instance.plugins, instance.childBridges),
    attention(instance, counts, handlers),
    links(instance))
}

function runState(instance: InstanceSnapshot): [Tone, string] {
  if (instance.api.state === 'unauthorized') return ['err', 'Sign-in failed']
  if (instance.api.state === 'unreachable') return ['err', 'Unreachable']
  if (instance.api.state === 'connecting' || !instance.homebridge) return ['muted', 'Connecting']
  if (instance.homebridge.status === 'down') return ['err', 'Stopped']
  if (instance.homebridge.status === 'pending') return ['warn', 'Starting']
  return instance.homebridge.status === 'ok' ? ['ok', 'Running'] : ['muted', 'Unknown']
}

function subtitle(instance: InstanceSnapshot): HTMLElement | null {
  const hb = instance.homebridge
  if (!hb) {
    return null
  }
  const isUpdate = hasUpdate(hb)
  const version = (hb.version || isUpdate) && h('span', isUpdate ? { class: 'update', title: 'Update available' } : {}, `Homebridge ${formatVersion(hb)}`)
  const parts = [
    version,
    instance.accessories && h('span', {}, plural(instance.accessories.total, 'accessory', 'accessories')),
  ].filter((part) => part instanceof HTMLElement)
  if (parts.length === 0) {
    return null
  }
  return h('p', { class: 'card-sub' }, ...parts.flatMap((part, index) => index === 0 ? [part] : [' · ', part]))
}

/**
 * What is wrong, if anything. While Homebridge UI is out of reach the card
 * keeps the last known bridges, versions and batteries, and says how old they
 * are. The plugin and accessory polls only count while it is reachable.
 */
function connectionNotice(instance: InstanceSnapshot, now: number): HTMLElement | null {
  const problems: string[] = []
  const isApiDown = instance.api.state !== 'connected' && instance.api.state !== 'connecting'
  if (isApiDown) {
    problems.push(`Homebridge UI: ${instance.api.error ?? instance.api.state} (${formatAgo(instance.api.since, now)})`)
    if (instance.updatedAt !== null) {
      problems.push(`Showing what was known ${formatAgo(instance.updatedAt, now)}`)
    }
  }
  if (instance.logs.state !== 'connected' && instance.logs.state !== 'connecting') {
    problems.push(`Log stream: ${instance.logs.error ?? instance.logs.state}; retrying`)
  }
  if (instance.api.state === 'connected') {
    if (instance.pluginsError) problems.push(`Plugin updates: ${instance.pluginsError}`)
    if (instance.accessoriesError) problems.push(`Accessories: ${instance.accessoriesError}`)
  }
  return problems.length > 0 ? h('div', { class: 'notice', role: 'status' }, ...problems.map((text) => h('p', {}, text))) : null
}

function bridges(list: readonly ChildBridgeSummary[], installed: readonly PluginSummary[]): HTMLElement | null {
  if (list.length === 0) {
    return null
  }
  const running = list.filter((bridge) => bridge.status === 'ok').length
  return h('div', { class: 'section' },
    h('h3', {}, 'Child bridges', h('span', { class: 'count' }, running === list.length ? `${running} running` : `${running} of ${list.length} running`)),
    h('ul', { class: 'bridges' }, ...list.map((bridge) => {
      const [tone, text] = bridgeState(bridge)
      const plugin = installed.find((candidate) => candidate.name === bridge.plugin)
      return h('li', {},
        h('span', { class: `dot ${tone}` }),
        h('span', { class: 'name', title: bridge.plugin }, bridge.name),
        text && h('span', { class: `state ${tone}` }, text),
        plugin && version(plugin))
    })))
}

function plugins(installed: readonly PluginSummary[], childBridges: readonly ChildBridgeSummary[]): HTMLElement | null {
  const list = pluginsOutsideBridges(installed, childBridges)
  if (list.length === 0) {
    return null
  }
  const heading = list.length === installed.length ? 'Plugins' : 'Other plugins'
  return h('div', { class: 'section' },
    h('h3', {}, heading, h('span', { class: 'count' }, `${list.length} installed`)),
    h('ul', { class: 'plugins' }, ...list.map((plugin) => h('li', { class: plugin.disabled ? 'disabled' : null },
      h('span', { class: 'name', title: plugin.name }, plugin.displayName),
      version(plugin)))))
}

function version(plugin: PluginSummary): HTMLElement {
  const isUpdate = hasPluginUpdate(plugin)
  return h('span', { class: isUpdate ? 'version update' : 'version', title: isUpdate ? 'Update available' : null }, formatPluginVersion(plugin))
}

function bridgeState(bridge: ChildBridgeSummary): [Tone, string] {
  if (bridge.manuallyStopped) return ['muted', 'stopped']
  if (bridge.status === 'ok') return ['ok', '']
  if (bridge.status === 'pending') return ['warn', 'starting']
  return bridge.status === 'down' ? ['err', 'down'] : ['muted', 'unknown']
}

function attention(instance: InstanceSnapshot, counts: readonly LogCount[], handlers: OverviewHandlers): HTMLElement | null {
  const items = [
    ...logItems(instance.name, counts, handlers),
    ...(instance.accessories?.lowBattery ?? []).map((battery) => item('battery', 'warn',
      `${battery.name} battery ${battery.level === null ? 'low' : `${battery.level}%`}`)),
  ]
  return items.length > 0 ? h('div', { class: 'section' }, h('h3', {}, 'Investigate'), h('ul', { class: 'attention' }, ...items)) : null
}

function logItems(name: string, counts: readonly LogCount[], handlers: OverviewHandlers): HTMLElement[] {
  const errors = counts.filter((count) => count.level === 'error')
  const total = (level: 'error' | 'warn') => counts.filter((count) => count.level === level).reduce((sum, count) => sum + count.count, 0)
  const errorCount = total('error')
  const warnCount = total('warn')
  if (errorCount + warnCount === 0) {
    return []
  }
  const summary = [errorCount > 0 && plural(errorCount, 'error'), warnCount > 0 && plural(warnCount, 'warning')].filter(Boolean).join(', ')
  const head = item('alert', errorCount > 0 ? 'err' : 'warn', `${summary} in 24 h`, () => handlers.focus({ instances: [name], level: 'warn' }))
  const top = errors.slice(0, TOP_PLUGINS).map((count) => item(null, 'err', `${count.plugin ?? 'Homebridge'} · ${count.count}`,
    () => handlers.focus({ instances: [name], level: 'error', plugin: count.plugin ?? '' }), 'sub'))
  return [head, ...top]
}

function item(iconName: string | null, tone: Tone, text: string, onclick?: () => void, extra = ''): HTMLElement {
  const content = onclick ? h('button', { type: 'button', class: 'link', onclick }, text) : h('span', {}, text)
  return h('li', { class: `${tone} ${extra}`.trim() }, iconName ? icon(iconName) : null, content)
}

function links(instance: InstanceSnapshot): HTMLElement {
  const link = (path: string, label: string) => h('a', { href: `${instance.uiUrl}${path}`, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external', 'icon small'))
  return h('nav', { class: 'card-links', 'aria-label': `${instance.name} in Homebridge UI` },
    link('/', 'Open'), link('/logs', 'Logs'), link('/plugins', 'Plugins'), link('/accessories', 'Accessories'))
}
