const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function runMigration() {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL is not set. Skipping database migration.');
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    const exists = await pool.query("SELECT to_regclass('public.users') AS table_name");

    if (exists.rows[0].table_name) {
      console.log('Database schema already exists. Skipping migration.');
      return;
    }

    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schema);
    console.log('Database schema created.');
  } finally {
    await pool.end();
  }
}

runMigration().catch((error) => {
  console.error('Database migration failed:', error);
  process.exit(1);
});
