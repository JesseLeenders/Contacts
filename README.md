# Contacten

A small Express application for creating, viewing, editing, and deleting contacts
stored in a local SQLite database.

## Requirements

- Node.js 20.19+
- npm

## Run locally

```sh
npm install
npm run set-password
npm run sync-postcodes
npm run make-cert
npm run build
npm start
```

**The app only speaks HTTPS.** `npm start` reads `.env.https` and refuses to run
without a TLS certificate, so run `npm run make-cert` first. Open
<https://127.0.0.1:3443> and log in. Plain HTTP is not served on any port, and
every response carries HSTS, a strict Content-Security-Policy, `nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a restrictive
`Permissions-Policy`. Requests with a `Host` header other than `localhost` or
`127.0.0.1` are rejected with `421` (DNS-rebinding protection). Every
state-changing request (`POST`, `PUT`, `DELETE`, `PATCH`) that carries an
`Origin` header must come from the same host, otherwise it gets `403` — this is
the CSRF guard on top of the `SameSite=Strict` cookie. Requests without an
`Origin` header (curl, scripts) are allowed, since only browsers send it.

All `/api/*` responses carry `Cache-Control: no-store`. A global limiter allows
240 API requests per minute per address (on top of the stricter login limit),
and the HTTP server uses short `headersTimeout`/`requestTimeout` values so slow
connections cannot pile up.

## Security log

Failed logins, successful logins, rejected cross-origin writes and rate-limit
blocks are stored in the `security_events` table (IP, timestamp, event, detail —
never the password). Inspect the last events with:

```sh
npm run security-log
```

or via `GET /api/security-events` once logged in. Entries older than 30 days are
purged automatically on each successful login.

On Windows, run `npm run harden-permissions` once after `npm run make-cert`. It
removes inherited ACLs from the TLS private key, the database and `data/`, and
grants access only to your account, `SYSTEM` and `Administrators`. Without it,
`BUILTIN\Users` can read the private key — POSIX `mode: 0o600` is ignored on
Windows.

The server binds to `127.0.0.1` by default; set `HOST=0.0.0.0` only if you really
need network access. Set the password **first**: `npm run set-password` asks twice
for a shared password (12+ characters, hidden input, no shell history) and stores
only a salted scrypt hash in SQLite. Without it, `/login` reports that no password
is configured and `POST /api/session` returns `503`.

Sessions are stored in SQLite as SHA-256 token hashes and sent as an `HttpOnly`,
`SameSite=Strict`, `Secure` cookie valid for 12 hours. Login attempts are rate
limited (10 per 15 minutes per address) and the counters live in SQLite, so
restarting the server does not reset a block. Running `npm run set-password` again
revokes every existing session.

If a port is already taken, the server prints a clear message instead of failing
silently — usually an older instance is still running.

## Deployen op Render

Kies bij het aanmaken een **Web Service** (geen Static Site, geen Private Service).
`render.yaml` in de repo zet de juiste waarden klaar; je kunt ook handmatig:

| Instelling | Waarde |
|---|---|
| Runtime | Node (niet Docker, niet Alpine) |
| Build command | `npm ci && npm rebuild better-sqlite3` |
| Start command | `npm start` |
| Health check path | `/login` |
| Persistent disk | 1 GB, gemount op `/data` |

Omgevingsvariabelen:

| Variabele | Waarde |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `DB_PATH` | `/data/contacts.db` |
| `COOKIE_SECURE` | `true` |
| `ALLOWED_HOSTS` | je Render-domein, bijv. `contacten.onrender.com` |
| `APP_PASSWORD` | eenmalig, voor het instellen van het wachtwoord |

Zonder certificaat start de app in **HTTP-modus**, want Render termineert TLS bij
de load balancer. Lokaal blijft HTTPS verplicht zodra `certs/` bestaat.

Wachtwoord instellen in de Render-shell (de gewone `npm run set-password` vraagt
om een TTY en werkt daar niet):

```sh
APP_PASSWORD='een-lang-genoeg-wachtwoord' npm run set-password:env
```

Verwijder `APP_PASSWORD` daarna uit de omgevingsvariabelen; het script is alleen
nodig bij de eerste keer of bij een wachtwoordwijziging.

**Let op:** de persistent disk is nodig, anders is de database bij elke deploy
leeg. Op de gratis tier van Render bestaat geen persistent disk.

## HTTPS lokaal

```sh
npm run make-cert
npm start
```

`npm run make-cert` writes a self-signed certificate for `localhost` and
`127.0.0.1` to `certs/` (gitignored, valid one year; use `npm run make-cert --
--force` to replace it). `npm start` reads `.env.https`, serves
`https://127.0.0.1:3443` and enables the `Secure` cookie flag. Your browser warns
once about the unknown issuer — that is expected for a self-signed certificate.
To serve a different certificate, point `TLS_KEY_PATH` and `TLS_CERT_PATH` in
`.env.https` at your own PEM files.

For a Windows service, use `scripts/service.js`; it starts the same `src/app.js`,
so the service is HTTPS-only too and needs `certs/` to exist:

```sh
node scripts/service.js install
```

The service uses the default certificate paths, so it does not need
`.env.https`. `node-windows` is a production dependency: removing it (or running
an install that drops it) breaks the service with
`Cannot find module node-windows/lib/wrapper.js`. If that happens, run
`npm install` and start the service again.

Open <http://localhost:3000>. On first startup, the app creates the empty
`data/contacts.db` database and its `contacts` table. The sync command downloads
the Dutch bpost postcode list, imports postcode/place combinations into SQLite,
and stores the source file locally at `data/bpost-postcodes.xls`. Run it again
to refresh the list. A postcode can have multiple places; contacts store both
the selected postcode and its matching place. Existing contacts are preserved
when the database schema is upgraded. The previous `data/app.db` file is not
used or changed. Set `DB_PATH` to use a different SQLite file, or `PORT` to use
a different HTTP port.

## API

All contact and postcode endpoints require a logged-in session:

- `POST /api/session` — log in (`password`) → sets the session cookie
- `DELETE /api/session` — log out
- `GET /api/me` — current session status
- `GET /api/security-events` — recent security events (`?limit=50`)
- `GET /api/contacts` — list contacts
- `POST /api/contacts` — create a contact (`naam`, `voornaam`, `adres`)
- `PUT /api/contacts/:id` — update a contact
- `DELETE /api/contacts/:id` — delete a contact

## Test

```sh
npm test
```
