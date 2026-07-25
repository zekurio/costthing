<script lang="ts">
  import { Check, HandHeart, Pencil, Scissors, X } from 'lucide-svelte'
  import EntryForm from './EntryForm.svelte'
  import Select from './Select.svelte'
  import { api } from '../lib/api.ts'
  import { costIcon } from '../lib/icons.ts'
  import {
    artLabel,
    cadenceLabel,
    categoryColor,
    categoryTextColor,
    cents,
    formatDate,
    formatMonthYear,
    signedCents,
  } from '../lib/format.ts'
  import type {
    CostSaveInput,
    Coverage,
    Donation,
    DonationInput,
    KnownUser,
    SummaryPoint,
  } from '../../../shared/types.ts'

  interface Props {
    points: SummaryPoint[]
    donations: Donation[]
    categoryIcons: Record<string, string>
    coverage: Coverage
    fmt: Intl.NumberFormat
    admin: boolean
    /** admin only: Jellyfin users (incl. archived) for linking donations */
    knownUsers?: KnownUser[]
    /** logged-in user's name — prefills self-submitted donations */
    meName: string
    onchanged: () => Promise<void>
    onadminerror: (err: unknown) => void
  }

  let {
    points,
    donations,
    categoryIcons,
    coverage,
    fmt,
    admin,
    knownUsers = [],
    meName,
    onchanged,
    onadminerror,
  }: Props = $props()

  /** resolves a donation's linked Jellyfin user from the archive */
  function linkedUser(d: Donation): KnownUser | null {
    if (!d.userId) return null
    return knownUsers.find((u) => u.id === d.userId) ?? null
  }

  type Entry = { kind: 'cost'; cost: SummaryPoint } | { kind: 'donation'; donation: Donation }

  let query = $state('')
  let filterType = $state<'all' | 'costs' | 'donations'>('all')
  let filterCategory = $state('all')
  let filterCadence = $state<'all' | 'recurring' | 'one_time' | 'cancelled'>('all')
  let sortBy = $state<'date' | 'name' | 'amount'>('date')

  // 'submit' = non-admin reporting a donation for themselves (pending until confirmed)
  let editing = $state<Entry | 'new' | 'submit' | null>(null)

  const pendingCount = $derived(donations.filter((d) => d.status === 'pending').length)

  const existingCategories = $derived(
    [...new Set(points.map((p) => p.category))].sort((a, b) => a.localeCompare(b, 'de')),
  )

  const categoryOptions = $derived([
    { value: 'all', label: 'Alle Kategorien' },
    ...existingCategories.map((c) => ({ value: c, label: c })),
  ])

  const cadenceOptions = [
    { value: 'all', label: 'Alle Rhythmen' },
    { value: 'recurring', label: 'Laufend' },
    { value: 'one_time', label: 'Einmalig' },
    { value: 'cancelled', label: 'Beendet' },
  ] as const

  const sortOptions = [
    { value: 'date', label: 'Neueste zuerst' },
    { value: 'name', label: 'Name A–Z' },
    { value: 'amount', label: 'Betrag (absteigend)' },
  ] as const

  function costVisible(p: SummaryPoint, q: string): boolean {
    if (filterCategory !== 'all' && p.category !== filterCategory) return false
    if (filterCadence === 'one_time' && p.cadence !== 'one_time') return false
    if (filterCadence === 'recurring' && (p.cadence === 'one_time' || p.endsOn)) return false
    if (filterCadence === 'cancelled' && !p.endsOn) return false
    if (q && !`${p.name} ${p.category}`.toLowerCase().includes(q)) return false
    return true
  }

  function donationVisible(d: Donation, q: string): boolean {
    // category is cost-specific; cadence applies to both entry types
    if (filterType === 'all' && filterCategory !== 'all') return false
    if (filterCadence === 'one_time' && d.cadence !== 'one_time') return false
    if (filterCadence === 'recurring' && (d.cadence === 'one_time' || d.endsOn)) return false
    if (filterCadence === 'cancelled' && !d.endsOn) return false
    if (q && !d.name.toLowerCase().includes(q)) return false
    return true
  }

  const visibleEntries = $derived.by<Entry[]>(() => {
    const q = query.trim().toLowerCase()
    let list: Entry[] = []
    if (filterType !== 'donations') {
      for (const p of points) if (costVisible(p, q)) list.push({ kind: 'cost', cost: p })
    }
    if (filterType !== 'costs') {
      for (const d of donations) if (donationVisible(d, q)) list.push({ kind: 'donation', donation: d })
    }
    const dateOf = (e: Entry) => (e.kind === 'cost' ? e.cost.startsOn : e.donation.receivedOn)
    const nameOf = (e: Entry) => (e.kind === 'cost' ? e.cost.name : e.donation.name)
    const amountOf = (e: Entry) => (e.kind === 'cost' ? e.cost.monthlyCents : e.donation.amountCents)
    switch (sortBy) {
      case 'name':
        list = [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'de'))
        break
      case 'amount':
        list = [...list].sort((a, b) => amountOf(b) - amountOf(a))
        break
      default:
        list = [...list].sort(
          (a, b) => dateOf(b).localeCompare(dateOf(a)) || nameOf(a).localeCompare(nameOf(b), 'de'),
        )
    }
    return list
  })

  // ---- confirm dialog ----

  interface ConfirmAction {
    label: string
    kind: 'primary' | 'danger' | 'ghost'
    run: () => void
  }

  let confirmDialog = $state<{ title: string; body: string; actions: ConfirmAction[] } | null>(
    null,
  )

  // ---- cost CRUD ----

  async function saveCost(input: CostSaveInput) {
    if (!admin || !editing) return
    try {
      if (editing !== 'new' && editing !== 'submit' && editing.kind === 'cost') {
        await api.update(editing.cost.id, input)
      } else {
        await api.create(input)
      }
      editing = null
      await onchanged()
    } catch (err) {
      onadminerror(err)
      throw err
    }
  }

  function askCancel(point: SummaryPoint) {
    if (!admin) return
    confirmDialog = {
      title: `„${point.name}“ kündigen?`,
      body:
        `Ende = heute (${formatDate(new Date().toISOString().slice(0, 10))}). ` +
        'Der Posten zählt noch für den laufenden Monat und bleibt danach im Verlauf erhalten.',
      actions: [
        { label: 'Kündigen', kind: 'primary', run: () => void doCancel(point) },
        { label: 'Abbrechen', kind: 'ghost', run: () => {} },
      ],
    }
  }

  function askRemove(point: SummaryPoint) {
    if (!admin) return
    const stillActive = !point.endsOn && point.cadence !== 'one_time'
    const actions: ConfirmAction[] = []
    if (stillActive) {
      actions.push({
        label: 'Stattdessen kündigen',
        kind: 'primary',
        run: () => void doCancel(point),
      })
    }
    actions.push(
      { label: 'Endgültig löschen', kind: 'danger', run: () => void doRemove(point) },
      { label: 'Abbrechen', kind: 'ghost', run: () => {} },
    )
    confirmDialog = {
      title: `„${point.name}“ löschen?`,
      body: stillActive
        ? 'Der Posten läuft noch. Löschen entfernt ihn rückwirkend aus dem gesamten Verlauf – kündigen erhält die Historie.'
        : 'Löschen entfernt den Posten rückwirkend aus dem gesamten Verlauf. Das kann nicht rückgängig gemacht werden.',
      actions,
    }
  }

  async function doCancel(point: SummaryPoint) {
    if (!admin) return
    const { monthlyCents: _m, amortizationElapsedMonths: _a, ...input } = point
    try {
      await api.update(point.id, {
        ...input,
        endsOn: new Date().toISOString().slice(0, 10),
      })
      await onchanged()
    } catch (err) {
      onadminerror(err)
    }
  }

  async function doRemove(point: SummaryPoint) {
    if (!admin) return
    try {
      await api.remove(point.id)
      await onchanged()
    } catch (err) {
      onadminerror(err)
    }
  }

  // ---- donation CRUD ----

  async function saveDonation(input: DonationInput) {
    if (!editing) return
    try {
      if (editing === 'submit') {
        await api.submitDonation(input)
      } else if (editing !== 'new' && editing.kind === 'donation') {
        await api.updateDonation(editing.donation.id, input)
      } else {
        await api.createDonation(input)
      }
      editing = null
      await onchanged()
    } catch (err) {
      onadminerror(err)
      throw err
    }
  }

  async function confirmDonation(donation: Donation) {
    if (!admin) return
    try {
      await api.confirmDonation(donation.id)
      await onchanged()
    } catch (err) {
      onadminerror(err)
    }
  }

  function askRemoveDonation(donation: Donation) {
    if (!admin) return
    const stillActive = donation.cadence !== 'one_time' && !donation.endsOn
    const actions: ConfirmAction[] = []
    if (stillActive) {
      actions.push({
        label: 'Stattdessen beenden',
        kind: 'primary',
        run: () => void doCancelDonation(donation),
      })
    }
    actions.push(
      { label: 'Endgültig löschen', kind: 'danger', run: () => void doRemoveDonation(donation) },
      { label: 'Abbrechen', kind: 'ghost', run: () => {} },
    )
    confirmDialog = {
      title: 'Spende löschen?',
      body: stillActive
        ? `„${donation.name}“ läuft noch. Löschen entfernt die Spende rückwirkend aus dem gesamten Verlauf – beenden erhält die Historie.`
        : `„${donation.name}“ (${cents(fmt, donation.amountCents)}, ${formatDate(donation.receivedOn)}) wird rückwirkend entfernt.`,
      actions,
    }
  }

  function askCancelDonation(donation: Donation) {
    if (!admin) return
    confirmDialog = {
      title: `„${donation.name}“ beenden?`,
      body:
        `Ende = heute (${formatDate(new Date().toISOString().slice(0, 10))}). ` +
        'Die Spende zählt noch für den laufenden Monat und bleibt danach im Verlauf erhalten.',
      actions: [
        { label: 'Beenden', kind: 'primary', run: () => void doCancelDonation(donation) },
        { label: 'Abbrechen', kind: 'ghost', run: () => {} },
      ],
    }
  }

  async function doCancelDonation(donation: Donation) {
    if (!admin) return
    try {
      await api.updateDonation(donation.id, {
        ...donation,
        endsOn: new Date().toISOString().slice(0, 10),
      })
      await onchanged()
    } catch (err) {
      onadminerror(err)
    }
  }

  async function doRemoveDonation(donation: Donation) {
    if (!admin) return
    try {
      await api.removeDonation(donation.id)
      await onchanged()
    } catch (err) {
      onadminerror(err)
    }
  }

</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key !== 'Escape') return
    if (confirmDialog) confirmDialog = null
    else if (editing) editing = null
  }}
/>

<section class="entries">
  <div class="section-head">
    <h2 class="section-title">Alle Einträge</h2>
    <div class="section-meta">
      <span class="muted">{visibleEntries.length} von {points.length + donations.length}</span>
      {#if donations.length > 0}
        <span class="muted" title="aufsummierte Monatsbilanzen seit der ersten erfassten Spende">
          Gesamtsaldo
          <span class={coverage.cumulativeBalanceCents >= 0 ? 'ok' : 'deficit'}>
            {signedCents(fmt, coverage.cumulativeBalanceCents)}
          </span>
        </span>
      {/if}
      {#if admin && pendingCount > 0}
        <span class="pending-count" title="wartet auf Bestätigung">
          {pendingCount} ausstehend
        </span>
      {/if}
      {#if admin}
        <button class="add-entry" onclick={() => (editing = 'new')}>+ Eintrag hinzufügen</button>
      {:else}
        <button class="add-entry" onclick={() => (editing = 'submit')}>+ Spende melden</button>
      {/if}
    </div>
  </div>

  <div class="filters">
    <input class="search" type="search" bind:value={query} placeholder="Einträge suchen…" />
    <div class="type-filter" role="group" aria-label="Typ filtern">
      <button class:active={filterType === 'all'} onclick={() => (filterType = 'all')}>Alle</button>
      <button class:active={filterType === 'costs'} onclick={() => (filterType = 'costs')}>
        Kosten
      </button>
      <button class:active={filterType === 'donations'} onclick={() => (filterType = 'donations')}>
        Spenden
      </button>
    </div>
    <Select
      bind:value={filterCategory}
      options={categoryOptions}
      disabled={filterType === 'donations'}
      title={filterType === 'donations' ? 'Kategorien gelten nur für Kosten' : ''}
    />
    <Select bind:value={filterCadence} options={[...cadenceOptions]} />
    <Select bind:value={sortBy} options={[...sortOptions]} />
  </div>

  <div class="table-head table-grid" class:admin>
    <span>Posten</span>
    <span class="col-art">Art</span>
    <span class="col-date">Datum</span>
    <span>Betrag</span>
    {#if admin}<span></span>{/if}
  </div>

  <ul class="rows">
    {#each visibleEntries as e (e.kind === 'cost' ? `c${e.cost.id}` : `d${e.donation.id}`)}
      {@const cancelled = e.kind === 'cost'
        ? e.cost.endsOn !== null && e.cost.monthlyCents === 0
        : e.donation.endsOn !== null &&
          e.donation.endsOn.slice(0, 7) < new Date().toISOString().slice(0, 7)}
      <li class="table-grid row" class:admin class:cancelled>
        {#if e.kind === 'cost'}
          {@const p = e.cost}
          {@const Icon = costIcon(categoryIcons[p.category])}
          <div class="cell-posten">
            <span
              class="letter-tile"
              style:background="color-mix(in srgb, {categoryColor(p.category)} 28%, transparent)"
              style:color={categoryTextColor(p.category)}
            >
              {#if Icon}
                <Icon size={19} />
              {:else}
                {p.category.charAt(0).toUpperCase()}
              {/if}
            </span>
            <div>
              <div class="row-name">{p.name}</div>
              <div class="row-cat muted">{p.category}</div>
            </div>
          </div>
          <span class="cell muted col-art">
            {artLabel(p)}{p.endsOn ? ` · bis ${formatMonthYear(p.endsOn)}` : ''}
          </span>
          <span class="cell muted col-date">{formatMonthYear(p.startsOn)}</span>
          <span class="cell row-amount">
            {#if p.monthlyCents > 0}
              <span class="amount-main">{cents(fmt, p.monthlyCents)}</span>
              <span class="amount-sub muted">{cents(fmt, p.monthlyCents * 12)}/Jahr</span>
            {:else}
              –
            {/if}
          </span>
          {#if admin}
            <span class="cell row-admin">
              {#if !p.endsOn}
                <button onclick={() => askCancel(p)} title="kündigen (Ende = heute)">
                  <Scissors size={15} />
                </button>
              {/if}
              <button onclick={() => (editing = { kind: 'cost', cost: p })} title="bearbeiten">
                <Pencil size={15} />
              </button>
              <button class="danger" onclick={() => askRemove(p)} title="löschen">
                <X size={16} />
              </button>
            </span>
          {/if}
        {:else}
          {@const d = e.donation}
          <div class="cell-posten">
            <span class="letter-tile donation-tile" class:pending-tile={d.status === 'pending'}>
              <HandHeart size={18} />
            </span>
            <div>
              <div class="row-name">
                {d.name}
                {#if d.status === 'pending'}
                  <span class="pending-badge" title={d.submittedBy ? `gemeldet von ${d.submittedBy}` : 'wartet auf Bestätigung'}>ausstehend</span>
                {/if}
              </div>
              <div class="row-cat muted">
                Spende{d.status === 'pending' && d.submittedBy ? ` · von ${d.submittedBy}` : ''}
                {#if admin && linkedUser(d)}
                  {@const u = linkedUser(d)!}
                  <span
                    class="user-badge"
                    class:archived={u.archived}
                    title={u.archived
                      ? 'Jellyfin-Konto existiert nicht mehr — archiviert'
                      : 'verknüpftes Jellyfin-Konto'}
                  >
                    {u.name}{u.archived ? ' †' : ''}
                  </span>
                {/if}
              </div>
            </div>
          </div>
          <span class="cell muted col-art">
            {cadenceLabel({
              cadence: d.cadence,
              intervalCount: null,
              intervalUnit: null,
            })}{d.endsOn ? ` · bis ${formatMonthYear(d.endsOn)}` : ''}
          </span>
          <span class="cell muted col-date">{formatDate(d.receivedOn)}</span>
          <span class="cell row-amount">
            <span class="amount-main donation-amount">{cents(fmt, d.amountCents)}</span>
          </span>
          {#if admin}
            <span class="cell row-admin">
              {#if d.status === 'pending'}
                <button class="confirm" onclick={() => confirmDonation(d)} title="Spende bestätigen">
                  <Check size={16} />
                </button>
              {/if}
              {#if d.cadence !== 'one_time' && !d.endsOn}
                <button onclick={() => askCancelDonation(d)} title="beenden (Ende = heute)">
                  <Scissors size={15} />
                </button>
              {/if}
              <button onclick={() => (editing = { kind: 'donation', donation: d })} title="bearbeiten">
                <Pencil size={15} />
              </button>
              <button class="danger" onclick={() => askRemoveDonation(d)} title="löschen">
                <X size={16} />
              </button>
            </span>
          {/if}
        {/if}
      </li>
    {:else}
      <li class="empty muted">Keine Einträge gefunden.</li>
    {/each}
  </ul>
</section>

{#if editing}
  <EntryForm
    initial={editing === 'new' || editing === 'submit'
      ? null
      : editing.kind === 'cost'
        ? editing.cost
        : editing.donation}
    initialKind={editing === 'new' ? 'cost' : editing === 'submit' ? 'donation' : editing.kind}
    donorOnly={editing === 'submit'}
    defaultName={editing === 'submit' ? meName : ''}
    {knownUsers}
    categories={existingCategories}
    {categoryIcons}
    onsaveCost={saveCost}
    onsaveDonation={saveDonation}
    onclose={() => (editing = null)}
  />
{/if}

{#if confirmDialog}
  <div
    class="overlay"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && (confirmDialog = null)}
  >
    <div class="admin-box confirm-box">
      <h2>{confirmDialog.title}</h2>
      <p class="confirm-body">{confirmDialog.body}</p>
      <div class="actions">
        {#each confirmDialog.actions as action (action.label)}
          <button
            class={action.kind === 'danger' ? 'danger-solid' : action.kind === 'ghost' ? 'muted-btn' : 'primary'}
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

<style>

  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    row-gap: 10px;
  }

  .section-title {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .section-meta {
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 14px;
    flex-wrap: wrap;
    row-gap: 10px;
  }

  .ok {
    color: var(--ok-strong);
    font-weight: 600;
  }

  .deficit {
    color: var(--danger-strong);
    font-weight: 600;
  }

  .add-entry {
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
    font-size: 14px;
    border-radius: 99px;
    padding: 9px 18px;
    transition: background 120ms ease;
  }

  .add-entry:hover {
    background: var(--accent-strong);
  }

  .pending-count {
    font-size: 12px;
    font-weight: 600;
    color: var(--warn-strong, #a16207);
    background: color-mix(in srgb, var(--warn, #eab308) 16%, transparent);
    border-radius: 99px;
    padding: 4px 12px;
  }

  /* ---- filters ---- */

  .filters {
    display: grid;
    grid-template-columns: 2fr auto 1fr 1fr 1fr;
    gap: 10px;
    margin: 14px 0 6px;
    align-items: center;
  }

  .type-filter {
    display: flex;
    background: var(--surface-2);
    border-radius: 99px;
    padding: 3px;
    gap: 2px;
  }

  .type-filter button {
    padding: 6px 14px;
    font-size: 14px;
    color: var(--muted);
    white-space: nowrap;
    border-radius: 99px;
    transition: background 120ms ease, color 120ms ease;
  }

  .type-filter button.active {
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-weight: 600;
  }

  @media (max-width: 960px) {
    .filters {
      grid-template-columns: 1fr 1fr;
    }

    .search {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 640px) {
    .filters {
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 14px 0 6px;
    }

    .search,
    .type-filter {
      grid-column: 1 / -1;
    }

    .filters > :global(.select:last-child) {
      grid-column: 1 / -1;
    }

    .type-filter button {
      flex: 1;
      padding: 8px 6px;
    }
  }

  /* ---- table ---- */

  .table-grid {
    display: grid;
    grid-template-columns: minmax(200px, 2.2fr) 1.1fr 0.9fr 0.9fr;
    gap: 16px;
    align-items: center;
  }

  .table-grid.admin {
    grid-template-columns: minmax(200px, 2.2fr) 1.1fr 0.9fr 0.9fr 88px;
  }

  .table-head {
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row {
    padding: 11px 0;
  }

  .row + .row {
    border-top: 1px solid var(--line);
  }

  .row.cancelled {
    opacity: 0.45;
  }

  .cell-posten {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }

  .letter-tile {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    font-weight: 700;
    font-size: 16px;
    flex-shrink: 0;
  }

  .donation-tile {
    background: color-mix(in srgb, var(--ok) 18%, transparent);
    color: var(--ok-strong);
  }

  .pending-tile {
    background: color-mix(in srgb, var(--warn, #eab308) 18%, transparent);
    color: var(--warn-strong, #a16207);
  }

  .pending-badge {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--warn-strong, #a16207);
    background: color-mix(in srgb, var(--warn, #eab308) 16%, transparent);
    border-radius: 99px;
    padding: 2px 8px;
    margin-left: 6px;
    vertical-align: middle;
  }

  .row-name {
    font-weight: 700;
    font-size: 16px;
  }

  .row-cat {
    font-size: 13px;
    margin-top: 2px;
  }

  .user-badge {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent-strong);
    background: var(--accent-soft);
    border-radius: 99px;
    padding: 2px 8px;
    margin-left: 4px;
    vertical-align: middle;
  }

  .user-badge.archived {
    color: var(--muted);
    background: var(--surface-2);
  }

  .cell {
    font-size: 14px;
  }

  .row-amount {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .amount-main {
    font-weight: 700;
    font-size: 16px;
  }

  .amount-sub {
    font-size: 12px;
  }

  .donation-amount {
    color: var(--ok-strong);
  }

  .row-admin {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
  }

  .row-admin button {
    color: var(--muted);
    padding: 5px 6px;
    border-radius: 6px;
    display: grid;
    place-items: center;
  }

  .row-admin button:hover {
    color: var(--accent-strong);
    background: var(--accent-soft);
  }

  .row-admin .danger:hover {
    color: var(--danger-strong);
    background: color-mix(in srgb, var(--danger) 14%, transparent);
  }

  .row-admin .confirm:hover {
    color: var(--ok-strong);
    background: color-mix(in srgb, var(--ok) 16%, transparent);
  }

  .empty {
    padding: 20px 0;
  }

  @media (max-width: 860px) {
    .col-art,
    .col-date {
      display: none;
    }

    .table-grid {
      grid-template-columns: minmax(0, 1.6fr) auto;
    }

    .table-grid.admin {
      grid-template-columns: minmax(0, 1.6fr) auto max-content;
    }
  }

  @media (max-width: 640px) {
    /* two-column rows: name left, amount right; admin actions get their own line */
    .table-grid,
    .table-grid.admin {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 4px 12px;
    }

    .table-head {
      padding: 12px 0;
    }

    .table-head span:empty {
      display: none;
    }

    .table-head span + span {
      text-align: right;
    }

    .row {
      padding: 14px 0;
    }

    .cell-posten {
      gap: 12px;
    }

    .letter-tile {
      width: 36px;
      height: 36px;
    }

    .row-name {
      font-size: 15px;
    }

    .amount-main {
      font-size: 15px;
    }

    .row-amount {
      align-items: flex-end;
      text-align: right;
    }

    .row-admin {
      grid-column: 1 / -1;
      margin-top: 6px;
      gap: 8px;
    }

    .row-admin button {
      padding: 7px 14px;
      background: var(--surface-2);
      border-radius: 8px;
    }

    .section-head {
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
    }

    .section-meta {
      justify-content: space-between;
    }

    .add-entry {
      flex-basis: 100%;
      padding: 12px 18px;
      text-align: center;
    }
  }

  /* ---- confirm dialog ---- */

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
    width: min(400px, 100%);
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

  .confirm-body {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
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

  .primary:hover {
    background: var(--accent-strong);
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
</style>
