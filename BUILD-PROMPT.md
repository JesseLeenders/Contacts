# Bouwprompt — Contacten (HTTPS-only, SQLite, één gedeeld wachtwoord)

> Kopieer alles onder de streep naar een AI-agent. De prompt is zelfstandig: hij
> beschrijft de volledige applicatie, de beveiligingseisen en de tests die moeten
> slagen. Ga ervan uit dat er niets bestaat en bouw het van nul op.

---

## Opdracht

Bouw een lokale webapplicatie **"Contacten"**: een persoonlijk adresboek met
naam, voornaam, adres, postcode en plaats, opgeslagen in SQLite, beveiligd met
één gedeeld wachtwoord en **uitsluitend bereikbaar via HTTPS**. De interface is
Nederlandstalig. Werk in kleine stappen, test na elke stap en stop pas als alle
genoemde tests slagen.

## Technische stack (niet afwijken)

| Onderdeel | Keuze |
|---|---|
| Runtime | Node.js 20.19+ (CommonJS, geen TypeScript, geen bundler, geen transpiler) |
| Server | Express 5 |
| Database | `better-sqlite3` (synchroon, prepared statements) |
| Wachtwoordhash | `node:crypto` `scrypt` — **geen** extra wachtwoordbibliotheek |
| TLS | `node:https` met een zelfondertekend certificaat uit `selfsigned` |
| Spreadsheet-parser | `@e965/xlsx` (**niet** `xlsx`: dat heeft een niet-gerepareerde CVE) |
| CSS | `@picocss/pico` via `/vendor/pico/pico.min.css` |
| Windows-service | `node-windows` (moet in `dependencies` staan) |
| Tests | `node --test` (ingebouwde testrunner) |

Geen React, geen build-stap, geen ORM, geen dotenv-pakket (gebruik
`node --env-file-if-exists`).

## Bestandsstructuur

```
package.json
README.md
.gitignore
.env.https                 (niet in versiebeheer)
.env.https.example
src/app.js                 server, routes, validatie, DB-schema
src/auth.js                hashing, sessies, cookies, rate limiter
public/index.html          hoofdscherm (beveiligd)
public/app.js              frontendlogica hoofdscherm
public/login.html          inlogscherm (openbaar)
public/login.js            frontendlogica login
public/styles.css          opmaak
scripts/set-password.js    wachtwoord instellen (interactief)
scripts/make-cert.js       zelfondertekend certificaat
scripts/sync-bpost-postcodes.js  postcode-import
scripts/service.js         Windows-service install/uninstall
test/app.test.js           testsuite
data/                      SQLite-database (niet in versiebeheer)
certs/                     TLS-sleutel + certificaat (niet in versiebeheer)
```

## Database

Open de database op `process.env.DB_PATH || './data/contacts.db'`, maak de
map aan met `fs.mkdirSync(dir, { recursive: true })` en initialiseer **idempotent**
bij elke start.

```sql
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  naam TEXT NOT NULL,
  voornaam TEXT NOT NULL,
  adres TEXT NOT NULL,
  postcode TEXT NOT NULL DEFAULT '',
  plaats TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS postal_places (
  postcode TEXT NOT NULL,
  plaats TEXT NOT NULL,
  gemeente TEXT NOT NULL DEFAULT '',
  deelgemeente INTEGER NOT NULL DEFAULT 0,
  provincie TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (postcode, plaats)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  started_at INTEGER NOT NULL
);
```

**Migratie van bestaande databases is verplicht.** Lees
`database.pragma('table_info(contacts)')`, en voeg ontbrekende kolommen toe:

```sql
ALTER TABLE contacts ADD COLUMN postcode TEXT NOT NULL DEFAULT ''
ALTER TABLE contacts ADD COLUMN plaats  TEXT NOT NULL DEFAULT ''
```

Bestaande contacten mogen nooit verdwijnen; hun nieuwe kolommen worden leeg.

## Functionele eisen

**Contacten beheren** (alleen ingelogd):

- `GET /api/contacts` → `200 { contacts: [...] }`, gesorteerd op
  `naam COLLATE NOCASE, voornaam COLLATE NOCASE, id`, velden
  `id, naam, voornaam, adres, postcode, plaats`.
- `POST /api/contacts` → `201 { contact }`.
- `PUT /api/contacts/:id` → `200 { contact }`; `404` als het id niet bestaat.
- `DELETE /api/contacts/:id` → `204`; `404` als het id niet bestaat.
- `:id` wordt geparsed met `Number()` en moet een veilig geheel getal > 0 zijn;
  anders `400 VALIDATION_ERROR` met `"Ongeldig contactnummer."`.

**Validatie** (`validateContact`), in deze volgorde:

1. Geen object of een array → `"Vul alle contactgegevens in."`
2. `naam`, `voornaam`, `adres` zijn na `trim()` verplicht →
   `"Naam, voornaam en adres zijn verplicht."`
3. `naam`/`voornaam` max 100 tekens, `adres` max 300 →
   `"Naam en voornaam mogen maximaal 100 tekens bevatten; adres maximaal 300."`
4. Postcode en plaats zijn **samen** leeg of **samen** gevuld →
   `"Vul zowel de postcode als de bijbehorende plaats in."`
5. Postcode moet `^\d{4}$` zijn → `"Een Belgische postcode bestaat uit vier cijfers."`
6. Als postcode+plaats gevuld zijn, moet de combinatie bestaan in `postal_places` →
   `"Kies een plaats die bij deze postcode hoort."`

**Postcodes** (alleen ingelogd):

- `GET /api/postal-places/:postcode` → `200 { places: ["..."] }`, alfabetisch,
  `COLLATE NOCASE`; ongeldige postcode → `400`.
- Eén postcode hoort **meerdere** plaatsen te kunnen hebben. Controleer dit
  minstens met `3540` → Berbroek, Donk, Herk-de-Stad, Schulen.

**Foutformaat** — altijd hetzelfde object:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…" } }
```

Codes: `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `INVALID_CREDENTIALS`,
`TOO_MANY_ATTEMPTS`, `PASSWORD_NOT_SET`, `BAD_REQUEST`, `INTERNAL_SERVER_ERROR`.
Ongeldige JSON (`error.type === 'entity.parse.failed'`) → `400 BAD_REQUEST`.
Onverwachte DB-fouten → `500` met algemene tekst; details alleen naar `console.error`.

## Beveiligingseisen (hard, niet onderhandelbaar)

**HTTPS is de enige optie**

- De server start **nooit** op HTTP. Ontbreken de certificaatbestanden, dan
  weigert de app te starten met een melding die naar `npm run make-cert` verwijst.
- `https.createServer({ key, cert, minVersion: 'TLSv1.2' }, app)`.
- Elke respons krijgt `Strict-Transport-Security: max-age=31536000`.
- Standaard `HOST=127.0.0.1`, `PORT=3443`. `HOST=0.0.0.0` alleen op expliciete
  aanvraag, want dan is de app op het netwerk bereikbaar.
- `app.disable('x-powered-by')`; JSON-bodylimiet `16kb`.

**Wachtwoord**

- Eén gedeeld beheerderswachtwoord, minimaal 12 tekens.
- Hashformaat: `scrypt$N,r,p$saltB64$hashB64`.
  Parameters `N=32768, r=8, p=1`, sleutel 64 bytes, salt 16 random bytes.
- **Let op:** geef altijd `maxmem: 64 * 1024 * 1024` mee. Node's standaard
  `maxmem` (32 MB) is te klein voor `N=2^15` en gooit
  `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`.
- Vergelijken met `crypto.timingSafeEqual`; bij twijfel of fout `false` retourneren.
- De parameters staan **in** de hash, zodat ze later verzwaard kunnen worden.
- Het platte wachtwoord komt nooit in de database, nooit in een log, nooit in een
  API-respons en nooit in de shell-geschiedenis.
- Opnieuw instellen verwijdert **alle** sessies.

**Sessies**

- Token: 32 random bytes, `base64url`. In de database staat alleen
  `sha256(token)` — nooit het token zelf.
- Geldigheid: **12 uur** vanaf login (geen sliding expiration).
- Cookie `sid`: `Path=/; HttpOnly; SameSite=Strict; Max-Age=<seconden>`,
  plus `Secure`. `COOKIE_SECURE` is standaard **true**; alleen expliciet
  `COOKIE_SECURE=false` zet de vlag uit.
- Verlopen sessies worden bij gebruik geweigerd **en** uit de tabel verwijderd;
  bij succesvol inloggen worden verlopen rijen opgeruimd.
- Uitloggen (`DELETE /api/session`) verwijdert de rij en stuurt een lege cookie
  met `Max-Age=0`.

**Rate limiting op login**

- Maximaal 10 mislukte pogingen per 15 minuten per IP.
- Teller **persisteert in SQLite** (`login_attempts`), dus een herstart reset een
  blokkade niet. In-memory cache mag, maar de database is de bron van waarheid.
- Bij blokkade: `429` met `Retry-After` in seconden.
- Verlopen rijen worden opgeruimd zodra er een mislukking wordt geregistreerd,
  zodat een blokkade nooit permanent wordt.
- Succesvol inloggen wist de teller van dat IP.

**Toegangscontrole**

- `POST /api/session` met `{ password }` → `204` + cookie; fout wachtwoord → `401`;
  geen wachtwoord geconfigureerd → `503 PASSWORD_NOT_SET`.
- `GET /api/me` → `200 { authenticated: true, expiresAt }`.
- Alle `/api/contacts*` en `/api/postal-places*` zonder sessie → `401`.
- `/`, `/index.html`, `/app.js` zonder sessie → `302` naar `/login`.
- `/login` met geldige sessie → `302` naar `/`.
- `/login.html`, `/login.js`, `/styles.css`, `/vendor/pico/*` zijn openbaar.
- **Geen `express.static` als terugval voor de beveiligde bestanden.** Gebruik
  expliciete routes per bestand plus een laatste guard die `/`, `/index.html` en
  `/app.js` naar `/login` stuurt. Reden: `express.static` normaliseert
  `//index.html` en `/%2findex.html` en levert dan de beveiligde pagina zonder
  login. Test deze twee paden expliciet; ze moeten `404` of `302` geven, nooit `200`.
- Voeg geen sessie- of wachtwoordgegevens toe aan API-responsen.

## Frontend

- Pico CSS, Nederlands, `lang="nl"`, eigen `styles.css` erbij.
- `index.html`: sticky topbar met merk, status-pill ("Verbinden…", "Opgeslagen",
  "Verbinding mislukt"), formulierkaart, records-kaart, uitlogknop.
- Formuliervelden: `naam`, `voornaam`, `adres`, `postcode`, `plaats` (select).
- De plaats-select is uitgeschakeld tot een geldige postcode is ingevuld; bij
  invoer wordt `/api/postal-places/:postcode` bevraagd. Toon "Vul eerst een
  postcode in", "Plaatsen laden…", "Selecteer een plaats", "Geen plaatsen
  gevonden", "Plaatsen niet beschikbaar".
- Tabelkolommen: Naam, Voornaam, Adres, Postcode, Plaats, Acties. Lege waarden
  tonen `—`. Lege lijst: volledige-breedte melding met `colspan="6"`.
- Wijzigen vult het formulier en zet de knop op "Wijzigingen opslaan"; Annuleren
  herstelt. Verwijderen vraagt bevestiging met de volledige naam.
- **Gebruik uitsluitend `textContent` en `document.createElement`.** Geen
  `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval` of `new Function`.
  Contactgegevens zijn gebruikersinvoer en mogen nooit als HTML worden geïnterpreteerd.
- Elke `fetch` die `401` terugkrijgt, stuurt de gebruiker naar `/login`.
- Loginpagina: wachtwoordveld, foutmelding in tekst, knop tijdelijk uitgeschakeld
  tijdens het verzoek, `window.location.replace('/')` bij succes.
- Race-conditions in de postcode-lookup voorkomen met een oplopend
  aanvraagnummer: alleen het nieuwste antwoord mag de select bijwerken.

## Scripts en commando's

```json
"build": "node --check src/app.js && node --check src/auth.js && node --check public/app.js && node --check public/login.js && node --check scripts/sync-bpost-postcodes.js && node --check scripts/set-password.js && node --check scripts/make-cert.js",
"start": "node --env-file-if-exists=.env.https src/app.js",
"start:https": "node --env-file-if-exists=.env.https src/app.js",
"make-cert": "node scripts/make-cert.js",
"set-password": "node scripts/set-password.js",
"sync-postcodes": "node scripts/sync-bpost-postcodes.js",
"test": "node --test"
```

**`set-password.js`** — interactief, verborgen invoer via
`process.stdin.setRawMode(true)`, twee keer vragen, vergelijken, dan
`setPassword()`. Weigeren zonder TTY. `Ctrl+C` breekt af zonder wijziging.
Minstens 12 tekens, anders fout.

**`make-cert.js`** — `selfsigned` **v5 is asynchroon**: `await
selfsigned.generate(...)`. Certificaat voor `commonName=localhost`, 365 dagen,
`keySize: 2048`, `algorithm: 'sha256'`, SAN met `localhost` en `127.0.0.1`,
`basicConstraints(CA:false)`, `keyUsage`, `extKeyUsage serverAuth`. Schrijf de
sleutel met `mode: 0o600`. Bestaat het certificaat al, stop dan met een melding
tenzij `--force` is meegegeven.

**`sync-bpost-postcodes.js`** — download
`https://www.bpost.be/sites/default/files/zipcodes/zipcodes_alpha_nl_2025.xls`,
parse met `@e965/xlsx`, verwacht de kolommen `Postcode, Plaatsnaam, Deelgemeente,
Hoofdgemeente, Provincie`. Weiger te importeren als kolommen ontbreken of er
minder dan 2000 rijen zijn. Postcode `padStart(4, '0')`; `Deelgemeente === 'ja'`
wordt `1`. Vervang de inhoud van `postal_places` in **één transactie** (DELETE +
INSERT) en bewaar het bronbestand als `data/bpost-postcodes.xls`. Log het aantal
geïmporteerde combinaties en de `Last-Modified` van de bron. Bij circa 2.764
regels en een postcode `3540` met vier plaatsen zit je goed.

**`service.js`** — `node-windows` `Service` met `name: 'Jesse'`,
`script: src/app.js`, `workingDirectory` = projectroot, `execPath:
process.execPath`. Na install `sc.exe config <naam> start= auto` en starten.
Weiger te installeren als `certs/` ontbreekt. Accepteer alleen `install` of
`uninstall` als argument.

## Omgevingsvariabelen

```ini
PORT=3443
HOST=127.0.0.1
TLS_KEY_PATH=./certs/localhost-key.pem
TLS_CERT_PATH=./certs/localhost-cert.pem
COOKIE_SECURE=true
# optioneel: DB_PATH, TRUST_PROXY=true (alleen achter een echte proxy)
```

`.env.https` staat niet in versiebeheer; `.env.https.example` wel.

## `.gitignore`

```
node_modules/
data/*.db
data/*.db-shm
data/*.db-wal
data/bpost-postcodes.xls
certs/
.env.https
src/daemon/
npm-debug.log*
```

## Tests die moeten slagen (20)

1. Contacten beginnen leeg; create/update/list/delete werkt.
2. Ontbrekende velden en onbekende id's worden geweigerd.
3. Een oude `contacts`-tabel migreert zonder gegevensverlies.
4. Postcode-lookup en validatie ondersteunen meerdere plaatsen per postcode.
5. `GET /` toont het hoofdscherm na inloggen.
6. Zonder sessie: `302` op pagina's, `401` op alle API-routes, `/login` is `200`.
7. De sessiecookie is `HttpOnly` en `SameSite=Strict` en bevat nooit het wachtwoord.
8. Fout wachtwoord → `401`; na het maximum → `429` met `Retry-After`.
9. Het opgeslagen wachtwoord is een scrypt-hash met salt; twee hashes van
   hetzelfde wachtwoord verschillen.
10. Wachtwoord wijzigen trekt alle bestaande sessies in.
11. Uitloggen trekt de sessie in.
12. Verlopen sessies worden geweigerd en opgeruimd.
13. Login zonder geconfigureerd wachtwoord → `503`.
14. Te kort wachtwoord bij instellen → fout.
15. Rate limiting overleeft een herstart via SQLite.
16. Verlopen loginpogingen worden opgeruimd.
17. De `Secure`-vlag staat op de cookie als HTTPS is ingeschakeld.
18. Elke respons bevat de HSTS-header.
19. De server weigert te starten zonder certificaat.
20. Het gegenereerde certificaat bedient echt HTTPS op een live poort.

## Werkwijze die je moet volgen

1. Scaffold en `npm install`; controleer daarna meteen dat `node-windows`,
   `@e965/xlsx` en `better-sqlite3` nog aanwezig zijn.
2. Database + migraties, dan de API zonder auth, dan de tests daarop.
3. Auth (hashing → sessies → routes → rate limiting), dan HTTPS.
4. Frontend, en pas daarna de postcode-import van bpost.
5. `npm run build`, `npm test`, `npm audit --omit=dev` — alle drie schoon.
6. Start de server in de achtergrond en controleer met echte verzoeken:
   `https://127.0.0.1:3443/login` → `200`, `/` → `302`, `/api/contacts` → `401`,
   `//index.html` → geen `200`, `http://127.0.0.1:3443` → geen verbinding.

## Valkuilen die je moet vermijden

- `scrypt` zonder `maxmem` crasht bij `N=32768`.
- `selfsigned` v5 geeft een Promise; de oude synchrone API levert stil `undefined`.
- `express.static` als terugval omzeilt je loginmuur via `//index.html`.
- Een langlopend serverproces starten met een pipe (`| Select-Object`) laat de
  opdracht eindigen noch terugkeren; start servers los of in de achtergrond.
- `node-windows` vergeten in `dependencies` sloopt de Windows-service bij een
  volgende installatie (`Cannot find module .../wrapper.js`).
- SQL samenstellen met strings. Alles moet via `?` of `@naam` met prepared
  statements; `better-sqlite3` staat sowieso maar één statement per `prepare` toe.
- Wachtwoorden of hashes in logs, API-responsen of foutmeldingen zetten.
- Vergeten dat contactgegevens **plat tekst** in SQLite staan. Dat is een bewuste
  keuze: de hash beschermt het wachtwoord, niet de adressen. Meld dit expliciet
  aan de gebruiker en wijs op BitLocker of SQLCipher als echte oplossing.