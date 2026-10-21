const CTRL_C = '\u0003'
const CTRL_D = '\u0004'
const ESCAPE = '\u001b'
const BACKSPACE = new Set(['\u007f', '\b'])

export type HiddenResult = { value: string, rest: string } | 'cancel' | null

/**
 * The characters of one answer typed without echo, as they arrive from a raw
 * terminal. Arrow keys and other escape sequences are skipped, as are other
 * control characters. Ctrl-C and Ctrl-D cancel.
 */
export class HiddenLine {
  private value = ''
  /** After ESC: 'esc'; inside `ESC [ ...` until its final byte: 'csi'; after `ESC O`: 'ss3', which takes one more character. */
  private escape: 'none' | 'esc' | 'csi' | 'ss3' = 'none'

  /** The answer and what came after it once Enter arrives, 'cancel', or null while the answer goes on. */
  feed(chunk: string): HiddenResult {
    const chars = Array.from(chunk)
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index] ?? ''
      if (this.skipEscape(char)) {
        continue
      }
      if (char === CTRL_C || char === CTRL_D) {
        return 'cancel'
      }
      if (char === '\r' || char === '\n') {
        const next = char === '\r' && chars[index + 1] === '\n' ? index + 2 : index + 1
        return { value: this.value, rest: chars.slice(next).join('') }
      }
      if (BACKSPACE.has(char)) {
        this.value = Array.from(this.value).slice(0, -1).join('')
      } else if (char >= ' ') {
        this.value += char
      }
    }
    return null
  }

  private skipEscape(char: string): boolean {
    switch (this.escape) {
      case 'esc':
        this.escape = char === '[' ? 'csi' : char === 'O' ? 'ss3' : 'none'
        return true
      case 'csi':
        if (char >= '@' && char <= '~') {
          this.escape = 'none'
        }
        return true
      case 'ss3':
        this.escape = 'none'
        return true
      case 'none':
        if (char === ESCAPE) {
          this.escape = 'esc'
          return true
        }
        return false
    }
  }
}
