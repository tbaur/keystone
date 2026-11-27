/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/** The theme button: a title, an aria-label and the icon's <use>. */
class FakeButton extends EventTarget {
  title = ''
  readonly attributes = new Map<string, string>()
  readonly use = { href: '', setAttribute: (_name: string, value: string): void => { this.use.href = value } }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  querySelector(selector: string): { setAttribute: (name: string, value: string) => void } | null {
    return selector === 'use' ? this.use : null
  }
}

describe('theme switch', () => {
  it('applies the saved theme at once, then cycles dark, light and auto, saving all but the default', async () => {
    const stored = new Map<string, string>([['keystone.theme', 'light']])
    const page = new EventTarget()
    const button = new FakeButton()
    const root = { dataset: {} as Record<string, string | undefined> }
    Object.assign(globalThis, {
      HTMLButtonElement: FakeButton,
      window: {
        localStorage: {
          getItem: (key: string) => stored.get(key) ?? null,
          setItem: (key: string, value: string) => stored.set(key, value),
          removeItem: (key: string) => stored.delete(key),
        },
      },
      document: Object.assign(page, { documentElement: root, getElementById: (id: string) => (id === 'theme' ? button : null) }),
    })
    await import('../../src/web/theme.ts')
    assert.equal(root.dataset.theme, 'light', 'before the page is drawn')
    page.dispatchEvent(new Event('DOMContentLoaded'))
    assert.equal(button.title, 'Theme: light')
    assert.equal(button.use.href, '#i-theme-light')

    button.dispatchEvent(new Event('click'))
    assert.equal(root.dataset.theme, undefined, 'auto follows the system')
    assert.equal(stored.get('keystone.theme'), 'auto')
    assert.equal(button.attributes.get('aria-label'), 'Theme: same as the system')

    button.dispatchEvent(new Event('click'))
    assert.equal(root.dataset.theme, 'dark')
    assert.equal(stored.has('keystone.theme'), false, 'the default is not saved')
  })
})
