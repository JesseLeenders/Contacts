const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('@e965/xlsx');
const { openDatabase } = require('../src/app');

const sourceUrl = 'https://www.bpost.be/sites/default/files/zipcodes/zipcodes_alpha_nl_2025.xls';
const minimumExpectedRows = 2000;

async function syncPostcodes() {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`De bpost-download mislukte: HTTP ${response.status}.`);
  }

  const fileContents = Buffer.from(await response.arrayBuffer());
  const workbook = XLSX.read(fileContents, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Het bpost-bestand bevat geen werkblad.');

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  const requiredColumns = ['Postcode', 'Plaatsnaam', 'Deelgemeente', 'Hoofdgemeente', 'Provincie'];
  if (!rows.length || requiredColumns.some((column) => !(column in rows[0]))) {
    throw new Error('De kolommen in het bpost-bestand zijn gewijzigd; de database is niet aangepast.');
  }
  if (rows.length < minimumExpectedRows) {
    throw new Error(`Onverwacht weinig postplaatsregels (${rows.length}); de database is niet aangepast.`);
  }

  const postalPlaces = rows.map((row, index) => {
    const rawPostcode = String(row.Postcode).trim();
    const postcode = rawPostcode.padStart(4, '0');
    const plaats = String(row.Plaatsnaam).trim();
    if (!/^\d{4}$/.test(postcode) || !plaats) {
      throw new Error(`Ongeldige postcode of plaats op Excel-rij ${index + 2}; de database is niet aangepast.`);
    }

    return {
      postcode,
      plaats,
      gemeente: String(row.Hoofdgemeente).trim(),
      deelgemeente: String(row.Deelgemeente).trim().toLowerCase() === 'ja' ? 1 : 0,
      provincie: String(row.Provincie).trim(),
    };
  });

  const database = openDatabase();
  try {
    const replacePostalPlaces = database.transaction((places) => {
      database.prepare('DELETE FROM postal_places').run();
      const insert = database.prepare(`
        INSERT INTO postal_places (postcode, plaats, gemeente, deelgemeente, provincie)
        VALUES (@postcode, @plaats, @gemeente, @deelgemeente, @provincie)
      `);
      for (const place of places) insert.run(place);
    });
    replacePostalPlaces(postalPlaces);
  } finally {
    database.close();
  }

  const dataDirectory = path.resolve(__dirname, '../data');
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(path.join(dataDirectory, 'bpost-postcodes.xls'), fileContents);
  const lastModified = response.headers.get('last-modified');
  console.log(`Geïmporteerd: ${postalPlaces.length} postcode-plaatscombinaties van bpost${lastModified ? ` (bron gewijzigd: ${lastModified})` : ''}.`);
}

syncPostcodes().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
