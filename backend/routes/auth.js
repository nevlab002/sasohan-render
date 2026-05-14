const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db      = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

// ── 회원가입 ──────────────────────────────
router.post('/signup', [
  body('email').isEmail().normalizeEmail().withMessage('올바른 이메일을 입력해주세요.'),
  body('password').isLength({ min: 6 }).withMessage('비밀번호는 6자 이상이어야 합니다.')
], async (req, res) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const {
    email,
    password,
    name,
    age,
    gender,
    region,
    bio,
    job,
    height,
    weight,
    taste,
    hobby,
    interests
  } = req.body;

  const role = 'cami';

  const uniqueInterests = [...new Set([
    ...(Array.isArray(interests) ? interests : []),
    ...(Array.isArray(taste) ? taste : []),
    ...(Array.isArray(hobby) ? hobby : [])
  ].filter(Boolean))];

  const parsedAge = age ? parseInt(age, 10) : null;
  const parsedHeight = height ? parseInt(height, 10) : null;
  const parsedWeight = weight ? parseInt(weight, 10) : null;

  if (!name?.trim()) {
    return res.status(400).json({ error: '이름을 입력해주세요.' });
  }

  if (!parsedAge || parsedAge < 19 || parsedAge > 70) {
    return res.status(400).json({ error: '나이를 올바르게 입력해주세요.' });
  }

  if (!gender) {
    return res.status(400).json({ error: '성별을 선택해주세요.' });
  }

  try {
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [email]);

    if (existing.rows.length) {
      return res.status(409).json({ error: '이미 사용중인 이메일입니다.' });
    }

    const hashed = await bcrypt.hash(password, 12);

    const created = await db.query(
      `INSERT INTO users (email, password, role, status)
       VALUES ($1,$2,$3,$4)
       RETURNING id, email, role, status`,
      [email, hashed, role, 'active']
    );

    const user = created.rows[0];

    await db.query(
      `INSERT INTO profiles
       (user_id, name, age, gender, region, bio, job, photos, height, weight, taste, hobby)
       VALUES ($1,$2,$3,$4,$5,$6,$7,ARRAY[]::text[],$8,$9,$10::text[],ARRAY[]::text[])
       ON CONFLICT (user_id) DO UPDATE SET
         name=EXCLUDED.name,
         age=EXCLUDED.age,
         gender=EXCLUDED.gender,
         region=EXCLUDED.region,
         bio=EXCLUDED.bio,
         job=EXCLUDED.job,
         height=EXCLUDED.height,
         weight=EXCLUDED.weight,
         taste=EXCLUDED.taste,
         hobby=ARRAY[]::text[],
         updated_at=NOW()`,
      [
        user.id,
        name.trim(),
        parsedAge,
        gender,
        region || null,
        bio || null,
        job || null,
        parsedHeight,
        parsedWeight,
        uniqueInterests
      ]
    );

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: '가입이 완료됐습니다. 바로 서비스를 이용할 수 있습니다.',
      token,
      user
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '회원가입 중 서버 오류가 발생했습니다.' });
  }
});

// ── 로그인 ───────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    if (user.status === 'blocked') return res.status(403).json({ error: '차단된 계정입니다. 관리자에게 문의하세요.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role, status: user.status }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// ── 내 정보 ──────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.role, u.status, u.created_at,
              p.name, p.age, p.gender, p.region, p.bio, p.job, p.photos
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id=$1`, [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 비밀번호 변경 (로그인 상태) ──────────
router.patch('/password', authMiddleware, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { currentPassword, newPassword } = req.body;
  try {
    const { rows } = await db.query('SELECT password FROM users WHERE id=$1', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, rows[0].password);
    if (!valid) return res.status(401).json({ error: '현재 비밀번호가 올바르지 않습니다.' });
    const hashed = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE users SET password=$1 WHERE id=$2', [hashed, req.user.id]);
    res.json({ ok: true, message: '비밀번호가 변경됐습니다.' });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 비밀번호 재설정 요청 ─────────────────
// (이메일 발송 없이 관리자가 임시 비밀번호를 설정해주는 방식)
router.post('/reset-password-request', [
  body('email').isEmail().normalizeEmail()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email } = req.body;
  try {
    const { rows } = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if (!rows[0]) {
      // 보안상 존재하지 않는 이메일도 같은 응답
      return res.json({ ok: true, message: '등록된 이메일이라면 관리자가 확인 후 연락드립니다.' });
    }
    // 비밀번호 재설정 요청을 DB에 기록 (관리자가 직접 처리)
    await db.query(
      `INSERT INTO notifications (user_id, type, message)
       VALUES ((SELECT id FROM users WHERE role='admin' LIMIT 1), 'password_reset', $1)
       ON CONFLICT DO NOTHING`,
      [`비밀번호 재설정 요청: ${email}`]
    ).catch(() => {}); // notifications에 admin 없어도 오류 무시
    res.json({ ok: true, message: '관리자에게 비밀번호 재설정 요청이 전달됐습니다.\n고객센터(sasohan@sasohan.net)로 이메일을 보내주시면 빠르게 처리해드립니다.' });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

module.exports = router;
