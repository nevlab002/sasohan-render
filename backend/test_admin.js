require('dotenv').config();
const db = require('./models/db');

async function run() {
  console.log('\n=== 관리자 회원관리 API 진단 ===\n');

  // 1. DB 연결 확인
  try {
    await db.query('SELECT 1');
    console.log('✅ DB 연결 정상');
  } catch(e) {
    console.log('❌ DB 연결 실패:', e.message);
    process.exit(1);
  }

  // 2. users 테이블 존재 및 컬럼 확인
  try {
    const { rows } = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' ORDER BY ordinal_position
    `);
    console.log('✅ users 컬럼:', rows.map(r=>r.column_name).join(', '));
  } catch(e) {
    console.log('❌ users 테이블 오류:', e.message);
  }

  // 3. 실제 회원 목록 쿼리 실행
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.email, u.role, u.status, u.created_at,
             p.name, p.age
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.role != 'admin'
      ORDER BY u.created_at DESC
      LIMIT 5
    `);
    console.log(`\n✅ 회원 목록 쿼리 성공: ${rows.length}명`);
    rows.forEach(u => console.log(`  [${u.role}/${u.status}] ${u.email} | ${u.name||'이름없음'}`));
  } catch(e) {
    console.log('❌ 회원 목록 쿼리 실패:', e.message);
  }

  // 4. profiles 테이블 컬럼 확인 (taste, hobby 등)
  try {
    const { rows } = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'profiles' ORDER BY ordinal_position
    `);
    const cols = rows.map(r=>r.column_name);
    console.log('\n✅ profiles 컬럼:', cols.join(', '));
    // admin.js가 참조하는 컬럼 체크
    const needed = ['taste','hobby'];
    needed.forEach(c => {
      if (!cols.includes(c)) console.log(`  ⚠️  '${c}' 컬럼 없음 → 쿼리 실패 원인`);
    });
  } catch(e) {
    console.log('❌ profiles 테이블 오류:', e.message);
  }

  // 5. admin.js 쿼리 그대로 실행
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.email, u.role, u.status, u.created_at,
             p.name, p.age, p.gender, p.region, p.job, p.photos, p.taste, p.hobby,
             (COALESCE(p.taste,'{}') || COALESCE(p.hobby,'{}')) as interests
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.role != 'admin'
      ORDER BY u.created_at DESC
    `);
    console.log(`\n✅ admin.js 실제 쿼리 성공: ${rows.length}명`);
  } catch(e) {
    console.log('\n❌ admin.js 실제 쿼리 실패:', e.message);
    console.log('  → 이게 "불러오기 실패"의 원인');
  }

  // 6. JWT_SECRET 환경변수 확인
  console.log('\nJWT_SECRET:', process.env.JWT_SECRET ? '✅ 설정됨' : '❌ 없음 → 인증 실패');

  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
