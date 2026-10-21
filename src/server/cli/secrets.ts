/**
 * Write the secrets file: the Keystone users' password hashes and each
 * instance's Homebridge UI password.
 *
 *   npm run secrets                       Homebridge passwords, and a first user if there is none
 *   npm run secrets -- --user <name>      add a user, or change that user's password
 *   npm run secrets -- --remove-user <n>  remove a user
 *   --config <path>                       another config file, as for the server
 *
 * On a terminal it asks for each value without echo, and Enter keeps the
 * current value. From a pipe it reads one line per value in the same order,
 * and an empty line keeps the current value.
 */
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

import { hashPassword } from '../auth/password.ts'
import { ConfigError, configPath, readSettings, type Settings } from '../config.ts'
import { normalizeUsername, readSecretsFile, SecretsError, writeSecretsFile, type Secrets } from '../secrets.ts'
import { HiddenLine, type HiddenResult } from './hidden-line.ts'

const MIN_LENGTH = 12
const KEEP = ' (Enter keeps it)'
/** The shell's code for a command ended by Ctrl-C. */
const EXIT_CANCELLED = 130
const USAGE = 'usage: npm run secrets -- [--config <path>] [--user <name> | --remove-user <name>]'

type Ask = (prompt: string) => Promise<string>

interface Prompter {
  /** For passwords: a terminal does not echo them. */
  ask: Ask
  /** For user names, which a terminal echoes. */
  askVisible: Ask
  isTerminal: boolean
}

async function readVisible(prompt: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await lines.question(prompt)
  } finally {
    lines.close()
  }
}

/** Typed or pasted characters after the Enter that ended the last answer, for the next question. */
let typedAhead = ''

/** Read one line from the terminal in raw mode, so nothing typed is echoed. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin
  process.stdout.write(prompt)
  const line = new HiddenLine()
  const settle = (result: HiddenResult, resolvePromise: (value: string) => void): boolean => {
    if (result === null) {
      return false
    }
    process.stdout.write('\n')
    if (result === 'cancel') {
      process.exit(EXIT_CANCELLED)
    }
    typedAhead = result.rest
    resolvePromise(result.value)
    return true
  }
  return new Promise((resolvePromise) => {
    const pending = typedAhead
    typedAhead = ''
    if (settle(line.feed(pending), resolvePromise)) {
      return
    }
    const onData = (chunk: string): void => {
      const result = line.feed(chunk)
      if (result !== null) {
        stdin.off('data', onData)
        stdin.setRawMode(false)
        stdin.pause()
        settle(result, resolvePromise)
      }
    }
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
    stdin.resume()
  })
}

/** Answers from a pipe: one line each, in order. */
async function pipedAnswers(): Promise<Ask> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    chunks.push(chunk)
  }
  const lines = Buffer.concat(chunks).toString('utf8').split('\n').map((line) => line.replace(/\r$/, ''))
  let next = 0
  return () => Promise.resolve(lines[next++] ?? '')
}

function requireUsername(value: string): string {
  const name = normalizeUsername(value)
  if (!name) {
    throw new Error(`"${value}" is not a valid user name; use up to 32 lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit`)
  }
  return name
}

/** Ask for a user's password. `current` is the hash that Enter keeps, if there is one. */
async function askUserHash({ ask, isTerminal }: Prompter, name: string, current: string | undefined): Promise<string> {
  const value = await ask(`Keystone password for ${name}${current ? KEEP : ''}: `)
  if (!value) {
    if (current) {
      return current
    }
    throw new Error(`${name} needs a password`)
  }
  if (value.length < MIN_LENGTH) {
    throw new Error(`use at least ${MIN_LENGTH} characters for the Keystone password`)
  }
  if (isTerminal && (await ask('Again: ')) !== value) {
    throw new Error('the two passwords differ')
  }
  return hashPassword(value)
}

async function askHomebridgePasswords({ ask }: Prompter, settings: Settings, current: Secrets): Promise<Record<string, string>> {
  const passwords: Record<string, string> = {}
  for (const instance of settings.instances) {
    const known = current.passwords[instance.name]
    const value = await ask(`Password of ${instance.username} in the ${instance.name} Homebridge UI${known ? KEEP : ''}: `)
    if (!value && !known) {
      throw new Error(`${instance.name} needs a password`)
    }
    passwords[instance.name] = value || (known ?? '')
  }
  return passwords
}

function removeUser(users: Record<string, string>, name: string): Record<string, string> {
  if (!Object.hasOwn(users, name)) {
    throw new Error(`there is no user ${name}`)
  }
  const rest = Object.fromEntries(Object.entries(users).filter(([user]) => user !== name))
  if (Object.keys(rest).length === 0) {
    throw new Error(`${name} is the only user; add another one first`)
  }
  return rest
}

function readArgs(): { config?: string, user?: string, removeUser?: string } {
  let values: { config?: string, user?: string, 'remove-user'?: string }
  try {
    values = parseArgs({
      args: process.argv.slice(2),
      options: { config: { type: 'string' }, user: { type: 'string' }, 'remove-user': { type: 'string' } },
    }).values
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${USAGE}`, { cause: error })
  }
  if (values.user !== undefined && values['remove-user'] !== undefined) {
    throw new Error(`use --user or --remove-user, not both\n${USAGE}`)
  }
  return { config: values.config, user: values.user, removeUser: values['remove-user'] }
}

async function main(): Promise<void> {
  const args = readArgs()
  const settings = readSettings(configPath(args.config, process.env), process.env)
  const current = readSecretsFile(settings.secretsFile) ?? { users: {}, passwords: {} }
  const isTerminal = process.stdin.isTTY
  const piped = isTerminal ? null : await pipedAnswers()
  const prompter: Prompter = { ask: piped ?? readHidden, askVisible: piped ?? readVisible, isTerminal }
  let users = { ...current.users }
  let passwords = current.passwords
  if (args.removeUser !== undefined) {
    users = removeUser(users, requireUsername(args.removeUser))
  } else if (args.user !== undefined) {
    const name = requireUsername(args.user)
    users[name] = await askUserHash(prompter, name, Object.hasOwn(current.users, name) ? current.users[name] : undefined)
  } else {
    if (Object.keys(users).length === 0) {
      const name = requireUsername(await prompter.askVisible('Keystone user name: '))
      users[name] = await askUserHash(prompter, name, undefined)
    }
    passwords = await askHomebridgePasswords(prompter, settings, current)
  }
  writeSecretsFile(settings.secretsFile, { users, passwords })
  process.stdout.write(`Wrote ${settings.secretsFile}. Users: ${Object.keys(users).sort().join(', ')}. Restart Keystone to use it.\n`)
}

main().catch((error: unknown) => {
  const isKnown = error instanceof ConfigError || error instanceof SecretsError
  process.stderr.write(`secrets: ${isKnown ? error.message : (error as Error).message}\n`)
  process.exit(1)
})
