# Repository Guidelines

- costthing is a cost-transparency dashboard for a shared Jellyfin server: a Deno + Elysia API
  (`src/`), a Svelte 5 + Vite SPA (`frontend/`), and the wire contract both sides import from
  `shared/types.ts`. State is one JSON file on disk — there is no database.
- `main` is the only long-lived branch; use `main` or `origin/main` for diffs.
- Deno 2 is the whole toolchain (`denoland/deno:2.4.2` in the Dockerfile). Never use npm, pnpm, yarn
  or Bun; `nodeModulesDir: auto` lets Deno manage `node_modules` from `deno.json` imports.
- `deno task dev` runs the API (`:8080`) and the Vite dev server together; `deno task start` serves
  the built frontend and the API from one process; `deno task frontend:build` writes
  `frontend/dist`.
- Before a coding task is complete: `deno fmt`, `deno lint`, `deno task check` (`deno check` plus
  `svelte-check`), and `deno test --allow-read --allow-write` must pass. There is no test task; run
  it by hand.
- `deno fmt` also formats Markdown, including this file and `README.md`.
- `fmt` and `lint` exclude `frontend/`; Svelte code is only checked by `deno task frontend:check`.
- The server runs with `--allow-env --allow-net --allow-read --allow-write`. Keep new code inside
  those permissions.
- Nix: `nix develop` gives a shell with Deno, `nix build` / `nix run` build the package. Any change
  to `deno.json` or `deno.lock` invalidates the vendored dependency hashes — run
  `nix/update-deps-hashes.sh` and paste its output into `denoDepsHashes` in `nix/package.nix`.

## Branch Names

Short, at most three words, hyphen-separated. No slashes, no `feat/` or `fix/` prefixes.

Examples: `donation-linking`, `fix-timeline-gap`, `sticky-stats-column`.

## Commits and PR Titles

Conventional commit style: `type(scope): summary`. Types are `feat`, `fix`, `docs`, `chore`,
`refactor`, `test`. Scopes are optional; use the affected area, e.g. `api`, `store`, `calc`,
`frontend`, or `nix`.

Examples: `feat(store): archive departed Jellyfin users`, `fix(calc): count custom cadence`,
`chore(nix): refresh deps hashes`.

## Style Guide

- `deno fmt` owns layout (single quotes, no semicolons, 100 columns). Never hand-format.
- Import local modules with their `.ts` extension and use `import type` for types
  (`verbatimModuleSyntax`).
- `strict` and `noUncheckedIndexedAccess` are on, so index access is `T | undefined`. Use `!` only
  right after an invariant is established (a length check, a sort, a guarded route handler).
- Money is integer cents end to end. Divide only when formatting, via `frontend/src/lib/format.ts`.

```ts
// Good
const totalMonthly = points.reduce((sum, p) => sum + p.monthlyCents, 0)
cents(fmt, totalMonthly)

// Bad
const totalMonthly = points.reduce((sum, p) => sum + p.monthlyCents / 100, 0)
```

- Dates are `YYYY-MM-DD` strings and months are `YYYY-MM` strings. All arithmetic is UTC; compare
  months by string ordering instead of parsing.

```ts
// Good
if (month < startMonth) return 0
const first = new Date(Date.UTC(year, monthIndex, 1))

// Bad
if (new Date(month) < new Date(startMonth)) return 0
const first = new Date(year, monthIndex, 1)
```

- UI copy and number/date formatting are German (`de-DE`). Log lines, errors and comments are
  English and lowercase (`[store] no data file at ...`).
- Frontend is Svelte 5 runes only: `$state`, `$derived`, `$props`, `$bindable`, `$effect`. No
  stores, no `export let`.
- Components style themselves with the CSS custom properties defined in `frontend/src/app.css`
  (light and dark). No utility framework, no literal colors in components.
- Comment non-obvious constraints and surprising behaviour (cookie lifetimes, why a fallback is
  silent), not plain assignments.

## Repo Patterns

- Routes live in `src/main.ts` as Elysia handlers with `t.Object` body schemas. Authorization is two
  nested `.guard({ beforeHandle })` layers: the outer one requires a valid Jellyfin session, the
  inner one requires `isAdmin`. Put new endpoints inside the matching guard instead of adding ad-hoc
  checks.
- Admin status comes only from Jellyfin (`Policy.IsAdministrator`); the app stores no credentials
  and no roles. `src/auth.ts` caches token → user for 60s and treats an unreachable Jellyfin as
  logged out.
- `Store` (`src/store.ts`) is the only writer of the data file. Every mutation ends in `#persist()`,
  which reconciles donation → user links, prunes icons of dead categories, copies the previous file
  to `costs.json.bak`, and renames a `.tmp` file into place. Never touch the file directly.
- The on-disk format is exactly the export format (`CostFile`, `schemaVersion: 1`). Every read goes
  through `normalizeCostFile`, which validates and migrates legacy shapes. A new field needs the
  type in `shared/types.ts`, a branch in the normalizer, and a default for old files.
- `knownUsers` is append-only: users that disappear from Jellyfin are marked `archived`, never
  deleted, so historic donations stay attributable and returning donors reuse their id.
- Cost and donation math lives only in `src/calc.ts` and is covered by `src/calc_test.ts`. The
  frontend renders the `Summary` from `/api/summary` and never recomputes totals.
- `COST_ICONS` keys in `frontend/src/lib/icons.ts` are persisted in the data file — add keys, never
  rename them.
- All frontend requests go through the `api` object in `frontend/src/lib/api.ts`; failures throw
  `ApiError` carrying the server's message.
- Vite proxies `/api` to `:8080` in dev. In production `src/main.ts` serves `STATIC_DIR` with an
  `index.html` fallback, a path-traversal guard, and immutable caching for `assets/`.
