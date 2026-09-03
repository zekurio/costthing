import { createApp } from './app.ts'
import { Jellyfin } from './auth.ts'
import { loadConfig } from './config.ts'
import { serveStatic } from './static.ts'
import { Store } from './store.ts'

const config = loadConfig()
if (!config.jellyfinUrl) console.warn('[config] JELLYFIN_URL unset; nobody can log in')

const jellyfin = new Jellyfin(config.jellyfinUrl || 'http://localhost:8096')
const store = await Store.load(config.dataFile)
const app = createApp({ jellyfin, store, staticDir: config.staticDir, serveStatic })

Deno.serve({ port: config.port }, app.fetch)
console.log(`costthing listening on http://localhost:${config.port}`)
