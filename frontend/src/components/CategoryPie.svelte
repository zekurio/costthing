<script lang="ts">
  import { categoryColor, cents } from '../lib/format.ts'

  interface Slice {
    name: string
    monthlyCents: number
  }

  let { slices, fmt }: { slices: Slice[]; fmt: Intl.NumberFormat } = $props()

  const R = 80
  const CIRC = 2 * Math.PI * R
  const GAP = 3

  const total = $derived(slices.reduce((sum, s) => sum + s.monthlyCents, 0))

  const segments = $derived.by(() => {
    let offset = 0
    return slices
      .filter((s) => s.monthlyCents > 0)
      .map((s) => {
        const frac = total > 0 ? s.monthlyCents / total : 0
        const seg = {
          ...s,
          frac,
          len: Math.max(frac * CIRC - GAP, 0.5),
          offset,
          color: categoryColor(s.name),
        }
        offset += frac * CIRC
        return seg
      })
  })

  let active = $state<string | null>(null)

  const totalRounded = $derived(`${Math.round(total / 100).toLocaleString('de-DE')} €`)
</script>

<div class="pie-wrap">
  <svg viewBox="0 0 220 220" class="pie" role="img" aria-label="Kostenanteile pro Kategorie">
    <circle cx="110" cy="110" r={R} fill="none" stroke="var(--surface-2)" stroke-width="22" />
    {#each segments as seg (seg.name)}
      <circle
        cx="110"
        cy="110"
        r={R}
        fill="none"
        stroke={seg.color}
        stroke-width={active === seg.name ? 26 : 22}
        stroke-dasharray="{seg.len} {CIRC - seg.len}"
        stroke-dashoffset={-seg.offset}
        transform="rotate(-90 110 110)"
        class="seg"
        class:dimmed={active !== null && active !== seg.name}
        role="img"
        aria-label="{seg.name}: {cents(fmt, seg.monthlyCents)} ({Math.round(seg.frac * 100)} %)"
        onpointerenter={() => (active = seg.name)}
        onpointerleave={() => (active = null)}
      >
        <title>{seg.name}: {cents(fmt, seg.monthlyCents)} ({Math.round(seg.frac * 100)} %)</title>
      </circle>
    {/each}
    <text x="110" y="106" text-anchor="middle" class="center-value">{totalRounded}</text>
    <text x="110" y="128" text-anchor="middle" class="center-label">pro Monat</text>
  </svg>

  <ul class="legend">
    {#each segments as seg (seg.name)}
      <li
        class:dimmed={active !== null && active !== seg.name}
        onpointerenter={() => (active = seg.name)}
        onpointerleave={() => (active = null)}
      >
        <span class="dot" style:background={seg.color}></span>
        <span class="legend-name">{seg.name}</span>
        <span class="legend-amount">{cents(fmt, seg.monthlyCents)}</span>
        <span class="legend-pct">{Math.round(seg.frac * 100)} %</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .pie-wrap {
    display: flex;
    align-items: center;
    gap: 20px;
  }

  .pie {
    width: 170px;
    height: 170px;
    flex-shrink: 0;
  }

  .seg {
    transition: opacity 140ms ease, stroke-width 140ms ease;
    cursor: pointer;
  }

  .seg.dimmed {
    opacity: 0.3;
  }

  .center-value {
    fill: var(--ink);
    font-family: var(--font-ui);
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .center-label {
    fill: var(--muted);
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: 500;
  }

  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    min-width: 0;
    flex: 1;
  }

  .legend li {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto max-content;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    margin: 0 -10px;
    border-radius: 10px;
    font-size: 14px;
    cursor: default;
    transition: background 120ms ease, opacity 140ms ease;
  }

  .legend li:hover {
    background: var(--surface-2);
  }

  .legend li.dimmed {
    opacity: 0.45;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 99px;
    flex-shrink: 0;
  }

  .legend-amount {
    font-weight: 700;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .legend-pct {
    color: var(--muted);
    min-width: 44px;
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .legend-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 700px) {
    .pie-wrap {
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }

    .pie {
      width: 180px;
      height: 180px;
    }

    .legend {
      width: 100%;
      flex: none;
    }

    .legend li {
      font-size: 14px;
      padding: 8px 10px;
    }
  }
</style>
