const router  = require('express').Router();
const db      = require('../models/db');
const multer  = require('multer');
const { authMiddleware, adminOnly } = require('../middleware/auth');

// site_settings 테이블 자동 생성
db.query(`
  CREATE TABLE IF NOT EXISTS site_settings (
    key   VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(() => {});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('이미지만 가능'));
  }
});

// ── 설정 전체 조회 (공개) ─────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT key, value FROM site_settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) {
    console.error('settings GET 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 설정 저장 (관리자) ────────────────────
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object')
    return res.status(400).json({ error: '잘못된 데이터' });
  try {
    for (const [key, value] of Object.entries(settings)) {
      await db.query(
        `INSERT INTO site_settings (key, value, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
        [key, value ?? '']
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('settings POST 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 이미지 업로드 (관리자) ───────────────
router.post('/upload', authMiddleware, adminOnly, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('multer 오류:', err.message);
      return res.status(400).json({ error: err.message || '업로드 실패' });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  const { key } = req.body;
  const url = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  try {
    if (key) {
      await db.query(
        `INSERT INTO site_settings (key, value, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
        [key, url]
      );
    }
    res.json({ ok: true, url });
  } catch (err) {
    console.error('settings upload DB 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

module.exports = router;
