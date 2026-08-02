import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { serveStatic } from './static.ts'

Deno.test('static serving distinguishes assets, navigation, and malformed paths', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'costthing-static-test-' })
  try {
    await Deno.mkdir(join(directory, 'assets'))
    await Deno.writeTextFile(join(directory, 'index.html'), '<h1>app</h1>')
    const script = 'export const value = 1\n'.repeat(100)
    await Deno.writeTextFile(join(directory, 'assets', 'app.js'), script)

    const root = await serveStatic('/', '*/*', directory)
    assert.equal(root.status, 200)
    assert.match(root.headers.get('content-type') ?? '', /^text\/html/)
    assert.equal(root.headers.get('cache-control'), 'no-cache')

    const asset = await serveStatic('/assets/app.js', '*/*', directory)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/)
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff')

    const compressed = await serveStatic('/assets/app.js', '*/*', directory, 'br, gzip')
    assert.equal(compressed.headers.get('content-encoding'), 'gzip')
    assert.equal(compressed.headers.get('vary'), 'accept-encoding')
    const decompressed = compressed.body!.pipeThrough(new DecompressionStream('gzip'))
    assert.equal(await new Response(decompressed).text(), script)
    for (const encoding of ['gzip;q=0', 'gzip;q=0, *;q=1']) {
      assert.equal(
        (await serveStatic('/assets/app.js', '*/*', directory, encoding)).headers.get(
          'content-encoding',
        ),
        null,
      )
    }

    const missingAsset = await serveStatic('/assets/missing.js', 'text/html', directory)
    assert.equal(missingAsset.status, 404)
    assert.equal((await serveStatic('/assets', 'text/html', directory)).status, 404)

    const navigation = await serveStatic('/dashboard', 'text/html,application/xhtml+xml', directory)
    assert.equal(navigation.status, 200)
    assert.equal(await navigation.text(), '<h1>app</h1>')

    assert.equal((await serveStatic('/dashboard', '*/*', directory)).status, 404)
    assert.equal((await serveStatic('/%ZZ', 'text/html', directory)).status, 400)
    assert.equal((await serveStatic('/..%2Fsecret', 'text/html', directory)).status, 403)
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
})
