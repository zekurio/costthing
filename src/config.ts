import { type StaticDecode, Type } from '@sinclair/typebox'
import { decode } from './validation.ts'

const PortSchema = Type.Transform(Type.String({ pattern: '^\\d+$' }))
  .Decode((value) => Number(value))
  .Encode((value) => String(value))

const EnvironmentSchema = Type.Object({
  PORT: Type.Optional(PortSchema),
  JELLYFIN_URL: Type.Optional(Type.String({ pattern: '^(?:$|https?://.+)$' })),
  DATA_FILE: Type.Optional(Type.String({ minLength: 1 })),
  STATIC_DIR: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: true })

const ConfigSchema = Type.Object({
  port: Type.Integer({ minimum: 1, maximum: 65_535 }),
  jellyfinUrl: Type.String(),
  dataFile: Type.String({ minLength: 1 }),
  staticDir: Type.String({ minLength: 1 }),
}, { additionalProperties: false })

export type Config = StaticDecode<typeof ConfigSchema>

export function loadConfig(environment: Record<string, string> = Deno.env.toObject()): Config {
  const parsed = decode(EnvironmentSchema, environment)
  return decode(ConfigSchema, {
    port: parsed.PORT ?? 8080,
    jellyfinUrl: parsed.JELLYFIN_URL ?? '',
    dataFile: parsed.DATA_FILE ?? new URL('../data/costs.json', import.meta.url).pathname,
    staticDir: parsed.STATIC_DIR ?? new URL('../frontend/dist', import.meta.url).pathname,
  })
}
