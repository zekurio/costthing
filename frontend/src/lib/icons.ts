import {
  Bell,
  Clapperboard,
  Cloud,
  Cpu,
  CreditCard,
  Database,
  Fan,
  Film,
  Gamepad2,
  Globe,
  HardDrive,
  KeyRound,
  Lock,
  Mail,
  MemoryStick,
  Monitor,
  Music,
  Package,
  Plug,
  Receipt,
  Router,
  Server,
  Shield,
  Tv,
  Wifi,
  Wrench,
  Zap,
} from 'lucide-svelte'

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
