const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let Service;
try {
  ({ Service } = require('node-windows'));
} catch {
  console.error('node-windows is niet geinstalleerd (optionele dependency, alleen Windows).');
  console.error('Installeer het met: npm install node-windows');
  process.exit(1);
}

const serviceName = 'Jesse';
const projectRoot = path.resolve(__dirname, '..');
const certificateKey = path.join(projectRoot, 'certs', 'localhost-key.pem');
const certificateCert = path.join(projectRoot, 'certs', 'localhost-cert.pem');

const service = new Service({
  name: serviceName,
  description: 'Jesse contacts application (HTTPS only)',
  script: path.join(projectRoot, 'src', 'app.js'),
  workingDirectory: projectRoot,
  execPath: process.execPath,
});

function setAutomaticStartup() {
  execFile('sc.exe', ['config', serviceName, 'start=', 'auto'], (error, stdout, stderr) => {
    if (error) {
      console.error(stderr || error.message);
      process.exitCode = 1;
      return;
    }

    console.log(stdout.trim());
    service.start();
  });
}

service.on('install', setAutomaticStartup);
service.on('start', () => console.log(`Service ${serviceName} is running.`));
service.on('uninstall', () => console.log(`Service ${serviceName} was removed.`));
service.on('alreadyinstalled', () => {
  console.error(`Service ${serviceName} already exists. Uninstall it before reinstalling.`);
  process.exitCode = 1;
});
service.on('alreadyuninstalled', () => console.log(`Service ${serviceName} is not installed.`));
service.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

if (process.argv[2] === 'install') {
  if (!fs.existsSync(certificateKey) || !fs.existsSync(certificateCert)) {
    console.error('Geen HTTPS-certificaat gevonden in certs/. Voer eerst npm run make-cert uit.');
    process.exitCode = 1;
  } else {
    service.install();
  }
} else if (process.argv[2] === 'uninstall') {
  service.uninstall();
} else {
  console.error('Usage: node scripts/service.js <install|uninstall>');
  process.exitCode = 1;
}