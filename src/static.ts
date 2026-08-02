import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** Serves one built asset, with an index fallback only for HTML navigation. */
export async function serveStatic(
  pathname: string,
  accept: string,
  staticDir: string,
  acceptEncoding = '',
): Promise<Response> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return new Response('bad request', { status: 400 })
  }

  const requested = normalize(decoded.replace(/^[/\\]+/, ''))
  const root = resolve(staticDir)
  const file = resolve(root, requested === '.' || requested === '' ? 'index.html' : requested)
  const fromRoot = relative(root, file)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return new Response('forbidden', { status: 403 })
  }

  try {
    const data = await Deno.readFile(file)
    const immutable = fromRoot.startsWith(`assets${sep}`)
    return staticResponse(data, file, immutable, acceptEncoding)
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound) && !(err instanceof Deno.errors.IsADirectory)) {
      console.error(`[static] failed to read ${file}`, err)
      return new Response('internal server error', { status: 500 })
    }
  }

  // Missing assets stay 404; only extensionless HTML navigation gets the SPA shell.
  const navigation = extname(requested) === '' && requested !== 'assets' &&
    !requested.startsWith(`assets${sep}`) && accept.includes('text/html')
  if (!navigation) return new Response('not found', { status: 404 })
  try {
    const index = join(root, 'index.html')
    return staticResponse(await Deno.readFile(index), index, false, acceptEncoding)
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.error('[static] failed to read index.html', err)
      return new Response('internal server error', { status: 500 })
    }
    return new Response('frontend not built — run `deno task frontend:build`', { status: 404 })
  }
}

function staticResponse(
  data: Uint8Array,
  file: string,
  immutable: boolean,
  acceptEncoding: string,
): Response {
  const extension = extname(file)
  const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  const headers = new Headers({
    'content-type': MIME[extension] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  const compressible = ['.html', '.js', '.css', '.svg', '.json'].includes(extension)
  if (data.byteLength >= 1_024 && compressible) {
    headers.set('vary', 'accept-encoding')
  }
  if (data.byteLength >= 1_024 && compressible && acceptsGzip(acceptEncoding)) {
    headers.set('content-encoding', 'gzip')
    const stream = new Response(body).body!.pipeThrough(new CompressionStream('gzip'))
    return new Response(stream, { headers })
  }
  return new Response(body, { headers })
}

function acceptsGzip(header: string): boolean {
  const preferences = new Map<string, number>()
  for (const part of header.split(',')) {
    const [rawName, ...parameters] = part.trim().toLowerCase().split(';')
    if (!rawName) continue
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='))
    preferences.set(rawName, quality ? Number(quality.split('=')[1]) : 1)
  }
  if (preferences.has('gzip')) return (preferences.get('gzip') ?? 0) > 0
  return (preferences.get('*') ?? 0) > 0
}
