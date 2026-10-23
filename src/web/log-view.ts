import type { LogLine, LogPage } from '../shared/types.ts'
import { parseAnsi, stripAnsi } from './ansi.ts'
import { h } from './dom.ts'
import { matches, type Filters } from './filters.ts'
import { formatDay, formatFull, formatTime, plural } from './format.ts'
import { dayNumber, HeldLines, inLogOrder, isBefore, type LineKey } from './log-order.ts'

/** Rows kept while following the tail. Older rows fall off the top and stay one scroll away. */
const MAX_ROWS = 5000
/** Rows kept while reading older lines. Past this the newest rows go, and the view no longer reaches the tail. */
const MAX_ROWS_DETACHED = MAX_ROWS * 2
const NEAR_BOTTOM_PX = 48
const NEAR_TOP_PX = 400

export interface LogViewElements {
  scroller: HTMLElement
  list: HTMLElement
  status: HTMLElement
  jump: HTMLButtonElement
}

export interface LogViewOptions {
  elements: LogViewElements
  /** The colour slot of an instance, 0 to 7. */
  colourOf: (instance: string) => number
  loadOlder: (beforeId: number) => Promise<LogPage>
  /** Called when a click on a row's instance or plugin should narrow the filters. */
  onPick: (pick: { instance?: string, plugin?: string }) => void
  /** The view no longer joins up with the newest lines; reload the newest page instead. */
  onReload: () => void
}

/**
 * The log list, in log time order. Lines arrive in batches and are drawn once
 * per animation frame; a line older than the rows below it goes in its place.
 * While the view is at the bottom it follows new lines. Scrolling up holds
 * them and counts them, and scrolling near the top loads older lines.
 */
export class LogView {
  private readonly options: LogViewOptions
  private readonly el: LogViewElements
  private filters: Filters
  private queue: LogLine[] = []
  /** Live lines that arrived during a reload, not yet filtered. */
  private waiting: LogLine[] = []
  /** Live lines that arrived while the reader was scrolled up. */
  private readonly held = new HeldLines<LogLine>(MAX_ROWS)
  private frame = 0
  private generation = 0
  private lastDay = 0
  private rows = 0
  private hasMore = false
  private isLoadingOlder = false
  private hasOlderFailed = false
  private isFollowing = true
  /** True when the rows at the bottom no longer join up with the newest lines. */
  private isDetached = false
  private hasGap = false
  private unseen = 0
  private isWaiting = false
  /** The scroll position at the last scroll event, or after the view scrolled itself. Lower on the next event means the reader scrolled up. */
  private lastScrollTop = 0
  /** Plugin names seen in lines, for the plugin menu. */
  readonly plugins = new Set<string>()

  constructor(options: LogViewOptions, filters: Filters) {
    this.options = options
    this.el = options.elements
    this.filters = filters
    this.el.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true })
    this.el.jump.addEventListener('click', () => this.jumpToLatest())
    this.el.list.addEventListener('click', (event) => this.onClick(event))
    // Fonts, wrapping and the cards can change the height after the last scroll,
    // and a resize fires no scroll event, so stay at the bottom while following.
    const pin = new ResizeObserver(() => {
      if (this.isFollowing) {
        this.scrollToBottom()
      }
    })
    pin.observe(this.el.scroller)
    pin.observe(this.el.list)
  }

  /**
   * Replace everything with a fresh page, for new filters or a reload. The
   * server has already filtered the page. Lines that arrived since pause()
   * and are newer than the page follow it.
   */
  reset(page: LogPage, filters: Filters): void {
    const waiting = this.waiting.filter((line) => line.id > page.latestId)
    this.waiting = []
    this.generation++
    this.filters = filters
    this.queue = []
    this.held.clear()
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.el.list.replaceChildren()
    this.rows = 0
    this.lastDay = 0
    this.unseen = 0
    this.hasMore = page.hasMore
    this.isFollowing = true
    this.isDetached = false
    this.hasGap = false
    this.isWaiting = false
    this.hasOlderFailed = false
    this.notePlugins(page.lines)
    this.place(page.lines)
    this.receive(waiting)
    this.flush()
    this.scrollToBottom()
    this.updateStatus()
  }

  /** Hold live lines while a new page loads, so none fall in the gap. */
  pause(): void {
    this.isWaiting = true
  }

  /** New lines from the stream. Lines that do not match the filters are skipped. */
  receive(lines: readonly LogLine[]): void {
    if (this.isWaiting) {
      this.waiting.push(...lines)
      return
    }
    this.notePlugins(lines)
    this.queue.push(...lines.filter((line) => matches(line, this.filters)))
    // Browsers pause animation frames in background tabs, so a tab left open can
    // queue lines for hours. Keep only what one screen of history would show.
    if (this.queue.length > MAX_ROWS) {
      this.queue.splice(0, this.queue.length - MAX_ROWS)
      this.hasGap = true
    }
    if (this.queue.length > 0 && this.frame === 0) {
      this.frame = requestAnimationFrame(() => this.flush())
    }
  }

  setWrap(isWrapped: boolean): void {
    this.el.list.classList.toggle('wrap', isWrapped)
  }

  jumpToLatest(): void {
    if (this.isDetached || this.held.overflowed) {
      this.options.onReload()
      return
    }
    this.setFollowing(true)
    this.scrollToBottom()
  }

  private notePlugins(lines: readonly LogLine[]): void {
    for (const line of lines) {
      if (line.plugin) {
        this.plugins.add(line.plugin)
      }
    }
  }

  private flush(): void {
    this.frame = 0
    const lines = this.queue
    this.queue = []
    if (lines.length === 0) {
      this.updateStatus()
      return
    }
    if (this.hasGap) {
      this.startOver()
    }
    if (this.isFollowing) {
      this.place(lines)
      this.trim()
      this.scrollToBottom()
    } else {
      if (!this.isDetached) {
        this.held.add(lines)
      }
      this.unseen += lines.length
    }
    this.updateStatus()
  }

  /** Put lines into the list in log order: at the end when they are newest, which is nearly always, else in their place. */
  private place(lines: readonly LogLine[]): void {
    const list = this.el.list
    for (const line of inLogOrder(lines)) {
      const last = lastRow(list)
      if (!last || isBefore(keyOf(last), line)) {
        const day = dayNumber(line.ts)
        if (day !== this.lastDay) {
          list.append(divider(line.ts))
          this.lastDay = day
        }
        list.append(this.row(line))
        this.rows++
      } else {
        this.insertInPlace(line)
      }
    }
  }

  /** A line older than the newest row. When it is older than every row and older pages exist, it waits for those pages. */
  private insertInPlace(line: LogLine): void {
    let next: HTMLElement | null = lastRow(this.el.list)
    while (next) {
      const previous = previousRow(next)
      if (!previous || isBefore(keyOf(previous), line)) {
        break
      }
      next = previous
    }
    if (!next || (this.hasMore && !previousRow(next))) {
      return
    }
    const row = this.row(line)
    next.before(row)
    fixDivider(row)
    fixDivider(next)
    this.rows++
  }

  private async loadOlder(): Promise<void> {
    const first = firstRow(this.el.list)
    if (this.isLoadingOlder || !this.hasMore || !first) {
      return
    }
    const generation = this.generation
    this.isLoadingOlder = true
    this.hasOlderFailed = false
    this.updateStatus()
    try {
      const page = await this.options.loadOlder(keyOf(first).id)
      if (generation === this.generation) {
        this.prepend(page)
      }
    } catch {
      this.hasOlderFailed = true
    } finally {
      this.isLoadingOlder = false
      if (generation === this.generation) {
        this.updateStatus()
      }
    }
  }

  /** Lines were dropped from the queue, so the rows on screen no longer join up with the new ones. */
  private startOver(): void {
    this.hasGap = false
    this.el.list.replaceChildren()
    this.rows = 0
    this.lastDay = 0
    this.hasMore = true
    this.isDetached = false
    this.held.clear()
    this.setFollowing(true)
  }

  /** Insert older lines above, keeping what is on screen where it was. */
  private prepend(page: LogPage): void {
    this.hasMore = page.hasMore
    if (page.lines.length === 0) {
      return
    }
    this.notePlugins(page.lines)
    const fragment = document.createDocumentFragment()
    let day = 0
    for (const line of page.lines) {
      const lineDay = dayNumber(line.ts)
      if (lineDay !== day) {
        fragment.append(divider(line.ts))
        day = lineDay
      }
      fragment.append(this.row(line))
    }
    const before = this.el.scroller.scrollHeight
    const top = this.el.list.firstElementChild
    if (top?.classList.contains('divider') && top.getAttribute('data-day') === String(day)) {
      top.remove()
    }
    this.el.list.prepend(fragment)
    this.el.scroller.scrollTop += this.el.scroller.scrollHeight - before
    this.lastScrollTop = this.el.scroller.scrollTop
    this.rows += page.lines.length
    this.trimNewest()
  }

  /** Drop the oldest rows past MAX_ROWS. They can be loaded again by scrolling up. */
  private trim(): void {
    const list = this.el.list
    let hasTrimmed = false
    while (this.rows > MAX_ROWS && list.firstElementChild) {
      if (list.firstElementChild.classList.contains('row')) {
        this.rows--
        hasTrimmed = true
      }
      list.firstElementChild.remove()
    }
    const first = firstRow(list)
    if (hasTrimmed && first) {
      this.hasMore = true
      if (!list.firstElementChild?.classList.contains('divider')) {
        first.before(divider(keyOf(first).ts))
      }
    }
  }

  /** While reading older lines, drop the newest rows past MAX_ROWS_DETACHED. The view then needs a reload to reach the tail. */
  private trimNewest(): void {
    const list = this.el.list
    if (this.rows <= MAX_ROWS_DETACHED) {
      return
    }
    while (this.rows > MAX_ROWS_DETACHED && list.lastElementChild) {
      if (list.lastElementChild.classList.contains('row')) {
        this.rows--
      }
      list.lastElementChild.remove()
    }
    while (list.lastElementChild?.classList.contains('divider')) {
      list.lastElementChild.remove()
    }
    const last = lastRow(list)
    this.lastDay = last ? dayNumber(keyOf(last).ts) : 0
    this.isDetached = true
    this.held.clear()
    this.setFollowing(false)
  }

  private row(line: LogLine): HTMLElement {
    const time = h('time', { class: 't', datetime: new Date(line.ts).toISOString(), title: formatFull(line.ts) }, formatTime(line.ts))
    const instance = h('span', { class: 'inst', title: `Show only ${line.instance}` }, line.instance)
    const attrs = { 'data-id': line.id, 'data-ts': line.ts, 'data-instance': line.instance }
    if (line.system) {
      return h('div', { ...attrs, class: `row system lvl-${line.level} c${this.options.colourOf(line.instance)}` },
        time, instance, h('span', { class: 'msg' }, stripAnsi(line.message)))
    }
    const plugin = line.plugin
      ? h('span', { class: 'plg', title: `Show only ${line.plugin}` }, line.plugin)
      : h('span', { class: 'plg core' }, 'Homebridge')
    const message = h('span', { class: 'msg' })
    for (const segment of parseAnsi(line.message)) {
      const span = segment.classes.length > 0 ? h('span', { class: segment.classes.join(' ') }) : message
      appendHighlighted(span, segment.text, this.filters.search)
      if (span !== message) {
        message.append(span)
      }
    }
    return h('div', { ...attrs, 'data-plugin': line.plugin ?? '', class: `row lvl-${line.level} c${this.options.colourOf(line.instance)}` },
      time, instance, plugin, message)
  }

  /**
   * Any scroll up lets go of the tail at once. Otherwise the next batch of
   * lines pulls a slow scroll back down before it gets NEAR_BOTTOM_PX away.
   * Coming back down near the bottom follows again.
   */
  private onScroll(): void {
    const s = this.el.scroller
    // Safari reports positions past the bottom while it bounces, so compare within the range.
    const bottom = s.scrollHeight - s.clientHeight
    const top = Math.min(s.scrollTop, bottom)
    const hasMovedUp = top < Math.min(this.lastScrollTop, bottom)
    this.lastScrollTop = top
    if (!this.isDetached) {
      if (this.isFollowing && hasMovedUp) {
        this.setFollowing(false)
      } else if (!this.isFollowing && !hasMovedUp && bottom - top < NEAR_BOTTOM_PX) {
        this.setFollowing(true)
      }
    }
    if (s.scrollTop < NEAR_TOP_PX) {
      void this.loadOlder()
    }
  }

  private onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
    if (window.getSelection()?.toString()) {
      return
    }
    const row = target.closest<HTMLElement>('.row')
    if (target.classList.contains('inst') && row?.dataset.instance) {
      this.options.onPick({ instance: row.dataset.instance })
    } else if (target.classList.contains('plg') && row?.dataset.plugin) {
      this.options.onPick({ plugin: row.dataset.plugin })
    }
  }

  /** Back at the bottom, the held lines go in. If too many arrived meanwhile, the newest page is loaded instead. */
  private setFollowing(isFollowing: boolean): void {
    this.isFollowing = isFollowing
    if (isFollowing) {
      if (this.held.overflowed) {
        this.options.onReload()
        return
      }
      this.place(this.held.take())
      this.trim()
      this.unseen = 0
    }
    this.updateStatus()
  }

  private scrollToBottom(): void {
    const s = this.el.scroller
    s.scrollTop = s.scrollHeight
    this.lastScrollTop = s.scrollTop
  }

  private updateStatus(): void {
    const jump = this.el.jump
    jump.hidden = this.isFollowing
    jump.textContent = this.unseen > 0 ? `${plural(this.unseen, 'new line')} below` : 'Back to latest'
    this.el.status.textContent = this.statusText()
    this.el.status.dataset.state = this.rows === 0 ? 'empty' : 'top'
  }

  private statusText(): string {
    if (this.isLoadingOlder) return 'Loading older lines…'
    if (this.hasOlderFailed) return 'Could not load older lines. Scroll up to try again.'
    if (this.rows === 0) return this.filters.search || this.filters.plugin || this.filters.level ? 'No lines match these filters.' : 'Waiting for log lines…'
    return this.hasMore ? '' : 'Start of the stored log'
  }
}

function keyOf(row: HTMLElement): LineKey {
  return { ts: Number(row.dataset.ts), id: Number(row.dataset.id) }
}

function firstRow(list: HTMLElement): HTMLElement | null {
  return list.querySelector<HTMLElement>(':scope > .row')
}

function lastRow(list: HTMLElement): HTMLElement | null {
  let element = list.lastElementChild
  while (element && !element.classList.contains('row')) {
    element = element.previousElementSibling
  }
  return element as HTMLElement | null
}

function previousRow(row: Element): HTMLElement | null {
  let element = row.previousElementSibling
  while (element && !element.classList.contains('row')) {
    element = element.previousElementSibling
  }
  return element as HTMLElement | null
}

/** Make the dividers just above `row` right: one when its day differs from the row before it, or it is the first row. */
function fixDivider(row: HTMLElement): void {
  while (row.previousElementSibling?.classList.contains('divider')) {
    row.previousElementSibling.remove()
  }
  const previous = previousRow(row)
  const ts = keyOf(row).ts
  if (!previous || dayNumber(keyOf(previous).ts) !== dayNumber(ts)) {
    row.before(divider(ts))
  }
}

/** Wrap each case-insensitive match of `query` in <mark>. */
function appendHighlighted(parent: HTMLElement, text: string, query: string): void {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    parent.append(text)
    return
  }
  const lower = text.toLowerCase()
  let cursor = 0
  for (let index = lower.indexOf(needle); index >= 0; index = lower.indexOf(needle, cursor)) {
    parent.append(text.slice(cursor, index), h('mark', {}, text.slice(index, index + needle.length)))
    cursor = index + needle.length
  }
  parent.append(text.slice(cursor))
}

function divider(ts: number): HTMLElement {
  return h('div', { class: 'divider', role: 'separator', 'data-day': dayNumber(ts) }, h('span', {}, formatDay(ts)))
}
