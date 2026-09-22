# costthing

A small dashboard that shows what running a shared Jellyfin server costs — per category, per month
and per year — and whether recorded income covers it. Built for transparency towards the friends
using the server.

Login is Jellyfin's own: anyone with an account sees the totals, the timeline and the full item
list, while adding, editing, cancelling and deleting is reserved for Jellyfin administrators.
Nothing but Jellyfin decides who may write. Each browser gets its own Jellyfin device identity, so
logging in elsewhere does not displace an existing session; transient Jellyfin outages show a retry
state instead of forgetting the session. The UI is in German.

### Cost model

Every cost point has a cadence:

- `monthly` / `yearly` — face value; yearly is divided by 12 for monthly figures.
- `custom` — every `<intervalCount>` `<intervalUnit>` (days/weeks/months/years), prorated per month.
- `one_time` — counts only in its start month, or, with `amortizationMonths`, is spread over exactly
  that many calendar months starting with the month containing `startsOn`. Remainder cents are
  distributed without losing money.

`endsOn` ("kündigen" in the UI) keeps a point counting through that month and drops it afterwards,
so historic months stay intact in the timeline. Deleting a point instead removes it retroactively.

### Income pot

Admins book received income manually, typically at the end of a month. Each entry has a month, an
amount in cents and an optional note. Several entries can belong to the same month. There are no
recurring income schedules, donor accounts, self-reports or confirmation steps.

The pot compares income booked through the current month with accumulated monthly costs, including
amortization. The balance starts at the first income month, preserving the previous balance window.
Earlier cost-only months remain visible in the timeline but do not reduce the pot. Before any income
is booked, the cumulative balance is zero. Future bookings do not count toward the current balance.
This is an amortized cost balance, not a bank-account balance.

Schema v1 files and exports migrate to schema v2. Confirmed donations become income entries for each
month they counted through the migration month, with the donor name retained as a note. Pending
submissions and future occurrences do not become booked income. No further income is generated after
migration. Export your old data before upgrading if you need to retain the donor registry or pending
submissions; the normal one-step backup is replaced by subsequent writes.

### Storage

A single JSON file, in exactly the import/export format — an export can be dropped back in as the
data file. Mutations are serialized, validated, written atomically and rolled back in memory if
persistence fails. Each write keeps the previous state as `costs.json.bak`. Imports are validated
before they replace anything and need an explicit confirmation in the UI.

### Configuration

| Variable       | Default             | Purpose                                       |
| -------------- | ------------------- | --------------------------------------------- |
| `PORT`         | `8080`              | listen port                                   |
| `JELLYFIN_URL` | unset (no login!)   | base URL of the Jellyfin server used for auth |
| `DATA_FILE`    | `./data/costs.json` | where costs are stored                        |
| `STATIC_DIR`   | `./frontend/dist`   | built frontend assets                         |

### Deployment

With Nix, `nix run github:zekurio/costthing` or `nix build` produce the app; it stores data in
`./data/costs.json` unless `DATA_FILE` says otherwise. Set `JELLYFIN_URL` to enable login. The
healthcheck is `/api/health` and an empty data file is created on first boot.

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

| Endpoint                 | Auth             | Purpose                                               |
| ------------------------ | ---------------- | ----------------------------------------------------- |
| `GET /api/health`        | —                | healthcheck                                           |
| `POST /api/auth`         | —                | Jellyfin username/password → session cookie           |
| `POST /api/logout`       | —                | invalidate the Jellyfin session + clear the cookie    |
| `GET /api/me`            | session cookie   | current user: name, admin status, avatar availability |
| `GET /api/me/avatar`     | session cookie   | proxied Jellyfin profile image                        |
| `GET /api/summary`       | session cookie   | cost points, income, coverage, timeline, totals       |
| `GET /api/export`        | + Jellyfin admin | download the raw JSON                                 |
| `POST /api/import`       | + Jellyfin admin | validate and replace data from JSON                   |
| `POST /api/costs`        | + Jellyfin admin | add a cost point                                      |
| `PUT /api/costs/:id`     | + Jellyfin admin | replace a cost point                                  |
| `DELETE /api/costs/:id`  | + Jellyfin admin | delete a cost point                                   |
| `POST /api/income`       | + Jellyfin admin | book income for a month                               |
| `PUT /api/income/:id`    | + Jellyfin admin | replace an income entry                               |
| `DELETE /api/income/:id` | + Jellyfin admin | delete an income entry                                |

### License

[MIT](LICENSE)
