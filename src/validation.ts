import { Value } from '@sinclair/typebox/value'
import type { StaticDecode, TSchema } from '@sinclair/typebox'
import { validator } from 'hono/validator'

export class TypeBoxValidationError extends Error {
  override name = 'TypeBoxValidationError'
}

/** Decodes transforms and reports the first schema failure in a stable form. */
export function decode<T extends TSchema>(schema: T, value: unknown): StaticDecode<T> {
  try {
    return Value.Decode(schema, value)
  } catch {
    const issue = Value.Errors(schema, value).First()
    const location = issue?.path || 'value'
    const message = issue ? `${location} ${issue.message}` : 'value does not match the schema'
    throw new TypeBoxValidationError(message)
  }
}

/** Hono validator whose output is the decoded TypeBox value. */
export function typeboxValidator<T extends TSchema, Target extends 'json' | 'param'>(
  target: Target,
  schema: T,
) {
  return validator(target, (value, context) => {
    try {
      return decode(schema, value)
    } catch (error) {
      if (!(error instanceof TypeBoxValidationError)) throw error
      return context.json({ error: error.message }, 400)
    }
  })
}
