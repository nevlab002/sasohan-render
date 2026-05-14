require('dotenv').config();
const db = require('./models/db');

async function fix() {
  console.log('\n🔧 데이터 수정 시작\n' + '='.repeat(40));

  // 1. 프로필 없는 cami 회원에게 기본 프로필 생성
  const { rows: noProfiles } = await db.query(`
    SELECT u.id, u.email FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE u.role = 'cami' AND p.user_id IS NULL
  `);

  for (const u of noProfiles) {
    await db.query(`
      INSERT INTO profiles (user_id, name, age, gender, region, bio, photos, taste, hobby)
      VALUES ($1, $2, 25, 'male', '서울 기타', '', '{}', '{}', '{}')
      ON CONFLICT DO NOTHING
    `, [u.id, u.email.split('@')[0]]);
    console.log(`✅ 기본 프로필 생성: ${u.email}`);
  }

  // 2. owner_id = visual_id (자기 자신과 매칭)된 잘못된 매칭 취소
  const { rows: selfMatches } = await db.query(
    `SELECT id FROM matches WHERE owner_id = visual_id`
  );
  for (const m of selfMatches) {
    await db.query(`UPDATE matches SET status='cancelled' WHERE id=$1`, [m.id]);
    console.log(`✅ 자기 자신 매칭 취소: ${m.id}`);
  }

  if (!noProfiles.length && !selfMatches.length) {
    console.log('수정할 항목 없음');
  }

  // 3. 현재 상태 확인
  const { rows: camis } = await db.query(`
    SELECT u.email, p.name, u.status
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id
    WHERE u.role = 'cami'
  `);
  console.log('\n현재 cami 회원:');
  camis.forEach(c => console.log(`  ${c.email} / 이름:${c.name||'없음'} / ${c.status}`));

  const { rows: matches } = await db.query(
    `SELECT status, COUNT(*) as cnt FROM matches GROUP BY status`
  );
  console.log('\n매칭 현황:');
  matches.forEach(m => console.log(`  ${m.status}: ${m.cnt}건`));

  console.log('\n✅ 완료\n');
  process.exit(0);
}

fix().catch(e => { console.error('실패:', e.message); process.exit(1); });
