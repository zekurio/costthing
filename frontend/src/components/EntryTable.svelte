<script lang="ts">
  import HandHeart from 'lucide-svelte/icons/hand-heart'
  import Pencil from 'lucide-svelte/icons/pencil'
  import Scissors from 'lucide-svelte/icons/scissors'
  import X from 'lucide-svelte/icons/x'
  import type EntryFormComponent from './EntryForm.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import Select from './Select.svelte'
  import { api, ApiError } from '../lib/api.ts'
  import type { ConfirmAction, ConfirmDialogState } from '../lib/dialog.ts'
  import { costInput } from '../lib/entries.ts'
  import { costIcon } from '../lib/icons.ts'
  import {
    artLabel,
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
    IncomeEntry,
    IncomeInput,
    SummaryPoint,
  } from '../../../shared/types.ts'

  interface Props {
    points: SummaryPoint[]
    income: IncomeEntry[]
    categoryIcons: Record<string, string>
    coverage: Coverage
    fmt: Intl.NumberFormat
    admin: boolean
    onchanged: () => Promise<void>
    onadminerror: (err: unknown) => void
  }

  let {
    points,
    income,
    categoryIcons,
    coverage,
    fmt,
    admin,
    onchanged,
    onadminerror,
  }: Props = $props()

  type Entry = { kind: 'cost'; cost: SummaryPoint } | { kind: 'income'; income: IncomeEntry }

  let query = $state('')
  let filterType = $state<'all' | 'costs' | 'income'>('all')
  let filterCategory = $state('all')
  let filterCadence = $state<'all' | 'recurring' | 'one_time' | 'cancelled'>('all')
  let sortBy = $state<'date' | 'name' | 'amount'>('date')

  let editing = $state<Entry | 'new' | null>(null)
  let EntryForm = $state<typeof EntryFormComponent | null>(null)
  let operationError = $state('')
  let reloadNeeded = $state(false)

  async function openEditor(next: NonNullable<typeof editing>) {
    operationError = ''
    reloadNeeded = false
    editing = next
    try {
      EntryForm ??= (await import('./EntryForm.svelte')).default
    } catch {
      editing = null
      operationError = 'Editor konnte nach einer Aktualisierung nicht geladen werden.'
      reloadNeeded = true
    }
  }

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

  function incomeVisible(entry: IncomeEntry, q: string): boolean {
    // Category and cadence describe costs, so selecting either excludes income.
    if (filterType === 'all' && (filterCategory !== 'all' || filterCadence !== 'all')) return false
    if (q && !entry.note?.toLowerCase().includes(q)) return false
    return true
  }

  const visibleEntries = $derived.by<Entry[]>(() => {
    const q = query.trim().toLowerCase()
    let list: Entry[] = []
    if (filterType !== 'income') {
      for (const p of points) if (costVisible(p, q)) list.push({ kind: 'cost', cost: p })
    }
    if (filterType !== 'costs') {
      for (const entry of income) {
        if (incomeVisible(entry, q)) list.push({ kind: 'income', income: entry })
      }
    }
    const dateOf = (e: Entry) => (e.kind === 'cost' ? e.cost.startsOn : e.income.month)
    const nameOf = (e: Entry) => (e.kind === 'cost' ? e.cost.name : e.income.note ?? '')
    const amountOf = (e: Entry) => (e.kind === 'cost' ? e.cost.monthlyCents : e.income.amountCents)
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

  let confirmDialog = $state<ConfirmDialogState | null>(null)

  function reportOperationError(err: unknown) {
    reloadNeeded = false
    onadminerror(err)
    if (!(err instanceof ApiError && (err.status === 401 || err.status === 403))) {
      operationError = err instanceof Error ? err.message : 'Aktion fehlgeschlagen.'
    }
  }

  // ---- cost CRUD ----

  async function saveCost(input: CostSaveInput) {
    if (!admin || !editing) return
    try {
      if (editing !== 'new' && editing.kind === 'cost') {
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
    try {
      await api.update(point.id, {
        ...costInput(point),
        endsOn: new Date().toISOString().slice(0, 10),
      })
      await onchanged()
    } catch (err) {
      reportOperationError(err)
    }
  }

  async function doRemove(point: SummaryPoint) {
    if (!admin) return
    try {
      await api.remove(point.id)
      await onchanged()
    } catch (err) {
      reportOperationError(err)
    }
  }

  // ---- income CRUD ----

  async function saveIncome(input: IncomeInput) {
    if (!admin || !editing) return
    try {
      if (editing !== 'new' && editing.kind === 'income') {
        await api.updateIncome(editing.income.id, input)
      } else {
        await api.createIncome(input)
      }
      editing = null
      await onchanged()
    } catch (err) {
      onadminerror(err)
      throw err
    }
  }

  function askRemoveIncome(entry: IncomeEntry) {
    if (!admin) return
    confirmDialog = {
      title: 'Einnahme löschen?',
      body: `${cents(fmt, entry.amountCents)} für ${formatMonthYear(entry.month)} werden rückwirkend entfernt.`,
      actions: [
        { label: 'Endgültig löschen', kind: 'danger', run: () => void doRemoveIncome(entry) },
        { label: 'Abbrechen', kind: 'ghost', run: () => {} },
      ],
    }
  }

  async function doRemoveIncome(entry: IncomeEntry) {
    if (!admin) return
    try {
      await api.removeIncome(entry.id)
      await onchanged()
    } catch (err) {
      reportOperationError(err)
    }
  }

</script>

<section class="entries">
  <div class="section-head">
    <h2 class="section-title">Alle Einträge</h2>
    <div class="section-meta">
      <span class="muted">{visibleEntries.length} von {points.length + income.length}</span>
      {#if income.length > 0}
        <span class="muted" title="Einnahmen abzüglich Kosten seit der ersten erfassten Einnahme">
          Gesamtsaldo
          <span class={coverage.totalBalanceCents >= 0 ? 'ok' : 'deficit'}>
            {signedCents(fmt, coverage.totalBalanceCents)}
          </span>
        </span>
      {/if}
      {#if admin}
        <button class="add-entry" onclick={() => void openEditor('new')}>+ Eintrag hinzufügen</button>
      {/if}
    </div>
  </div>

  {#if operationError}
    <div class="operation-error" role="alert">
      <span>{operationError}</span>
      {#if reloadNeeded}
        <button class="reload" onclick={() => location.reload()}>neu laden</button>
      {/if}
      <button aria-label="Fehlermeldung schließen" onclick={() => (operationError = '')}>×</button>
    </div>
  {/if}

  <div class="filters">
    <input
      class="search"
      type="search"
      bind:value={query}
      placeholder="Einträge suchen…"
      aria-label="Einträge suchen"
    />
    <div class="type-filter" role="group" aria-label="Typ filtern">
      <button
        class:active={filterType === 'all'}
        aria-pressed={filterType === 'all'}
        onclick={() => (filterType = 'all')}
      >
        Alle
      </button>
      <button
        class:active={filterType === 'costs'}
        aria-pressed={filterType === 'costs'}
        onclick={() => (filterType = 'costs')}
      >
        Kosten
      </button>
      <button
        class:active={filterType === 'income'}
        aria-pressed={filterType === 'income'}
        onclick={() => (filterType = 'income')}
      >
        Einnahmen
      </button>
    </div>
    <Select
      bind:value={filterCategory}
      options={categoryOptions}
      disabled={filterType === 'income'}
      title={filterType === 'income' ? 'Kategorien gelten nur für Kosten' : ''}
      ariaLabel="Kategorie filtern"
    />
    <Select
      bind:value={filterCadence}
      options={[...cadenceOptions]}
      disabled={filterType === 'income'}
      title={filterType === 'income' ? 'Rhythmen gelten nur für Kosten' : ''}
      ariaLabel="Rhythmus filtern"
    />
    <Select bind:value={sortBy} options={[...sortOptions]} ariaLabel="Einträge sortieren" />
  </div>

  <div class="table-head table-grid" class:admin>
    <span>Posten</span>
    <span class="col-art">Art</span>
    <span class="col-date">Datum</span>
    <span>Betrag</span>
    {#if admin}<span></span>{/if}
  </div>

  <ul class="rows">
    {#each visibleEntries as e (e.kind === 'cost' ? `c${e.cost.id}` : `i${e.income.id}`)}
      {@const cancelled = e.kind === 'cost' && e.cost.endsOn !== null && e.cost.monthlyCents === 0}
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
                <button
                  onclick={() => askCancel(p)}
                  title="kündigen (Ende = heute)"
                  aria-label={`${p.name} kündigen`}
                >
                  <Scissors size={15} />
                </button>
              {/if}
              <button
                onclick={() => void openEditor({ kind: 'cost', cost: p })}
                title="bearbeiten"
                aria-label={`${p.name} bearbeiten`}
              >
                <Pencil size={15} />
              </button>
              <button
                class="danger"
                onclick={() => askRemove(p)}
                title="löschen"
                aria-label={`${p.name} löschen`}
              >
                <X size={16} />
              </button>
            </span>
          {/if}
        {:else}
          {@const entry = e.income}
          <div class="cell-posten">
            <span class="letter-tile income-tile">
              <HandHeart size={18} />
            </span>
            <div>
              <div class="row-name">{entry.note ?? 'Einnahme'}</div>
              <div class="row-cat muted">Einnahme</div>
            </div>
          </div>
          <span class="cell muted col-art">einmalig</span>
          <span class="cell muted col-date">{formatMonthYear(entry.month)}</span>
          <span class="cell row-amount">
            <span class="amount-main income-amount">{cents(fmt, entry.amountCents)}</span>
          </span>
          {#if admin}
            <span class="cell row-admin">
              <button
                onclick={() => void openEditor({ kind: 'income', income: entry })}
                title="bearbeiten"
                aria-label="Einnahme bearbeiten"
              >
                <Pencil size={15} />
              </button>
              <button
                class="danger"
                onclick={() => askRemoveIncome(entry)}
                title="löschen"
                aria-label="Einnahme löschen"
              >
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

{#if editing && EntryForm}
  <EntryForm
    initial={editing === 'new'
      ? null
      : editing.kind === 'cost'
        ? editing.cost
        : editing.income}
    initialKind={editing === 'new' ? 'cost' : editing.kind}
    categories={existingCategories}
    {categoryIcons}
    onsaveCost={saveCost}
    onsaveIncome={saveIncome}
    onclose={() => (editing = null)}
  />
{/if}

{#if confirmDialog}
  <ConfirmDialog
    title={confirmDialog.title}
    body={confirmDialog.body}
    actions={confirmDialog.actions}
    onclose={() => (confirmDialog = null)}
  />
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

  .income-tile {
    background: color-mix(in srgb, var(--ok) 18%, transparent);
    color: var(--ok-strong);
  }

  .row-name {
    font-weight: 700;
    font-size: 16px;
  }

  .row-cat {
    font-size: 13px;
    margin-top: 2px;
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

  .income-amount {
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

  .operation-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 12px;
    padding: 9px 12px;
    color: var(--danger-strong);
    background: color-mix(in srgb, var(--danger) 10%, var(--surface));
    border-radius: 10px;
    font-size: 13px;
  }

  .operation-error button {
    flex-shrink: 0;
    color: inherit;
    line-height: 1;
  }

  .operation-error .reload {
    margin-left: auto;
    font-size: 13px;
    font-weight: 600;
  }

  .operation-error button:last-child {
    font-size: 18px;
  }
</style>
