require('dotenv').config();
const db = require('./models/db');

async function diagnose() {
  console.log('\n🔍 캐미 라인 서버 진단\n' + '='.repeat(40));

  // 1. 환경변수
  console.log('\n① 환경변수');
  console.log('  JWT_SECRET:', process.env.JWT_SECRET ? '✅ 설정됨' : '❌ 없음');
  console.log('  DATABASE_URL:', process.env.DATABASE_URL ? '✅ 설정됨' : '❌ 없음');
  console.log('  PORT:', process.env.PORT || '4000 (기본값)');

  // 2. DB 연결
  console.log('\n② DB 연결');
  try {
    await db.query('SELECT 1');
    console.log('  연결: ✅ 성공');
  } catch(e) {
    console.log('  연결: ❌ 실패 -', e.message);
    process.exit(1);
  }

  // 3. 테이블 존재
  console.log('\n③ 테이블 목록');
  const { rows: tables } = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
  );
  const tableNames = tables.map(t => t.tablename);
  const required = ['users','profiles','matches','chat_rooms','messages',
    'notifications','proposals','inquiries','managers','site_settings'];
  const optional = ['profile_likes','blocks','reports','reviews','manager_calls'];

  required.forEach(t => console.log(`  ${tableNames.includes(t)?'✅':'❌'} ${t} (필수)`));
  optional.forEach(t => console.log(`  ${tableNames.includes(t)?'✅':'⚠️ '} ${t} (선택)`));

  // 4. 회원 현황
  console.log('\n④ 회원 현황');
  const { rows: users } = await db.query(
    `SELECT role, status, COUNT(*) as cnt FROM users GROUP BY role, status ORDER BY role, status`
  );
  if (!users.length) {
    console.log('  ⚠️  회원이 없습니다. 관리자 계정을 먼저 만들어야 합니다.');
  } else {
    users.forEach(u => console.log(`  role=${u.role}, status=${u.status}: ${u.cnt}명`));
  }

  // 5. profiles 컬럼 확인
  console.log('\n⑤ profiles 컬럼');
  const { rows: cols } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='profiles' ORDER BY ordinal_position`
  );
  const colNames = cols.map(c => c.column_name);
  const needed = ['user_id','name','age','gender','region','job','bio','photos','taste','hobby','likes_count','manager_id'];
  needed.forEach(c => console.log(`  ${colNames.includes(c)?'✅':'❌'} ${c}`));

  // 6. users 컬럼 확인
  console.log('\n⑥ users 컬럼');
  const { rows: ucols } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position`
  );
  const ucolNames = ucols.map(c => c.column_name);
  ['id','email','password','role','status','created_at'].forEach(c =>
    console.log(`  ${ucolNames.includes(c)?'✅':'❌'} ${c}`)
  );

  console.log('\n' + '='.repeat(40));
  console.log('진단 완료\n');
  process.exit(0);
}

diagnose().catch(e => { console.error('진단 실패:', e.message); process.exit(1); });
