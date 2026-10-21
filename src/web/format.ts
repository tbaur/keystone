/** Display formatting. Times use the browser's locale and time zone. */

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' })

export function formatTime(ts: number): string {
  return TIME.format(ts)
}

export function formatDay(ts: number): string {
  return DAY.format(ts)
}

export function formatFull(ts: number): string {
  return FULL.format(ts)
}

/** "3d 4h", "5h 12m", "8m". */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${Math.max(minutes, 0)}m`
}

/** Bytes per second as megabits per second: "0.4", "9.9", "12", "940". */
export function formatMbps(bytesPerSecond: number): string {
  const mbps = (bytesPerSecond * 8) / 1_000_000
  return mbps < 10 ? mbps.toFixed(1) : String(Math.round(mbps))
}

/** "just now", "4 min ago", "2 h ago". */
export function formatAgo(ts: number, now = Date.now()): string {
  const seconds = Math.round((now - ts) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}
