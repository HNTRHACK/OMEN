import { config } from './config.js';
import { createDatabase } from './postgres.js';
import { createAuth } from './auth.js';

const database = createDatabase(config.databaseUrl);
try {
  const command = process.argv[2];
  if (command === 'migrate') { await database.migrate(); console.log('Migrations applied.'); }
  else if (command === 'import') console.log(`Imported ${await database.importLegacy(config.dataDir)} legacy records. Source files were not changed.`);
  else if (command === 'account') {
    // Provisioning is an operator command; no public account-registration or privilege escalation route.
    const account = await database.transaction(() => createAuth(database).provision({
      username: process.env.OMEN_ACCOUNT_USERNAME, password: process.env.OMEN_ACCOUNT_PASSWORD,
      role: process.env.OMEN_ACCOUNT_ROLE || 'moderator', playerId: process.env.OMEN_ACCOUNT_PLAYER_ID || null,
      disabled: process.env.OMEN_ACCOUNT_DISABLED === '1',
    }));
    console.log(JSON.stringify(account));
  } else throw new Error('Usage: node server/manage.js migrate|import|account');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await database.close(); }
