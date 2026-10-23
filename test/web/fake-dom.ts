/**
 * Just enough of a browser to run LogView in Node: elements, a scroller with
 * a fixed row height, animation frames and resize observers. A test moves
 * time forward with frame(), which runs the steps in a browser's order:
 * scroll events, animation frames, layout, then resize observers.
 */

export const ROW_PX = 20
export const VIEW_PX = 400

interface FakeEvent {
  type: string
  target: FakeElement
}

type Listener = (event: FakeEvent) => void
type FakeChild = FakeElement | FakeText
type Insertable = FakeChild | string

class FakeNode {
  parent: FakeElement | null = null

  remove(): void {
    this.parent?.removeChild(this)
  }

  before(...nodes: Insertable[]): void {
    this.parent?.insert(nodes, this)
  }
}

class FakeText extends FakeNode {
  readonly textContent: string

  constructor(text: string) {
    super()
    this.textContent = text
  }
}

export class FakeElement extends FakeNode {
  readonly tagName: string
  readonly nodes: FakeChild[] = []
  hidden = false
  readonly dataset: Record<string, string | undefined>
  readonly classList = {
    contains: (name: string): boolean => this.classes().includes(name),
    toggle: (name: string, force = !this.classList.contains(name)): void => {
      const others = this.classes().filter((each) => each !== name)
      this.className = (force ? [...others, name] : others).join(' ')
    },
  }

  private readonly attributes = new Map<string, string>()
  private readonly listeners = new Map<string, Listener[]>()

  constructor(tagName: string) {
    super()
    this.tagName = tagName.toUpperCase()
    this.dataset = new Proxy<Record<string, string | undefined>>({}, {
      get: (_target, key) => typeof key === 'string' ? this.getAttribute(dataAttribute(key)) ?? undefined : undefined,
      set: (_target, key, value) => {
        this.setAttribute(dataAttribute(String(key)), String(value))
        return true
      },
    })
  }

  get className(): string {
    return this.getAttribute('class') ?? ''
  }

  set className(value: string) {
    this.setAttribute('class', value)
  }

  get textContent(): string {
    return this.nodes.map((node) => node.textContent).join('')
  }

  set textContent(text: string) {
    this.replaceChildren(text)
  }

  get children(): FakeElement[] {
    return this.nodes.filter((node) => node instanceof FakeElement)
  }

  get firstElementChild(): FakeElement | null {
    return elementFrom(this.nodes, 0, 1)
  }

  get lastElementChild(): FakeElement | null {
    return elementFrom(this.nodes, this.nodes.length - 1, -1)
  }

  get previousElementSibling(): FakeElement | null {
    const siblings = this.parent?.nodes ?? []
    return elementFrom(siblings, siblings.indexOf(this) - 1, -1)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  appendChild(node: FakeChild): FakeChild {
    this.insert([node], null)
    return node
  }

  append(...nodes: Insertable[]): void {
    this.insert(nodes, null)
  }

  prepend(...nodes: Insertable[]): void {
    this.insert(nodes, this.nodes[0] ?? null)
  }

  replaceChildren(...nodes: Insertable[]): void {
    for (const node of this.nodes) {
      node.parent = null
    }
    this.nodes.length = 0
    this.insert(nodes, null)
  }

  removeChild(node: FakeNode): void {
    this.nodes.splice(this.nodes.findIndex((child) => child === node), 1)
    node.parent = null
  }

  /** Insert before `anchor`, or at the end. A fragment gives up its children. */
  insert(nodes: Insertable[], anchor: FakeNode | null): void {
    const flat = nodes.flatMap((node) => {
      if (typeof node === 'string') return [new FakeText(node)]
      if (node instanceof FakeFragment) return node.takeAll()
      return [node]
    })
    for (const node of flat) {
      node.remove()
    }
    const index = anchor ? this.nodes.findIndex((child) => child === anchor) : this.nodes.length
    this.nodes.splice(index, 0, ...flat)
    for (const node of flat) {
      node.parent = this
    }
  }

  /** Only `:scope > .name`, which is all LogView asks for. */
  querySelector(selector: string): FakeElement | null {
    const name = /^:scope > \.([\w-]+)$/.exec(selector)?.[1]
    if (!name) throw new Error(`The fake DOM does not support the selector ${selector}`)
    return this.children.find((child) => child.classList.contains(name)) ?? null
  }

  /** Only `.name`. */
  closest(selector: string): FakeElement | null {
    const name = /^\.([\w-]+)$/.exec(selector)?.[1]
    if (!name) throw new Error(`The fake DOM does not support the selector ${selector}`)
    for (const element of selfAndAncestors(this)) {
      if (element.classList.contains(name)) return element
    }
    return null
  }

  /** Every descendant element with this class, in document order. */
  findAll(name: string): FakeElement[] {
    return this.children.flatMap((child) => [...(child.classList.contains(name) ? [child] : []), ...child.findAll(name)])
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  fire(event: FakeEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event)
    }
  }

  /** A click on this element, bubbling up to the root. */
  click(): void {
    for (const element of selfAndAncestors(this)) {
      element.fire({ type: 'click', target: this })
    }
  }

  private classes(): string[] {
    return this.className.split(' ').filter(Boolean)
  }
}

class FakeFragment extends FakeElement {
  constructor() {
    super('#fragment')
  }

  takeAll(): FakeChild[] {
    const nodes = this.nodes.splice(0)
    for (const node of nodes) {
      node.parent = null
    }
    return nodes
  }
}

/** A scroll box whose content is one list, each child ROW_PX tall, shown VIEW_PX at a time. */
export class FakeScroller extends FakeElement {
  /** A browser fires one scroll event in the next frame after the position changes. */
  hasMoved = false
  private readonly content: FakeElement
  private top = 0

  constructor(content: FakeElement) {
    super('div')
    this.content = content
    this.append(content)
  }

  get clientHeight(): number {
    return VIEW_PX
  }

  get scrollHeight(): number {
    return Math.max(VIEW_PX, this.content.children.length * ROW_PX)
  }

  get scrollTop(): number {
    return this.top
  }

  set scrollTop(value: number) {
    const top = Math.max(0, Math.min(value, this.scrollHeight - VIEW_PX))
    if (top !== this.top) {
      this.top = top
      this.hasMoved = true
    }
  }

  get isAtBottom(): boolean {
    return this.top === this.scrollHeight - VIEW_PX
  }

  /** The reader scrolls by `px`. Negative is up. */
  scrollBy(px: number): void {
    this.scrollTop = this.top + px
  }

  /** Layout: when the content gets shorter, the position comes in with it. */
  layout(): void {
    this.scrollTop = this.top
  }
}

/** The page elements LogView uses, and the browser globals it calls, installed on globalThis. */
export class FakeBrowser {
  readonly list = new FakeElement('div')
  readonly scroller = new FakeScroller(this.list)
  readonly status = new FakeElement('div')
  readonly jump = new FakeElement('button')
  /** What window.getSelection() returns as text. */
  selection = ''
  private readonly frames = new Map<number, () => void>()
  private readonly observers: Array<() => void> = []
  private nextFrame = 1
  private observedHeight = 0

  constructor() {
    const frames = this.frames
    const observers = this.observers
    Object.assign(globalThis, {
      document: {
        createElement: (tag: string) => new FakeElement(tag),
        createTextNode: (text: string) => new FakeText(text),
        createDocumentFragment: () => new FakeFragment(),
      },
      window: { getSelection: () => ({ toString: () => this.selection }) },
      requestAnimationFrame: (callback: (time: number) => void) => {
        const id = this.nextFrame++
        frames.set(id, () => callback(0))
        return id
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      ResizeObserver: class {
        constructor(callback: () => void) {
          observers.push(callback)
        }

        observe(): void {}
      },
    })
  }

  /**
   * The elements, typed as LogView expects them. The fakes cover only what
   * LogView calls, so a new DOM call there fails these tests instead of passing.
   */
  elements(): { scroller: HTMLElement, list: HTMLElement, status: HTMLElement, jump: HTMLButtonElement } {
    return {
      scroller: this.scroller as unknown as HTMLElement,
      list: this.list as unknown as HTMLElement,
      status: this.status as unknown as HTMLElement,
      jump: this.jump as unknown as HTMLButtonElement,
    }
  }

  /** One browser frame. */
  frame(): void {
    if (this.scroller.hasMoved) {
      this.scroller.hasMoved = false
      this.scroller.fire({ type: 'scroll', target: this.scroller })
    }
    const callbacks = [...this.frames.values()]
    this.frames.clear()
    for (const callback of callbacks) {
      callback()
    }
    this.scroller.layout()
    if (this.scroller.scrollHeight !== this.observedHeight) {
      this.observedHeight = this.scroller.scrollHeight
      for (const observer of this.observers) {
        observer()
      }
    }
  }

  /** A few frames, enough for a scroll, a draw and the resize after it to settle. */
  settle(): void {
    for (let i = 0; i < 3; i++) {
      this.frame()
    }
  }
}

function dataAttribute(key: string): string {
  return `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
}

function* selfAndAncestors(element: FakeElement): Generator<FakeElement> {
  for (let current: FakeElement | null = element; current; current = current.parent) {
    yield current
  }
}

/** The first element at or after `start`, walking by `step`. */
function elementFrom(nodes: readonly FakeChild[], start: number, step: 1 | -1): FakeElement | null {
  for (let index = start; index >= 0 && index < nodes.length; index += step) {
    const node = nodes[index]
    if (node instanceof FakeElement) return node
  }
  return null
}
