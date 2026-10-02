// Adds users.username (UNIQUE) so staff can sign in with the usernames management assigned
// (e.g. "rbere"), and backfills it from each email's local part where that local part is unambiguous.
//
// Why the backfill: login used to also match the email local part ("golden.stars1316") with LIMIT 1
// and no ORDER BY, which picked an arbitrary account when two emails shared a local part. Login now
// matches the email or the exact username only; backfilling keeps every UNAMBIGUOUS local-part login
// working, while ambiguous local parts get no username (those users sign in with their full email).
//
// Additive and idempotent: never overwrites an existing username, re-running changes nothing.
// Refuses to run without an env file so it can never fall back to a default database.
// Run: node --env-file=.env.dev scripts/addUsername.js
const mysql = require('mysql2/promise');
const { usernameFromEmail } = require('../src/utils/username');

/**
 * Picks usernames for users that have none. A candidate is used only when exactly one user (deleted
 * or not) produces it and no user already holds it, so the result never collides.
 */
function planUsernameBackfill(users) {
  const taken = new Set(users.map((u) => u.username).filter(Boolean));
  const producers = new Map();
  for (const user of users) {
    const candidate = usernameFromEmail(user.email);
    if (candidate) producers.set(candidate, (producers.get(candidate) || 0) + 1);
  }

  const assignments = [];
  let ambiguous = 0;
  let unusable = 0;
  for (const user of users) {
    if (user.username) continue;
    const candidate = usernameFromEmail(user.email);
    if (!candidate) { unusable += 1; continue; }
    if (producers.get(candidate) > 1 || taken.has(candidate)) { ambiguous += 1; continue; }
    assignments.push({ id: user.id, username: candidate });
  }
  return { assignments, ambiguous, unusable };
}

async function main() {
  if (!process.env.DB_NAME) {
    throw new Error('DB_NAME is not set. Run with --env-file=<.env.dev|.env.prod>.');
  }
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
  });

  try {
    const [columns] = await pool.execute(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'username' LIMIT 1`
    );
    if (columns.length > 0) {
      console.log('users.username already exists — skipping');
    } else {
      await pool.query('ALTER TABLE users ADD COLUMN username VARCHAR(50) NULL AFTER email');
      console.log('Added users.username');
    }

    const [indexes] = await pool.execute(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uq_users_username' LIMIT 1`
    );
    if (indexes.length > 0) {
      console.log('uq_users_username already exists — skipping');
    } else {
      await pool.query('ALTER TABLE users ADD UNIQUE INDEX uq_users_username (username)');
      console.log('Added unique index uq_users_username');
    }

    // Includes soft-deleted rows: the unique index spans them too.
    const [users] = await pool.execute('SELECT id, email, username FROM users');
    const { assignments, ambiguous, unusable } = planUsernameBackfill(users);
    let applied = 0;
    for (const { id, username } of assignments) {
      const [result] = await pool.execute(
        'UPDATE users SET username = ? WHERE id = ? AND username IS NULL',
        [username, id]
      );
      applied += result.affectedRows;
    }
    console.log(`Username backfill: ${applied} set, ${ambiguous} skipped (shared local part), ${unusable} skipped (unusable local part)`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('ERR', error.message);
    process.exit(1);
  });
}

module.exports = { planUsernameBackfill };
