<script lang="ts">
  import { onMount } from 'svelte'
  import {
    CircleUserRound,
    Download,
    LogOut,
    Monitor,
    Moon,
    ShieldCheck,
    Sun,
    Upload,
  } from 'lucide-svelte'
  import Gate from './components/Gate.svelte'
  import CategoryPie from './components/CategoryPie.svelte'
  import TimelineChart from './components/TimelineChart.svelte'
  import EntryTable from './components/EntryTable.svelte'
  import { api, ApiError } from './lib/api.ts'
  import { cents, moneyFormatter } from './lib/format.ts'
  import type { KnownUser, Me, Summary, SummaryPoint } from '../../shared/types.ts'

  let view = $state<'loading' | 'gate' | 'ready'>('loading')
  let summary = $state<Summary | null>(null)
  let me = $state<Me | null>(null)
  /** admin only: Jellyfin users (incl. archived) for linking donations */
  let knownUsers = $state<KnownUser[]>([])
  let loadError = $state('')

  // ---- theme ----

  type ThemePref = 'light' | 'dark' | 'system'
  const storedTheme = localStorage.getItem('costthing.theme')
  let themePref = $state<ThemePref>(
    storedTheme === 'dark' || storedTheme === 'light' ? storedTheme : 'system',
  )
  let systemDark = $state(matchMedia('(prefers-color-scheme: dark)').matches)

  onMount(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => (systemDark = e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  })

  const resolvedTheme = $derived(
    themePref === 'system' ? (systemDark ? 'dark' : 'light') : themePref,
  )

  $effect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    if (themePref === 'system') localStorage.removeItem('costthing.theme')
    else localStorage.setItem('costthing.theme', themePref)
  })

  // ---- user menu ----

  let menuOpen = $state(false)
  let menuEl = $state<HTMLElement>()
  let importInput = $state<HTMLInputElement>()

  const admin = $derived(me?.isAdmin ?? false)
  const fmt = $derived(moneyFormatter(summary?.currency ?? 'EUR'))

  interface CategoryGroup {
    name: string
    monthlyCents: number
    points: SummaryPoint[]
  }

  const categories = $derived.by<CategoryGroup[]>(() => {
    if (!summary) return []
    const map = new Map<string, CategoryGroup>()
    for (const p of summary.points) {
      let group = map.get(p.category)
      if (!group) {
        group = { name: p.category, monthlyCents: 0, points: [] }
        map.set(p.category, group)
      }
      group.monthlyCents += p.monthlyCents
      group.points.push(p)
    }
    return [...map.values()].sort((a, b) => b.monthlyCents - a.monthlyCents)
  })

  async function load() {
    try {
      ;[summary, me] = await Promise.all([api.summary(), api.me()])
      if (me.isAdmin) {
        // best effort — linking still works from the archive if Jellyfin is down
        try {
          knownUsers = await api.users()
        } catch {
          knownUsers = []
        }
      }
      view = 'ready'
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        view = 'gate'
      } else {
        loadError = err instanceof Error ? err.message : 'Laden fehlgeschlagen'
        view = 'gate'
      }
    }
  }

  onMount(load)

  function handleAdminError(err: unknown) {
    // session expired or admin rights revoked — re-sync with the server
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) void load()
  }

  async function logout() {
    await api.logout()
    me = null
    view = 'gate'
  }

  // ---- admin import/export ----

  interface ConfirmAction {
    label: string
    kind: 'primary' | 'danger' | 'ghost'
    run: () => void
  }

  let confirmDialog = $state<{ title: string; body: string; actions: ConfirmAction[] } | null>(
    null,
  )

  async function downloadExport() {
    try {
      const data = await api.exportJson()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cost-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      if (err instanceof ApiError) handleAdminError(err)
    }
  }

  async function chooseImport(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return

    let data: unknown
    try {
      data = JSON.parse(await file.text())
    } catch {
      showImportError('Die ausgewählte Datei enthält kein gültiges JSON.')
      return
    }

    const candidate = data as { costPoints?: unknown; donations?: unknown }
    const costs = Array.isArray(candidate?.costPoints) ? candidate.costPoints.length : null
    const donationCount = Array.isArray(candidate?.donations) ? candidate.donations.length : null
    if (costs === null || donationCount === null) {
      showImportError('Die Datei enthält keinen gültigen costthing-Export.')
      return
    }

    confirmDialog = {
      title: 'JSON importieren?',
      body:
        `Die aktuellen Daten werden durch ${costs} Kostenpunkte und ${donationCount} Spenden ersetzt. ` +
        'Der bisherige Stand bleibt als costs.json.bak erhalten.',
      actions: [
        { label: 'Importieren', kind: 'danger', run: () => void doImport(data) },
        { label: 'Abbrechen', kind: 'ghost', run: () => {} },
      ],
    }
  }

  async function doImport(data: unknown) {
    try {
      await api.importJson(data)
      await load()
    } catch (err) {
      handleAdminError(err)
      showImportError(err instanceof Error ? err.message : 'Import fehlgeschlagen.')
    }
  }

  function showImportError(message: string) {
    confirmDialog = {
      title: 'Import fehlgeschlagen',
      body: message,
      actions: [{ label: 'Schließen', kind: 'ghost', run: () => {} }],
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key !== 'Escape') return
    if (confirmDialog) confirmDialog = null
    else if (menuOpen) menuOpen = false
  }}
  onpointerdown={(e) => {
    if (menuOpen && menuEl && !menuEl.contains(e.target as Node)) menuOpen = false
  }}
/>

{#if view === 'loading'}
  <div class="center muted">lädt…</div>
{:else if view === 'gate'}
  <Gate onunlock={load} />
  {#if loadError}<div class="center muted">{loadError}</div>{/if}
{:else if summary}
  <nav class="topbar">
    <div class="brand">
      <img class="tile" src="/icon.svg" alt="" aria-hidden="true" />
      <span class="brand-name">costthing</span>
    </div>
    <div class="user-menu" bind:this={menuEl}>
      <button
        class="avatar-btn"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Menü"
        onclick={() => (menuOpen = !menuOpen)}
      >
        {#if me?.hasAvatar}
          <img class="avatar-img" src="/api/me/avatar" alt={me.name} />
        {:else}
          <CircleUserRound size={22} />
        {/if}
        {#if admin}<span class="admin-dot" title="Admin"></span>{/if}
      </button>

      {#if menuOpen}
        <div class="menu" role="menu">
          {#if me}
            <div class="menu-user">
              <span class="menu-user-name">{me.name}</span>
              {#if admin}
                <span class="menu-user-role" title="Admin" aria-label="Admin">
                  <ShieldCheck size={16} />
                </span>
              {/if}
            </div>
            <div class="menu-sep"></div>
          {/if}
          <div class="menu-label">Design</div>
          <div class="theme-tabs" role="group" aria-label="Design wählen">
            <button
              class:active={themePref === 'light'}
              onclick={() => (themePref = 'light')}
              title="Hell"
              aria-label="Helles Design"
            >
              <Sun size={16} />
            </button>
            <button
              class:active={themePref === 'system'}
              onclick={() => (themePref = 'system')}
              title="Systemeinstellung folgen"
              aria-label="Design der Systemeinstellung folgen"
            >
              <Monitor size={16} />
            </button>
            <button
              class:active={themePref === 'dark'}
              onclick={() => (themePref = 'dark')}
              title="Dunkel"
              aria-label="Dunkles Design"
            >
              <Moon size={16} />
            </button>
          </div>

          <div class="menu-sep"></div>

          {#if admin}
            <input
              class="file-input"
              type="file"
              accept="application/json,.json"
              bind:this={importInput}
              onchange={chooseImport}
            />
            <button role="menuitem" onclick={() => importInput?.click()}>
              <Upload size={16} /> JSON importieren
            </button>
            <button role="menuitem" onclick={downloadExport}>
              <Download size={16} /> JSON exportieren
            </button>
            <div class="menu-sep"></div>
          {/if}

          <button role="menuitem" onclick={logout}>
            <LogOut size={16} /> Abmelden
          </button>
        </div>
      {/if}
    </div>
  </nav>

  <main>
    <section class="duo">
      <div class="duo-col">
        <div class="section-head">
          <h2 class="section-title">Kosten nach Kategorie</h2>
          <p class="section-note">
            aktueller Monat · {cents(fmt, summary.totals.yearlyCents)}/Jahr
          </p>
        </div>
        <CategoryPie
          slices={categories.map((c) => ({ name: c.name, monthlyCents: c.monthlyCents }))}
          {fmt}
        />
      </div>
      <div class="duo-col">
        <div class="section-head">
          <h2 class="section-title">Kosten &amp; Spenden</h2>
          <p class="section-note">gesamt + 12 Monate Prognose</p>
        </div>
        <TimelineChart timeline={summary.timeline} coverage={summary.coverage} {fmt} />
      </div>
    </section>

    <EntryTable
      points={summary.points}
      donations={summary.donations}
      categoryIcons={summary.categoryIcons}
      coverage={summary.coverage}
      {fmt}
      {admin}
      {knownUsers}
      meName={me?.name ?? ''}
      onchanged={load}
      onadminerror={handleAdminError}
    />
  </main>

  {#if confirmDialog}
    <div
      class="overlay"
      role="presentation"
      onclick={(e) => e.target === e.currentTarget && (confirmDialog = null)}
    >
      <div class="admin-box">
        <h2>{confirmDialog.title}</h2>
        <p class="confirm-body">{confirmDialog.body}</p>
        <div class="actions">
          {#each confirmDialog.actions as action (action.label)}
            <button
              class={action.kind === 'danger'
                ? 'danger-solid'
                : action.kind === 'ghost'
                  ? 'muted-btn'
                  : 'primary'}
              onclick={() => {
                confirmDialog = null
                action.run()
              }}
            >
              {action.label}
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .center {
    flex: 1;
    display: grid;
    place-items: center;
  }

  .muted {
    color: var(--muted);
  }

  /* ---- topbar ---- */

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 32px;
    background: var(--topbar-bg);
    color: var(--on-topbar);
    border-bottom: 1px solid var(--topbar-border);
    box-shadow: var(--shadow-1);
    position: sticky;
    top: 0;
    z-index: 5;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .tile {
    width: 34px;
    height: 34px;
    display: block;
    border-radius: 9px;
    background: var(--topbar-tile);
  }

  .brand-name {
    font-weight: 700;
    font-size: 17px;
    letter-spacing: -0.01em;
  }

  /* ---- user menu ---- */

  .user-menu {
    position: relative;
  }

  .avatar-btn {
    position: relative;
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 99px;
    color: var(--on-topbar);
    transition: background 120ms ease;
  }

  .avatar-btn:hover,
  .avatar-btn[aria-expanded='true'] {
    background: var(--topbar-hover);
  }

  .avatar-img {
    width: 30px;
    height: 30px;
    border-radius: 99px;
    object-fit: cover;
    display: block;
  }

  .menu-user {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px 6px;
  }

  .menu-user-name {
    font-weight: 600;
    font-size: 14px;
  }

  .menu-user-role {
    display: inline-flex;
    align-items: center;
    color: var(--accent-strong);
  }

  .admin-dot {
    position: absolute;
    right: 6px;
    bottom: 6px;
    width: 8px;
    height: 8px;
    border-radius: 99px;
    background: var(--ok);
    border: 2px solid var(--topbar-bg);
  }

  .menu {
    position: absolute;
    top: calc(100% + 10px);
    right: 0;
    min-width: 220px;
    background: var(--surface);
    color: var(--ink);
    border-radius: 14px;
    box-shadow: var(--shadow-2);
    padding: 6px;
    display: flex;
    flex-direction: column;
    z-index: 20;
  }

  .menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 9px;
    font-size: 14px;
    color: var(--ink);
    text-align: left;
    transition: background 120ms ease;
  }

  .menu button:hover {
    background: var(--surface-2);
  }

  .menu-sep {
    height: 1px;
    background: var(--line);
    margin: 5px 8px;
  }

  .menu-label {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 6px 12px 2px;
  }

  .theme-tabs {
    display: flex;
    gap: 2px;
    background: var(--surface-2);
    border-radius: 99px;
    padding: 3px;
    margin: 4px 8px 6px;
  }

  .theme-tabs button {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 7px 0;
    border-radius: 99px;
    color: var(--muted);
    transition: background 120ms ease, color 120ms ease;
  }

  .theme-tabs button:hover {
    color: var(--ink);
  }

  .theme-tabs button.active {
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-weight: 600;
  }

  .file-input {
    display: none;
  }

  /* ---- layout ---- */

  main {
    width: min(1160px, 100%);
    margin: 0 auto;
    padding: 0 32px 64px;
  }

  /* ---- duo: pie + timeline ---- */

  .duo {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    gap: 56px;
    padding: 48px 0;
  }

  @media (max-width: 860px) {
    .duo {
      grid-template-columns: 1fr;
      gap: 40px;
    }
  }

  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
  }

  .section-note {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .section-title {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .duo .section-head {
    margin-bottom: 24px;
  }

  @media (max-width: 640px) {
    main {
      padding: 0 16px 48px;
    }

    .topbar {
      padding: 12px 16px;
    }

    .duo {
      padding: 28px 0;
      gap: 32px;
    }

    .duo .section-head {
      margin-bottom: 16px;
    }

    .section-head {
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
    }

    .section-title {
      font-size: 18px;
    }
  }

  /* ---- admin modal ---- */

  .overlay {
    position: fixed;
    inset: 0;
    background: rgb(40 50 60 / 0.4);
    display: grid;
    place-items: center;
    padding: 20px;
    z-index: 10;
  }

  .admin-box {
    width: min(340px, 100%);
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: var(--shadow-2);
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .admin-box h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }

  .primary {
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
    border-radius: 99px;
    padding: 8px 18px;
    transition: background 120ms ease;
  }

  .primary:hover:not(:disabled) {
    background: var(--accent-strong);
  }

  .primary:disabled {
    opacity: 0.5;
  }

  .muted-btn {
    color: var(--muted);
    border-radius: 99px;
    padding: 8px 14px;
  }

  .muted-btn:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .danger-solid {
    background: var(--danger);
    color: var(--on-accent);
    font-weight: 600;
    border-radius: 99px;
    padding: 8px 18px;
    transition: background 120ms ease;
  }

  .danger-solid:hover {
    background: var(--danger-strong);
  }

  .confirm-body {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }
</style>
