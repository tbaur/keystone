import { stripAnsiText } from '../logs/line-parser.ts'

/**
 * The text that a search looks in: the plugin and the message without colours,
 * lowercased. `matches()` in src/web/filters.ts builds the same text for live
 * lines, and a test keeps the two the same.
 */
export function searchText(plugin: string | null, message: string): string {
  return `${plugin ?? ''} ${stripAnsiText(message)}`.toLowerCase()
}

/** A search as the user typed it, in the form that `searchText` is in. */
export function searchQuery(query: string): string {
  return query.trim().toLowerCase()
}
