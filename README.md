# costthing

A small dashboard that shows what running a shared Jellyfin server costs — per category, per month
and per year — and how far donations cover it. Built for transparency towards the friends using the
server.

Login is Jellyfin's own: anyone with an account sees the totals, the timeline and the full item
list, while adding, editing, cancelling and deleting is reserved for Jellyfin administrators.
Nothing but Jellyfin decides who may write. The UI is in German.

### Cost model

Every cost point has a cadence:

- `monthly` / `yearly` — face value; yearly is divided by 12 for monthly figures.
- `custom` — every `<intervalCount>` `<intervalUnit>` (days/weeks/months/years), prorated per month.
- `one_time` — counts only in its start month, or, with `amortizationMonths`, is spread evenly over
  that many months from `startsOn`.

`endsOn` ("kündigen" in the UI) keeps a point counting through that month and drops it afterwards,
so historic months stay intact in the timeline. Deleting a point instead removes it retroactively.

### Donations

Donations are one-off, monthly or yearly. Any logged-in user can report one for themselves; it stays
_pending_ and uncounted until an admin confirms it. Admins can add, edit and delete donations
directly.

The dashboard shows how much of the current month's cost is covered, the surplus or shortfall, and a
cumulative balance starting at the first donation month — earlier cost-only history is ignored so it
does not drown the balance in deficit. The timeline chart draws donations as a second curve.

Donations link to Jellyfin accounts, one donor name to one identity. Self-reports link to the
submitter; on every write unlinked donations inherit the link of same-named linked donations, and
otherwise match an account by exact name (case-insensitive). Names claimed by several users stay
unlinked. Every user ever seen is kept in a `knownUsers` registry and archived rather than deleted
when the account disappears from Jellyfin, so old donations remain attributable. The registry syncs
whenever an admin loads the user list.

### Storage

A single JSON file, in exactly the import/export format — an export can be dropped back in as the
data file. Each write keeps the previous state as `costs.json.bak`. Imports are validated before
they replace anything and need an explicit confirmation in the UI.

### Configuration

| Variable       | Default             | Purpose                                       |
| -------------- | ------------------- | --------------------------------------------- |
| `PORT`         | `8080`              | listen port                                   |
| `JELLYFIN_URL` | unset (no login!)   | base URL of the Jellyfin server used for auth |
| `DATA_FILE`    | `./data/costs.json` | where costs are stored                        |
| `STATIC_DIR`   | `./frontend/dist`   | built frontend assets                         |

### Deployment

Railway builds the repo's `Dockerfile` directly via `railway.toml`: create a service from this repo,
add a **volume mounted at `/data`**, and set `JELLYFIN_URL`. The healthcheck is `/api/health` and an
empty data file is created on first boot.

Plain Docker works the same way:

```sh
docker build -t costthing .
docker run -p 8080:8080 -v costthing-data:/data -e JELLYFIN_URL=http://jellyfin:8096 costthing
```

With Nix, `nix run github:zekurio/costthing` or `nix build` produce the same app; it stores data in
`./data/costs.json` unless `DATA_FILE` says otherwise.

### Development

`nix develop` provides Deno, or install Deno 2 yourself.

```sh
cp .env.example .env   # point JELLYFIN_URL at your Jellyfin server
deno task dev          # API on :8080 + Vite dev server proxying /api
```

`deno task check` typechecks both ends, `deno test --allow-read --allow-write` runs the cost and
store tests, and `deno fmt` / `deno lint` cover `src/` and `shared/`. `deno task frontend:build`
writes `frontend/dist`, which `deno task start` then serves together with the API from one process.
[AGENTS.md](AGENTS.md) documents the conventions this repo expects.

### API

| Endpoint                          | Auth             | Purpose                                                |
| --------------------------------- | ---------------- | ------------------------------------------------------ |
| `GET /api/health`                 | —                | healthcheck                                            |
| `POST /api/auth`                  | —                | Jellyfin username/password → session cookie            |
| `POST /api/logout`                | —                | invalidate the Jellyfin session + clear the cookie     |
| `GET /api/me`                     | session cookie   | current user: name, admin status, avatar availability  |
| `GET /api/me/avatar`              | session cookie   | proxied Jellyfin profile image                         |
| `GET /api/summary`                | session cookie   | cost points, donations, coverage, timeline, totals     |
| `POST /api/donations/submit`      | session cookie   | self-report a donation (pending until confirmed)       |
| `GET /api/users`                  | + Jellyfin admin | Jellyfin users incl. archived ones; syncs the registry |
| `GET /api/export`                 | + Jellyfin admin | download the raw JSON                                  |
| `POST /api/import`                | + Jellyfin admin | validate and replace data from JSON                    |
| `POST /api/costs`                 | + Jellyfin admin | add a cost point                                       |
| `PUT /api/costs/:id`              | + Jellyfin admin | replace a cost point                                   |
| `DELETE /api/costs/:id`           | + Jellyfin admin | delete a cost point                                    |
| `POST /api/donations`             | + Jellyfin admin | add a confirmed donation                               |
| `POST /api/donations/:id/confirm` | + Jellyfin admin | confirm a pending donation                             |
| `PUT /api/donations/:id`          | + Jellyfin admin | replace a donation                                     |
| `DELETE /api/donations/:id`       | + Jellyfin admin | delete a donation                                      |

### License

[MIT](LICENSE)
