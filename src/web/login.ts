import { byId } from './dom.ts'

const form = byId('login', HTMLFormElement)
const username = byId('username', HTMLInputElement)
const password = byId('password', HTMLInputElement)
const submit = byId('submit', HTMLButtonElement)
const message = byId('message', HTMLElement)

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void signIn()
})

async function signIn(): Promise<void> {
  submit.disabled = true
  message.textContent = ''
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value }),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.ok) {
      window.location.assign('/')
      return
    }
    const body = await response.json().catch(() => null) as { message?: string } | null
    message.textContent = body?.message ?? 'Sign-in failed. Try again.'
    password.select()
  } catch {
    message.textContent = 'Keystone did not answer. Check the connection and try again.'
  } finally {
    submit.disabled = false
  }
}
