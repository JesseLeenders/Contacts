const { openDatabase } = require('../src/app');
const auth = require('../src/auth');

const database = openDatabase();
try {
  const events = auth.listSecurityEvents(database, Number(process.argv[2]) || 30);
  if (events.length === 0) {
    console.log('Geen security-events geregistreerd.');
  } else {
    console.log(`${events.length} recente security-events (nieuwste eerst):\n`);
    for (const event of events) {
      const time = new Date(event.created_at).toISOString().replace('T', ' ').slice(0, 19);
      const detail = event.detail ? ` — ${event.detail}` : '';
      console.log(`${time}  ${event.event.padEnd(18)} ${event.ip}${detail}`);
    }
  }
} finally {
  database.close();
}