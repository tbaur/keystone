/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { InstanceSnapshot, Overview } from '../../src/shared/types.ts'
import { CORE_PLUGIN, type Filters } from '../../src/web/filters.ts'
import { renderInstances } from '../../src/web/overview-view.ts'
import { FakeBrowser, FakeElement } from './fake-dom.ts'

const NOW = 10 * 60_000

function snapshot(overrides: Partial<InstanceSnapshot> = {}): InstanceSnapshot {
  return {
    name: 'example-1', uiUrl: 'https://example-1.example.com',
    api: { state: 'connected', since: 0, error: null }, logs: { state: 'connected', since: 0, error: null },
    homebridge: { status: 'ok', bridgeName: 'Example Bridge', version: '1.11.0', latestVersion: null, updateAvailable: false },
    childBridges: [], plugins: [], pluginsError: null, accessories: null, accessoriesError: null, host: null, updatedAt: 0,
    ...overrides,
  }
}

function overview(instance: InstanceSnapshot, logCounts: Overview['logCounts'] = []): Overview {
  return { instances: [instance], logCounts, store: 'ok' }
}

function render(container: FakeElement, value: Overview, focused: Array<Partial<Filters>> = []): FakeElement {
  // renderInstances only uses the parts of an element that the fake has.
  renderInstances(container as unknown as HTMLElement, value, { focus: (filters) => focused.push(filters), colourOf: () => 0 }, NOW)
  const card = container.children[0]
  assert.ok(card)
  return card
}

describe('instance cards', () => {
  new FakeBrowser()

  it('keeps a card that shows the same thing, and redraws it when that changes', () => {
    const container = new FakeElement('div')
    const first = render(container, overview(snapshot({ name: 'example-cache' })))
    assert.equal(render(container, overview(snapshot({ name: 'example-cache' }))), first)
    const down = snapshot({ name: 'example-cache', logs: { state: 'unreachable', since: NOW - 5 * 60_000, error: 'no log data' } })
    assert.notEqual(render(container, overview(down)), first)
  })

  it('says how long the log stream has been down', () => {
    const down = snapshot({ name: 'example-down', logs: { state: 'unreachable', since: NOW - 5 * 60_000, error: 'no log data' } })
    const notice = render(new FakeElement('div'), overview(down)).findAll('notice')[0]
    assert.equal(notice?.textContent, 'Log stream: no log data (5 min ago); retrying')
  })

  it('narrows the log to Homebridge itself from its error count', () => {
    const focused: Array<Partial<Filters>> = []
    const counts: Overview['logCounts'] = [{ instance: 'example-core', plugin: null, level: 'error', count: 3 }]
    const card = render(new FakeElement('div'), overview(snapshot({ name: 'example-core' }), counts), focused)
    const link = card.findAll('link').find((button) => button.textContent === 'Homebridge · 3')
    assert.ok(link)
    link.click()
    assert.deepEqual(focused, [{ instances: ['example-core'], level: 'error', plugin: CORE_PLUGIN }])
  })
})
