const crypto = require('node:crypto');

const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = 'sid';
const PASSWORD_MIN_LENGTH = 12;

function initializeAuthTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      started_at INTEGER NOT NULL
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      event TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT ''
    )
  `);
  database.exec(
    'CREATE INDEX IF NOT EXISTS security_events_created_at ON security_events (created_at)',
  );

  return database;
}

const SECURITY_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function logSecurityEvent(database, { event, ip = '', detail = '' } = {}) {
  if (!database || typeof event !== 'string' || event === '') return;

  try {
    database.prepare(
      'INSERT INTO security_events (created_at, event, ip, detail) VALUES (?, ?, ?, ?)',
    ).run(Date.now(), event, String(ip).slice(0, 64), String(detail).slice(0, 300));
  } catch {
    // Loggen mag nooit een verzoek laten falen.
  }
}

function purgeSecurityEvents(database, retentionMs = SECURITY_LOG_RETENTION_MS) {
  if (!database) return;
  try {
    database.prepare('DELETE FROM security_events WHERE created_at <= ?')
      .run(Date.now() - retentionMs);
  } catch {
    // Opruimen is best-effort.
  }
}

function listSecurityEvents(database, limit = 50) {
  if (!database) return [];
  return database.prepare(`
    SELECT id, created_at, event, ip, detail
    FROM security_events
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.min(Math.max(Number(limit) || 50, 1), 500));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N},${SCRYPT_PARAMS.r},${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

    const [N, r, p] = parts[1].split(',').map(Number);
    if (![N, r, p].every((value) => Number.isInteger(value) && value > 0)) return false;

    const salt = Buffer.from(parts[2], 'base64');
    const expected = Buffer.from(parts[3], 'base64');
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = await new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_PARAMS.maxmem }, (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      });
    });

    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function getPasswordHash(database) {
  const row = database.prepare("SELECT value FROM app_settings WHERE key = 'password_hash'").get();
  return row ? row.value : null;
}

function hasPassword(database) {
  return Boolean(getPasswordHash(database));
}

function setPassword(database, password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Het wachtwoord moet minstens ${PASSWORD_MIN_LENGTH} tekens lang zijn.`);
  }

  const passwordHash = hashPassword(password);
  const savePassword = database.transaction(() => {
    database.prepare(`
      INSERT INTO app_settings (key, value) VALUES ('password_hash', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(passwordHash);
    database.prepare('DELETE FROM sessions').run();
  });
  savePassword();
  return passwordHash;
}

function digestToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(database, ttlMs = SESSION_TTL_MS) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  database.prepare(
    'INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
  ).run(digestToken(token), now, now + ttlMs);
  return { token, ttlMs };
}

function findSession(database, token) {
  if (typeof token !== 'string' || token.length === 0) return null;

  const tokenHash = digestToken(token);
  const session = database.prepare(
    'SELECT token_hash, expires_at FROM sessions WHERE token_hash = ?',
  ).get(tokenHash);
  if (!session) return null;

  if (session.expires_at <= Date.now()) {
    database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return session;
}

function revokeSession(database, token) {
  if (typeof token !== 'string' || token.length === 0) return;
  database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digestToken(token));
}

function revokeAllSessions(database) {
  database.prepare('DELETE FROM sessions').run();
}

function purgeExpiredSessions(database) {
  database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const name = part.slice(0, separator).trim();
    if (!name || name in cookies) continue;

    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

function sessionTokenFromRequest(request) {
  return parseCookies(request.headers.cookie)[SESSION_COOKIE] || '';
}

function serializeSessionCookie(token, maxAgeSeconds, { secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function serializeClearedCookie({ secure = false } = {}) {
  return serializeSessionCookie('', 0, { secure });
}

function createRequestRateLimiter({ maxRequests = 240, windowMs = 60 * 1000 } = {}) {
  const buckets = new Map();

  function bucketFor(ip) {
    const now = Date.now();
    const bucket = buckets.get(ip);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      const fresh = { count: 0, startedAt: now };
      buckets.set(ip, fresh);
      return fresh;
    }
    return bucket;
  }

  return {
    hit(ip) {
      const bucket = bucketFor(ip);
      bucket.count += 1;

      if (buckets.size > 5000) {
        for (const [key, value] of buckets) {
          if (Date.now() - value.startedAt >= windowMs) buckets.delete(key);
        }
      }

      return bucket.count <= maxRequests;
    },
    retryAfterSeconds(ip) {
      const bucket = bucketFor(ip);
      const remaining = windowMs - (Date.now() - bucket.startedAt);
      return Math.max(1, Math.ceil(remaining / 1000));
    },
  };
}

function createLoginRateLimiter({ maxAttempts = 10, windowMs = 15 * 60 * 1000, database = null } = {}) {
  const attempts = new Map();

  function entryFor(ip) {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now - entry.startedAt > windowMs) {
      const fresh = { count: 0, startedAt: now };
      attempts.set(ip, fresh);
      return fresh;
    }
    return entry;
  }

  function persist(ip, entry) {
    if (!database) return;
    try {
      database.prepare(`
        INSERT INTO login_attempts (ip, count, started_at) VALUES (?, ?, ?)
        ON CONFLICT(ip) DO UPDATE SET count = excluded.count, started_at = excluded.started_at
      `).run(ip, entry.count, entry.startedAt);
    } catch {
      // De in-memory teller blijft werken als de database tijdelijk niet beschikbaar is.
    }
  }

  function purgeStaleFromDatabase() {
    if (!database) return;
    try {
      database.prepare('DELETE FROM login_attempts WHERE started_at <= ?').run(Date.now() - windowMs);
    } catch {
      // Opruimen is best-effort.
    }
  }

  return {
    isBlocked(ip) {
      return entryFor(ip).count >= maxAttempts;
    },
    registerFailure(ip) {
      const entry = entryFor(ip);
      entry.count += 1;
      persist(ip, entry);
      if (attempts.size > 1000) {
        for (const [key, value] of attempts) {
          if (Date.now() - value.startedAt > windowMs) attempts.delete(key);
        }
      }
      purgeStaleFromDatabase();
    },
    registerSuccess(ip) {
      attempts.delete(ip);
      if (!database) return;
      try {
        database.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
      } catch {
        // Best-effort.
      }
    },
    retryAfterSeconds(ip) {
      const entry = entryFor(ip);
      const remaining = windowMs - (Date.now() - entry.startedAt);
      return Math.max(1, Math.ceil(remaining / 1000));
    },
  };
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  PASSWORD_MIN_LENGTH,
  initializeAuthTables,
  hashPassword,
  verifyPassword,
  getPasswordHash,
  hasPassword,
  setPassword,
  createSession,
  findSession,
  revokeSession,
  revokeAllSessions,
  purgeExpiredSessions,
  parseCookies,
  sessionTokenFromRequest,
  serializeSessionCookie,
  serializeClearedCookie,
  createLoginRateLimiter,
  createRequestRateLimiter,
  logSecurityEvent,
  purgeSecurityEvents,
  listSecurityEvents,
  SECURITY_LOG_RETENTION_MS,
};