/**
 * A small element builder. Text always goes in through text nodes, never as
 * HTML, so nothing from a log line can become markup.
 */

type Child = Node | string | number | null | undefined | false
type Props = Record<string, string | number | boolean | EventListener | null | undefined>

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) {
      continue
    }
    if (typeof value === 'function') {
      element.addEventListener(key.replace(/^on/, '').toLowerCase(), value)
    } else if (key === 'class') {
      element.className = String(value)
    } else {
      element.setAttribute(key, value === true ? '' : String(value))
    }
  }
  append(element, children)
  return element
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue
    }
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)))
  }
}

/** The element with this id, checked to be of the expected type. */
export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id)
  if (!(element instanceof type)) {
    throw new Error(`#${id} is missing from the page or is not a ${type.name}`)
  }
  return element
}

/** A small inline SVG icon from the sprite in index.html. */
export function icon(name: string, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.appendChild(use)
  return svg
}
