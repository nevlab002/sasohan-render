require('dotenv').config();
const db = require('./models/db');

async function diagnose() {
  console.log('\n🔍 매칭/채팅 상세 진단\n' + '='.repeat(40));

  // 1. cami 회원 프로필 현황
  console.log('\n① cami 회원 프로필');
  const { rows: camis } = await db.query(`
    SELECT u.id, u.email, u.status,
           p.name, p.age, p.region,
           ARRAY_LENGTH(p.photos, 1) as photo_count
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE u.role = 'cami'
    ORDER BY u.created_at
  `);
  camis.forEach(u => {
    console.log(`  ${u.email}`);
    console.log(`    이름:${u.name||'❌없음'} 나이:${u.age||'❌없음'} 지역:${u.region||'없음'} 사진:${u.photo_count||0}장 상태:${u.status}`);
  });

  // 2. 매칭 현황
  console.log('\n② 매칭 현황');
  const { rows: matches } = await db.query(`
    SELECT m.id, m.status, m.matched_at,
           op.name as a이름, vp.name as b이름,
           cr.id as room_id
    FROM matches m
    JOIN profiles op ON op.user_id = m.owner_id
    JOIN profiles vp ON vp.user_id = m.visual_id
    LEFT JOIN chat_rooms cr ON cr.match_id = m.id
    ORDER BY m.created_at DESC LIMIT 10
  `);
  if (!matches.length) console.log('  ⚠️  매칭 없음');
  else matches.forEach(m =>
    console.log(`  [${m.status}] ${m.a이름||'?'} ↔ ${m.b이름||'?'} room:${m.room_id||'없음'}`)
  );

  // 3. 채팅방 현황
  console.log('\n③ 채팅방 현황');
  const { rows: rooms } = await db.query(`
    SELECT cr.id, COUNT(msg.id) as msg_count
    FROM chat_rooms cr
    LEFT JOIN messages msg ON msg.room_id = cr.id
    GROUP BY cr.id
  `);
  if (!rooms.length) console.log('  ⚠️  채팅방 없음');
  else rooms.forEach(r => console.log(`  방 ${r.id}: 메시지 ${r.msg_count}개`));

  // 4. 실제 recommend 쿼리 테스트 (첫 번째 cami로)
  console.log('\n④ 추천 쿼리 테스트');
  if (camis.length >= 2) {
    const testUser = camis[0];
    const { rows: rec } = await db.query(`
      SELECT p.name, u.role, u.status
      FROM profiles p
      JOIN users u ON u.id = p.user_id
      WHERE u.id != $1
        AND u.status = 'active'
        AND u.role = 'cami'
      LIMIT 10
    `, [testUser.id]);
    console.log(`  ${testUser.email} 기준으로 보이는 cami: ${rec.length}명`);
    rec.forEach(r => console.log(`    - ${r.name||'이름없음'} (${r.role}/${r.status})`));
  } else {
    console.log('  cami 회원이 2명 미만 - 테스트 불가');
  }

  // 5. profiles에 프로필이 없는 cami 확인
  console.log('\n⑤ 프로필 미작성 cami');
  const { rows: noprofile } = await db.query(`
    SELECT u.email FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE u.role = 'cami' AND p.user_id IS NULL
  `);
  if (noprofile.length) noprofile.forEach(u => console.log(`  ❌ ${u.email} - 프로필 없음`));
  else console.log('  ✅ 모든 cami에 프로필 있음');

  console.log('\n' + '='.repeat(40) + '\n');
  process.exit(0);
}

diagnose().catch(e => { console.error('실패:', e.message); process.exit(1); });
