require('dotenv').config();
const db = require('./models/db');

async function run() {
  console.log('\n🔍 채팅방 진단\n' + '='.repeat(40));

  // 채팅방 목록
  const { rows: rooms } = await db.query(`
    SELECT cr.id as room_id, cr.match_id,
           m.status as match_status,
           m.owner_id, m.visual_id,
           op.name as owner_name, op.user_id as owner_profile_uid,
           vp.name as visual_name, vp.user_id as visual_profile_uid,
           (SELECT COUNT(*) FROM messages WHERE room_id=cr.id) as msg_count,
           (SELECT content FROM messages WHERE room_id=cr.id ORDER BY created_at DESC LIMIT 1) as last_msg
    FROM chat_rooms cr
    JOIN matches m ON m.id = cr.match_id
    LEFT JOIN profiles op ON op.user_id = m.owner_id
    LEFT JOIN profiles vp ON vp.user_id = m.visual_id
  `);

  console.log(`\n채팅방 수: ${rooms.length}`);
  rooms.forEach(r => {
    console.log(`\n  방 ID: ${r.room_id}`);
    console.log(`  매칭 상태: ${r.match_status}`);
    console.log(`  owner: ${r.owner_name||'프로필없음'} (${r.owner_id})`);
    console.log(`  visual: ${r.visual_name||'프로필없음'} (${r.visual_id})`);
    console.log(`  메시지: ${r.msg_count}개 | 마지막: ${r.last_msg||'없음'}`);
  });

  // chat.js GET / 쿼리 직접 테스트 (모든 cami 회원 기준)
  const { rows: camis } = await db.query(`SELECT id, email FROM users WHERE role='cami' AND status='active'`);
  console.log(`\n\n각 cami 회원의 채팅방 목록:`);
  for (const u of camis) {
    const { rows } = await db.query(`
      SELECT cr.id as room_id,
             CASE WHEN m.owner_id=$1 THEN m.visual_id ELSE m.owner_id END as partner_id,
             CASE WHEN m.owner_id=$1 THEN vp.name ELSE op.name END as partner_name,
             (SELECT content FROM messages WHERE room_id=cr.id ORDER BY created_at DESC LIMIT 1) as last_msg
      FROM chat_rooms cr
      JOIN matches m ON m.id = cr.match_id
      JOIN profiles op ON op.user_id = m.owner_id
      JOIN profiles vp ON vp.user_id = m.visual_id
      WHERE m.owner_id=$1 OR m.visual_id=$1
    `, [u.id]);
    console.log(`\n  ${u.email}:`);
    if (!rows.length) console.log('    채팅방 없음');
    else rows.forEach(r => console.log(`    → 상대: ${r.partner_name||'이름없음'} | 마지막: ${r.last_msg||'없음'}`));
  }

  process.exit(0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
