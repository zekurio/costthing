<script lang="ts">
  import type { Coverage, TimelineEntry } from '../../../shared/types.ts'
  import { cents, signedCents } from '../lib/format.ts'

  let {
    timeline,
    coverage,
    fmt,
  }: { timeline: TimelineEntry[]; coverage: Coverage; fmt: Intl.NumberFormat } = $props()

  const W = 560
  const H = 240
  const PAD_L = 10
  const PAD_R = 10
  const PAD_TOP = 30
  const PAD_BOTTOM = 28
  const CHART_H = H - PAD_TOP - PAD_BOTTOM
  const INNER_W = W - PAD_L - PAD_R

  const nowMonth = new Date().toISOString().slice(0, 7)

  const n = $derived(timeline.length)

  // Keep the scale readable instead of using awkward raw values such as 38,84 €.
  function niceScaleMax(value: number): number {
    if (value <= 0) return 100
    const magnitude = 10 ** Math.floor(Math.log10(value))
    const normalized = value / magnitude
    const step = normalized <= 2 ? 0.5 : normalized <= 5 ? 1 : 2
    return Math.ceil(value / (step * magnitude)) * step * magnitude
  }

  const maxCents = $derived(
    niceScaleMax(Math.max(1, ...timeline.map((t) => Math.max(t.totalCents, t.donatedCents)))),
  )
  const exactNowIdx = $derived(timeline.findIndex((t) => t.month === nowMonth))
  const nowIdx = $derived.by(() => {
    if (exactNowIdx >= 0) return exactNowIdx
    const firstFuture = timeline.findIndex((t) => t.month > nowMonth)
    if (firstFuture === -1) return Math.max(0, n - 1)
    return Math.max(0, firstFuture - 1)
  })

  function x(i: number): number {
    return PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * INNER_W)
  }

  function y(v: number): number {
    return PAD_TOP + CHART_H * (1 - v / maxCents)
  }

  const pts = $derived(timeline.map((t, i) => ({ X: x(i), Y: y(t.totalCents) })))

  function toPath(points: { X: number; Y: number }[]): string {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.X.toFixed(1)} ${p.Y.toFixed(1)}`).join(' ')
  }

  const solidPath = $derived(toPath(pts.slice(0, nowIdx + 1)))
  const futurePath = $derived(toPath(pts.slice(nowIdx)))
  const areaPath = $derived(
    pts.length > 0
      ? `${solidPath} L ${x(nowIdx).toFixed(1)} ${y(0)} L ${x(0).toFixed(1)} ${y(0)} Z`
      : '',
  )

  // ---- donation curve: history + recurring-donation forecast ----

  const firstDonIdx = $derived(timeline.findIndex((t) => t.donatedCents > 0))
  const donActive = $derived(firstDonIdx !== -1)
  // Keep the zero-value history so the donation curve grows naturally from the
  // baseline instead of appearing halfway through the chart.
  const donPts = $derived(
    donActive ? timeline.map((t, i) => ({ X: x(i), Y: y(t.donatedCents) })) : [],
  )
  const donNowIdx = $derived(nowIdx)
  const donPath = $derived(toPath(donPts.slice(0, donNowIdx + 1)))
  const donFuturePath = $derived(toPath(donPts.slice(donNowIdx)))
  const donAreaPath = $derived(
    donPts.length > 0
      ? `${donPath} L ${donPts[donNowIdx]!.X.toFixed(1)} ${y(0)} L ${donPts[0]!.X.toFixed(1)} ${y(0)} Z`
      : '',
  )
  const donNow = $derived(donPts[donNowIdx] ?? null)

  // ---- current-month coverage ----

  const donPct = $derived(
    coverage.costCents > 0 ? Math.round((coverage.donatedCents / coverage.costCents) * 100) : null,
  )

  // ---- stock-style header: current value + deltas ----

  const current = $derived(coverage.costCents)
  const prev = $derived(exactNowIdx > 0 ? timeline[exactNowIdx - 1]?.totalCents : undefined)
  const yearAgo = $derived(exactNowIdx >= 12 ? timeline[exactNowIdx - 12]?.totalCents : undefined)

  // ---- hover ----

  let hover = $state<number | null>(null)

  function onMove(event: PointerEvent) {
    if (n === 0) return
    const svg = event.currentTarget as SVGSVGElement
    const rect = svg.getBoundingClientRect()
    const frac = (event.clientX - rect.left) / rect.width
    const i = Math.round(((frac * W - PAD_L) / INNER_W) * (n - 1))
    hover = Math.min(Math.max(i, 0), n - 1)
  }

  const hoverEntry = $derived(hover !== null ? timeline[hover] ?? null : null)
  const hoverPoint = $derived(hover !== null ? pts[hover] ?? null : null)
  const controlIndex = $derived(hover ?? (exactNowIdx >= 0 ? exactNowIdx : nowIdx))
  const controlEntry = $derived(timeline[controlIndex] ?? null)

  const hoverDonY = $derived.by(() => {
    if (hover === null || !donActive) return null
    const entry = timeline[hover]
    return entry ? y(entry.donatedCents) : null
  })

  // ---- ticks ----

  const labelEvery = $derived(Math.max(1, Math.ceil(n / 8)))

  function monthLabel(ym: string): string {
    const [y, m] = ym.split('-').map(Number)
    const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1))
    const month = d.toLocaleDateString('de-DE', { month: 'short', timeZone: 'UTC' })
    return `${month} ${String(y ?? 0).slice(2)}`
  }

  function deltaClass(delta: number): string {
    return delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
  }
</script>

<div class="summary-panel">
  <div class="cost-summary">
    <div>
      <span class="metric-label">Monatliche Kosten</span>
      <div class="stock-head">
        <span class="stock-value">{cents(fmt, current)}</span>
        <span class="stock-sub">Stand {monthLabel(nowMonth)}</span>
      </div>
    </div>
    <div class="deltas">
      {#if prev !== undefined}
        {@const d = current - prev}
        <span class="delta {deltaClass(d)}">
          {d > 0 ? '▲' : d < 0 ? '▼' : '＝'} {cents(fmt, Math.abs(d))}
          <small>zum Vormonat</small>
        </span>
      {/if}
      {#if yearAgo !== undefined}
        {@const d = current - yearAgo}
        <span class="delta {deltaClass(d)}">
          {d > 0 ? '▲' : d < 0 ? '▼' : '＝'} {cents(fmt, Math.abs(d))}
          <small>zum Vorjahr</small>
        </span>
      {/if}
    </div>
  </div>

  <div class="metric-grid">
    <div class="metric-card">
      <span class="metric-label">Spenden</span>
      <strong>{cents(fmt, coverage.donatedCents)}</strong>
      <span class="metric-detail">
        {donPct !== null ? `${donPct} % gedeckt` : 'keine Kosten'}
      </span>
    </div>
    <div class="metric-card" class:positive={coverage.balanceCents > 0} class:negative={coverage.balanceCents < 0}>
      <span class="metric-label">Monatsbilanz</span>
      <strong>{signedCents(fmt, coverage.balanceCents)}</strong>
      <span class="metric-detail">
        {coverage.balanceCents > 0
          ? 'Überschuss'
          : coverage.balanceCents < 0
            ? 'Fehlbetrag'
            : 'Ausgeglichen'} im {monthLabel(coverage.month)}
      </span>
    </div>
    <div
      class="metric-card total"
      class:positive={coverage.cumulativeBalanceCents > 0}
      class:negative={coverage.cumulativeBalanceCents < 0}
    >
      <span class="metric-label">Gesamtbilanz</span>
      <strong>{signedCents(fmt, coverage.cumulativeBalanceCents)}</strong>
      <span class="metric-detail">
        {coverage.cumulativeBalanceCents > 0
          ? 'Gesamtüberschuss'
          : coverage.cumulativeBalanceCents < 0
            ? 'Gesamtfehlbetrag'
            : 'Ausgeglichen'} seit der ersten Spende
      </span>
    </div>
  </div>
</div>

<div class="chart-wrap">
  <div class="legend" aria-hidden="true">
    <span><i class="swatch cost"></i>Kosten</span>
    <span><i class="swatch don"></i>Spenden</span>
  </div>
  <svg
    viewBox="0 0 {W} {H}"
    class="chart"
    role="img"
    aria-label="Monatskosten und Spenden im Verlauf"
    onpointermove={onMove}
    onpointerleave={() => (hover = null)}
  >
    <!-- gridlines -->
    {#each [0.5, 1] as f (f)}
      <line x1={PAD_L} x2={W - PAD_R} y1={y(maxCents * f)} y2={y(maxCents * f)} class="grid" />
      <text x={PAD_L + 2} y={y(maxCents * f) - 5} class="grid-label">{cents(fmt, maxCents * f)}</text>
    {/each}
    <line x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} class="axis" />
    {#if exactNowIdx >= 0 && pts[exactNowIdx]}
      {@const nowPoint = pts[exactNowIdx]}
      <line x1={nowPoint.X} x2={nowPoint.X} y1={PAD_TOP} y2={y(0)} class="now-line" />
    {/if}

    <path d={areaPath} class="area" />
    {#if donAreaPath}
      <path d={donAreaPath} class="area donation" />
    {/if}
    {#if donPath}
      <path d={donPath} class="line donation" />
    {/if}
    {#if donFuturePath}
      <path d={donFuturePath} class="line donation future" />
    {/if}
    <path d={futurePath} class="line future" />
    <path d={solidPath} class="line" />

    {#if exactNowIdx >= 0 && pts[exactNowIdx]}
      {@const nowPoint = pts[exactNowIdx]}
      <circle cx={nowPoint.X} cy={nowPoint.Y} r="3.5" class="now-dot" />
    {/if}
    {#if donNow}
      <circle cx={donNow.X} cy={donNow.Y} r="3.5" class="now-dot don" />
    {/if}

    {#each timeline as t, i (t.month)}
      {#if i % labelEvery === 0}
        <text
          x={x(i)}
          y={H - 8}
          text-anchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
          class="tick"
        >{monthLabel(t.month)}</text>
      {/if}
    {/each}

    {#if hoverPoint}
      <line x1={hoverPoint.X} x2={hoverPoint.X} y1={PAD_TOP - 8} y2={y(0)} class="crosshair" />
      <circle cx={hoverPoint.X} cy={hoverPoint.Y} r="4.5" class="hover-dot" />
      {#if hoverDonY !== null}
        <circle cx={hoverPoint.X} cy={hoverDonY} r="4" class="hover-dot don" />
      {/if}
    {/if}
  </svg>

  {#if n > 0}
    <input
      class="chart-control"
      type="range"
      min="0"
      max={n - 1}
      value={controlIndex}
      aria-label="Monat im Verlauf auswählen"
      aria-valuetext={controlEntry
        ? `${monthLabel(controlEntry.month)}: ${cents(fmt, controlEntry.totalCents)} Kosten, ${cents(fmt, controlEntry.donatedCents)} Spenden`
        : undefined}
      onfocus={() => (hover = exactNowIdx >= 0 ? exactNowIdx : nowIdx)}
      onblur={() => (hover = null)}
      oninput={(event) => (hover = Number(event.currentTarget.value))}
    />
  {/if}

  {#if hoverEntry && hoverPoint}
    <div
      class="tooltip"
      role="status"
      class:align-left={hoverPoint.X < W * 0.15}
      class:align-right={hoverPoint.X > W * 0.85}
      class:below={hoverPoint.Y < H * 0.25}
      style:left="{(hoverPoint.X / W) * 100}%"
      style:top="{(hoverPoint.Y / H) * 100}%"
    >
      <span class="tip-month">{monthLabel(hoverEntry.month)}</span>
      <span class="tip-row"><i class="swatch cost"></i>{cents(fmt, hoverEntry.totalCents)}</span>
      <span class="tip-row">
        <i class="swatch don"></i>{cents(fmt, hoverEntry.donatedCents)}
        {hoverEntry.month > nowMonth ? ' geplant' : ''}
      </span>
    </div>
  {/if}
</div>

<style>
  .summary-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-bottom: 18px;
  }

  .cost-summary {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 20px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--line);
  }

  .metric-label {
    display: block;
    margin-bottom: 5px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .stock-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }

  .stock-value {
    font-family: var(--font-display);
    font-size: 38px;
    font-weight: 700;
    letter-spacing: -0.035em;
    line-height: 1;
  }

  .stock-sub {
    color: var(--muted);
    font-size: 12px;
  }

  .deltas {
    display: flex;
    justify-content: flex-end;
    gap: 14px;
    font-size: 12px;
    flex-wrap: wrap;
  }

  .delta {
    display: flex;
    flex-direction: column;
    font-weight: 650;
    line-height: 1.25;
  }

  .delta small {
    color: var(--muted);
    font-size: 11px;
    font-weight: 400;
  }

  .delta.up {
    color: var(--danger-strong);
  }

  .delta.down {
    color: var(--ok-strong);
  }

  .delta.flat {
    color: var(--muted);
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .metric-card {
    min-width: 0;
    padding: 2px 18px;
  }

  .metric-card:first-child {
    padding-left: 0;
  }

  .metric-card + .metric-card {
    border-left: 1px solid var(--line);
  }

  .metric-card:last-child {
    padding-right: 0;
  }

  .metric-card strong {
    display: block;
    overflow: hidden;
    font-size: 17px;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .metric-card.positive strong {
    color: var(--ok-strong);
  }

  .metric-card.negative strong {
    color: var(--danger-strong);
  }

  .metric-detail {
    display: block;
    margin-top: 4px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.25;
  }

  @media (max-width: 640px) {
    .cost-summary {
      align-items: flex-start;
      flex-direction: column;
    }

    .deltas {
      justify-content: flex-start;
    }

    .metric-grid {
      grid-template-columns: 1fr;
    }

    .metric-card,
    .metric-card:first-child,
    .metric-card:last-child {
      padding: 10px 0;
    }

    .metric-card + .metric-card {
      border-top: 1px solid var(--line);
      border-left: 0;
    }

    .metric-card:first-child {
      padding-top: 0;
    }

    .metric-card:last-child {
      padding-bottom: 0;
    }

    .stock-value {
      font-size: 34px;
    }
  }

  .swatch {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 99px;
    flex-shrink: 0;
  }

  .swatch.cost {
    background: var(--accent);
  }

  .swatch.don {
    background: var(--ok);
  }

  /* ---- chart ---- */

  .chart-wrap {
    position: relative;
  }

  .legend {
    position: absolute;
    top: 0;
    right: 0;
    display: flex;
    gap: 14px;
    font-size: 12px;
    color: var(--muted);
  }

  .legend span {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .chart {
    width: 100%;
    height: auto;
    display: block;
    touch-action: pan-y;
  }

  .chart-control {
    width: 100%;
    height: 16px;
    margin: -2px 0 0;
    padding: 0;
    accent-color: var(--accent);
    background: transparent;
    border: 0;
    box-shadow: none;
  }

  .grid {
    stroke: var(--line);
    stroke-width: 1;
    stroke-dasharray: 2 4;
  }

  .grid-label {
    fill: var(--muted);
    font-size: 10px;
    opacity: 0.8;
  }

  .axis {
    stroke: var(--line);
    stroke-width: 1;
  }

  .now-line {
    stroke: var(--muted);
    stroke-width: 1;
    stroke-dasharray: 2 3;
    opacity: 0.35;
  }

  .area {
    fill: var(--accent);
    opacity: 0.14;
  }

  .area.donation {
    fill: var(--ok);
  }

  .line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2.5;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .line.future {
    stroke-dasharray: 4 5;
    opacity: 0.45;
  }

  .line.donation {
    stroke: var(--ok);
    stroke-width: 2;
  }

  .now-dot {
    fill: var(--accent);
    stroke: var(--surface);
    stroke-width: 2;
  }

  .now-dot.don {
    fill: var(--ok);
  }

  .crosshair {
    stroke: var(--muted);
    stroke-width: 1;
    stroke-dasharray: 2 3;
    opacity: 0.6;
  }

  .hover-dot {
    fill: var(--ink);
    stroke: var(--accent);
    stroke-width: 2;
  }

  .hover-dot.don {
    stroke: var(--ok);
  }

  .tick {
    fill: var(--muted);
    font-size: 11px;
  }

  .tooltip {
    position: absolute;
    transform: translate(-50%, -130%);
    background: var(--surface);
    box-shadow: var(--shadow-2);
    border-radius: 10px;
    padding: 7px 10px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    pointer-events: none;
    white-space: nowrap;
  }

  .tooltip.align-left {
    transform: translate(0, -130%);
  }

  .tooltip.align-right {
    transform: translate(-100%, -130%);
  }

  .tooltip.below {
    transform: translate(-50%, 20%);
  }

  .tooltip.align-left.below {
    transform: translate(0, 20%);
  }

  .tooltip.align-right.below {
    transform: translate(-100%, 20%);
  }

  .tip-month {
    color: var(--muted);
    font-size: 12px;
  }

  .tip-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
  }
</style>
