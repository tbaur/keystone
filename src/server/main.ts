import { parseArgs } from 'node:util'

import { ConfigError, configPath, loadConfig, type Config } from './config.ts'
import { SetupError, startDashboard } from './dashboard-server.ts'
import { createLogger } from './logger.ts'
import { SecretsError } from './secrets.ts'

/** sysexits.h EX_USAGE: the command line is wrong. */
const EXIT_USAGE = 64
/** sysexits.h EX_CONFIG: launchd and systemd logs show a bad config or build, not a crash, and a restart will not help. */
const EXIT_CONFIG = 78
const USAGE = 'usage: node dist/server/main.js [--config <path>]'

function readArgs(): string | undefined {
  try {
    return parseArgs({ args: process.argv.slice(2), options: { config: { type: 'string' } } }).values.config
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}\n`)
    process.exit(EXIT_USAGE)
  }
}

function readConfig(): Config {
  const path = configPath(readArgs(), process.env)
  try {
    return loadConfig(path, process.env)
  } catch (error) {
    const isKnown = error instanceof ConfigError || error instanceof SecretsError
    const message = isKnown ? error.message : `Cannot read config ${path}: ${(error as Error).message}`
    process.stderr.write(`${message}\n`)
    process.exit(EXIT_CONFIG)
  }
}

async function main(): Promise<void> {
  const config = readConfig()
  const logger = createLogger({ level: config.logLevel })
  const fatal = (msg: string) => (error: unknown) => {
    logger.error(msg, { error })
    process.exit(1)
  }
  process.on('uncaughtException', fatal('uncaught exception'))
  process.on('unhandledRejection', fatal('unhandled rejection'))

  let running: Awaited<ReturnType<typeof startDashboard>>
  try {
    running = await startDashboard(config, logger)
  } catch (error) {
    logger.error('start failed', { error })
    process.exit(error instanceof SetupError ? EXIT_CONFIG : 1)
  }
  let isStopping = false
  const stop = (signal: string): void => {
    if (isStopping) {
      logger.warn('stopping now, without waiting', { signal })
      process.exit(1)
    }
    isStopping = true
    logger.info('stopping', { signal })
    running.close().then(() => process.exit(0), fatal('shutdown failed'))
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

await main()
