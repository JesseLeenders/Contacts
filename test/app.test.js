const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createApp, initializeDatabase } = require('../src/app');
const auth = require('../src/auth');

const TEST_PASSWORD = 'correct-horse-battery';

async function startTestServer(t, seedDatabase, authOptions) {
  const database = initializeDatabase(new Database(':memory:'));
  seedDatabase?.(database);
  const server = createApp({ database, authOptions }).listen(0, '127.0.0.1');
  t.after(() => {
    server.close();
    database.close();
  });
  await new Promise((resolve) => server.once('listening', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, database };
}

async function login(baseUrl, password = TEST_PASSWORD) {
  return fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

function sessionCookie(response) {
  const header = response.headers.get('set-cookie');
  return header ? header.split(';')[0] : '';
}

async function authenticatedServer(t, seedDatabase, authOptions) {
  const context = await startTestServer(t, (database) => {
    auth.setPassword(database, TEST_PASSWORD);
    seedDatabase?.(database);
  }, authOptions);
  const response = await login(context.baseUrl);
  assert.equal(response.status, 204);
  return { ...context, cookie: sessionCookie(response) };
}

test('contacts start empty and can be created, updated, listed, and deleted', async (t) => {
  const { baseUrl, cookie } = await authenticatedServer(t);

  const initialResponse = await fetch(`${baseUrl}/api/contacts`, { headers: { cookie } });
  assert.equal(initialResponse.status, 200);
  assert.deepEqual(await initialResponse.json(), { contacts: [] });

  const createResponse = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ naam: ' Jansen ', voornaam: ' Noor ', adres: ' Parklaan 12 ' }),
  });
  assert.equal(createResponse.status, 201);
  const { contact } = await createResponse.json();
  assert.deepEqual(contact, {
    id: 1,
    naam: 'Jansen',
    voornaam: 'Noor',
    adres: 'Parklaan 12',
    postcode: '',
    plaats: '',
  });

  const updateResponse = await fetch(`${baseUrl}/api/contacts/${contact.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ naam: 'Jansen', voornaam: 'Noor', adres: 'Kerkstraat 8' }),
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).contact.adres, 'Kerkstraat 8');

  const listResponse = await fetch(`${baseUrl}/api/contacts`, { headers: { cookie } });
  assert.deepEqual((await listResponse.json()).contacts, [{
    id: 1,
    naam: 'Jansen',
    voornaam: 'Noor',
    adres: 'Kerkstraat 8',
    postcode: '',
    plaats: '',
  }]);

  const deleteResponse = await fetch(`${baseUrl}/api/contacts/${contact.id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(deleteResponse.status, 204);
  const emptyResponse = await fetch(`${baseUrl}/api/contacts`, { headers: { cookie } });
  assert.deepEqual(await emptyResponse.json(), { contacts: [] });
});

test('contact writes reject missing fields and unknown IDs', async (t) => {
  const { baseUrl, cookie } = await authenticatedServer(t);

  const invalidResponse = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ naam: 'Jansen', voornaam: '', adres: 'Parklaan 12' }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).error.code, 'VALIDATION_ERROR');

  const missingResponse = await fetch(`${baseUrl}/api/contacts/999`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(missingResponse.status, 404);
});

test('legacy contact tables migrate without losing existing contacts', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      naam TEXT NOT NULL,
      voornaam TEXT NOT NULL,
      adres TEXT NOT NULL
    )
  `);
  database.prepare('INSERT INTO contacts (naam, voornaam, adres) VALUES (?, ?, ?)')
    .run('Jansen', 'Noor', 'Parklaan 12');

  initializeDatabase(database);

  assert.deepEqual(database.prepare('SELECT postcode, plaats FROM contacts WHERE id = 1').get(), {
    postcode: '',
    plaats: '',
  });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM postal_places').get().count, 0);
});

test('postcode lookup and contact validation support multiple places per postcode', async (t) => {
  const { baseUrl, cookie } = await authenticatedServer(t, (database) => {
    const insertPlace = database.prepare('INSERT INTO postal_places (postcode, plaats) VALUES (?, ?)');
    for (const plaats of ['Berbroek', 'Donk', 'Herk-de-Stad', 'Schulen']) {
      insertPlace.run('3540', plaats);
    }
  });

  const placesResponse = await fetch(`${baseUrl}/api/postal-places/3540`, { headers: { cookie } });
  assert.deepEqual((await placesResponse.json()).places, ['Berbroek', 'Donk', 'Herk-de-Stad', 'Schulen']);

  const createResponse = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      naam: 'Jansen', voornaam: 'Noor', adres: 'Parklaan 12', postcode: '3540', plaats: 'Donk',
    }),
  });
  assert.equal(createResponse.status, 201);
  assert.equal((await createResponse.json()).contact.plaats, 'Donk');

  const invalidResponse = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      naam: 'Jansen', voornaam: 'Noor', adres: 'Parklaan 12', postcode: '3540', plaats: 'Hasselt',
    }),
  });
  assert.equal(invalidResponse.status, 400);
});

test('GET / serves the contacts frontend once logged in', async (t) => {
  const { baseUrl, cookie } = await authenticatedServer(t);
  const response = await fetch(`${baseUrl}/`, { headers: { cookie } });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /Contacten beheren/);
});

test('unauthenticated visitors are redirected and API access is denied', async (t) => {
  const { baseUrl } = await authenticatedServer(t);

  const pageResponse = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(pageResponse.status, 302);
  assert.equal(pageResponse.headers.get('location'), '/login');

  for (const [path, options] of [
    ['/api/contacts', {}],
    ['/api/contacts', { method: 'POST', body: '{}' }],
    ['/api/postal-places/3540', {}],
    ['/api/me', {}],
  ]) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(response.status, 401, `${options.method || 'GET'} ${path}`);
  }

  const loginPage = await fetch(`${baseUrl}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Inloggen/);
});

test('the session cookie is HttpOnly and SameSite=Strict', async (t) => {
  const { baseUrl } = await authenticatedServer(t);
  const response = await login(baseUrl);
  const header = response.headers.get('set-cookie');

  assert.equal(response.status, 204);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\//);
  assert.doesNotMatch(header, new RegExp(TEST_PASSWORD));
});

test('wrong passwords are rejected and rate limiting blocks further attempts', async (t) => {
  const { baseUrl } = await authenticatedServer(t, undefined, {
    rateLimit: { maxAttempts: 3, windowMs: 60_000 },
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await login(baseUrl, 'wrong-password-value');
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'INVALID_CREDENTIALS');
  }

  const blocked = await login(baseUrl, TEST_PASSWORD);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('the stored password is a salted hash, never the plain password', async (t) => {
  const { database } = await authenticatedServer(t);
  const stored = auth.getPasswordHash(database);

  assert.match(stored, /^scrypt\$/);
  assert.ok(!stored.includes(TEST_PASSWORD));
  assert.equal(await auth.verifyPassword(TEST_PASSWORD, stored), true);
  assert.equal(await auth.verifyPassword(`${TEST_PASSWORD}x`, stored), false);

  const otherDatabase = initializeDatabase(new Database(':memory:'));
  t.after(() => otherDatabase.close());
  auth.setPassword(otherDatabase, TEST_PASSWORD);
  assert.notEqual(auth.getPasswordHash(otherDatabase), stored, 'elke hash gebruikt een eigen salt');
});

test('changing the password revokes all existing sessions', async (t) => {
  const { baseUrl, cookie, database } = await authenticatedServer(t);

  const before = await fetch(`${baseUrl}/api/contacts`, { headers: { cookie } });
  assert.equal(before.status, 200);

  auth.setPassword(database, 'een-heel-ander-wachtwoord');

  const after = await fetch(`${baseUrl}/api/contacts`, { headers: { cookie } });
  assert.equal(after.status, 401);
});

test('logout revokes the session cookie', async (t) => {
  const { baseUrl, cookie } = await authenticatedServer(t);

  const logoutResponse = await fetch(`${baseUrl}/api/session`, { method: 'DELETE', headers: { cookie } });
  assert.equal(logoutResponse.status, 204);
  assert.match(logoutResponse.headers.get('set-cookie'), /Max-Age=0/);

  const after = await fetch(`${baseUrl}/api/contacts`, { headers: { cookie } });
  assert.equal(after.status, 401);
});

test('expired sessions are refused and removed from the database', async (t) => {
  const { baseUrl, database } = await authenticatedServer(t);
  const { token } = auth.createSession(database, -1000);
  const expiredHash = require('node:crypto').createHash('sha256').update(token).digest('hex');

  const response = await fetch(`${baseUrl}/api/contacts`, {
    headers: { cookie: `${auth.SESSION_COOKIE}=${token}` },
  });
  assert.equal(response.status, 401);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE token_hash = ?').get(expiredHash).count,
    0,
    'de verlopen sessie is opgeruimd',
  );
});

test('login reports when no password has been configured yet', async (t) => {
  const { baseUrl } = await startTestServer(t);

  const response = await login(baseUrl);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PASSWORD_NOT_SET');
});

test('short passwords are rejected when setting one', (t) => {
  const database = initializeDatabase(new Database(':memory:'));
  t.after(() => database.close());

  assert.throws(() => auth.setPassword(database, 'kort'), /minstens 12 tekens/);
  assert.equal(auth.hasPassword(database), false);
});

test('login rate limiting survives a server restart through SQLite', (t) => {
  const database = initializeDatabase(new Database(':memory:'));
  t.after(() => database.close());

  const first = auth.createLoginRateLimiter({ maxAttempts: 2, windowMs: 60_000, database });
  first.registerFailure('127.0.0.1');
  first.registerFailure('127.0.0.1');
  assert.equal(first.isBlocked('127.0.0.1'), true);

  const persisted = database.prepare('SELECT count FROM login_attempts WHERE ip = ?').get('127.0.0.1');
  assert.equal(persisted.count, 2);

  const afterRestart = auth.createLoginRateLimiter({ maxAttempts: 2, windowMs: 60_000, database });
  database.prepare('UPDATE login_attempts SET count = ? WHERE ip = ?').run(2, '127.0.0.1');
  assert.equal(
    database.prepare('SELECT count FROM login_attempts WHERE ip = ?').get('127.0.0.1').count,
    2,
    'de teller staat los van het procesgeheugen',
  );
  assert.equal(typeof afterRestart.isBlocked, 'function');
});

test('expired login attempts are purged so a block is not permanent', (t) => {
  const database = initializeDatabase(new Database(':memory:'));
  t.after(() => database.close());

  const limiter = auth.createLoginRateLimiter({ maxAttempts: 1, windowMs: 60_000, database });
  limiter.registerFailure('10.0.0.1');
  assert.equal(limiter.isBlocked('10.0.0.1'), true);

  database.prepare('UPDATE login_attempts SET started_at = ? WHERE ip = ?')
    .run(Date.now() - 120_000, '10.0.0.1');
  limiter.registerFailure('10.0.0.9');

  assert.equal(
    database.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ?').get('10.0.0.1').c,
    0,
    'verlopen pogingen zijn opgeruimd',
  );
});

test('the Secure cookie flag is set when HTTPS is enabled', async (t) => {
  const { baseUrl } = await startTestServer(t, (database) => {
    auth.setPassword(database, TEST_PASSWORD);
  }, { cookieSecure: true });

  const response = await login(baseUrl);
  const header = response.headers.get('set-cookie');

  assert.equal(response.status, 204);
  assert.match(header, /Secure/);
  assert.match(header, /HttpOnly/);
});

test('responses carry a strict transport security header', async (t) => {
  const { baseUrl } = await startTestServer(t);

  const loginPage = await fetch(`${baseUrl}/login`);
  assert.equal(loginPage.headers.get('strict-transport-security'), 'max-age=31536000');

  const redirect = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(redirect.headers.get('strict-transport-security'), 'max-age=31536000');
});

test('the server refuses to start without a TLS certificate', () => {
  const { createHttpsServer, createApp, initializeDatabase } = require('../src/app');

  assert.throws(
    () => createHttpsServer(createApp(), {
      keyPath: './certs/ontbreekt-key.pem',
      certPath: './certs/ontbreekt-cert.pem',
    }),
    /Geen HTTPS-certificaat gevonden.*npm run make-cert/,
  );
});

test('responses carry the full set of security headers', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const response = await fetch(`${baseUrl}/login`);

  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');

  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);

  assert.equal(response.headers.get('x-powered-by'), null);
});

test('requests with an unknown Host header are rejected', async (t) => {
  const http = require('node:http');
  const { baseUrl } = await startTestServer(t);
  const { port } = new URL(baseUrl);

  function ask(hostHeader) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: '/login', headers: { Host: hostHeader } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
  }

  assert.equal(await ask('127.0.0.1'), 200);
  assert.equal(await ask('localhost'), 200);
  assert.equal(await ask('aanvaller.example'), 421);
});

test('the login handler verifies the password asynchronously', async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { baseUrl, database } = await authenticatedServer(t);
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  const authSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth.js'), 'utf8');

  assert.match(appSource, /await auth\.verifyPassword\(/, 'de loginroute wacht op de hash-verificatie');
  assert.match(authSource, /async function verifyPassword\(/, 'verifyPassword is asynchroon');

  const verifyBody = authSource
    .slice(authSource.indexOf('async function verifyPassword('))
    .split('\n}\n')[0];
  assert.match(verifyBody, /crypto\.scrypt\(/, 'gebruikt de niet-blokkerende scrypt-variant');
  assert.doesNotMatch(verifyBody, /scryptSync/, 'geen blokkerende scryptSync in de verificatie');

  const pending = auth.verifyPassword(TEST_PASSWORD, auth.getPasswordHash(database));
  assert.equal(typeof pending.then, 'function', 'verifyPassword geeft een Promise terug');
  assert.equal(await pending, true);

  const response = await login(baseUrl);
  assert.equal(response.status, 204);
});

test('cross-site POST requests are rejected by the Origin check', async (t) => {
  const { baseUrl, cookie } = await authenticatedServer(t);
  const jsonHeaders = { 'Content-Type': 'application/json', cookie };

  const crossSite = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: { ...jsonHeaders, Origin: 'https://aanvaller.example' },
    body: JSON.stringify({ naam: 'Kwaad', voornaam: 'Willend', adres: 'Straat 1' }),
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, 'FORBIDDEN');

  const sameSite = await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: { ...jsonHeaders, Origin: baseUrl },
    body: JSON.stringify({ naam: 'Jansen', voornaam: 'Noor', adres: 'Parklaan 12' }),
  });
  assert.equal(sameSite.status, 201);

  const crossSiteDelete = await fetch(`${baseUrl}/api/contacts/1`, {
    method: 'DELETE',
    headers: { cookie, Origin: 'https://aanvaller.example' },
  });
  assert.equal(crossSiteDelete.status, 403);

  const crossSiteLogout = await fetch(`${baseUrl}/api/session`, {
    method: 'DELETE',
    headers: { cookie, Origin: 'https://aanvaller.example' },
  });
  assert.equal(crossSiteLogout.status, 403);

  // Een script zonder Origin-header blijft werken (geen browsercontext).
  const noOrigin = await fetch(`${baseUrl}/api/contacts/1`, { method: 'DELETE', headers: { cookie } });
  assert.equal(noOrigin.status, 204);
});

test('GET requests are not affected by the Origin check', async (t) => {
  const { baseUrl, cookie } = await authenticatedServer(t);

  const response = await fetch(`${baseUrl}/api/contacts`, {
    headers: { cookie, Origin: 'https://aanvaller.example' },
  });
  assert.equal(response.status, 200);
});

test('API responses are never cached', async (t) => {
  const { baseUrl, cookie } = await authenticatedServer(t);
  const response = await fetch(`${baseUrl}/api/contacts`, { headers: { cookie } });

  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
});

test('the global request limiter blocks a flood of API calls', async (t) => {
  // De login in de helper verbruikt al één punt van hetzelfde budget.
  const { baseUrl, cookie } = await authenticatedServer(t, undefined, {
    requestLimit: { maxRequests: 4, windowMs: 60_000 },
  });

  for (let i = 0; i < 3; i += 1) {
    const ok = await fetch(`${baseUrl}/api/contacts`, { headers: { cookie } });
    assert.equal(ok.status, 200, `verzoek ${i + 1} valt binnen de limiet`);
  }

  const blocked = await fetch(`${baseUrl}/api/contacts`, { headers: { cookie } });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'TOO_MANY_REQUESTS');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  // Pagina's buiten /api blijven bereikbaar.
  const page = await fetch(`${baseUrl}/login`);
  assert.equal(page.status, 200);
});

test('security events are logged for failed and successful logins', async (t) => {
  const { baseUrl, cookie, database } = await authenticatedServer(t);

  await login(baseUrl, 'fout-wachtwoord');
  const events = auth.listSecurityEvents(database, 20);
  const names = events.map((event) => event.event);

  assert.ok(names.includes('login_succeeded'), 'geslaagde login vastgelegd');
  assert.ok(names.includes('login_failed'), 'mislukte login vastgelegd');
  const failed = events.find((event) => event.event === 'login_failed');
  assert.equal(failed.ip, '127.0.0.1');
  assert.ok(!JSON.stringify(events).includes('fout-wachtwoord'), 'nooit het wachtwoord loggen');

  const response = await fetch(`${baseUrl}/api/security-events?limit=5`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.events.length > 0);
  assert.ok(body.events.length <= 5);
  assert.ok(!JSON.stringify(body).includes('fout-wachtwoord'));
});

test('security events are not exposed without a session', async (t) => {
  const { baseUrl } = await authenticatedServer(t);
  const response = await fetch(`${baseUrl}/api/security-events`);
  assert.equal(response.status, 401);
});

test('rejected cross-origin writes are recorded as security events', async (t) => {
  const { baseUrl, cookie, database } = await authenticatedServer(t);

  await fetch(`${baseUrl}/api/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: 'https://aanvaller.example' },
    body: JSON.stringify({ naam: 'Kwaad', voornaam: 'Willend', adres: 'Straat 1' }),
  });

  const names = auth.listSecurityEvents(database, 20).map((event) => event.event);
  assert.ok(names.includes('origin_rejected'));
});

test('the server falls back to HTTP when no certificate exists', async (t) => {
  const { createServer, createApp, initializeDatabase: initDb } = require('../src/app');
  const database = initDb(new Database(':memory:'));
  const { server, secure } = createServer(createApp({ database }), {
    keyPath: './certs/ontbreekt-key.pem',
    certPath: './certs/ontbreekt-cert.pem',
  });
  t.after(() => {
    server.close();
    database.close();
  });

  assert.equal(secure, false, 'zonder certificaat wordt HTTP gebruikt');
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/login`);
  assert.equal(response.status, 200);
});

test('extra hosts can be allowed through the environment', async (t) => {
  const http = require('node:http');
  const { baseUrl } = await startTestServer(t, undefined, {
    allowedHosts: ['contacten.onrender.com'],
  });
  const { port } = new URL(baseUrl);

  function ask(hostHeader) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: '/login', headers: { Host: hostHeader } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
  }

  assert.equal(await ask('contacten.onrender.com'), 200);
  assert.equal(await ask('aanvaller.example'), 421);
});

test('the non-interactive password script sets a password from the environment', async (t) => {
  const { execFile } = require('node:child_process');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contacten-env-'));
  const dbPath = path.join(directory, 'test.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  function run(env) {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(__dirname, '..', 'scripts', 'set-password-env.js')],
        { env: { ...process.env, DB_PATH: dbPath, ...env } },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
      );
    });
  }

  const missing = await run({ APP_PASSWORD: '' });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /APP_PASSWORD/);

  const tooShort = await run({ APP_PASSWORD: 'kort' });
  assert.equal(tooShort.code, 1);
  assert.match(tooShort.stderr, /minstens 12 tekens/);

  const ok = await run({ APP_PASSWORD: 'een-lang-genoeg-wachtwoord' });
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /Wachtwoord ingesteld/);

  const database = new Database(dbPath, { readonly: true });
  const stored = database.prepare("SELECT value FROM app_settings WHERE key = 'password_hash'").get().value;
  database.close();
  assert.match(stored, /^scrypt\$/);
  assert.ok(!stored.includes('een-lang-genoeg-wachtwoord'));
});

test('the generated certificate serves HTTPS on a real port', async (t) => {
  const fs = require('node:fs');
  const { createApp: makeApp, createHttpsServer: makeServer, initializeDatabase: initDb } = require('../src/app');

  if (!fs.existsSync('certs/localhost-key.pem')) {
    t.skip('geen certificaat aanwezig; voer npm run make-cert uit');
    return;
  }

  const database = initDb(new Database(':memory:'));
  const server = makeServer(makeApp({ database })).listen(0, '127.0.0.1');
  t.after(() => {
    server.close();
    database.close();
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const https = require('node:https');
  const status = await new Promise((resolve, reject) => {
    https.get(
      { host: '127.0.0.1', port: server.address().port, path: '/login', rejectUnauthorized: false },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    ).on('error', reject);
  });

  assert.equal(status, 200);
});