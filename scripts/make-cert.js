const fs = require('node:fs');
const path = require('node:path');
const selfsigned = require('selfsigned');

const certificateDirectory = path.resolve(__dirname, '../certs');
const keyPath = path.join(certificateDirectory, 'localhost-key.pem');
const certPath = path.join(certificateDirectory, 'localhost-cert.pem');
const validityDays = 365;

async function generateCertificate(force = false) {
  if (!force && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log('Er bestaat al een certificaat in certs/. Gebruik --force om het te vervangen.');
    return;
  }

  fs.mkdirSync(certificateDirectory, { recursive: true });

  const attributes = [{ name: 'commonName', value: 'localhost' }];
  const { private: privateKey, cert: certificate } = await selfsigned.generate(attributes, {
    days: validityDays,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });

  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(certPath, certificate);

  console.log('Zelfondertekend certificaat aangemaakt:');
  console.log(`  sleutel: ${keyPath}`);
  console.log(`  certificaat: ${certPath}`);
  console.log(`  geldig: ${validityDays} dagen voor localhost en 127.0.0.1`);
  console.log('');
  console.log('Je browser zal waarschuwen omdat de uitgever onbekend is. Dat is normaal bij een');
  console.log('zelfondertekend certificaat; keur het eenmalig goed. De verbinding is daarna versleuteld.');
  console.log('Het certificaat staat in certs/ en hoort niet in versiebeheer.');
}

generateCertificate(process.argv.includes('--force')).catch((error) => {
  console.error(`Certificaat aanmaken mislukt: ${error.message}`);
  process.exitCode = 1;
});