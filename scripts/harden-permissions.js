const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const keyPath = path.join(projectRoot, 'certs', 'localhost-key.pem');
const certPath = path.join(projectRoot, 'certs', 'localhost-cert.pem');
const dataDirectory = path.join(projectRoot, 'data');

function runIcacls(args) {
  return new Promise((resolve, reject) => {
    execFile('icacls', args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || error.message} (icacls ${args.join(' ')})`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function hardenFile(filePath, { currentUser }) {
  // Inheritance uitschakelen: alleen de huidige gebruiker, SYSTEM en Administrators.
  await runIcacls([filePath, '/inheritance:r']);
  await runIcacls([filePath, '/grant:r', `${currentUser}:(R,W)`]);
  await runIcacls([filePath, '/grant:r', 'SYSTEM:(F)']);
  await runIcacls([filePath, '/grant:r', 'Administrators:(F)']);
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('Dit script gebruikt icacls en werkt alleen op Windows.');
    process.exitCode = 1;
    return;
  }

  const currentUser = process.env.USERNAME;
  if (!currentUser) {
    console.error('Kan de huidige gebruiker niet bepalen.');
    process.exitCode = 1;
    return;
  }

  const targets = [
    { label: 'TLS-sleutel', filePath: keyPath, mustExist: true },
    { label: 'SQLite-database', filePath: path.join(dataDirectory, 'contacts.db'), mustExist: false },
    { label: 'Database-map', filePath: dataDirectory, mustExist: true, directory: true },
  ];

  for (const target of targets) {
    if (!fs.existsSync(target.filePath)) {
      if (target.mustExist) {
        console.error(`${target.label} ontbreekt: ${target.filePath}`);
        process.exitCode = 1;
        return;
      }
      console.log(`${target.label}: nog niet aanwezig, overgeslagen.`);
      continue;
    }

    try {
      await hardenFile(target.filePath, { currentUser });
      if (!target.directory) {
        await runIcacls([target.filePath, '/inheritance:r']);
      }
      console.log(`${target.label}: rechten beperkt tot ${currentUser}, SYSTEM en Administrators.`);
    } catch (error) {
      console.error(`${target.label}: ${error.message}`);
      process.exitCode = 1;
    }
  }

  if (process.exitCode === 1) return;

  console.log('');
  console.log('Certificaatbestanden:');
  for (const file of [keyPath, certPath]) {
    if (fs.existsSync(file)) console.log(`  ${path.relative(projectRoot, file)}`);
  }
  console.log('');
  console.log('Let op: de service draait als LocalSystem en heeft daarmee al toegang.');
  console.log('Gebruik een eigen service-account als je de rechten verder wilt beperken.');
}

main();