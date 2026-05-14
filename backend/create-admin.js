/**
 * 관리자 계정 생성 스크립트
 * 사용법: node create-admin.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function createAdmin() {
  const email    = process.env.ADMIN_EMAIL    || 'admin@sasohan.net';
  const password = process.env.ADMIN_PASSWORD || 'Admin1234!';

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.rows.length) {
      console.log(`⚠️  이미 존재하는 계정: ${email}`);
      // 기존 계정을 admin으로 업그레이드
      await pool.query("UPDATE users SET role='admin', status='active' WHERE email=$1", [email]);
      console.log(`✅ ${email} 계정을 관리자로 업그레이드했습니다.`);
    } else {
      const hashed = await bcrypt.hash(password, 12);
      await pool.query(
        "INSERT INTO users (email, password, role, status) VALUES ($1,$2,'admin','active')",
        [email, hashed]
      );
      console.log(`✅ 관리자 계정 생성 완료`);
      console.log(`   이메일: ${email}`);
      console.log(`   비밀번호: ${password}`);
      console.log(`   ⚠️  반드시 로그인 후 비밀번호를 변경하세요!`);
    }
  } catch (err) {
    console.error('❌ 오류:', err.message);
  } finally {
    await pool.end();
  }
}

createAdmin();
