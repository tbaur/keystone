/*
 * The theme switch: dark (the default), light, or auto (follow the system),
 * kept in the browser. This file has no imports or exports, so it builds to a
 * classic script that the page head runs before the first paint, and a saved
 * theme never flashes the other one.
 */
{
  const THEME_KEY = 'keystone.theme'
  const THEMES = ['dark', 'light', 'auto'] as const
  type Theme = (typeof THEMES)[number]
  const DEFAULT_THEME: Theme = 'dark'
  const LABELS: Record<Theme, string> = {
    auto: 'Theme: same as the system',
    dark: 'Theme: dark',
    light: 'Theme: light',
  }

  const savedTheme = (): Theme => {
    const value = window.localStorage.getItem(THEME_KEY)
    return THEMES.find((theme) => theme === value) ?? DEFAULT_THEME
  }

  const applyTheme = (theme: Theme): void => {
    if (theme === 'auto') {
      delete document.documentElement.dataset.theme
    } else {
      document.documentElement.dataset.theme = theme
    }
  }

  const showTheme = (button: HTMLButtonElement, theme: Theme): void => {
    button.title = LABELS[theme]
    button.setAttribute('aria-label', LABELS[theme])
    button.querySelector('use')?.setAttribute('href', `#i-theme-${theme}`)
  }

  const bindSwitch = (): void => {
    const button = document.getElementById('theme')
    if (!(button instanceof HTMLButtonElement)) {
      return
    }
    showTheme(button, savedTheme())
    button.addEventListener('click', () => {
      const next = THEMES[(THEMES.indexOf(savedTheme()) + 1) % THEMES.length] ?? DEFAULT_THEME
      if (next === DEFAULT_THEME) {
        window.localStorage.removeItem(THEME_KEY)
      } else {
        window.localStorage.setItem(THEME_KEY, next)
      }
      applyTheme(next)
      showTheme(button, next)
    })
  }

  applyTheme(savedTheme())
  document.addEventListener('DOMContentLoaded', bindSwitch)
}
