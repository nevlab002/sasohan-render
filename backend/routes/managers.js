const router = require('express').Router();
const db     = require('../models/db');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');
let sharp; try { sharp = require('sharp'); } catch { sharp = null; }

async function optimizeMgrPhoto(filePath) {
  if (!sharp) return filePath;
  try {
    const dir     = path.dirname(filePath);
    const base    = path.basename(filePath, path.extname(filePath));
    const outPath = path.join(dir, `${base}.jpg`);
    await sharp(filePath).rotate()
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90, progressive: true })
      .toFile(outPath);
    if (outPath !== filePath) fs.unlink(filePath, () => {});
    return outPath;
  } catch { return filePath; }
}

const uploadDir = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => cb(null, `mgr_${uuidv4()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('이미지만 가능합니다.'));
  }
});

// 매니저 목록 (공개)
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM managers WHERE is_active=TRUE ORDER BY created_at ASC'
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// 매니저 등록 (관리자만)
router.post('/', authMiddleware, adminOnly, upload.single('photo'), async (req, res) => {
  const { name, title, intro, specialty } = req.body;
  if (!name) return res.status(400).json({ error: '이름은 필수입니다.' });
  try {
    let photo = null;
    if (req.file) {
      const optimized = await optimizeMgrPhoto(path.join(uploadDir, req.file.filename));
      photo = `/uploads/${path.basename(optimized)}`;
    }
    const specialtyArr = specialty ? JSON.parse(specialty) : [];
    const { rows } = await db.query(
      'INSERT INTO managers (name, photo, title, intro, specialty) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, photo, title||null, intro||null, specialtyArr]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// 매니저 수정
router.patch('/:id', authMiddleware, adminOnly, upload.single('photo'), async (req, res) => {
  const { name, title, intro, specialty, is_active } = req.body;
  try {
    const cur = await db.query('SELECT * FROM managers WHERE id=$1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: '매니저를 찾을 수 없습니다.' });
    let photo = cur.rows[0].photo;
    if (req.file) {
      const optimized = await optimizeMgrPhoto(path.join(uploadDir, req.file.filename));
      photo = `/uploads/${path.basename(optimized)}`;
    }
    const specialtyArr = specialty ? JSON.parse(specialty) : cur.rows[0].specialty;
    const { rows } = await db.query(
      'UPDATE managers SET name=$1,photo=$2,title=$3,intro=$4,specialty=$5,is_active=$6 WHERE id=$7 RETURNING *',
      [name||cur.rows[0].name, photo, title||cur.rows[0].title, intro||cur.rows[0].intro,
       specialtyArr, is_active !== undefined ? is_active : cur.rows[0].is_active, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// 매니저 삭제
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM managers WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// 내 매니저 선택
router.post('/select/:managerId', authMiddleware, async (req, res) => {
  try {
    const mgr = await db.query('SELECT id FROM managers WHERE id=$1 AND is_active=TRUE', [req.params.managerId]);
    if (!mgr.rows.length) return res.status(404).json({ error: '매니저를 찾을 수 없습니다.' });
    await db.query('UPDATE profiles SET manager_id=$1 WHERE user_id=$2', [req.params.managerId, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

module.exports = router;
