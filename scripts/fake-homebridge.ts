/**
 * Run Keystone against two fake Homebridge instances that write a steady,
 * realistic log, for working on the UI without a real Homebridge.
 *
 *   npm run build && npm run dev:fake
 *
 * Then open http://127.0.0.1:8590 and sign in with the password printed below.
 * Data goes to ./data/dev, which git ignores.
 */
import { join } from 'node:path'

import { hashPassword } from '../src/server/auth/password.ts'
import type { Config } from '../src/server/config.ts'
import { startDashboard } from '../src/server/dashboard-server.ts'
import { createLogger } from '../src/server/logger.ts'
import { FakeHomebridge, fakeChildBridge, homebridgeLine } from '../test/helpers/fake-homebridge.ts'

const USER = 'example'
const PASSWORD = 'keystone-dev-password'
const ROOT = join(import.meta.dirname, '..')
const STACK = ['    at Socket.emit (node:events:519:28)', '    at TCP.onStreamRead (node:internal/stream_base_commons:189:23)']

type Level = 'info' | 'warn' | 'error' | 'debug'
type Message = [plugin: string | null, text: string, level: Level]

/** What one fake install runs: its own bridges, plugins, accessories and log lines. */
interface Profile {
  bridgeName: string
  childBridges: unknown[]
  plugins: unknown[]
  accessories: unknown[]
  /** Logged once, at the start of the history. */
  startup: Message[]
  messages: Message[]
}

function plugin(name: string, displayName: string, installed: string, latest = installed): unknown {
  return { name, displayName, installedVersion: installed, latestVersion: latest, updateAvailable: installed !== latest }
}

/** One entry of /api/accessories, which lists services: an accessory with a battery has a service for it. */
function service(uniqueId: string, aid: number, accessory: string, serviceName: string, humanType: string, values: Record<string, unknown>): unknown {
  return { uniqueId, aid, instance: { username: '02:00:00:00:00:10' }, accessoryInformation: { Name: accessory }, serviceName, humanType, values }
}

const UI_PLUGIN = plugin('homebridge-config-ui-x', 'Homebridge UI', '5.29.0')

const FIRST: Profile = {
  bridgeName: 'Example Bridge',
  childBridges: [fakeChildBridge('Sensor Bridge', 'homebridge-example-sensor', 'ok', 1), fakeChildBridge('Camera Bridge', 'homebridge-example-camera', 'down', 2)],
  plugins: [UI_PLUGIN, plugin('homebridge-example-lights', 'Lights', '2.0.0', '2.1.0'), plugin('homebridge-example-sensor', 'Sensor', '1.3.0'), plugin('homebridge-example-camera', 'Camera', '0.9.2')],
  accessories: [
    service('a1', 2, 'Front Door Sensor', 'Front Door Sensor', 'Contact Sensor', { ContactSensorState: 0, StatusLowBattery: 1 }),
    service('a1b', 2, 'Front Door Sensor', 'Battery', 'Battery', { BatteryLevel: 12, StatusLowBattery: 1 }),
    service('a2', 3, 'Zone One Light', 'Zone One Light', 'Lightbulb', { On: true }),
    service('a3', 4, 'Zone One Camera', 'Zone One Camera', 'Camera RTP Stream Management', {}),
  ],
  startup: [
    ['Homebridge UI', 'Homebridge UI v5.29.0 is listening on :: port 8581', 'info'],
    [null, 'Homebridge v1.11.0 (HAP v1.1.0) (Example Bridge) is running on port 51826.', 'info'],
  ],
  messages: [
    ['Lights', 'Zone One Light: set On to true', 'info'],
    ['Lights', 'Zone One Light: set Brightness to 40', 'info'],
    ['Lights', 'Polling 12 devices', 'debug'],
    ['Lights', 'Request failed with status 503; retrying in 30 s', 'error'],
    ['Sensor', 'Front Door Sensor: contact detected', 'info'],
    ['Sensor', 'Front Door Sensor battery is at 12%', 'warn'],
    ['Camera', 'Zone One Camera: snapshot took 4.2 s; consider a longer timeout', 'warn'],
    ['Camera', 'Error: connect ETIMEDOUT 192.0.2.40:443', 'error'],
  ],
}

const SECOND: Profile = {
  bridgeName: 'Second Bridge',
  childBridges: [fakeChildBridge('Climate Bridge', 'homebridge-example-climate', 'ok', 3), fakeChildBridge('Lock Bridge', 'homebridge-example-lock', 'ok', 4)],
  plugins: [UI_PLUGIN, plugin('homebridge-example-climate', 'Climate', '1.4.0', '1.5.0'), plugin('homebridge-example-lock', 'Lock', '3.2.1')],
  accessories: [
    service('b1', 2, 'Zone Two Thermostat', 'Zone Two Thermostat', 'Thermostat', { CurrentTemperature: 21.5, TargetTemperature: 21 }),
    service('b2', 3, 'Zone Two Lock', 'Zone Two Lock', 'Lock Mechanism', { LockCurrentState: 1, StatusLowBattery: 1, BatteryLevel: 18 }),
  ],
  startup: [
    ['Homebridge UI', 'Homebridge UI v5.29.0 is listening on :: port 8681', 'info'],
    [null, 'Homebridge v1.11.0 (HAP v1.1.0) (Second Bridge) is running on port 51836.', 'info'],
  ],
  messages: [
    ['Climate', 'Zone Two Thermostat: current temperature 21.5 °C', 'info'],
    ['Climate', 'Zone Two Thermostat: set TargetTemperature to 21', 'info'],
    ['Climate', 'Refreshing 3 zones', 'debug'],
    ['Climate', 'Cloud API rate limit reached; next poll in 120 s', 'warn'],
    ['Lock', 'Zone Two Lock: locked', 'info'],
    ['Lock', 'Zone Two Lock battery is at 18%', 'warn'],
    ['Lock', 'Error: lock did not answer within 10 s', 'error'],
  ],
}

const HISTORY_MS = 10 * 60_000

/** The fake hosts run in this machine's zone, and say so in /api/status/uptime as Homebridge UI does. */
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

function stamp(date: Date): string {
  return date.toLocaleString('en-US', { timeZone: TIME_ZONE })
}

/** One random line from the profile, followed by a stack trace now and then when it is an error. */
function randomLines(profile: Profile, at = new Date()): string[] {
  const [name, text, level] = profile.messages[Math.floor(Math.random() * profile.messages.length)]!
  const line = homebridgeLine(stamp(at), name, text, level)
  return level === 'error' && Math.random() < 0.3 ? [line, ...STACK] : [line]
}

/** The startup lines, then `count` random lines spread over the last ten minutes. */
function history(profile: Profile, count: number): string[] {
  const start = Date.now() - HISTORY_MS
  const startup = profile.startup.map(([name, text, level]) => homebridgeLine(stamp(new Date(start)), name, text, level))
  const lines = Array.from({ length: count }, (_, i) => randomLines(profile, new Date(start + ((i + 1) * HISTORY_MS) / count)))
  return [...startup, ...lines.flat()]
}

function fake(profile: Profile, port: number, lines: number): Promise<FakeHomebridge> {
  const { bridgeName, childBridges, plugins, accessories } = profile
  return new FakeHomebridge({ port, log: history(profile, lines), bridgeName, childBridges, plugins, accessories, timeZone: TIME_ZONE }).start()
}

async function main(): Promise<void> {
  const one = await fake(FIRST, 18581, 200)
  const two = await fake(SECOND, 18582, 80)
  const config: Config = {
    listen: { host: '127.0.0.1', port: 8590 },
    dataDir: join(ROOT, 'data', 'dev'),
    retentionDays: 7,
    users: { [USER]: await hashPassword(PASSWORD) },
    cookieSecure: false,
    trustProxy: false,
    logLevel: 'info',
    instances: [
      { name: 'example-1', apiUrl: one.url, uiUrl: 'https://example-1.example.com', username: one.username, password: one.password },
      { name: 'example-2', apiUrl: two.url, uiUrl: 'https://example-2.example.com', username: two.username, password: two.password },
    ],
  }
  const running = await startDashboard(config, createLogger({ level: 'info' }), { webRoot: join(ROOT, 'dist', 'web') })
  console.log(`\nKeystone: http://127.0.0.1:${running.port}  user: ${USER}  password: ${PASSWORD}\n`)

  const tick = setInterval(() => {
    const [target, profile] = Math.random() < 0.6 ? [one, FIRST] : [two, SECOND]
    target.append(...randomLines(profile))
  }, 900)

  process.on('SIGINT', () => {
    clearInterval(tick)
    void running.close().then(() => Promise.all([one.stop(), two.stop()])).then(() => process.exit(0))
  })
}

await main()
