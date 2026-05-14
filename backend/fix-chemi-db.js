const db = require('./config/db');

async function main() {
  console.log('케미게임 DB 구조를 UUID/문자열 채팅방 기준으로 수정합니다...');
  const sqls = [
    `CREATE TABLE IF NOT EXISTS chemi_games (
      id SERIAL PRIMARY KEY,
      room_id TEXT NOT NULL,
      inviter_id TEXT,
      responder_id TEXT,
      topic TEXT,
      used_topics TEXT[] DEFAULT '{}',
      round INTEGER DEFAULT 1,
      score INTEGER DEFAULT 0,
      wrong_rounds INTEGER DEFAULT 0,
      answers JSONB DEFAULT '{}'::jsonb,
      status VARCHAR(20) DEFAULT 'pending',
      round_started_at TIMESTAMPTZ,
      answer_started_at TIMESTAMPTZ,
      deadline_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS chemi_scores (
      id SERIAL PRIMARY KEY,
      room_id TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      month VARCHAR(7) NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE chemi_games ALTER COLUMN room_id TYPE TEXT USING room_id::text`,
    `ALTER TABLE chemi_scores ALTER COLUMN room_id TYPE TEXT USING room_id::text`,
    `ALTER TABLE chemi_games ADD COLUMN IF NOT EXISTS inviter_id TEXT`,
    `ALTER TABLE chemi_games ADD COLUMN IF NOT EXISTS responder_id TEXT`,
    `ALTER TABLE chemi_games ALTER COLUMN inviter_id TYPE TEXT USING inviter_id::text`,
    `ALTER TABLE chemi_games ALTER COLUMN responder_id TYPE TEXT USING responder_id::text`,
    `ALTER TABLE chemi_games ADD COLUMN IF NOT EXISTS used_topics TEXT[] DEFAULT '{}'`,
    `ALTER TABLE chemi_games ADD COLUMN IF NOT EXISTS wrong_rounds INTEGER DEFAULT 0`,
    `ALTER TABLE chemi_games ADD COLUMN IF NOT EXISTS answers JSONB DEFAULT '{}'::jsonb`,
    `ALTER TABLE chemi_games ADD COLUMN IF NOT EXISTS round_started_at TIMESTAMPTZ`,
    `ALTER TABLE chemi_games ADD COLUMN IF NOT EXISTS answer_started_at TIMESTAMPTZ`,
    `ALTER TABLE chemi_games ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ`,
    `ALTER TABLE chemi_games ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ`,
    `CREATE UNIQUE INDEX IF NOT EXISTS chemi_scores_room_month_uq ON chemi_scores(room_id, month)`
  ];
  for (const sql of sqls) {
    console.log('실행:', sql.split('\n')[0].slice(0, 100));
    await db.query(sql);
  }
  const result = await db.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_name IN ('chemi_games','chemi_scores')
      AND column_name IN ('room_id','inviter_id','responder_id')
    ORDER BY table_name, column_name
  `);
  console.table(result.rows);
  console.log('완료: 케미게임 DB 구조 수정 완료');
}

main().catch(err => {
  console.error('실패:', err);
  process.exit(1);
}).finally(() => process.exit(0));
