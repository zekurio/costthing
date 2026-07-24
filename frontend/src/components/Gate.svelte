<script lang="ts">
  import { api, ApiError } from '../lib/api.ts'

  let { onunlock }: { onunlock: () => void } = $props()

  let username = $state('')
  let password = $state('')
  let error = $state('')
  let busy = $state(false)

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!username.trim() || busy) return
    busy = true
    error = ''
    try {
      await api.login(username.trim(), password)
      onunlock()
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        error = 'Falsche Zugangsdaten – noch einmal versuchen.'
        password = ''
      } else if (err instanceof ApiError && err.status === 502) {
        error = 'Jellyfin ist gerade nicht erreichbar.'
      } else {
        error = 'Etwas ist schiefgelaufen.'
      }
    } finally {
      busy = false
    }
  }
</script>

<div class="gate">
  <form class="card" onsubmit={submit}>
    <img class="tile" src="/icon.svg" alt="" aria-hidden="true" />
    <h1>costthing</h1>
    <p class="hint">Kosten für SchnitzelFlix – melde dich mit deinem Jellyfin-Konto an.</p>
    <input
      type="text"
      bind:value={username}
      placeholder="Benutzername"
      aria-label="Benutzername"
      autocomplete="username"
    />
    <input
      type="password"
      bind:value={password}
      placeholder="Passwort"
      aria-label="Passwort"
      autocomplete="current-password"
    />
    {#if error}<p class="error">{error}</p>{/if}
    <button class="primary" type="submit" disabled={busy || !username.trim()}>
      {busy ? 'einen Moment…' : 'ansehen'}
    </button>
  </form>
</div>

<style>
  .gate {
    flex: 1;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .card {
    width: min(360px, 100%);
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: var(--shadow-2);
    padding: 32px 28px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    text-align: center;
  }

  .tile {
    width: 52px;
    height: 52px;
    margin: 0 auto;
    display: block;
  }

  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  .error {
    margin: 0;
    color: var(--danger-strong);
    font-size: 13px;
  }

  .primary {
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
    border-radius: 99px;
    padding: 10px;
    transition: background 120ms ease;
  }

  .primary:hover:not(:disabled) {
    background: var(--accent-strong);
  }

  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
