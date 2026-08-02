import Bell from 'lucide-svelte/icons/bell'
import Clapperboard from 'lucide-svelte/icons/clapperboard'
import Cloud from 'lucide-svelte/icons/cloud'
import Cpu from 'lucide-svelte/icons/cpu'
import CreditCard from 'lucide-svelte/icons/credit-card'
import Database from 'lucide-svelte/icons/database'
import Fan from 'lucide-svelte/icons/fan'
import Film from 'lucide-svelte/icons/film'
import Gamepad2 from 'lucide-svelte/icons/gamepad-2'
import Globe from 'lucide-svelte/icons/globe'
import HardDrive from 'lucide-svelte/icons/hard-drive'
import KeyRound from 'lucide-svelte/icons/key-round'
import Lock from 'lucide-svelte/icons/lock'
import Mail from 'lucide-svelte/icons/mail'
import MemoryStick from 'lucide-svelte/icons/memory-stick'
import Monitor from 'lucide-svelte/icons/monitor'
import Music from 'lucide-svelte/icons/music'
import Package from 'lucide-svelte/icons/package'
import Plug from 'lucide-svelte/icons/plug'
import Receipt from 'lucide-svelte/icons/receipt'
import Router from 'lucide-svelte/icons/router'
import Server from 'lucide-svelte/icons/server'
import Shield from 'lucide-svelte/icons/shield'
import Tv from 'lucide-svelte/icons/tv'
import Wifi from 'lucide-svelte/icons/wifi'
import Wrench from 'lucide-svelte/icons/wrench'
import Zap from 'lucide-svelte/icons/zap'

/**
 * Curated lucide icons selectable per cost entry. Keys are stored in the
 * data file, so renaming a key orphans existing entries — add, don't rename.
 */
export const COST_ICONS = {
  server: Server,
  'hard-drive': HardDrive,
  cpu: Cpu,
  'memory-stick': MemoryStick,
  zap: Zap,
  plug: Plug,
  fan: Fan,
  globe: Globe,
  cloud: Cloud,
  wifi: Wifi,
  router: Router,
  shield: Shield,
  lock: Lock,
  key: KeyRound,
  database: Database,
  monitor: Monitor,
  tv: Tv,
  film: Film,
  clapperboard: Clapperboard,
  music: Music,
  gamepad: Gamepad2,
  wrench: Wrench,
  package: Package,
  'credit-card': CreditCard,
  receipt: Receipt,
  mail: Mail,
  bell: Bell,
} as const

export type CostIconName = keyof typeof COST_ICONS

export type CostIcon = (typeof COST_ICONS)[CostIconName]

export function costIcon(name: string | null | undefined): CostIcon | null {
  if (!name) return null
  return name in COST_ICONS ? COST_ICONS[name as CostIconName] : null
}
