/**
 * A stand-in for one Homebridge UI: the REST endpoints the dashboard polls and
 * the `log` socket, with the same replay-then-stream behaviour. Responses carry
 * PINs and setup codes like the real ones, so tests can prove they never leak.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Server as SocketServer, type Socket } from 'socket.io'

export const FAKE_PIN = '031-45-154'
export const FAKE_SETUP_URI = 'X-HM://0000000000000'
const REPLAY_BYTES = 50_000

export interface FakeHomebridgeOptions {
  username?: string
  password?: string
  port?: number
  log?: string[]
  /** The bridge name, shown in the status response. */
  bridgeName?: string
  /** The `/api/status/homebridge/child-bridges` response. */
  childBridges?: unknown[]
  /** The `/api/plugins` response. */
  plugins?: unknown[]
  /** The `/api/accessories` response. */
  accessories?: unknown[]
  /** The IANA zone that `/api/status/uptime` reports for the host. */
  timeZone?: string
}

export class FakeHomebridge {
  readonly username: string
  readonly password: string
  /** The whole "log file", one entry per line. */
  readonly log: string[]
  logins = 0
  status: 'ok' | 'pending' | 'down' = 'ok'
  /** Act as if `restrictLogsToAdmins` were on: drop every log socket. */
  logsRestricted = false
  /** Accept log sockets but never send anything on them. */
  logsSilent = false
  accessories: unknown[]
  /** The status code of `/api/accessories` when it is not 200, as when the accessory list is shared off. */
  accessoriesStatus = 200
  /** Requests by path, for asserting on what was polled. */
  readonly requests = new Map<string, number>()
  private readonly timeZone: string
  private readonly bridgeName: string
  private readonly childBridges: unknown[]
  private readonly plugins: unknown[]
  private readonly tokens = new Set<string>()
  private readonly tails = new Set<Socket>()
  private server: Server | null = null
  private io: SocketServer | null = null
  private port = 0

  constructor(options: FakeHomebridgeOptions = {}) {
    this.username = options.username ?? 'example'
    this.password = options.password ?? 'test-password'
    this.log = [...(options.log ?? [])]
    this.bridgeName = options.bridgeName ?? 'Example Bridge'
    this.childBridges = options.childBridges ?? defaultChildBridges()
    this.plugins = options.plugins ?? defaultPlugins()
    this.accessories = options.accessories ?? defaultAccessories()
    this.timeZone = options.timeZone ?? 'UTC'
    this.port = options.port ?? 0
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(): Promise<this> {
    const server = createServer((req, res) => void this.handle(req, res))
    this.io = new SocketServer(server, { transports: ['websocket'] })
    this.io.of('/log').on('connection', (socket) => {
      socket.on('tail-log', () => this.tail(socket))
      socket.on('disconnect', () => this.tails.delete(socket))
    })
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve))
    this.port = (server.address() as AddressInfo).port
    this.server = server
    return this
  }

  async stop(): Promise<void> {
    this.tails.clear()
    await new Promise<void>((resolve) => {
      if (this.io) {
        void this.io.close(() => resolve())
      } else {
        resolve()
      }
    })
    this.server = null
    this.io = null
  }

  /** Write a line to the log file and to every open tail. */
  append(...lines: string[]): void {
    for (const line of lines) {
      this.log.push(line)
      for (const socket of this.tails) {
        socket.emit('stdout', `${line}\n\r`)
      }
    }
  }

  /** Forget every token, like a restart with a new secret. */
  revokeTokens(): void {
    this.tokens.clear()
  }

  /** Drop every log socket from the server side. */
  dropLogSockets(): void {
    for (const socket of this.tails) {
      socket.disconnect(true)
    }
  }

  private tail(socket: Socket): void {
    const token = (socket.handshake.auth as { token?: unknown }).token
    if (typeof token !== 'string' || !this.tokens.has(token) || this.logsRestricted) {
      socket.disconnect(true)
      return
    }
    if (this.logsSilent) {
      return
    }
    socket.emit('stdout', '\u001b[36mLoading logs using native method...\r\n\u001b[39m')
    socket.emit('stdout', '\u001b[36mFile: /home/user/.homebridge/homebridge.log\r\n\r\n\u001b[39m')
    const text = this.log.map((line) => `${line}\n`).join('')
    const replay = text.length > REPLAY_BYTES ? text.slice(text.length - REPLAY_BYTES) : text
    if (replay) {
      socket.emit('stdout', replay.split('\n').join('\n\r'))
    }
    this.tails.add(socket)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', this.url).pathname
    this.requests.set(path, (this.requests.get(path) ?? 0) + 1)
    if (req.method === 'POST' && path === '/api/auth/login') {
      await this.login(req, res)
      return
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (!this.tokens.has(token)) {
      send(res, 401, { message: 'Unauthorized' })
      return
    }
    const body = this.respond(path)
    if (path === '/api/accessories' && this.accessoriesStatus !== 200) {
      send(res, this.accessoriesStatus, { message: 'Bad Request' })
    } else if (body === undefined) {
      send(res, 404, { message: 'Not Found' })
    } else {
      send(res, 200, body)
    }
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req as AsyncIterable<Buffer>) {
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { username?: string, password?: string }
    this.logins++
    if (body.username !== this.username || body.password !== this.password) {
      send(res, 401, { message: 'Unauthorized' })
      return
    }
    const token = randomBytes(16).toString('hex')
    this.tokens.add(token)
    send(res, 201, { access_token: token, token_type: 'Bearer', expires_in: 28800 })
  }

  private respond(path: string): unknown {
    const responses: Record<string, unknown> = {
      '/api/status/homebridge': {
        status: this.status, consolePort: 8581, name: this.bridgeName, port: 51826,
        pin: FAKE_PIN, setupUri: FAKE_SETUP_URI, packageVersion: '5.29.0', paired: true,
      },
      '/api/status/homebridge/child-bridges': this.childBridges,
      '/api/status/cpu': { currentLoad: 7.25, cpuLoadHistory: [], cpuTemperature: { main: -1 } },
      '/api/status/ram': { mem: { total: 17179869184, available: 9663676416 }, memoryUsageHistory: [] },
      '/api/status/uptime': { time: { current: 0, uptime: 266400, timezone: 'UTC', timezoneName: this.timeZone }, processUptime: 3600 },
      '/api/status/network': { net: { iface: 'en0', rx_sec: 1850000, tx_sec: 240000 }, point: 1.99 },
      '/api/status/homebridge-version': { name: 'homebridge', installedVersion: '1.11.0', latestVersion: '1.11.1', updateAvailable: true },
      '/api/plugins': this.plugins,
      '/api/accessories': this.accessories,
    }
    return responses[path]
  }
}

/** A Homebridge-style log line: white time, cyan plugin, message coloured by level. */
export function homebridgeLine(time: string, plugin: string | null, message: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info'): string {
  const colours = { info: '', warn: '\u001b[33m', error: '\u001b[31m', debug: '\u001b[90m' }
  const reset = level === 'info' ? '' : '\u001b[39m'
  const prefix = plugin ? `\u001b[36m[${plugin}]\u001b[39m ` : ''
  return `\u001b[37m[${time}] \u001b[39m${prefix}${colours[level]}${message}${reset}`
}

/** A child bridge entry with the PIN and setup code that the real API returns. */
export function fakeChildBridge(name: string, plugin: string, status: 'ok' | 'down', index: number): unknown {
  const id = index.toString(16).padStart(2, '0')
  return { status, name, plugin, username: `02:00:00:00:00:${id}`, pin: FAKE_PIN, setupUri: FAKE_SETUP_URI, identifier: `0200000000000${id.padStart(3, '0')}`, manuallyStopped: false, paired: true }
}

function defaultChildBridges(): unknown[] {
  return [fakeChildBridge('Sensor Bridge', 'homebridge-example', 'ok', 1), fakeChildBridge('Camera Bridge', 'homebridge-example-camera', 'down', 2)]
}

function defaultPlugins(): unknown[] {
  return [
    { name: 'homebridge-config-ui-x', displayName: 'Homebridge UI', installedVersion: '5.29.0', latestVersion: '5.29.0', updateAvailable: false },
    { name: 'homebridge-example', displayName: 'Example', installedVersion: '2.0.0', latestVersion: '2.1.0', updateAvailable: true, installPath: '/home/user/node_modules' },
  ]
}

/** One entry per service, as the real API returns: the door sensor has a contact service and a battery service. */
function defaultAccessories(): unknown[] {
  const bridge = { username: '02:00:00:00:00:10' }
  const door = { Name: 'Front Door Sensor' }
  return [
    { uniqueId: 'a1', aid: 2, instance: bridge, accessoryInformation: door, serviceName: 'Front Door Sensor', humanType: 'Contact Sensor', values: { ContactSensorState: 0, StatusLowBattery: 1 } },
    { uniqueId: 'a1b', aid: 2, instance: bridge, accessoryInformation: door, serviceName: 'Battery', humanType: 'Battery', values: { BatteryLevel: 12, StatusLowBattery: 1 } },
    { uniqueId: 'a2', aid: 3, instance: bridge, accessoryInformation: { Name: 'Zone One Light' }, serviceName: 'Zone One Light', humanType: 'Lightbulb', values: { On: true } },
    { uniqueId: 'a3', aid: 4, instance: bridge, accessoryInformation: { Name: 'Sensor' }, serviceName: 'Sensor', humanType: 'Battery', values: { BatteryLevel: 80, StatusLowBattery: 0 } },
  ]
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
