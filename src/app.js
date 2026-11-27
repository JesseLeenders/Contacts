const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const express = require('express');
const Database = require('better-sqlite3');
const auth = require('./auth');

const DEFAULT_HTTPS_PORT = 3443;
const DEFAULT_HTTP_PORT = 3000;
const HSTS_HEADER = 'max-age=31536000';
const SECURITY_HEADERS = {
  'Strict-Transport-Security': HSTS_HEADER,
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function allowedHostsFromEnvironment() {
  const configured = (process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return [...LOCAL_HOSTS, ...configured];
}

const ALLOWED_HOSTS = new Set(allowedHostsFromEnvironment());
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function loadTlsCertificate({
  keyPath = process.env.TLS_KEY_PATH || './certs/localhost-key.pem',
  certPath = process.env.TLS_CERT_PATH || './certs/localhost-cert.pem',
} = {}) {
  const resolvedKey = path.resolve(keyPath);
  const resolvedCert = path.resolve(certPath);
  const missing = [resolvedKey, resolvedCert].filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `Geen HTTPS-certificaat gevonden (${missing.join(', ')}).`
      + ' Maak er eerst een met npm run make-cert. De app start alleen met HTTPS.',
    );
  }
  return { key: fs.readFileSync(resolvedKey), cert: fs.readFileSync(resolvedCert) };
}

function createHttpsServer(app, tlsOptions = {}) {
  return https.createServer({ ...loadTlsCertificate(tlsOptions), minVersion: 'TLSv1.2' }, app);
}

function tlsCertificatesAvailable(tlsOptions = {}) {
  try {
    loadTlsCertificate(tlsOptions);
    return true;
  } catch {
    return false;
  }
}

function createServer(app, tlsOptions = {}) {
  // Zonder certificaat starten we HTTP: op Render termineert de load balancer TLS.
  if (tlsCertificatesAvailable(tlsOptions)) {
    return { server: createHttpsServer(app, tlsOptions), secure: true };
  }
  return { server: http.createServer(app), secure: false };
}

function initializeDatabase(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      naam TEXT NOT NULL,
      voornaam TEXT NOT NULL,
      adres TEXT NOT NULL,
      postcode TEXT NOT NULL DEFAULT '',
      plaats TEXT NOT NULL DEFAULT ''
    )
  `);

  const contactColumns = new Set(database.pragma('table_info(contacts)').map((column) => column.name));
  if (!contactColumns.has('postcode')) {
    database.exec("ALTER TABLE contacts ADD COLUMN postcode TEXT NOT NULL DEFAULT ''");
  }
  if (!contactColumns.has('plaats')) {
    database.exec("ALTER TABLE contacts ADD COLUMN plaats TEXT NOT NULL DEFAULT ''");
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS postal_places (
      postcode TEXT NOT NULL,
      plaats TEXT NOT NULL,
      gemeente TEXT NOT NULL DEFAULT '',
      deelgemeente INTEGER NOT NULL DEFAULT 0,
      provincie TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (postcode, plaats)
    )
  `);

  auth.initializeAuthTables(database);

  return database;
}

function openDatabase(dbPath = process.env.DB_PATH || './data/contacts.db') {
  const resolvedPath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  return initializeDatabase(new Database(resolvedPath));
}

function initializeConfiguredPassword(database, password = process.env.APP_PASSWORD) {
  if (typeof password !== 'string' || password.length === 0 || auth.hasPassword(database)) {
    return false;
  }

  auth.setPassword(database, password);
  auth.logSecurityEvent(database, { event: 'password_initialized', ip: 'system' });
  return true;
}

function validateContact(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Vul alle contactgegevens in.' };
  }

  const contact = {
    naam: typeof body.naam === 'string' ? body.naam.trim() : '',
    voornaam: typeof body.voornaam === 'string' ? body.voornaam.trim() : '',
    adres: typeof body.adres === 'string' ? body.adres.trim() : '',
    postcode: typeof body.postcode === 'string' ? body.postcode.trim() : '',
    plaats: typeof body.plaats === 'string' ? body.plaats.trim() : '',
  };

  if (!contact.naam || !contact.voornaam || !contact.adres) {
    return { error: 'Naam, voornaam en adres zijn verplicht.' };
  }

  if (contact.naam.length > 100 || contact.voornaam.length > 100 || contact.adres.length > 300) {
    return { error: 'Naam en voornaam mogen maximaal 100 tekens bevatten; adres maximaal 300.' };
  }

  if (Boolean(contact.postcode) !== Boolean(contact.plaats)) {
    return { error: 'Vul zowel de postcode als de bijbehorende plaats in.' };
  }
  if (contact.postcode && !/^\d{4}$/.test(contact.postcode)) {
    return { error: 'Een Belgische postcode bestaat uit vier cijfers.' };
  }

  return { contact };
}

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function databaseError(response, error) {
  console.error(error);
  response.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'De gegevens konden niet worden opgeslagen of opgehaald.',
    },
  });
}

function createApp({ database = openDatabase(), authOptions = {} } = {}) {
  const app = express();
  const runningBehindProxy = process.env.NODE_ENV === 'production'
    || process.env.TRUST_PROXY === 'true'
    || Boolean(process.env.RENDER);
  const cookieSecure = authOptions.cookieSecure
    ?? (process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE !== 'false' : true);
  const rateLimiter = auth.createLoginRateLimiter({ ...authOptions.rateLimit, database });
  const requestLimiter = auth.createRequestRateLimiter(authOptions.requestLimit);

  app.disable('x-powered-by');
  app.set('trust proxy', runningBehindProxy ? 1 : false);

  const enforceHostHeader = authOptions.enforceHostHeader ?? process.env.ALLOW_ANY_HOST !== 'true';
  app.use((request, response, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.setHeader(name, value);
    }

    if (enforceHostHeader) {
      const hostname = (request.headers.host || '').replace(/:\d+$/, '').toLowerCase();
      const allowed = [...ALLOWED_HOSTS, ...(authOptions.allowedHosts || [])].map((host) => host.toLowerCase());
      if (!allowed.includes(hostname)) {
        response.status(421).type('text/plain').send('Onbekende hostnaam.');
        return;
      }
    }
    next();
  });

  app.use('/api', (request, response, next) => {
    const ip = request.ip || 'unknown';
    if (!requestLimiter.hit(ip)) {
      auth.logSecurityEvent(database, { event: 'rate_limited', ip, detail: request.path });
      response.set('Retry-After', String(requestLimiter.retryAfterSeconds(ip)));
      response.status(429).json({
        error: { code: 'TOO_MANY_REQUESTS', message: 'Te veel verzoeken. Probeer het later opnieuw.' },
      });
      return;
    }

    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    next();
  });

  app.use(express.json({ limit: '16kb' }));

  const enforceOrigin = authOptions.enforceOrigin ?? process.env.ALLOW_CROSS_ORIGIN !== 'true';
  const crossOriginError = {
    error: { code: 'FORBIDDEN', message: 'Verzoek vanaf een andere site is geweigerd.' },
  };

  app.use((request, response, next) => {
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }
    if (!enforceOrigin) {
      next();
      return;
    }

    // Browsers sturen Origin mee bij elke niet-GET. Ontbreekt hij, dan is het
    // geen browserverzoek (curl, script) en dus niet CSRF-gevoelig.
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || origin === '') {
      next();
      return;
    }

    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      response.status(403).json(crossOriginError);
      return;
    }

    if (originHost !== (request.headers.host || '').toLowerCase()) {
      auth.logSecurityEvent(database, {
        event: 'origin_rejected',
        ip: request.ip || 'unknown',
        detail: `${request.method} ${request.path}`,
      });
      response.status(403).json(crossOriginError);
      return;
    }

    next();
  });

  function currentSession(request) {
    return auth.findSession(database, auth.sessionTokenFromRequest(request));
  }

  function requirePageSession(request, response, next) {
    if (currentSession(request)) {
      next();
      return;
    }
    response.redirect(302, '/login');
  }

  function requireApiSession(request, response, next) {
    if (currentSession(request)) {
      next();
      return;
    }
    response.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Log eerst in om contacten te beheren.' },
    });
  }

  app.get('/login', (request, response) => {
    if (currentSession(request)) {
      response.redirect(302, '/');
      return;
    }
    response.sendFile(path.join(__dirname, '../public/login.html'));
  });

  app.post('/api/session', async (request, response) => {
    const storedHash = auth.getPasswordHash(database);
    if (!storedHash) {
      response.status(503).json({
        error: { code: 'PASSWORD_NOT_SET', message: 'Er is nog geen wachtwoord ingesteld. Voer eerst npm run set-password uit.' },
      });
      return;
    }

    const ip = request.ip || 'unknown';
    if (rateLimiter.isBlocked(ip)) {
      const retryAfter = rateLimiter.retryAfterSeconds(ip);
      response.set('Retry-After', String(retryAfter)).status(429).json({
        error: { code: 'TOO_MANY_ATTEMPTS', message: 'Te veel mislukte pogingen. Probeer het later opnieuw.' },
      });
      return;
    }

    const password = request.body?.password;
    if (typeof password !== 'string' || password.length === 0) {
      response.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Vul je wachtwoord in.' },
      });
      return;
    }

    if (!(await auth.verifyPassword(password, storedHash))) {
      rateLimiter.registerFailure(ip);
      auth.logSecurityEvent(database, { event: 'login_failed', ip, detail: 'ongeldig wachtwoord' });
      response.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Onjuist wachtwoord.' },
      });
      return;
    }

    rateLimiter.registerSuccess(ip);
    auth.purgeExpiredSessions(database);
    auth.purgeSecurityEvents(database);
    auth.logSecurityEvent(database, { event: 'login_succeeded', ip });
    const { token, ttlMs } = auth.createSession(database);
    response.setHeader(
      'Set-Cookie',
      auth.serializeSessionCookie(token, Math.floor(ttlMs / 1000), { secure: cookieSecure }),
    );
    response.status(204).end();
  });

  app.delete('/api/session', (request, response) => {
    auth.revokeSession(database, auth.sessionTokenFromRequest(request));
    response.setHeader('Set-Cookie', auth.serializeClearedCookie({ secure: cookieSecure }));
    response.status(204).end();
  });

  app.get('/api/me', requireApiSession, (request, response) => {
    const session = currentSession(request);
    response.status(200).json({
      authenticated: true,
      expiresAt: new Date(session.expires_at).toISOString(),
    });
  });

  app.get('/api/security-events', requireApiSession, (request, response) => {
    try {
      const events = auth.listSecurityEvents(database, request.query.limit)
        .map((event) => ({
          id: event.id,
          createdAt: new Date(event.created_at).toISOString(),
          event: event.event,
          ip: event.ip,
          detail: event.detail,
        }));
      response.status(200).json({ events });
    } catch (error) {
      databaseError(response, error);
    }
  });

  app.get('/api/postal-places/:postcode', requireApiSession, (request, response) => {
    const { postcode } = request.params;
    if (!/^\d{4}$/.test(postcode)) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Een Belgische postcode bestaat uit vier cijfers.' } });
      return;
    }

    try {
      const places = database.prepare(
        'SELECT plaats FROM postal_places WHERE postcode = ? ORDER BY plaats COLLATE NOCASE',
      ).all(postcode).map(({ plaats }) => plaats);
      response.status(200).json({ places });
    } catch (error) {
      databaseError(response, error);
    }
  });

  app.get('/api/contacts', requireApiSession, (_request, response) => {
    try {
      const contacts = database.prepare(
        'SELECT id, naam, voornaam, adres, postcode, plaats FROM contacts ORDER BY naam COLLATE NOCASE, voornaam COLLATE NOCASE, id',
      ).all();
      response.status(200).json({ contacts });
    } catch (error) {
      databaseError(response, error);
    }
  });

  app.post('/api/contacts', requireApiSession, (request, response) => {
    const result = validateContact(request.body);
    if (result.error) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: result.error } });
      return;
    }

    if (result.contact.postcode && !database.prepare(
      'SELECT 1 FROM postal_places WHERE postcode = ? AND plaats = ?',
    ).get(result.contact.postcode, result.contact.plaats)) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Kies een plaats die bij deze postcode hoort.' } });
      return;
    }

    try {
      const insert = database.prepare(
        'INSERT INTO contacts (naam, voornaam, adres, postcode, plaats) VALUES (@naam, @voornaam, @adres, @postcode, @plaats)',
      );
      const { lastInsertRowid } = insert.run(result.contact);
      const contact = database.prepare(
        'SELECT id, naam, voornaam, adres, postcode, plaats FROM contacts WHERE id = ?',
      ).get(lastInsertRowid);
      response.status(201).json({ contact });
    } catch (error) {
      databaseError(response, error);
    }
  });

  app.put('/api/contacts/:id', requireApiSession, (request, response) => {
    const id = parseId(request.params.id);
    if (!id) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Ongeldig contactnummer.' } });
      return;
    }

    const result = validateContact(request.body);
    if (result.error) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: result.error } });
      return;
    }

    if (result.contact.postcode && !database.prepare(
      'SELECT 1 FROM postal_places WHERE postcode = ? AND plaats = ?',
    ).get(result.contact.postcode, result.contact.plaats)) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Kies een plaats die bij deze postcode hoort.' } });
      return;
    }

    try {
      const update = database.prepare(
        'UPDATE contacts SET naam = @naam, voornaam = @voornaam, adres = @adres, postcode = @postcode, plaats = @plaats WHERE id = @id',
      );
      const outcome = update.run({ ...result.contact, id });
      if (outcome.changes === 0) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contact niet gevonden.' } });
        return;
      }

      const contact = database.prepare(
        'SELECT id, naam, voornaam, adres, postcode, plaats FROM contacts WHERE id = ?',
      ).get(id);
      response.status(200).json({ contact });
    } catch (error) {
      databaseError(response, error);
    }
  });

  app.delete('/api/contacts/:id', requireApiSession, (request, response) => {
    const id = parseId(request.params.id);
    if (!id) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Ongeldig contactnummer.' } });
      return;
    }

    try {
      const outcome = database.prepare('DELETE FROM contacts WHERE id = ?').run(id);
      if (outcome.changes === 0) {
        response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contact niet gevonden.' } });
        return;
      }
      response.status(204).end();
    } catch (error) {
      databaseError(response, error);
    }
  });

  app.use('/vendor/pico', express.static(
    path.join(__dirname, '../node_modules/@picocss/pico/css'),
  ));

  const publicDirectory = path.join(__dirname, '../public');
  app.get(['/', '/index.html'], requirePageSession, (_request, response) => {
    response.sendFile(path.join(publicDirectory, 'index.html'));
  });
  app.get('/app.js', requirePageSession, (_request, response) => {
    response.sendFile(path.join(publicDirectory, 'app.js'));
  });
  app.get('/styles.css', (_request, response) => {
    response.sendFile(path.join(publicDirectory, 'styles.css'));
  });
  app.get('/login.html', (_request, response) => {
    response.sendFile(path.join(publicDirectory, 'login.html'));
  });
  app.get('/login.js', (_request, response) => {
    response.sendFile(path.join(publicDirectory, 'login.js'));
  });

  const pageAliases = new Set(['/', '/index.html', '/app.js']);
  app.use((request, response, next) => {
    if (pageAliases.has(request.path)) {
      response.redirect(302, '/login');
      return;
    }
    next();
  });

  app.use((error, _request, response, next) => {
    if (error.type === 'entity.parse.failed') {
      response.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Ongeldige JSON in het verzoek.' },
      });
      return;
    }
    if (response.headersSent) {
      next(error);
      return;
    }
    databaseError(response, error);
  });

  return app;
}

if (require.main === module) {
  const hasCertificates = tlsCertificatesAvailable();
  const port = Number(process.env.PORT) || (hasCertificates ? DEFAULT_HTTPS_PORT : DEFAULT_HTTP_PORT);
  // Op een host zonder certificaat (zoals Render) moet de app op alle interfaces luisteren.
  const host = process.env.HOST || (hasCertificates ? '127.0.0.1' : '0.0.0.0');

  const database = openDatabase();
  if (process.env.APP_PASSWORD) {
    try {
      const initialized = initializeConfiguredPassword(database);
      console.log(initialized
        ? 'Initiële APP_PASSWORD als scrypt-hash opgeslagen.'
        : 'Wachtwoord bestaat al; APP_PASSWORD niet gebruikt.');
    } catch (error) {
      console.error(`APP_PASSWORD instellen mislukt: ${error.message}`);
      database.close();
      process.exit(1);
    } finally {
      delete process.env.APP_PASSWORD;
    }
  }

  const { server, secure } = createServer(createApp({ database }));

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `Poort ${port} op ${host} is al in gebruik. Er draait waarschijnlijk nog een oude server.`
        + ` Stop dat proces of kies een andere poort met PORT=${port + 1} npm start.`,
      );
      return;
    }
    console.error(error.message);
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(`Contactenlijst beschikbaar op ${secure ? 'https' : 'http'}://${host}:${port}`);
    if (secure) {
      console.log('Lokaal HTTPS met eigen certificaat.');
    } else {
      console.log('Geen certificaat gevonden: HTTP-modus, bedoeld achter een TLS-proxy.');
      if (process.env.NODE_ENV === 'production') {
        console.log('Waarschuwing: zorg dat een proxy HTTPS afhandelt voordat je dit publiek gebruikt.');
      }
    }
  });

  // Houd kwaadwillige trage verbindingen kort; Node's standaard is 5 minuten.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
}

module.exports = {
  createApp,
  createHttpsServer,
  createServer,
  loadTlsCertificate,
  tlsCertificatesAvailable,
  initializeDatabase,
  initializeConfiguredPassword,
  openDatabase,
  validateContact,
};
