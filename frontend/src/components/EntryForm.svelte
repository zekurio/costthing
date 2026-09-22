<script lang="ts">
  import Dialog from './Dialog.svelte'
  import Select from './Select.svelte'
  import { categoryColor, categoryTextColor } from '../lib/format.ts'
  import { COST_ICONS } from '../lib/icons.ts'
  import type {
    Cadence,
    CostSaveInput,
    IncomeEntry,
    IncomeInput,
    IntervalUnit,
    PriceChange,
    SummaryPoint,
  } from '../../../shared/types.ts'

  interface Props {
    /** null = new entry; otherwise the entry being edited (tab is locked to its kind) */
    initial: SummaryPoint | IncomeEntry | null
    /** which tab to show first when adding a new entry */
    initialKind: 'cost' | 'income'
    categories: string[]
    /** category name → lucide icon name */
    categoryIcons: Record<string, string>
    onsaveCost: (input: CostSaveInput) => Promise<void>
    onsaveIncome: (input: IncomeInput) => Promise<void>
    onclose: () => void
  }

  let {
    initial,
    initialKind,
    categories,
    categoryIcons,
    onsaveCost,
    onsaveIncome,
    onclose,
  }: Props = $props()

  // The form is remounted for every open (it lives behind `{#if editing}`), so
  // capturing the props' initial values here is intentional — the fields seed
  // once and are then owned by the user.
  // svelte-ignore state_referenced_locally
  const initialCost = initial && 'costCents' in initial ? initial : null
  // svelte-ignore state_referenced_locally
  const initialIncome = initial && 'amountCents' in initial ? initial : null

  const today = new Date().toISOString().slice(0, 10)
  const currentMonth = today.slice(0, 7)

  // svelte-ignore state_referenced_locally
  let kind = $state<'cost' | 'income'>(initialKind)

  // shared
  // svelte-ignore state_referenced_locally
  let name = $state(initialCost?.name ?? '')
  let amount = $state(
    initialCost
      ? (initialCost.costCents / 100).toFixed(2)
      : initialIncome
        ? (initialIncome.amountCents / 100).toFixed(2)
        : '',
  )

  // cost-only
  let category = $state(initialCost?.category ?? '')
  // svelte-ignore state_referenced_locally
  let icon = $state<string | null>(
    initialCost ? categoryIcons[initialCost.category] ?? null : null,
  )

  // switching to an existing category pulls in its current icon; the picker
  // can still override it afterwards (the icon is saved per category)
  $effect(() => {
    const trimmed = category.trim()
    if (Object.prototype.hasOwnProperty.call(categoryIcons, trimmed)) {
      icon = categoryIcons[trimmed] ?? null
    }
    else icon = null
  })
  let cadence = $state<Cadence>(initialCost?.cadence ?? 'monthly')
  let startsOn = $state(initialCost?.startsOn ?? today)
  let endsOn = $state(initialCost?.endsOn ?? '')
  let amortizationMonths = $state(initialCost?.amortizationMonths ?? 60)
  let intervalCount = $state(initialCost?.intervalCount ?? 3)
  let intervalUnit = $state<IntervalUnit>(initialCost?.intervalUnit ?? 'months')

  // later amounts over time; the base Betrag above counts from Beginn
  interface PriceChangeRow {
    id: number
    startsOn: string
    amount: string
  }
  let nextRowId = 0
  let priceChanges = $state<PriceChangeRow[]>(
    initialCost?.priceChanges.map((change) => ({
      id: nextRowId++,
      startsOn: change.startsOn,
      amount: (change.costCents / 100).toFixed(2),
    })) ?? [],
  )

  function addPriceChange() {
    priceChanges.push({ id: nextRowId++, startsOn: '', amount: '' })
  }

  function removePriceChange(id: number) {
    priceChanges = priceChanges.filter((row) => row.id !== id)
  }

  // income-only
  let month = $state(initialIncome?.month ?? currentMonth)
  let note = $state(initialIncome?.note ?? '')

  const editorTitle = $derived(
    initial
      ? (kind === 'cost' ? 'Kostenpunkt bearbeiten' : 'Einnahme bearbeiten')
      : 'Eintrag hinzufügen',
  )

  let error = $state('')
  let busy = $state(false)

  function parseAmount(raw: string): number | null {
    const match = raw.trim().match(/^(\d+)(?:[.,](\d{1,2}))?$/)
    if (!match) return null
    const euros = Number(match[1])
    const fraction = (match[2] ?? '').padEnd(2, '0')
    const cents = euros * 100 + Number(fraction)
    return Number.isSafeInteger(cents) ? cents : null
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    const amountCents = parseAmount(amount)
    if (amountCents === null || (kind === 'income' && amountCents === 0)) {
      error =
        kind === 'income'
          ? 'Betrag muss eine positive Zahl sein, z. B. 5,00'
          : 'Betrag muss eine Zahl sein, z. B. 10,40'
      return
    }
    if (kind === 'cost') {
      if (endsOn && endsOn < startsOn) {
        error = 'Ende liegt vor dem Beginn.'
        return
      }
      if (cadence === 'one_time' && (!amortizationMonths || amortizationMonths < 1)) {
        error = 'Abschreibung muss mindestens 1 Monat sein.'
        return
      }
      if (cadence === 'custom' && (!intervalCount || intervalCount < 1)) {
        error = 'Das Intervall muss mindestens 1 sein.'
        return
      }
      if (cadence !== 'one_time') {
        const seenMonths = new Set<string>()
        for (const row of priceChanges) {
          const rowCents = parseAmount(row.amount)
          if (rowCents === null || !row.startsOn) {
            error = 'Jede Preisänderung braucht ein Datum und einen Betrag, z. B. 10,40.'
            return
          }
          const changeMonth = row.startsOn.slice(0, 7)
          if (changeMonth <= startsOn.slice(0, 7)) {
            error = 'Preisänderungen müssen in einem späteren Monat als der Beginn liegen.'
            return
          }
          if (seenMonths.has(changeMonth)) {
            error = 'Pro Monat ist nur eine Preisänderung möglich.'
            return
          }
          seenMonths.add(changeMonth)
        }
      }
    }
    busy = true
    error = ''
    try {
      if (kind === 'cost') {
        const parsedChanges: PriceChange[] = cadence === 'one_time'
          ? []
          : priceChanges.map((row) => ({
            startsOn: row.startsOn,
            costCents: parseAmount(row.amount) ?? 0,
          }))
        parsedChanges.sort((a, b) => a.startsOn.localeCompare(b.startsOn))
        await onsaveCost({
          name: name.trim(),
          category: category.trim(),
          icon,
          costCents: amountCents,
          priceChanges: parsedChanges,
          cadence,
          startsOn,
          endsOn: endsOn || null,
          amortizationMonths: cadence === 'one_time' ? amortizationMonths : null,
          intervalCount: cadence === 'custom' ? intervalCount : null,
          intervalUnit: cadence === 'custom' ? intervalUnit : null,
        })
      } else {
        await onsaveIncome({
          month,
          amountCents,
          note: note.trim() || null,
        })
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Speichern fehlgeschlagen.'
      busy = false
    }
  }
</script>

<Dialog title={editorTitle} {onclose} size="form">
  <form onsubmit={submit}>
    <div
        class="kind-toggle"
        role="group"
        aria-label="Eintragstyp"
        title={initial ? 'Typ kann beim Bearbeiten nicht geändert werden' : ''}
      >
        <button
          type="button"
          aria-pressed={kind === 'cost'}
          class:active={kind === 'cost'}
          disabled={initial !== null}
          onclick={() => (kind = 'cost')}
        >
          Kostenpunkt
        </button>
        <button
          type="button"
          aria-pressed={kind === 'income'}
          class:active={kind === 'income'}
          disabled={initial !== null}
          onclick={() => (kind = 'income')}
        >
          Einnahme
        </button>
      </div>

    {#if kind === 'cost'}
      <label>
        Name
      <input
        bind:value={name}
        required
        maxlength="200"
        placeholder="z. B. Mullvad VPN"
      />
      </label>
    {/if}

    {#if kind === 'cost'}
      <label>
        Kategorie
        <input bind:value={category} required maxlength="100" placeholder="Neue Kategorie eingeben…" />
      </label>
      {#if categories.length > 0}
        <div class="cat-chips-wrap">
          <span class="help">Bisherige Kategorien antippen — oder oben eine neue eingeben.</span>
          <div class="cat-chips">
            {#each categories as cat (cat)}
              <button
                type="button"
                class="cat-chip"
                class:active={category.trim() === cat}
                aria-pressed={category.trim() === cat}
                onclick={() => (category = cat)}
              >
                <span class="chip-dot" style:background={categoryColor(cat)}></span>
                {cat}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <div class="icon-picker">
        <span class="help">Kategorie-Icon (optional) — gilt für alle Posten dieser Kategorie; ohne Auswahl wird der Anfangsbuchstabe gezeigt.</span>
        <div class="icon-grid">
          <button
            type="button"
            class="icon-btn letter"
            class:active={icon === null}
            style:color={category.trim() ? categoryTextColor(category.trim()) : undefined}
            onclick={() => (icon = null)}
            title="kein Icon (Buchstabe)"
            aria-label="kein Icon, Anfangsbuchstabe verwenden"
            aria-pressed={icon === null}
          >
            {category.trim().charAt(0).toUpperCase() || 'A'}
          </button>
          {#each Object.entries(COST_ICONS) as [iconName, Icon] (iconName)}
            <button
              type="button"
              class="icon-btn"
              class:active={icon === iconName}
              onclick={() => (icon = iconName)}
              title={iconName}
              aria-label={`Icon ${iconName}`}
              aria-pressed={icon === iconName}
            >
              <Icon size={17} />
            </button>
          {/each}
        </div>
      </div>

      <div class="row">
        <label>
          Betrag
          <input bind:value={amount} required inputmode="decimal" placeholder="10,40" />
        </label>
        <label>
          Rhythmus
          <Select
            bind:value={cadence}
            options={[
              { value: 'monthly', label: 'monatlich' },
              { value: 'yearly', label: 'jährlich' },
              { value: 'one_time', label: 'einmalig' },
              { value: 'custom', label: 'eigenes Intervall' },
            ]}
          />
        </label>
      </div>

      <div class="row">
        <label>
          Beginn
          <input type="date" bind:value={startsOn} required />
        </label>
        <label>
          Ende (optional)
          <input type="date" bind:value={endsOn} />
        </label>
      </div>
      {#if endsOn}
        <span class="help">Gekündigt: zählt noch bis einschließlich dieses Monats, der Verlauf bleibt erhalten.</span>
      {/if}

      {#if cadence !== 'one_time'}
        <div class="price-changes">
          <span class="help">
            Preisänderungen (optional) — z. B. nach einem Anbieterwechsel: ab dem gewählten Monat
            gilt der neue Betrag, bis zur nächsten Änderung oder zum Ende. Der Betrag oben gilt ab
            Beginn.
          </span>
          {#each priceChanges as change (change.id)}
            <div class="change-row">
              <label>
                Gilt ab
                <input type="date" bind:value={change.startsOn} required />
              </label>
              <label>
                Neuer Betrag
                <input bind:value={change.amount} required inputmode="decimal" placeholder="12,00" />
              </label>
              <button
                type="button"
                class="change-remove"
                aria-label="Preisänderung entfernen"
                title="Preisänderung entfernen"
                onclick={() => removePriceChange(change.id)}
              >×</button>
            </div>
          {/each}
          <div>
            <button type="button" class="btn ghost change-add" onclick={addPriceChange}>
              + Preisänderung
            </button>
          </div>
        </div>
      {/if}

      {#if cadence === 'one_time'}
        <label>
          Abschreibung über (Monate)
          <input type="number" min="1" max="1200" bind:value={amortizationMonths} required />
          <span class="help">Verteilt die Kosten gleichmäßig über so viele Monate.</span>
        </label>
      {/if}

      {#if cadence === 'custom'}
        <div class="row">
          <label>
            Alle
            <input type="number" min="1" bind:value={intervalCount} required />
          </label>
          <label>
            Einheit
            <Select
              bind:value={intervalUnit}
              options={[
                { value: 'days', label: 'Tage' },
                { value: 'weeks', label: 'Wochen' },
                { value: 'months', label: 'Monate' },
                { value: 'years', label: 'Jahre' },
              ]}
            />
          </label>
        </div>
      {/if}
    {:else}
      <div class="row">
        <label>
          Betrag
          <input bind:value={amount} required inputmode="decimal" placeholder="5,00" />
        </label>
        <label>
          Monat
          <input type="month" bind:value={month} required />
        </label>
      </div>
      <label>
        Notiz (optional)
        <input bind:value={note} maxlength="500" placeholder="z. B. Überweisung" />
      </label>
    {/if}

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <div class="actions">
      <button type="button" class="btn ghost" onclick={onclose}>abbrechen</button>
      <button type="submit" class="btn primary" disabled={busy}>
        {busy ? 'speichere…' : 'speichern'}
      </button>
    </div>
  </form>
</Dialog>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .kind-toggle {
    display: flex;
    background: var(--surface-2);
    border-radius: 99px;
    padding: 3px;
    gap: 2px;
  }

  .kind-toggle button {
    flex: 1;
    padding: 8px 12px;
    font-size: 14px;
    color: var(--muted);
    border-radius: 99px;
    transition: background 120ms ease, color 120ms ease;
  }

  .kind-toggle button.active {
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-weight: 600;
  }

  .kind-toggle button:disabled {
    cursor: not-allowed;
  }

  .kind-toggle button:disabled:not(.active) {
    opacity: 0.45;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--muted);
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .help {
    font-size: 12px;
    color: var(--muted);
  }

  .price-changes {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .change-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: 12px;
    align-items: end;
  }

  .change-remove {
    width: 37px;
    height: 37px;
    display: grid;
    place-items: center;
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--muted);
    font-size: 16px;
    transition: background 120ms ease, color 120ms ease;
  }

  .change-remove:hover {
    color: var(--danger-strong);
    background: color-mix(in srgb, var(--danger) 14%, transparent);
  }

  .change-add {
    padding: 7px 14px;
    font-size: 13px;
  }

  .cat-chips-wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .cat-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .cat-chip {
    display: flex;
    align-items: center;
    gap: 7px;
    border: 1px solid var(--line);
    border-radius: 99px;
    padding: 6px 12px;
    font-size: 13px;
    color: var(--muted);
  }

  .cat-chip:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .cat-chip.active {
    border-color: var(--accent);
    color: var(--accent-strong);
    background: var(--accent-soft);
    font-weight: 600;
  }

  .chip-dot {
    width: 8px;
    height: 8px;
    border-radius: 99px;
  }

  .icon-picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .icon-grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 4px;
  }

  .icon-btn {
    width: 100%;
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--muted);
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }

  .icon-btn:hover {
    background: var(--surface-2);
    color: var(--ink);
  }

  .icon-btn.letter {
    font-weight: 700;
    font-size: 15px;
  }

  .icon-btn.active {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-strong);
  }

  .error {
    margin: 0;
    color: var(--danger-strong);
    font-size: 13px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 4px;
  }

  .primary {
    padding: 9px 20px;
  }

  .ghost {
    padding: 9px 16px;
  }

  @media (max-width: 420px) {
    .row {
      grid-template-columns: 1fr;
    }

    .icon-grid {
      grid-template-columns: repeat(6, minmax(0, 1fr));
    }
  }
</style>
