import type { Cadence, IntervalUnit } from '../../../shared/types.ts'

export function moneyFormatter(currency: string): Intl.NumberFormat {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency })
}

export function cents(fmt: Intl.NumberFormat, value: number): string {
  return fmt.format(value / 100)
}

/** like cents(), but always carries a sign: "+12,00 €" / "−4,50 €" */
export function signedCents(fmt: Intl.NumberFormat, value: number): string {
  const sign = value < 0 ? '−' : '+'
  return `${sign}${fmt.format(Math.abs(value) / 100)}`
}

const UNITS: Record<IntervalUnit, [string, string]> = {
  days: ['Tag', 'Tage'],
  weeks: ['Woche', 'Wochen'],
  months: ['Monat', 'Monate'],
  years: ['Jahr', 'Jahre'],
}

export function cadenceLabel(p: {
  cadence: Cadence
  intervalCount: number | null
  intervalUnit: IntervalUnit | null
}): string {
  switch (p.cadence) {
    case 'one_time':
      return 'einmalig'
    case 'monthly':
      return 'monatlich'
    case 'yearly':
      return 'jährlich'
    case 'custom': {
      const n = p.intervalCount ?? 1
      const [singular, plural] = UNITS[p.intervalUnit ?? 'months']
      return n === 1 ? `jeden ${singular}` : `alle ${n} ${plural}`
    }
  }
}

/**
 * Pastel category hues across the full wheel, stable per name.
 * Soft saturation/lightness so slices and chips stay gentle on the light theme.
 */
export function categoryColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  const hue = (Math.abs(hash) % 12) * 30
  return `hsl(${hue} 60% 74%)`
}

/**
 * Companion of categoryColor() for text/icons on tinted tiles: darker than
 * the pastel on the light theme, lighter on the dark theme (via light-dark(),
 * driven by the color-scheme each theme sets).
 */
export function categoryTextColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  const hue = (Math.abs(hash) % 12) * 30
  return `light-dark(hsl(${hue} 45% 40%), hsl(${hue} 65% 78%))`
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).toLocaleDateString('de-DE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function formatMonthYear(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)).toLocaleDateString('de-DE', {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
}

/** "ART" column: e.g. "60 Mon. amortisiert", "Monatlich", "Jährlich" */
export function artLabel(p: {
  cadence: Cadence
  amortizationMonths: number | null
  intervalCount: number | null
  intervalUnit: IntervalUnit | null
}): string {
  if (p.cadence === 'one_time') {
    return p.amortizationMonths ? `${p.amortizationMonths} Mon. amortisiert` : 'Einmalig'
  }
  if (p.cadence === 'monthly') return 'Monatlich'
  if (p.cadence === 'yearly') return 'Jährlich'
  return cadenceLabel(p)
}
