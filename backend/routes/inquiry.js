const router = require('express').Router();
const db     = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

async function ensureInquiriesTable() {
  // UUID 익스텐션 활성화 (둘 중 하나면 됨)
  try { await db.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"'); } catch {}
  try { await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'); } catch {}

  // UUID 기본값 함수 결정
  let uuidFn = 'gen_random_uuid()';
  try {
    await db.query('SELECT gen_random_uuid()');
  } catch {
    uuidFn = 'uuid_generate_v4()';
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id             UUID PRIMARY KEY DEFAULT ${uuidFn},
      user_id        UUID,
      contact_email  VARCHAR(255),
      title          VARCHAR(200) NOT NULL,
      content        TEXT NOT NULL,
      topic          VARCHAR(50) DEFAULT 'general',
      status         VARCHAR(20) DEFAULT 'pending',
      answer         TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      answered_at    TIMESTAMPTZ
    )
  `);

  const cols = [
    "topic VARCHAR(50) DEFAULT 'general'",
    "status VARCHAR(20) DEFAULT 'pending'",
    'answer TEXT',
    'answered_at TIMESTAMPTZ',
    'contact_email VARCHAR(255)'
  ];
  for (const col of cols) {
    await db.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }
  await db.query(`ALTER TABLE inquiries ALTER COLUMN user_id DROP NOT NULL`).catch(() => {});
}

// 문의 등록 (비로그인 허용)
router.post('/', async (req, res) => {
  const { title, content, body, topic, contact_email } = req.body;
  const text = content || body;

  if (!title?.trim() || !text?.trim()) {
    return res.status(400).json({ error: '제목과 내용을 입력해주세요.' });
  }

  let userId = null;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
      userId = decoded.id;
    } catch {}
  }

  // 비로그인 문의 시 이메일 필수
  if (!userId && !contact_email?.trim()) {
    return res.status(400).json({ error: '비로그인 문의 시 답변받을 이메일을 입력해주세요.' });
  }

  const email = contact_email?.trim() || null;

  try {
    await ensureInquiriesTable();
    const { rows } = await db.query(
      `INSERT INTO inquiries (user_id, contact_email, title, content, topic)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, content, topic, status, answer, answered_at, created_at`,
      [userId, email, title.trim(), text.trim(), topic || 'general']
    );
    res.status(201).json({ ok: true, id: rows[0].id, inquiry: rows[0] });
  } catch (err) {
    console.error('문의 등록 오류:', err.message);
    res.status(500).json({ error: '문의 등록 중 오류가 발생했습니다: ' + err.message });
  }
});

// 문의 ID로 상태 조회 (비로그인 공개 — 문의 ID를 아는 사람만 접근 가능)
router.get('/status/:id', async (req, res) => {
  const id = req.params.id;
  // UUID 형식 검사
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(404).json({ error: '문의를 찾을 수 없습니다.' });
  }
  try {
    await ensureInquiriesTable();
    const { rows } = await db.query(
      `SELECT id, title, topic, status, answer, answered_at, created_at
       FROM inquiries WHERE id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: '문의를 찾을 수 없습니다.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: '조회 중 오류가 발생했습니다.' });
  }
});

// 내 문의 목록 (로그인 필요)
router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureInquiriesTable();
    const { rows } = await db.query(
      `SELECT id, title, content, topic, status, answer, answered_at, created_at
       FROM inquiries
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('문의 목록 오류:', err.message);
    res.status(500).json({ error: '문의 내역을 불러오지 못했습니다: ' + err.message });
  }
});

module.exports = router;
