const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

async function ensureAdmin() {
  const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, NODE_ENV } = process.env;

  if (!DATABASE_URL) {
    console.log('DATABASE_URL is not set. Skipping admin setup.');
    return;
  }

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log('ADMIN_EMAIL or ADMIN_PASSWORD is not set. Skipping admin setup.');
    return;
  }

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [ADMIN_EMAIL]);

    if (existing.rows.length) {
      await pool.query(
        "UPDATE users SET role='admin', status='active' WHERE email=$1",
        [ADMIN_EMAIL]
      );
      console.log(`Admin account already exists and is active: ${ADMIN_EMAIL}`);
      return;
    }

    const hashed = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await pool.query(
      "INSERT INTO users (email, password, role, status) VALUES ($1,$2,'admin','active')",
      [ADMIN_EMAIL, hashed]
    );
    console.log(`Admin account created: ${ADMIN_EMAIL}`);
  } finally {
    await pool.end();
  }
}

ensureAdmin().catch((error) => {
  console.error('Admin setup failed:', error);
  process.exit(1);
});
