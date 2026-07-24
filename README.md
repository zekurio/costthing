# costthing

A small dashboard that shows what running the shared Jellyfin server costs — broken down by
category, with effective monthly and yearly totals. Built for transparency towards the friends using
the server.

- **Dashboard behind Jellyfin login**: users sign in with their Jellyfin credentials
  (`AuthenticateByName`); anyone with an account on the server can see totals per month/year,
  per-category bars, and a full list of cost items including amortized one-time purchases.
- **Admin-only editing**: adding, editing, cancelling ("kündigen") and deleting cost items is
  reserved for Jellyfin administrators — admin status comes straight from Jellyfin, nothing else
  can change data.
- **Storage** is a single JSON file — the exact same format as the import/export, so exports can be
  dropped back in as the data file.

The stack mirrors arr-cal-proxy: Deno + Elysia backend, Svelte 5 + Vite frontend, Jellyfin duotone
(purple `#aa5cc3` → blue `#00a4dc`), Barlow Condensed + Instrument Sans.

## Cost model

Each cost point has a cadence:

- `monthly` / `yearly` — counted at face value (yearly is divided by 12 for monthly figures).
- `one_time` — with `amortizationMonths` set, the cost is spread evenly over that many months
  starting at `startsOn`; afterwards it drops off the monthly total. Without amortization it only
  counts in the month it started.
- `custom` — every `<intervalCount>` `<intervalUnit>` (days/weeks/months/years), prorated monthly.

Any point can have an `endsOn` date ("kündigen" in the UI): it keeps counting through that month,
then drops to zero — historical months keep it, so the timeline chart shows the full history.
Deleting a point instead removes it retroactively from the whole timeline. On every write the
previous state of the data file is kept as `costs.json.bak`.

## Donations

Donations can be one-off, monthly, or yearly entries (name/source, amount, first date, and an
optional end date). One-off donations count toward the month of their receipt; recurring donations
are automatically included in every matching month and in the 12-month forecast. The dashboard shows
how much of the current month's cost they cover, whether there's a surplus or shortfall, and a
cumulative balance across all months since the first recorded donation (earlier cost-only history is
ignored, so it doesn't drown the balance in deficit). The timeline chart draws donations as a
second, green curve next to the cost line. Adding/editing/deleting donations is admin-only; they
live in the same JSON file as the costs, so exports include them.

Donations can be linked to Jellyfin accounts — one donor name maps to one identity. Self-reported
donations are linked to the submitter automatically; admins can pick any account from a user picker
when adding or editing a donation. On every write (and on each admin user sync) unlinked donations
are reconciled: they inherit the link from already-linked donations with the same name (so manually
linking one donation covers the donor's whole history), otherwise they are matched to an account by
exact name (case-insensitive). Names claimed by several different users are never guessed and stay
unlinked.
The app keeps a `knownUsers` registry in the data file: every user ever seen is recorded, and when
an account disappears from the Jellyfin server it is kept as *archived* (never deleted), so old
donations stay attributable and a returning donor maps back to the same id. The registry is synced
from Jellyfin whenever an admin loads the user list (`GET /api/users`, using the admin's own
session token).

Admins can also import a previous costthing JSON export. Imports are validated before replacing the
current data, require an explicit confirmation in the UI, and retain the previous data file as
`costs.json.bak`.

## Configuration (env vars)

| Variable       | Default             | Purpose                                       |
| -------------- | ------------------- | --------------------------------------------- |
| `PORT`         | `8080`              | listen port                                   |
| `JELLYFIN_URL` | unset (no login!)   | base URL of the Jellyfin server used for auth |
| `DATA_FILE`    | `./data/costs.json` | where costs are stored                        |
| `STATIC_DIR`   | `./frontend/dist`   | built frontend assets                         |

## Development

Needs a Nix shell (`nix develop` provides Deno) or a local Deno install.

```sh
cp .env.example .env   # point JELLYFIN_URL at your Jellyfin server
deno task dev          # backend on :8080 + vite dev server with /api proxy
```

Other tasks: `deno task check` (typecheck both ends), `deno task frontend:build`, `deno task start`
(serve built frontend + API from one process).

## Nix package

Build with `nix build` or run with `nix run`. The package stores its writable data in
`./data/costs.json` by default; override `DATA_FILE` and set `JELLYFIN_URL` as needed.

## Deployment (Railway)

The repo ships a `Dockerfile` + `railway.toml`; Railway builds it directly.

1. Create a service from this repo.
2. Add a **volume mounted at `/data`** — that's where `costs.json` lives.
3. Set the `JELLYFIN_URL` env var.
4. Done — healthcheck is `/api/health`; an empty data file is created on first boot.

## API

| Endpoint                    | Auth             | Purpose                                                 |
| --------------------------- | ---------------- | ------------------------------------------------------- |
| `POST /api/auth`            | —                | Jellyfin username/password → session cookie             |
| `POST /api/logout`          | —                | invalidate the Jellyfin session + clear the cookie      |
| `GET /api/me`               | session cookie   | current user: name, admin status, avatar availability   |
| `GET /api/me/avatar`        | session cookie   | proxied Jellyfin profile image                          |
| `GET /api/summary`          | session cookie   | all cost points + computed totals                       |
| `GET /api/export`           | + Jellyfin admin | download the raw JSON                                   |
| `POST /api/import`          | + Jellyfin admin | validate and replace data from JSON                     |
| `POST /api/costs`           | + Jellyfin admin | add a cost point                                        |
| `PUT /api/costs/:id`        | + Jellyfin admin | replace a cost point                                    |
| `DELETE /api/costs/:id`     | + Jellyfin admin | delete a cost point                                     |
| `POST /api/donations`       | + Jellyfin admin | add a donation                                          |
| `PUT /api/donations/:id`    | + Jellyfin admin | replace a donation                                      |
| `DELETE /api/donations/:id` | + Jellyfin admin | delete a donation                                       |
