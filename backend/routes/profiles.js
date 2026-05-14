const router = require('express').Router();
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');
const db     = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
let sharp; try { sharp = require('sharp'); } catch { sharp = null; }

// 업로드된 이미지를 최적화 (리사이즈 + JPEG 변환)
async function optimizeImage(filePath) {
  if (!sharp) return filePath; // sharp 없으면 원본 그대로
  try {
    const dir  = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const outPath = path.join(dir, `${base}.jpg`);

    await sharp(filePath)
      .rotate()                                     // EXIF 회전 자동 보정
      .resize(1600, 1600, {                         // 최대 1600px (retina 2x 기준)
        fit: 'inside',
        withoutEnlargement: true                    // 원본보다 크게 늘리지 않음
      })
      .jpeg({ quality: 90, progressive: true })     // 높은 품질 JPEG, 점진적 로딩
      .toFile(outPath);

    if (outPath !== filePath) fs.unlink(filePath, () => {}); // 원본 삭제
    return outPath;
  } catch (e) {
    console.error('이미지 최적화 오류:', e.message);
    return filePath; // 실패 시 원본 반환
  }
}

const uploadDir = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/webp','image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('이미지 파일만 업로드 가능합니다.'));
  }
});

function mergeInterestsInput(taste, hobby, interests) {
  return [...new Set([
    ...(Array.isArray(interests) ? interests : []),
    ...(Array.isArray(taste) ? taste : []),
    ...(Array.isArray(hobby) ? hobby : [])
  ].filter(Boolean))];
}

// 내 프로필 조회
router.get('/me', authMiddleware, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM profiles WHERE user_id=$1', [req.user.id]);
  res.json(rows[0] || null);
});

// 프로필 생성/수정
router.post('/me', authMiddleware, async (req, res) => {
  const { name, age, gender, region, bio, job, photos, height, weight, taste, hobby, interests } = req.body;
  const mergedInterests = mergeInterestsInput(taste, hobby, interests);
  try {
    const existing = await db.query('SELECT id FROM profiles WHERE user_id=$1', [req.user.id]);
    let result;
    if (existing.rows.length) {
      if (Array.isArray(photos)) {
        result = await db.query(
          `UPDATE profiles SET name=$1,age=$2,gender=$3,region=$4,bio=$5,job=$6,photos=$7::text[],
           height=$8,weight=$9,taste=$10::text[],hobby=$11::text[],updated_at=NOW()
           WHERE user_id=$12 RETURNING *`,
          [name,age,gender,region,bio,job,photos,height||null,weight||null,mergedInterests,[],req.user.id]
        );
      } else {
        result = await db.query(
          `UPDATE profiles SET name=$1,age=$2,gender=$3,region=$4,bio=$5,job=$6,
           height=$7,weight=$8,taste=$9::text[],hobby=$10::text[],updated_at=NOW()
           WHERE user_id=$11 RETURNING *`,
          [name,age,gender,region,bio,job,height||null,weight||null,mergedInterests,[],req.user.id]
        );
      }
    } else {
      result = await db.query(
        `INSERT INTO profiles (user_id,name,age,gender,region,bio,job,height,weight,taste,hobby)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11::text[]) RETURNING *`,
        [req.user.id,name,age,gender,region,bio,job,height||null,weight||null,mergedInterests,[]]
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '프로필 저장 실패' });
  }
});

// 사진 업로드/교체
// slot: 0=대표사진, 1~3=추가사진
// 프론트에서 photo 또는 photos 이름으로 보내도 모두 처리
router.post('/photos/:slot?', authMiddleware, upload.any(), async (req, res) => {
  try {
    const files = req.files || [];

    if (!files.length) {
      return res.status(400).json({ error: '업로드할 파일이 없습니다.' });
    }

    const slotRaw = req.params.slot ?? req.body.slot;
    const slot = slotRaw === undefined || slotRaw === null || slotRaw === ''
      ? null
      : parseInt(slotRaw, 10);

    if (slot !== null && (!Number.isInteger(slot) || slot < 0 || slot > 3)) {
      return res.status(400).json({ error: '사진 위치가 올바르지 않습니다.' });
    }

    const cur = await db.query(
      'SELECT * FROM profiles WHERE user_id=$1',
      [req.user.id]
    );

    if (!cur.rows.length) {
      return res.status(400).json({
        error: '기본 프로필을 먼저 저장한 뒤 사진을 업로드해주세요.'
      });
    }

    // 이미지 최적화 (리사이즈 + JPEG 변환)
    const rawPath     = path.join(uploadDir, files[0].filename);
    const optimized   = await optimizeImage(rawPath);
    const finalName   = path.basename(optimized);
    const uploadedUrl = `/uploads/${finalName}`;

    let photos = Array.isArray(cur.rows[0]?.photos)
      ? [...cur.rows[0].photos]
      : [];

    if (slot !== null) {
      while (photos.length <= slot) photos.push('');
      photos[slot] = uploadedUrl;
    } else {
      const emptyIndex = photos.findIndex(v => !v);
      if (emptyIndex >= 0 && emptyIndex <= 3) photos[emptyIndex] = uploadedUrl;
      else photos.push(uploadedUrl);
    }

    photos = photos.slice(0, 4);

    const { rows } = await db.query(
      `UPDATE profiles
       SET photos=$1::text[], updated_at=NOW()
       WHERE user_id=$2
       RETURNING *`,
      [photos, req.user.id]
    );

    res.json({
      ok: true,
      photo: uploadedUrl,
      photos: rows[0]?.photos || photos,
      profile: rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '사진 업로드 실패' });
  }
});


// 사진 삭제 (슬롯 번호로)
router.delete('/photos/:slot', authMiddleware, async (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (isNaN(slot) || slot < 0 || slot > 3) return res.status(400).json({ error: '올바르지 않은 슬롯 번호입니다.' });
  try {
    const cur = await db.query('SELECT photos FROM profiles WHERE user_id=$1', [req.user.id]);
    if (!cur.rows.length) return res.status(404).json({ error: '프로필이 없습니다.' });
    const photos = Array.isArray(cur.rows[0].photos) ? [...cur.rows[0].photos] : [];
    if (slot < photos.length) photos[slot] = '';
    const cleaned = photos.map((p, i) => (i === slot ? '' : p));
    const { rows } = await db.query(
      `UPDATE profiles SET photos=$1::text[], updated_at=NOW() WHERE user_id=$2 RETURNING *`,
      [cleaned, req.user.id]
    );
    res.json({ ok: true, photos: rows[0]?.photos || cleaned });
  } catch (err) {
    console.error('사진 삭제 오류:', err.message);
    res.status(500).json({ error: '사진 삭제 실패' });
  }
});

// 특정 유저 프로필 조회
router.get('/:userId', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, u.role, u.status FROM profiles p
       JOIN users u ON u.id = p.user_id
       WHERE p.user_id=$1 AND u.status!='blocked'`,
      [req.params.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: '프로필을 찾을 수 없습니다.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

// 비주얼 회원 목록 (매칭용) - active 오너만
router.get('/', authMiddleware, async (req, res) => {
  try {
    const me = await db.query('SELECT role, status FROM users WHERE id=$1', [req.user.id]);
    if (me.rows[0]?.role !== 'owner' || me.rows[0]?.status !== 'active') {
      return res.status(403).json({ error: '활성화된 오너 회원만 이용 가능합니다.' });
    }
    const { rows } = await db.query(
      `SELECT p.*, u.id as user_id, u.role FROM profiles p
       JOIN users u ON u.id = p.user_id
       WHERE u.role='visual' AND u.status='active'
         AND u.id NOT IN (
           SELECT blocked_id FROM blocks WHERE blocker_id=$1
           UNION SELECT blocker_id FROM blocks WHERE blocked_id=$1
         )
       ORDER BY RANDOM() LIMIT 20`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

module.exports = router;
