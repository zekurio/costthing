import { strict as assert } from 'node:assert'
import { loadConfig } from './config.ts'
import { TypeBoxValidationError } from './validation.ts'

Deno.test('configuration decodes environment strings and applies defaults', () => {
  const configured = loadConfig({
    PORT: '9090',
    JELLYFIN_URL: 'https://jellyfin.example',
    DATA_FILE: '/tmp/costs.json',
    STATIC_DIR: '/tmp/frontend',
    UNRELATED: 'kept out of config',
  })
  assert.deepEqual(configured, {
    port: 9090,
    jellyfinUrl: 'https://jellyfin.example',
    dataFile: '/tmp/costs.json',
    staticDir: '/tmp/frontend',
  })

  const defaults = loadConfig({})
  assert.equal(defaults.port, 8080)
  assert.equal(defaults.jellyfinUrl, '')
  assert.match(defaults.dataFile, /data\/costs\.json$/)
  assert.match(defaults.staticDir, /frontend\/dist$/)
})

Deno.test('configuration rejects malformed environment values', () => {
  const invalidEnvironments: Record<string, string>[] = [
    { PORT: 'not-a-port' },
    { PORT: '70000' },
    { JELLYFIN_URL: 'jellyfin.example' },
    { DATA_FILE: '' },
  ]
  for (const environment of invalidEnvironments) {
    assert.throws(() => loadConfig(environment), TypeBoxValidationError)
  }
})
