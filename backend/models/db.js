const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => console.log('✅ DB 연결됨'));
pool.on('error',   (err) => console.error('❌ DB 오류:', err));

module.exports = pool;
