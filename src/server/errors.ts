/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Reading thrown values, which need not be Errors.
 */

import { readFileSync } from 'node:fs'

/** The message of a thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The Node error code of a thrown value, such as `ENOENT`, when it has one. */
export function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return undefined
}

/** A file's parsed JSON, or what went wrong in plain words: missing, unreadable, or not JSON. */
export function readJsonFile(path: string): { value: unknown } | { problem: string, isMissing: boolean } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT') {
      return { problem: 'the file is missing', isMissing: true }
    }
    const reason = code === 'EACCES' || code === 'EPERM' ? 'permission denied' : code === 'EISDIR' ? 'it is a directory' : errorMessage(error)
    return { problem: `cannot read it (${reason})`, isMissing: false }
  }
  try {
    return { value: JSON.parse(text) as unknown }
  } catch (error) {
    return { problem: `not valid JSON: ${errorMessage(error)}`, isMissing: false }
  }
}
