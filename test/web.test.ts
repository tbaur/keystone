import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { searchQuery, searchText } from '../src/server/store/search.ts'
import type { LogLine } from '../src/shared/types.ts'
import { parseAnsi, stripAnsi } from '../src/web/ansi.ts'
import { matches, NO_FILTERS, readFilters, toParams } from '../src/web/filters.ts'
import { formatDuration, formatMbps } from '../src/web/format.ts'
import { formatPluginVersion, formatVersion, hasPluginUpdate, hasUpdate, pluginsOutsideBridges } from '../src/web/plugins.ts'

describe('parseAnsi', () => {
  it('splits text into coloured segments and resets', () => {
    assert.deepEqual(parseAnsi('plain \u001b[31mred\u001b[39m back \u001b[1;92mbold green\u001b[0m'), [
      { text: 'plain ', classes: [] },
      { text: 'red', classes: ['fg-1'] },
      { text: ' back ', classes: [] },
      { text: 'bold green', classes: ['fg-10', 'b'] },
    ])
  })

  it('keeps 256-colour codes below 16 and skips true colour', () => {
    assert.deepEqual(parseAnsi('\u001b[38;5;3ma\u001b[38;2;1;2;3mb'), [{ text: 'ab', classes: ['fg-3'] }])
  })

  it('drops cursor and title escapes', () => {
    assert.equal(stripAnsi('\u001b[2K\u001b]0;title\u0007done'), 'done')
    assert.deepEqual(parseAnsi('\u001b[2Kdone'), [{ text: 'done', classes: [] }])
  })
})

describe('filters', () => {
  const line: LogLine = { id: 1, instance: 'example-1', ts: 0, plugin: 'Example', level: 'warn', message: '\u001b[33mBattery low\u001b[39m', system: false }

  it('round-trips through the URL', () => {
    const filters = { instances: ['example-1', 'example-2'], level: 'error' as const, plugin: 'Example', search: 'door' }
    assert.deepEqual(readFilters(`?${toParams(filters).toString()}`), filters)
    assert.deepEqual(readFilters('?level=nonsense'), NO_FILTERS)
  })

  it('match live lines the way the server filters', () => {
    assert.ok(matches(line, NO_FILTERS))
    assert.ok(matches(line, { ...NO_FILTERS, level: 'warn' }))
    assert.ok(!matches(line, { ...NO_FILTERS, level: 'error' }))
    assert.ok(!matches(line, { ...NO_FILTERS, instances: ['example-2'] }))
    assert.ok(matches(line, { ...NO_FILTERS, search: 'BATTERY' }))
    assert.ok(!matches(line, { ...NO_FILTERS, search: '33m' }))
    assert.ok(!matches(line, { ...NO_FILTERS, plugin: 'Other' }))
  })

  it('search live lines exactly as the server searches stored ones', () => {
    const lines: Array<Pick<LogLine, 'plugin' | 'message'>> = [
      { plugin: 'Example', message: '\u001b[31mDisk Full\u001b[39m' },
      { plugin: null, message: 'Homebridge v1.11.0 (HAP v1.0) is running on port 51826.' },
      { plugin: 'Other', message: '100% done \u001b]0;title\u0007with a title' },
      { plugin: 'Ünïcode', message: 'ÉCLAIR straße' },
    ]
    const queries = ['disk', ' DISK FULL ', 'example disk', 'other 100%', 'title', '0;title', 'éclair', 'ünïcode', 'v1.11', 'nothing', '31m']
    for (const sample of lines) {
      const full: LogLine = { ...line, ...sample }
      for (const query of queries) {
        const onServer = searchText(sample.plugin, sample.message).includes(searchQuery(query))
        assert.equal(matches(full, { ...NO_FILTERS, search: query }), onServer, `${JSON.stringify(query)} in ${JSON.stringify(sample.message)}`)
      }
    }
  })
})

describe('formatDuration', () => {
  it('shows the two largest units', () => {
    assert.equal(formatDuration(30), '0m')
    assert.equal(formatDuration(5 * 3600 + 12 * 60), '5h 12m')
    assert.equal(formatDuration(3 * 86_400 + 4 * 3600), '3d 4h')
  })
})

describe('formatMbps', () => {
  it('converts bytes per second to megabits, with one decimal below 10', () => {
    assert.equal(formatMbps(0), '0.0')
    assert.equal(formatMbps(240_000), '1.9')
    assert.equal(formatMbps(1_850_000), '15')
    assert.equal(formatMbps(117_500_000), '940')
  })
})

describe('formatPluginVersion', () => {
  const plugin = { name: 'homebridge-example', displayName: 'Example', version: '2.0.0', latestVersion: '2.0.0', updateAvailable: false, disabled: false }

  it('shows the installed version, and the latest one when an update is available', () => {
    assert.equal(formatPluginVersion(plugin), '2.0.0')
    assert.equal(formatPluginVersion({ ...plugin, latestVersion: '2.1.0', updateAvailable: true }), '2.0.0 → 2.1.0')
    assert.equal(formatPluginVersion({ ...plugin, version: null }), '–')
  })

  it('says when a plugin is disabled instead of offering its update', () => {
    assert.equal(formatPluginVersion({ ...plugin, latestVersion: '2.1.0', updateAvailable: true, disabled: true }), 'disabled')
  })
})

describe('formatVersion', () => {
  it('shows the installed version alone when the latest one is unknown', () => {
    assert.equal(formatVersion({ version: '1.11.0', latestVersion: null, updateAvailable: true }), '1.11.0')
    assert.equal(formatVersion({ version: '1.11.0', latestVersion: '1.11.1', updateAvailable: true }), '1.11.0 → 1.11.1')
  })

  it('still offers the update when the installed version is unknown', () => {
    assert.equal(formatVersion({ version: null, latestVersion: '1.11.1', updateAvailable: true }), '– → 1.11.1')
  })
})

describe('hasUpdate', () => {
  const plugin = { name: 'homebridge-example', displayName: 'Example', version: '2.0.0', latestVersion: '2.1.0', updateAvailable: true, disabled: false }

  it('counts an update only when the version to update to is known', () => {
    assert.equal(hasUpdate(plugin), true)
    assert.equal(hasUpdate({ ...plugin, latestVersion: null }), false)
    assert.equal(hasUpdate({ ...plugin, updateAvailable: false }), false)
  })

  it('offers no update for a disabled plugin', () => {
    assert.equal(hasPluginUpdate(plugin), true)
    assert.equal(hasPluginUpdate({ ...plugin, disabled: true }), false)
  })
})

describe('pluginsOutsideBridges', () => {
  const plugin = (name: string) => ({ name, displayName: name, version: '1.0.0', latestVersion: '1.0.0', updateAvailable: false, disabled: false })
  const bridge = (name: string, pluginName: string | null) => ({ name, plugin: pluginName, status: 'ok' as const, manuallyStopped: false })

  it('leaves out the plugins that a child bridge runs, since their rows show the version', () => {
    const installed = [plugin('homebridge-config-ui-x'), plugin('homebridge-example-lights'), plugin('homebridge-example-lock')]
    const childBridges = [bridge('Lock Bridge', 'homebridge-example-lock'), bridge('Second Lock Bridge', 'homebridge-example-lock'), bridge('Unknown', null)]
    assert.deepEqual(pluginsOutsideBridges(installed, childBridges).map((p) => p.name), ['homebridge-config-ui-x', 'homebridge-example-lights'])
  })
})

describe('page footer', () => {
  it('shows the version from package.json, on the line that release-please updates', () => {
    const root = join(import.meta.dirname, '..')
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
    const html = readFileSync(join(root, 'src/web/index.html'), 'utf8')
    const line = html.split('\n').find((text) => text.includes('x-release-please-version'))
    assert.ok(line?.includes(`>Keystone v${version}</a>`), 'the footer version must match package.json')
  })
})
