const { openDatabase } = require('../src/app');
const { setPassword, hasPassword, PASSWORD_MIN_LENGTH } = require('../src/auth');

// Niet-interactief: leest het wachtwoord uit APP_PASSWORD.
// Bedoeld voor omgevingen zonder TTY, zoals de Render-shell of een build-stap.
const password = process.env.APP_PASSWORD;

if (!password) {
  console.error('Zet APP_PASSWORD in de omgeving voordat je dit script uitvoert.');
  console.error('Voorbeeld: APP_PASSWORD=... npm run set-password:env');
  process.exitCode = 1;
} else if (password.length < PASSWORD_MIN_LENGTH) {
  console.error(`Het wachtwoord moet minstens ${PASSWORD_MIN_LENGTH} tekens lang zijn.`);
  process.exitCode = 1;
} else {
  const database = openDatabase();
  try {
    const replacing = hasPassword(database);
    setPassword(database, password);
    console.log(replacing
      ? 'Wachtwoord vervangen. Alle bestaande sessies zijn uitgelogd.'
      : 'Wachtwoord ingesteld. Alle bestaande sessies zijn uitgelogd.');
  } finally {
    database.close();
  }
}