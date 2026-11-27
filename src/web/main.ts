/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import type { LogLine, LogPage, Overview } from '../shared/types.ts'
import { ApiError, LiveStream, fetchLogs, fetchOverview, messageOf, signOut, type StreamStatus } from './api.ts'
import { byId, h } from './dom.ts'
import { isFiltered, isLevelFilter, NO_FILTERS, pluginMenu, readFilters, toParams, withKnownInstances, type Filters } from './filters.ts'
import { LogView } from './log-view.ts'
import { renderHost, renderInstances } from './overview-view.ts'

const COLOURS = 8
const SEARCH_DEBOUNCE_MS = 300
const AGE_REFRESH_MS = 30_000
/** The stream never renews the session, so the page asks the server something this often. A session renews in its last 15 days. */
const SESSION_REFRESH_MS = 6 * 60 * 60_000
/** After a failed request, the first wait before trying again. It doubles up to RETRY_MAX_MS. */
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 60_000
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
let stream: LiveStream | null = null
type BannerTopic = 'start' | 'log' | 'filters' | 'store' | 'stream'

/** What the banner says, by what it is about, so one problem clearing does not hide another. */
const banners = new Map<BannerTopic, string>()

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

/**
 * Load the newest page for the current filters. Only the latest of
 * overlapping reloads is shown. Filters the server refuses are dropped; any
 * other failure is tried again, with a growing wait, until a page loads.
 */
async function reload(first?: Promise<LogPage>): Promise<void> {
  const reloadNumber = ++reloads
  let pending = first
  let isShowingWanted = false
  for (let attempt = 0; reloadNumber === reloads; attempt++) {
    const wanted = filters
    // Live lines wait from here until the page is in, so none falls between the two.
    view.pause()
    try {
      const page = await (pending ?? fetchLogs(wanted))
      if (reloadNumber === reloads) {
        view.reset(page, wanted)
        setBanner('log', null)
        // The stream starts after the first page, so no line falls between the two.
        stream ??= new LiveStream(page.latestId, streamHandlers)
      }
      return
    } catch (error) {
      pending = undefined
      if (reloadNumber !== reloads) {
        return
      }
      if (error instanceof ApiError && error.status === 400 && isFiltered(wanted)) {
        setBanner('filters', `Could not use these filters (${error.message}), so every line is shown.`)
        useFilters(NO_FILTERS)
        isShowingWanted = false
        continue
      }
      setBanner('log', `Could not load the log: ${messageOf(error)}. Trying again…`)
      if (isShowingWanted) {
        view.resume()
      } else {
        // Until a page loads, show the new filters' live lines on an empty list, not the old filters' rows.
        view.reset({ lines: [], hasMore: false, latestId: view.latestId }, wanted)
        isShowingWanted = true
      }
      await wait(retryDelay(attempt))
    }
  }
}

function retryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => window.setTimeout(resolvePromise, ms))
}

function applyFilters(next: Filters): void {
  setBanner('filters', null)
  useFilters(next)
  void reload()
}

/** Make `next` the filters: in the URL and the controls, without loading a page. */
function useFilters(next: Filters): void {
  filters = next
  const query = toParams(filters).toString()
  window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname)
  syncControls()
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
  const menu = pluginMenu([...knownPlugins, ...view.plugins, filters.plugin])
  const current = [...el.pluginFilter.options].map((option) => option.value)
  if (menu.map(([value]) => value).join('\n') !== current.join('\n')) {
    el.pluginFilter.replaceChildren(...menu.map(([value, label]) => h('option', { value }, label)))
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
  setBanner('store', overview.store === 'failing' ? 'New log lines cannot be saved right now. The server log has the error.' : null)
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

function setBanner(topic: BannerTopic, message: string | null): void {
  if (message === null) {
    banners.delete(topic)
  } else {
    banners.set(topic, message)
  }
  el.banner.hidden = banners.size === 0
  el.banner.textContent = [...banners.values()].join(' ')
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
    const level = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button')?.dataset.level : undefined
    if (isLevelFilter(level)) {
      applyFilters({ ...filters, level })
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

const streamHandlers = {
  onLines,
  onOverview,
  onReset: () => void reload(),
  onStatus: setLive,
  onBadEvent: (error: unknown) => setBanner('stream', `The server sent something this page cannot read (${messageOf(error)}). Reload the page.`),
}

/** The overview, tried again with a growing wait until the server answers. */
async function firstOverview(): Promise<Overview> {
  for (let attempt = 0; ; attempt++) {
    try {
      const overview = await fetchOverview()
      setBanner('start', null)
      return overview
    } catch (error) {
      setBanner('start', `Could not load Keystone: ${messageOf(error)}. Trying again…`)
      await wait(retryDelay(attempt))
    }
  }
}

/** Ask the server for the overview now and then, which also renews the session. A failure tries again sooner. */
function keepSessionAlive(delay = SESSION_REFRESH_MS): void {
  window.setTimeout(() => {
    fetchOverview().then((overview) => {
      onOverview(overview)
      keepSessionAlive()
    }, () => keepSessionAlive(RETRY_MAX_MS))
  }, delay)
}

async function start(): Promise<void> {
  bindControls()
  setWrap(window.localStorage.getItem(WRAP_KEY) === '1')
  // Ask for the first page while the overview loads. Its result is used only if the filters stay as they are.
  const asked = filters
  const firstPage = fetchLogs(asked)
  // A failure is handled where the page is used, by reload(); this only keeps an unused page from being reported as unhandled.
  firstPage.catch(() => undefined)
  const overview = await firstOverview()
  instanceNames = overview.instances.map((instance) => instance.name)
  renderInstanceChips()
  renderHostPicker()
  onOverview(overview)
  // A bookmark can name an instance that has since been renamed or removed.
  useFilters(withKnownInstances(filters, instanceNames))
  window.setInterval(renderCards, AGE_REFRESH_MS)
  keepSessionAlive()
  await reload(filters === asked ? firstPage : undefined)
}

start().catch((error: unknown) => setBanner('start', `Could not start Keystone: ${messageOf(error)}. Reload the page.`))
