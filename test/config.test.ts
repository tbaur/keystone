import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import { verifyPassword } from '../src/server/auth/password.ts'
import { ConfigError, configPath, loadConfig, parseSettings } from '../src/server/config.ts'
import { SecretsError, writeSecretsFile } from '../src/server/secrets.ts'
import { tempDir } from './helpers/util.ts'

const HASH = `scrypt$32768$8$1$${'A'.repeat(22)}$${'B'.repeat(43)}`
const SECRETS_CLI = join(import.meta.dirname, '..', 'src', 'server', 'cli', 'secrets.ts')
const BOTH = { 'example-1': 'one', 'example-2': 'two' }

function validSettings(): Record<string, unknown> {
  return {
    instances: [
      { name: 'example-1', apiUrl: 'http://127.0.0.1:8581', uiUrl: 'https://example-1.example.com', username: 'example' },
      { name: 'example-2', apiUrl: 'http://127.0.0.1:8582/', uiUrl: 'https://example-2.example.com', username: 'example' },
    ],
  }
}

const context = { path: '/home/user/dashboard/config.json', env: {} }

/** A config.json in a temporary directory, and where its secrets go. */
function configDir(t: { after: (fn: () => void) => void }): { config: string, secrets: string } {
  const dir = tempDir(t)
  const config = join(dir, 'config.json')
  writeFileSync(config, JSON.stringify(validSettings()))
  return { config, secrets: join(dir, 'secrets.json') }
}

describe('parseSettings', () => {
  it('fills in defaults and resolves paths next to the config file', () => {
    const settings = parseSettings(validSettings(), context)
    assert.deepEqual(settings.listen, { host: '127.0.0.1', port: 8590 })
    assert.equal(settings.dataDir, '/home/user/dashboard/data')
    assert.equal(settings.secretsFile, '/home/user/dashboard/secrets.json')
    assert.equal(settings.retentionDays, 7)
    assert.equal(settings.cookieSecure, true)
    assert.equal(settings.instances[1]?.apiUrl, 'http://127.0.0.1:8582')
  })

  it('reports every problem at once', () => {
    const raw = { ...validSettings(), retentionDays: 0, instances: [{ name: 'Bad Name', apiUrl: 'ftp://host.test' }] }
    assert.throws(() => parseSettings(raw, context), (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.deepEqual(error.problems, [
        'retentionDays must be a whole number from 1 to 90',
        'instances[0].name must be lowercase letters, digits and dashes, up to 32 characters, starting with a letter or digit',
        'instances[0].apiUrl must be http or https',
        'instances[0].uiUrl is required',
        'instances[0].username is required',
      ])
      return true
    })
  })

  it('refuses secrets in the config file', () => {
    const raw = validSettings()
    ;(raw.instances as Array<Record<string, unknown>>)[0]!.password = 'test-password'
    assert.throws(() => parseSettings({ ...raw, users: { example: HASH } }, context), (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.equal(error.problems.length, 2)
      assert.match(error.problems.join('\n'), /users does not belong here[\s\S]*password does not belong here/)
      return true
    })
  })

  it('rejects duplicate instance names', () => {
    const raw = validSettings()
    const instances = raw.instances as Array<Record<string, unknown>>
    instances[1] = { ...instances[0] }
    assert.throws(() => parseSettings(raw, context), /instance names must be unique: example-1/)
  })

  it('takes the log level from KEYSTONE_LOG_LEVEL first, and treats an empty one as unset', () => {
    assert.equal(parseSettings({ ...validSettings(), logLevel: 'warn' }, { ...context, env: { KEYSTONE_LOG_LEVEL: 'debug' } }).logLevel, 'debug')
    assert.equal(parseSettings({ ...validSettings(), logLevel: 'warn' }, { ...context, env: { KEYSTONE_LOG_LEVEL: '' } }).logLevel, 'warn')
  })

  it('names the source of a bad log level, and checks the file even when the variable is set', () => {
    assert.throws(() => parseSettings(validSettings(), { ...context, env: { KEYSTONE_LOG_LEVEL: 'loud' } }), /KEYSTONE_LOG_LEVEL must be debug, info, warn or error, not "loud"/)
    assert.throws(() => parseSettings({ ...validSettings(), logLevel: 'loud' }, { ...context, env: { KEYSTONE_LOG_LEVEL: 'info' } }), /^[\s\S]*- logLevel must be/)
  })

  it('reports settings it does not know, so a typo does not fall back to a default', () => {
    const raw: Record<string, unknown> = { ...validSettings(), retentionDay: 30, listen: { port: 8590, adress: '127.0.0.1' } }
    ;(raw.instances as Array<Record<string, unknown>>)[0]!.uiURL = 'https://host.test'
    assert.throws(() => parseSettings(raw, context), (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.deepEqual(error.problems, [
        'retentionDay is not a setting; check the spelling',
        'listen.adress is not a setting; check the spelling',
        'instances[0].uiURL is not a setting; check the spelling',
      ])
      return true
    })
  })

  it('needs listen to be an object with a real host', () => {
    assert.throws(() => parseSettings({ ...validSettings(), listen: 8590 }, context), /listen must be an object/)
    assert.throws(() => parseSettings({ ...validSettings(), listen: { host: 'not a host!' } }, context), /listen.host must be an IP address or a host name/)
    assert.equal(parseSettings({ ...validSettings(), listen: { host: '::1' } }, context).listen.host, '::1')
    assert.equal(parseSettings({ ...validSettings(), listen: { host: 'localhost' } }, context).listen.host, 'localhost')
  })

  it('trusts X-Real-IP only when asked to', () => {
    assert.equal(parseSettings(validSettings(), context).trustProxy, false)
    assert.equal(parseSettings({ ...validSettings(), trustProxy: true }, context).trustProxy, true)
  })

  it('keeps a link path but needs the API at the root of its origin, without credentials', () => {
    const raw = validSettings()
    const instances = raw.instances as Array<Record<string, unknown>>
    instances[0] = { ...instances[0], uiUrl: 'https://host.test/homebridge/' }
    assert.equal(parseSettings(raw, context).instances[0]?.uiUrl, 'https://host.test/homebridge')
    instances[0] = { ...instances[0], apiUrl: 'https://user:secret@host.test/homebridge?x=1' }
    assert.throws(() => parseSettings(raw, context), (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.deepEqual(error.problems, [
        'instances[0].apiUrl must not hold a user name or password; `npm run secrets` stores the password',
        'instances[0].apiUrl must not have a query or fragment',
        'instances[0].apiUrl must be the Homebridge UI origin with no path, such as http://127.0.0.1:8581',
      ])
      return true
    })
  })
})

describe('loadConfig', () => {
  it('joins the settings with their secrets', (t) => {
    const { config, secrets } = configDir(t)
    writeSecretsFile(secrets, { users: { example: HASH }, passwords: BOTH })
    const loaded = loadConfig(config)
    assert.deepEqual(loaded.users, { example: HASH })
    assert.deepEqual(loaded.instances.map((instance) => instance.password), ['one', 'two'])
    assert.equal(statSync(secrets).mode & 0o777, 0o600)
  })

  it('refuses a user name that is not lowercase', (t) => {
    const { config, secrets } = configDir(t)
    writeFileSync(secrets, JSON.stringify({ users: { Example: HASH }, passwords: BOTH }), { mode: 0o600 })
    assert.throws(() => loadConfig(config), /user name "Example" is not valid/)
  })

  it('says how to create a missing secrets file', (t) => {
    const { config } = configDir(t)
    assert.throws(() => loadConfig(config), (error: unknown) => error instanceof SecretsError && /missing; run `npm run secrets`/.test(error.message))
  })

  it('names each instance without a password', (t) => {
    const { config, secrets } = configDir(t)
    writeSecretsFile(secrets, { users: { example: HASH }, passwords: { 'example-1': 'one' } })
    assert.throws(() => loadConfig(config), /no Homebridge password for example-2/)
  })

  it('refuses a secrets file that group or others can read', (t) => {
    const { config, secrets } = configDir(t)
    writeSecretsFile(secrets, { users: { example: HASH }, passwords: BOTH })
    chmodSync(secrets, 0o644)
    assert.throws(() => loadConfig(config), /mode is 644; run chmod 600/)
  })
})

describe('npm run secrets', () => {
  type Written = { users: Record<string, string>, passwords: Record<string, string>, passwordHash?: string }
  const run = (config: string, input: string, args: string[] = []): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SECRETS_CLI, '--config', config, ...args], { input, encoding: 'utf8', timeout: 20_000 })
  const read = (path: string): Written => JSON.parse(readFileSync(path, 'utf8')) as Written

  it('writes a first user and every Homebridge password, then keeps what an empty line skips', async (t) => {
    const { config, secrets } = configDir(t)
    const first = run(config, 'Example\nkeystone-test-password\none\ntwo\n')
    assert.equal(first.status, 0, String(first.stderr))
    const written = read(secrets)
    assert.deepEqual(Object.keys(written.users), ['example'])
    assert.ok(await verifyPassword('keystone-test-password', written.users.example ?? ''))
    assert.deepEqual(written.passwords, BOTH)
    assert.equal(statSync(secrets).mode & 0o777, 0o600)

    const second = run(config, '\nthree\n')
    assert.equal(second.status, 0, String(second.stderr))
    const kept = read(secrets)
    assert.deepEqual(kept.users, written.users)
    assert.deepEqual(kept.passwords, { 'example-1': 'one', 'example-2': 'three' })
  })

  it('adds a user and removes one, but never the last', async (t) => {
    const { config, secrets } = configDir(t)
    writeSecretsFile(secrets, { users: { example: HASH }, passwords: BOTH })
    const added = run(config, 'second-test-password\n', ['--user', 'second'])
    assert.equal(added.status, 0, String(added.stderr))
    assert.ok(await verifyPassword('second-test-password', read(secrets).users.second ?? ''))
    assert.equal(read(secrets).users.example, HASH)

    assert.equal(run(config, '', ['--remove-user', 'example']).status, 0)
    assert.deepEqual(Object.keys(read(secrets).users), ['second'])
    const last = run(config, '', ['--remove-user', 'second'])
    assert.equal(last.status, 1)
    assert.match(String(last.stderr), /only user/)
  })

  it('keeps a user password when Enter is pressed, and reads --config=<path>', (t) => {
    const { config, secrets } = configDir(t)
    writeSecretsFile(secrets, { users: { example: HASH }, passwords: BOTH })
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SECRETS_CLI, `--config=${config}`, '--user', 'example'], {
      input: '\n', encoding: 'utf8', timeout: 20_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(read(secrets), { users: { example: HASH }, passwords: BOTH })
  })

  it('refuses an unknown option, and --user with --remove-user', (t) => {
    const { config } = configDir(t)
    const unknown = run(config, '', ['--usr', 'example'])
    assert.equal(unknown.status, 1)
    assert.match(String(unknown.stderr), /usage: npm run secrets/)
    const both = run(config, '', ['--user', 'a', '--remove-user', 'b'])
    assert.equal(both.status, 1)
    assert.match(String(both.stderr), /not both/)
  })

  it('leaves no temporary file behind', (t) => {
    const { config, secrets } = configDir(t)
    assert.equal(run(config, 'example\nkeystone-test-password\none\ntwo\n').status, 0)
    const dir = join(secrets, '..')
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [])
  })

  it('refuses a short password or a bad user name, and writes nothing', (t) => {
    const { config, secrets } = configDir(t)
    const short = run(config, 'example\nshort\none\ntwo\n')
    assert.equal(short.status, 1)
    assert.match(String(short.stderr), /at least 12 characters/)
    const badName = run(config, 'not a name\nkeystone-test-password\none\ntwo\n')
    assert.equal(badName.status, 1)
    assert.match(String(badName.stderr), /not a valid user name/)
    assert.throws(() => statSync(secrets))
  })
})

describe('configPath', () => {
  it('prefers --config, then KEYSTONE_CONFIG, then ./config.json', () => {
    assert.equal(configPath('/etc/a.json', { KEYSTONE_CONFIG: '/etc/b.json' }), '/etc/a.json')
    assert.equal(configPath(undefined, { KEYSTONE_CONFIG: '/etc/b.json' }), '/etc/b.json')
    assert.equal(configPath(undefined, { KEYSTONE_CONFIG: '' }), resolve('config.json'))
    assert.equal(configPath(undefined, {}), resolve('config.json'))
  })
})
