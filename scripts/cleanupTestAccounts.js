// Archives (soft-deletes) test/demo/seed accounts so the client can start
// populating real Stockist + user data. Orders/inventory rows are never
// touched — history stays intact for reports.
//
// DRY RUN BY DEFAULT — prints what WOULD be archived and does not write.
// Pass --apply to actually soft-delete (is_deleted = 1). Never uses
// DELETE FROM.
//
// Targets:
//   - users whose email matches %test%, %demo%, %example.com%, %@nogatu.com%
//     (excluding super_admin role users — never touched)
//   - partners whose business_name matches %test%, %demo%, %sample%
//     (each archived partner also archives its non-super-admin users)
//
// Run (dry run):  node --env-file=.env.dev scripts/cleanupTestAccounts.js
// Run (apply):    node --env-file=.env.dev scripts/cleanupTestAccounts.js --apply
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');

const USER_EMAIL_PATTERNS = ['%test%', '%demo%', '%example.com%', '%@nogatu.com%'];
const PARTNER_NAME_PATTERNS = ['%test%', '%demo%', '%sample%'];

function printTable(title, rows) {
  console.log(`\n${title} (${rows.length})`);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  console.table(rows);
}

async function main() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nogatu_ncdms',
  });

  try {
    // 1. Partners matching test/demo/sample naming patterns.
    const partnerWhere = PARTNER_NAME_PATTERNS.map(() => 'business_name LIKE ?').join(' OR ');
    const [matchedPartners] = await pool.execute(
      `SELECT id, business_name, email
       FROM partners
       WHERE is_deleted = 0 AND (${partnerWhere})
       ORDER BY id`,
      PARTNER_NAME_PATTERNS
    );

    // 2. Users directly matching test/demo email patterns, excluding super_admin.
    const userEmailWhere = USER_EMAIL_PATTERNS.map(() => 'u.email LIKE ?').join(' OR ');
    const [emailMatchedUsers] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.partner_id, r.slug AS role_slug
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.is_deleted = 0
         AND r.slug != 'super_admin'
         AND (${userEmailWhere})
       ORDER BY u.id`,
      USER_EMAIL_PATTERNS
    );

    // 3. Users belonging to a matched partner (cascade), excluding super_admin.
    const userArchiveMap = new Map(); // id -> { id, name, email, reasons: Set }

    for (const u of emailMatchedUsers) {
      userArchiveMap.set(u.id, {
        id: u.id,
        name: u.name,
        email: u.email,
        reasons: new Set(['email matches test/demo pattern']),
      });
    }

    for (const partner of matchedPartners) {
      const [partnerUsers] = await pool.execute(
        `SELECT u.id, u.name, u.email
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.is_deleted = 0 AND u.partner_id = ? AND r.slug != 'super_admin'`,
        [partner.id]
      );
      for (const u of partnerUsers) {
        const reason = `belongs to archived Stockist #${partner.id} (${partner.business_name})`;
        if (userArchiveMap.has(u.id)) {
          userArchiveMap.get(u.id).reasons.add(reason);
        } else {
          userArchiveMap.set(u.id, { id: u.id, name: u.name, email: u.email, reasons: new Set([reason]) });
        }
      }
    }

    const usersToArchive = Array.from(userArchiveMap.values()).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      reason: Array.from(u.reasons).join('; '),
    }));

    const partnersToArchive = matchedPartners.map((p) => ({
      id: p.id,
      business_name: p.business_name,
      email: p.email,
      reason: 'business_name matches test/demo/sample pattern',
    }));

    console.log(APPLY ? '=== APPLYING (soft-delete) ===' : '=== DRY RUN (no changes made — pass --apply to archive) ===');
    printTable('Stockists (partners) to archive', partnersToArchive);
    printTable('Users to archive', usersToArchive);

    if (!APPLY) {
      console.log('\nDry run complete. Re-run with --apply to soft-delete the rows above.');
      return;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const u of usersToArchive) {
        await conn.execute('UPDATE users SET is_deleted = 1, status = ? WHERE id = ?', ['inactive', u.id]);
      }
      for (const p of partnersToArchive) {
        await conn.execute('UPDATE partners SET is_deleted = 1, status = ? WHERE id = ?', ['inactive', p.id]);
      }

      await conn.commit();
      console.log(`\nArchived ${partnersToArchive.length} Stockist(s) and ${usersToArchive.length} user(s).`);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
