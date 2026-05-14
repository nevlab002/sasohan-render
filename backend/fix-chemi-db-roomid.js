// fix-chemi-db-roomid.js
// 실행 위치: backend 폴더
// 실행 명령: node fix-chemi-db-roomid.js

require('dotenv').config();
const db = require('./models/db');

async function tableExists(tableName) {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=$1
     ) AS exists`,
    [tableName]
  );
  return rows[0].exists;
}

async function columnType(tableName, columnName) {
  const { rows } = await db.query(
    `SELECT data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name=$1
        AND column_name=$2`,
    [tableName, columnName]
  );
  return rows[0] || null;
}

async function fixRoomIdType(tableName) {
  const exists = await tableExists(tableName);
  if (!exists) {
    console.log(`- ${tableName}: 테이블 없음, 건너뜀`);
    return;
  }

  const before = await columnType(tableName, 'room_id');
  if (!before) {
    console.log(`- ${tableName}.room_id: 컬럼 없음, 건너뜀`);
    return;
  }

  console.log(`- ${tableName}.room_id 현재 타입: ${before.data_type} / ${before.udt_name}`);

  if (before.data_type === 'text') {
    console.log(`  → 이미 TEXT 타입입니다.`);
    return;
  }

  await db.query(`ALTER TABLE ${tableName} ALTER COLUMN room_id DROP DEFAULT`);
  await db.query(`ALTER TABLE ${tableName} ALTER COLUMN room_id TYPE TEXT USING room_id::text`);

  const after = await columnType(tableName, 'room_id');
  console.log(`  → 변경 완료: ${after.data_type} / ${after.udt_name}`);
}

async function main() {
  console.log('\n[케미게임 DB room_id 타입 수정 시작]\n');

  await db.query('BEGIN');
  try {
    // 진행 중이던 꼬인 케미게임은 안전하게 종료 처리
    const gamesExists = await tableExists('chemi_games');
    if (gamesExists) {
      const { rowCount } = await db.query(
        `UPDATE chemi_games
            SET status='cancelled', ended_at=COALESCE(ended_at, NOW())
          WHERE status IN ('pending','active')`
      );
      console.log(`- 진행 중/대기 중 케미게임 정리: ${rowCount}건`);
    }

    await fixRoomIdType('chemi_games');
    await fixRoomIdType('chemi_scores');

    // 필요한 인덱스 재생성
    const gamesExists2 = await tableExists('chemi_games');
    if (gamesExists2) {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_chemi_games_room_status ON chemi_games(room_id, status)`);
    }

    const scoresExists = await tableExists('chemi_scores');
    if (scoresExists) {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_chemi_scores_score ON chemi_scores(score DESC)`);
    }

    await db.query('COMMIT');
    console.log('\n✅ 수정 완료! 이제 node server.js 를 다시 실행하세요.\n');
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('\n❌ 수정 실패:', err.message);
    console.error('상세:', err);
    process.exitCode = 1;
  } finally {
    if (db.end) await db.end().catch(() => {});
  }
}

main();
