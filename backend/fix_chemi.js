require('dotenv').config();
const db = require('./models/db');

async function run() {
  // chemi_games 테이블 상태 확인
  try {
    const { rows } = await db.query(
      `SELECT id, room_id, status, started_at FROM chemi_games ORDER BY started_at DESC LIMIT 10`
    );
    console.log('현재 chemi_games:', rows);
    
    // active 게임 전부 cancelled로
    const result = await db.query(
      `UPDATE chemi_games SET status='cancelled', ended_at=NOW() WHERE status='active' RETURNING id`
    );
    console.log(`active → cancelled: ${result.rows.length}개`);
  } catch(e) {
    console.log('테이블 없음:', e.message);
  }
  process.exit(0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
