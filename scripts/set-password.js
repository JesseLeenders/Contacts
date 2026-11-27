const { openDatabase } = require('../src/app');
const { setPassword, PASSWORD_MIN_LENGTH } = require('../src/auth');

function askHidden(label) {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(label);

    const cleanup = () => {
      process.stdin.off('data', onData);
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Afgebroken. Er is niets gewijzigd.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ') value += char;
      }
    };

    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    console.error('Dit script heeft een interactieve terminal nodig.');
    process.exitCode = 1;
    return;
  }

  const database = openDatabase();
  try {
    console.log(`Stel het gedeelde beheerderswachtwoord in (minstens ${PASSWORD_MIN_LENGTH} tekens).`);
    console.log('Het wachtwoord wordt niet getoond en komt niet in de shell-geschiedenis terecht.');

    const first = await askHidden('Wachtwoord: ');
    const second = await askHidden('Herhaal wachtwoord: ');

    if (first !== second) {
      console.error('De wachtwoorden zijn niet gelijk. Er is niets gewijzigd.');
      process.exitCode = 1;
      return;
    }

    setPassword(database, first);
    console.log('Wachtwoord opgeslagen als scrypt-hash. Alle bestaande sessies zijn uitgelogd.');
    console.log('Start de server opnieuw en log in via http://127.0.0.1:3000/login');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    database.close();
  }
}

main();