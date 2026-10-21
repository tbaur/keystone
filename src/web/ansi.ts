/**
 * Turn ANSI SGR colour codes into styled segments. Only the codes that
 * Homebridge and its plugins use are kept: 16 colours, bold, dim, italic and
 * underline. Every other escape sequence is dropped.
 */

export interface Segment {
  text: string
  /** CSS classes, such as `fg-1` or `b`. Empty for plain text. */
  classes: string[]
}

interface Style {
  fg: number | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
}

// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[([0-9;?]*)([ -/]*[@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const PLAIN: Style = { fg: null, bold: false, dim: false, italic: false, underline: false }

export function parseAnsi(text: string): Segment[] {
  const segments: Segment[] = []
  let style: Style = PLAIN
  let cursor = 0
  for (const match of text.matchAll(ESCAPES)) {
    push(segments, text.slice(cursor, match.index), style)
    cursor = match.index + match[0].length
    if (match[2] === 'm') {
      style = applySgr(style, match[1] ?? '')
    }
  }
  push(segments, text.slice(cursor), style)
  return segments
}

export function stripAnsi(text: string): string {
  return text.replace(ESCAPES, '')
}

function push(segments: Segment[], text: string, style: Style): void {
  if (text === '') {
    return
  }
  const classes = classesOf(style)
  const last = segments.at(-1)
  if (last && last.classes.join(' ') === classes.join(' ')) {
    last.text += text
  } else {
    segments.push({ text, classes })
  }
}

function applySgr(current: Style, params: string): Style {
  const codes = params === '' ? [0] : params.split(';').map(Number)
  let style = { ...current }
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] ?? 0
    if (code === 38 || code === 48) {
      const skipped = skipExtendedColour(codes, i, code === 38 ? style : null)
      i = skipped.index
      style = skipped.style ?? style
      continue
    }
    style = applyCode(style, code)
  }
  return style
}

function applyCode(style: Style, code: number): Style {
  if (code === 0) return { ...PLAIN }
  if (code === 1) return { ...style, bold: true }
  if (code === 2) return { ...style, dim: true }
  if (code === 3) return { ...style, italic: true }
  if (code === 4) return { ...style, underline: true }
  if (code === 22) return { ...style, bold: false, dim: false }
  if (code === 23) return { ...style, italic: false }
  if (code === 24) return { ...style, underline: false }
  if (code >= 30 && code <= 37) return { ...style, fg: code - 30 }
  if (code >= 90 && code <= 97) return { ...style, fg: code - 90 + 8 }
  if (code === 39) return { ...style, fg: null }
  return style
}

/** `38;5;n` keeps colours 0 to 15; `38;2;r;g;b` and anything else is skipped. */
function skipExtendedColour(codes: number[], index: number, style: Style | null): { index: number, style: Style | null } {
  const mode = codes[index + 1]
  if (mode === 5) {
    const colour = codes[index + 2] ?? -1
    return { index: index + 2, style: style && colour >= 0 && colour < 16 ? { ...style, fg: colour } : style }
  }
  return { index: mode === 2 ? index + 4 : index + 1, style }
}

function classesOf(style: Style): string[] {
  const classes: string[] = []
  if (style.fg !== null) classes.push(`fg-${style.fg}`)
  if (style.bold) classes.push('b')
  if (style.dim) classes.push('d')
  if (style.italic) classes.push('i')
  if (style.underline) classes.push('u')
  return classes
}
