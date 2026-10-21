/**
 * Every time the dashboard connects to a log stream, Homebridge UI first replays
 * the end of its log file (the last 50 KB, or `tail -n 500`), then streams new
 * lines. Most of the replay is already stored. These functions find where the
 * stored lines stop inside the replay, so only the lines after that point are
 * stored again.
 */

/** How many stored lines are compared with a replay, which holds at most 500. */
export const REPLAY_COMPARE_LINES = 500
const MIN_MATCH = 3

const UI_BANNER = [
  /^Loading logs using \S+ method\.\.\.$/,
  /^(?:CMD|File): /,
  /^Node\.js v\S+ higher is required/,
  /^You may experience issues while running on Node\.js/,
]

/**
 * The index in `replay` where unseen lines begin.
 *
 * `stored` holds the newest stored lines of one instance, oldest first. The
 * replay should contain the end of `stored` followed by new lines. The overlap
 * is the place where the replay matches the stored lines furthest back.
 *
 * On a tie, a match that ran out of lines to compare beats one that stopped at
 * a different line: in [A B C X A B C] after stored [Y A B C], only the first
 * A B C can be the stored one. Otherwise the later place wins. With no overlap
 * (first run, rotated log, or a gap longer than the replay), every replayed
 * line is unseen and this returns 0.
 */
export function replayStart(stored: readonly string[], replay: readonly string[]): number {
  const last = stored.at(-1)
  if (last === undefined) {
    return 0
  }
  let best = { start: 0, length: 0, isWhole: false }
  for (let end = 0; end < replay.length; end++) {
    if (replay[end] !== last) {
      continue
    }
    const match = matchBackwards(stored, replay, end)
    const isBetter = match.length > best.length || (match.length === best.length && (match.isWhole || !best.isWhole))
    if (isBetter) {
      best = { start: end + 1, ...match }
    }
  }
  const needed = Math.min(MIN_MATCH, stored.length)
  const reachesStart = best.length > 0 && best.length === best.start
  return best.length >= needed || reachesStart ? best.start : 0
}

/**
 * How many lines match going back from `replay[end]` and the last stored line,
 * and whether they matched all the way to the end of what could be compared.
 */
function matchBackwards(stored: readonly string[], replay: readonly string[], end: number): { length: number, isWhole: boolean } {
  const limit = Math.min(end + 1, stored.length, REPLAY_COMPARE_LINES)
  let length = 0
  while (length < limit && replay[end - length] === stored[stored.length - 1 - length]) {
    length++
  }
  return { length, isWhole: length === limit }
}

/** True for the lines that Homebridge UI prints before the replay, which are not part of the log. */
export function isUiBanner(plain: string): boolean {
  return plain.trim() === '' || UI_BANNER.some((pattern) => pattern.test(plain))
}
