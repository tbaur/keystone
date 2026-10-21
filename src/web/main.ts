import type { LogLine, Overview } from '../shared/types.ts'
import { LiveStream, fetchLogs, fetchOverview, signOut, type StreamStatus } from './api.ts'
import { byId, h } from './dom.ts'
import { isFiltered, NO_FILTERS, readFilters, toParams, type Filters, type LevelFilter } from './filters.ts'
import { LogView } from './log-view.ts'
import { renderHost, renderInstances } from './overview-view.ts'

const COLOURS = 8
const SEARCH_DEBOUNCE_MS = 300
const AGE_REFRESH_MS = 30_000
const WRAP_KEY = 'keystone.wrap'
const HOST_KEY = 'keystone.host'
const TITLE = document.title

const el = {
  hostPick: byId('host-pick', HTMLElement),
  hostInstance: byId('host-instance', HTMLSelectElement),
  hostStats: byId('host-stats', HTMLElement),
  live: byId('live', HTMLElement),
  liveText: byId('live-text', HTMLElement),
  banner: byId('banner', HTMLElement),
  instances: byId('instances', HTMLElement),
  instanceFilter: byId('instance-filter', HTMLElement),
  levelFilter: byId('level-filter', HTMLElement),
  pluginFilter: byId('plugin-filter', HTMLSelectElement),
  search: byId('search', HTMLInputElement),
  clear: byId('clear', HTMLButtonElement),
  wrap: byId('wrap', HTMLButtonElement),
  signOut: byId('sign-out', HTMLButtonElement),
}

let filters = readFilters(window.location.search)
let instanceNames: string[] = []
let knownPlugins: string[] = []
let hiddenErrors = 0
let hostInstance = ''
let latest: Overview | null = null

const colourOf = (instance: string): number => Math.max(0, instanceNames.indexOf(instance)) % COLOURS

const view = new LogView({
  elements: {
    scroller: byId('log-scroll', HTMLElement),
    list: byId('log-lines', HTMLElement),
    status: byId('log-status', HTMLElement),
    jump: byId('jump', HTMLButtonElement),
  },
  colourOf,
  loadOlder: (beforeId) => fetchLogs(filters, beforeId),
  onPick: (pick) => applyFilters({ ...filters, instances: pick.instance ? [pick.instance] : filters.instances, plugin: pick.plugin ?? filters.plugin }),
  onReload: () => void reload(),
}, filters)

let reloads = 0

/** Load the newest page for the current filters. Only the latest of overlapping reloads is shown. */
async function reload(): Promise<void> {
  const reloadNumber = ++reloads
  const wanted = filters
  view.pause()
  try {
    const page = await fetchLogs(wanted)
    if (reloadNumber === reloads) {
      view.reset(page, wanted)
      showBanner(null)
    }
  } catch (error) {
    if (reloadNumber === reloads) {
      view.reset({ lines: [], hasMore: false, latestId: Number.MAX_SAFE_INTEGER }, wanted)
      showBanner(`Could not load the log: ${(error as Error).message}`)
    }
  }
}

function applyFilters(next: Filters): void {
  filters = next
  const query = toParams(filters).toString()
  window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname)
  syncControls()
  void reload()
}

function syncControls(): void {
  for (const chip of el.instanceFilter.querySelectorAll<HTMLButtonElement>('button')) {
    const name = chip.dataset.instance ?? ''
    chip.setAttribute('aria-pressed', String(filters.instances.length === 0 || filters.instances.includes(name)))
  }
  for (const button of el.levelFilter.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.level === filters.level))
  }
  refreshPluginOptions()
  if (document.activeElement !== el.search) {
    el.search.value = filters.search
  }
  el.clear.hidden = !isFiltered(filters)
}

function toggleInstance(name: string): void {
  const visible = filters.instances.length === 0 ? [...instanceNames] : [...filters.instances]
  const next = visible.includes(name) ? visible.filter((other) => other !== name) : [...visible, name]
  const showsAll = next.length === 0 || next.length === instanceNames.length
  applyFilters({ ...filters, instances: showsAll ? [] : next })
}

function renderInstanceChips(): void {
  el.instanceFilter.replaceChildren(...instanceNames.map((name) => h('button', {
    type: 'button', class: `chip c${colourOf(name)}`, 'data-instance': name, 'aria-pressed': 'true',
    title: `Show or hide ${name}`, onclick: () => toggleInstance(name),
  }, h('span', { class: 'swatch' }), name)))
}

/** The plugin menu lists every plugin seen in the log or in the error counts. */
function refreshPluginOptions(): void {
  const names = [...new Set([...knownPlugins, ...view.plugins, filters.plugin].filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const current = [...el.pluginFilter.options].map((option) => option.value).slice(1)
  if (names.join('\n') !== current.join('\n')) {
    el.pluginFilter.replaceChildren(h('option', { value: '' }, 'All plugins'), ...names.map((name) => h('option', { value: name }, name)))
  }
  el.pluginFilter.value = filters.plugin
}

/** Built once: the select must not be replaced while its menu may be open. */
function renderHostPicker(): void {
  const saved = window.localStorage.getItem(HOST_KEY)
  el.hostInstance.replaceChildren(...instanceNames.map((name) => h('option', { value: name }, name)))
  el.hostInstance.disabled = instanceNames.length < 2
  showHostOf(saved !== null && instanceNames.includes(saved) ? saved : instanceNames[0] ?? '')
}

function showHostOf(name: string): void {
  hostInstance = name
  el.hostInstance.value = name
  el.hostPick.className = `select host-pick c${colourOf(name)}`
  el.hostPick.title = `Host stats from ${name}`
  renderHost(el.hostStats, latest?.instances.find((instance) => instance.name === name)?.host ?? null)
}

function onOverview(overview: Overview): void {
  latest = overview
  knownPlugins = [...new Set(overview.logCounts.map((count) => count.plugin).filter((name): name is string => name !== null))]
  renderCards()
  showHostOf(hostInstance)
}

/** Also runs on a timer, so "5 min ago" keeps counting while nothing else changes. */
function renderCards(): void {
  if (latest) {
    renderInstances(el.instances, latest, { colourOf, focus: (patch) => applyFilters({ ...NO_FILTERS, ...patch }) })
  }
}

function onLines(lines: LogLine[]): void {
  view.receive(lines)
  if (document.hidden) {
    hiddenErrors += lines.filter((line) => line.level === 'error' && !line.system).length
    document.title = hiddenErrors > 0 ? `(${hiddenErrors}) ${TITLE}` : TITLE
  }
}

function setLive(status: StreamStatus): void {
  el.live.dataset.state = status
  el.liveText.textContent = status === 'live' ? 'Live' : 'Reconnecting…'
}

function showBanner(message: string | null): void {
  el.banner.hidden = message === null
  el.banner.textContent = message ?? ''
}

function setWrap(isWrapped: boolean): void {
  el.wrap.setAttribute('aria-pressed', String(isWrapped))
  window.localStorage.setItem(WRAP_KEY, isWrapped ? '1' : '0')
  view.setWrap(isWrapped)
}

function bindControls(): void {
  let searchTimer = 0
  el.search.addEventListener('input', () => {
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => applyFilters({ ...filters, search: el.search.value.trim() }), SEARCH_DEBOUNCE_MS)
  })
  el.levelFilter.addEventListener('click', (event) => {
    const level = (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.level
    if (level !== undefined) {
      applyFilters({ ...filters, level: level as LevelFilter })
    }
  })
  el.pluginFilter.addEventListener('focus', refreshPluginOptions)
  el.pluginFilter.addEventListener('change', () => applyFilters({ ...filters, plugin: el.pluginFilter.value }))
  el.hostInstance.addEventListener('change', () => {
    window.localStorage.setItem(HOST_KEY, el.hostInstance.value)
    showHostOf(el.hostInstance.value)
  })
  el.clear.addEventListener('click', () => applyFilters(NO_FILTERS))
  el.wrap.addEventListener('click', () => setWrap(el.wrap.getAttribute('aria-pressed') !== 'true'))
  el.signOut.addEventListener('click', () => void signOut())
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      hiddenErrors = 0
      document.title = TITLE
    }
  })
  document.addEventListener('keydown', onKey)
}

/** `/` searches, Escape clears the search, End jumps to the newest line. */
function onKey(event: KeyboardEvent): void {
  const isTyping = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
  if (event.key === '/' && !isTyping) {
    event.preventDefault()
    el.search.focus()
    el.search.select()
  } else if (event.key === 'Escape' && event.target === el.search) {
    el.search.value = ''
    applyFilters({ ...filters, search: '' })
    el.search.blur()
  } else if (event.key === 'End' && !isTyping) {
    event.preventDefault()
    view.jumpToLatest()
  }
}

async function start(): Promise<void> {
  bindControls()
  setWrap(window.localStorage.getItem(WRAP_KEY) === '1')
  const [overview, page] = await Promise.all([fetchOverview(), fetchLogs(filters)])
  instanceNames = overview.instances.map((instance) => instance.name)
  renderInstanceChips()
  renderHostPicker()
  onOverview(overview)
  view.reset(page, filters)
  syncControls()
  window.setInterval(renderCards, AGE_REFRESH_MS)
  new LiveStream(page.latestId, {
    onLines,
    onOverview,
    onReset: () => void reload(),
    onStatus: setLive,
  })
}

start().catch((error: unknown) => showBanner(`Could not load Keystone: ${(error as Error).message}`))
