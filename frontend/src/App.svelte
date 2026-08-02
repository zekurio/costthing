<script lang="ts">
  import { onMount } from 'svelte'
  import CircleUserRound from 'lucide-svelte/icons/circle-user-round'
  import Download from 'lucide-svelte/icons/download'
  import LogOut from 'lucide-svelte/icons/log-out'
  import Monitor from 'lucide-svelte/icons/monitor'
  import Moon from 'lucide-svelte/icons/moon'
  import ShieldCheck from 'lucide-svelte/icons/shield-check'
  import Sun from 'lucide-svelte/icons/sun'
  import Upload from 'lucide-svelte/icons/upload'
  import CategoryPie from './components/CategoryPie.svelte'
  import ConfirmDialog from './components/ConfirmDialog.svelte'
  import EntryTable from './components/EntryTable.svelte'
  import Gate from './components/Gate.svelte'
  import TimelineChart from './components/TimelineChart.svelte'
  import { api, ApiError } from './lib/api.ts'
  import type { ConfirmDialogState } from './lib/dialog.ts'
  import { cents, moneyFormatter } from './lib/format.ts'
  import type { KnownUser, Me, Summary, SummaryPoint } from '../../shared/types.ts'

  let view = $state<'loading' | 'gate' | 'ready' | 'error'>('loading')
  let summary = $state<Summary | null>(null)
  let me = $state<Me | null>(null)
  /** admin only: Jellyfin users (incl. archived) for linking donations */
  let knownUsers = $state<KnownUser[]>([])
  let loadError = $state('')

  // ---- theme ----

  type ThemePref = 'light' | 'dark' | 'system'

  function savedTheme(): string | null {
    try {
      return localStorage.getItem('costthing.theme')
    } catch {
      return null
    }
  }

  const storedTheme = savedTheme()
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
    try {
      if (themePref === 'system') localStorage.removeItem('costthing.theme')
      else localStorage.setItem('costthing.theme', themePref)
    } catch {
      // Theme persistence is optional when browser storage is unavailable.
    }
  })

  // ---- user menu ----

  let menuOpen = $state(false)
  let menuEl = $state<HTMLElement>()
  /** measured topbar height — keeps the sticky stats column from shifting on scroll */
  let topbarHeight = $state(55)
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

  let loadVersion = 0

  async function load() {
    const version = ++loadVersion
    const keepReady = view === 'ready' && summary !== null && me !== null
    if (!keepReady) view = 'loading'
    loadError = ''

    try {
      const [nextSummary, nextMe] = await Promise.all([api.summary(), api.me()])
      if (version !== loadVersion) return
      summary = nextSummary
      me = nextMe
      if (nextMe.isAdmin) {
        // Best effort: keep an already loaded archive during a transient failure.
        try {
          const users = await api.users()
          if (version !== loadVersion) return
          knownUsers = users
        } catch (err) {
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err
        }
      } else {
        knownUsers = []
      }
      view = 'ready'
    } catch (err) {
      if (version !== loadVersion) return
      if (err instanceof ApiError && err.status === 401) {
        summary = null
        me = null
        knownUsers = []
        menuOpen = false
        view = 'gate'
      } else {
        loadError = err instanceof ApiError && err.status === 503
          ? 'Jellyfin ist gerade nicht erreichbar. Deine Sitzung bleibt erhalten.'
          : err instanceof Error
            ? err.message
            : 'Laden fehlgeschlagen'
        if (!keepReady) view = 'error'
      }
    }
  }

  onMount(load)

  function handleAdminError(err: unknown) {
    // Session expired or admin rights revoked — re-sync with the server.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) void load()
  }

  async function logout() {
    loadError = ''
    try {
      await api.logout()
      loadVersion++
      summary = null
      me = null
      knownUsers = []
      menuOpen = false
      view = 'gate'
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Abmelden fehlgeschlagen'
    }
  }

  // ---- admin import/export ----

  let confirmDialog = $state<ConfirmDialogState | null>(null)

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
      handleAdminError(err)
      if (!(err instanceof ApiError && (err.status === 401 || err.status === 403))) {
        loadError = err instanceof Error ? err.message : 'Export fehlgeschlagen.'
      }
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
    if (e.key === 'Escape' && menuOpen) menuOpen = false
  }}
  onpointerdown={(e) => {
    if (menuOpen && menuEl && !menuEl.contains(e.target as Node)) menuOpen = false
  }}
/>

{#if view === 'loading'}
  <div class="center muted" role="status">lädt…</div>
{:else if view === 'gate'}
  <Gate onunlock={load} />
{:else if view === 'error'}
  <div class="center load-error" role="alert">
    <p>{loadError}</p>
    <button class="btn primary" onclick={load}>erneut versuchen</button>
  </div>
{:else if summary}
  <nav class="topbar" bind:offsetHeight={topbarHeight}>
    <div class="brand">
      <img class="tile" src="/icon.svg" alt="" aria-hidden="true" />
      <h1 class="brand-name">costthing</h1>
    </div>
    <div class="user-menu" bind:this={menuEl}>
      <button
        class="avatar-btn"
        aria-expanded={menuOpen}
        aria-controls="user-menu-panel"
        aria-label="Benutzermenü öffnen"
        title="Menü"
        onclick={() => (menuOpen = !menuOpen)}
      >
        {#if me?.hasAvatar}
          <img class="avatar-img" src="/api/me/avatar" alt={me.name} />
        {:else}
          <CircleUserRound size={22} />
        {/if}
      </button>

      {#if menuOpen}
        <div class="menu" id="user-menu-panel" aria-label="Benutzermenü">
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
              aria-pressed={themePref === 'light'}
            >
              <Sun size={16} />
            </button>
            <button
              class:active={themePref === 'system'}
              onclick={() => (themePref = 'system')}
              title="Systemeinstellung folgen"
              aria-label="Design der Systemeinstellung folgen"
              aria-pressed={themePref === 'system'}
            >
              <Monitor size={16} />
            </button>
            <button
              class:active={themePref === 'dark'}
              onclick={() => (themePref = 'dark')}
              title="Dunkel"
              aria-label="Dunkles Design"
              aria-pressed={themePref === 'dark'}
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
            <button onclick={() => importInput?.click()}>
              <Upload size={16} /> JSON importieren
            </button>
            <button onclick={downloadExport}>
              <Download size={16} /> JSON exportieren
            </button>
            <div class="menu-sep"></div>
          {/if}

          <button onclick={logout}>
            <LogOut size={16} /> Abmelden
          </button>
        </div>
      {/if}
    </div>
  </nav>

  <main>
    {#if loadError}
      <div class="load-banner" role="alert">
        <span>{loadError}</span>
        <button onclick={load}>erneut versuchen</button>
      </div>
    {/if}
    <div class="layout">
      <div class="entries-col">
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
      </div>

      <aside class="stats-col" style:--topbar-h="{topbarHeight}px">
        <section class="stat-block">
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
        </section>
        <section class="stat-block">
          <div class="section-head">
            <h2 class="section-title">Kosten &amp; Spenden</h2>
            <p class="section-note">gesamt + 12 Monate Prognose</p>
          </div>
          <TimelineChart timeline={summary.timeline} coverage={summary.coverage} {fmt} />
        </section>
      </aside>
    </div>
  </main>

  {#if confirmDialog}
    <ConfirmDialog
      title={confirmDialog.title}
      body={confirmDialog.body}
      actions={confirmDialog.actions}
      onclose={() => (confirmDialog = null)}
    />
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
    padding: 10px 24px;
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
    gap: 10px;
  }

  .tile {
    width: 30px;
    height: 30px;
    display: block;
    border-radius: 8px;
    background: var(--topbar-tile);
  }

  .brand-name {
    margin: 0;
    font-weight: 700;
    font-size: 16px;
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
    width: 34px;
    height: 34px;
    border-radius: 99px;
    color: var(--on-topbar);
    transition: background 120ms ease;
  }

  .avatar-btn:hover,
  .avatar-btn[aria-expanded='true'] {
    background: var(--topbar-hover);
  }

  .avatar-img {
    width: 28px;
    height: 28px;
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
    width: min(1560px, 100%);
    margin: 0 auto;
    padding: 0 32px 40px;
  }

  /* ---- layout: entries list + stats column ---- */

  .layout {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 40px;
    align-items: start;
    padding: 20px 0;
  }

  .entries-col {
    min-width: 0;
  }

  .stats-col {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 28px;
    position: sticky;
    /* topbar + .layout top padding = natural resting position, so pinning is seamless */
    top: calc(var(--topbar-h, 55px) + 20px);
  }

  @media (max-width: 1100px) {
    .layout {
      grid-template-columns: 1fr;
      gap: 28px;
    }

    /* stats above the list when stacked, matching the old order */
    .stats-col {
      order: -1;
      position: static;
    }

    .entries-col {
      border-top: 1px solid var(--line);
      padding-top: 24px;
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

  .stat-block .section-head {
    margin-bottom: 14px;
  }

  @media (max-width: 640px) {
    main {
      padding: 0 16px 40px;
    }

    .topbar {
      padding: 8px 16px;
    }

    .layout {
      padding: 16px 0;
      gap: 24px;
    }

    .stats-col {
      gap: 24px;
    }

    .stat-block .section-head {
      margin-bottom: 10px;
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

  .load-error {
    align-content: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
  }

  .load-error p {
    margin: 0;
    color: var(--danger-strong);
  }

  .load-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 16px;
    padding: 10px 14px;
    color: var(--danger-strong);
    background: color-mix(in srgb, var(--danger) 10%, var(--surface));
    border-radius: 10px;
    font-size: 14px;
  }

  .load-banner button {
    flex-shrink: 0;
    color: inherit;
    font-weight: 600;
  }
</style>
