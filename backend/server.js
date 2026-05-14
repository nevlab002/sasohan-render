require('dotenv').config();

if (!process.env.JWT_SECRET) {
  console.error('❌ .env 파일에 JWT_SECRET이 없습니다. 서버를 시작할 수 없습니다.');
  process.exit(1);
}

const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const http       = require('http');
const { WebSocketServer } = require('ws');
const fs         = require('fs');
const db         = require('./models/db');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.set('trust proxy', 1);

// ── 업로드 폴더 확보 ──────────────────────
const uploadDir = path.resolve(__dirname, process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ── CORS ─────────────────────────────────
const allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(',').map(s => s.trim())
  : ['http://localhost:4000', 'http://127.0.0.1:4000'];

app.use(cors({
  origin: (origin, cb) => {
    // 직접 파일 접속(file://) 또는 서버 자기자신은 허용
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    // 개발 환경에서는 모두 허용
    if (process.env.NODE_ENV !== 'production') return cb(null, true);
    cb(new Error('CORS 차단'));
  },
  credentials: true
}));

app.use(express.json({ limit: '20mb' }));

// ── Rate Limiting ─────────────────────────
// 로그인/회원가입: 10분에 10회
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { error: '너무 많은 요청입니다. 10분 후 다시 시도해주세요.' },
  standardHeaders: true, legacyHeaders: false
});
// 일반 API 제한
// 새로고침 한 번에도 여러 API가 동시에 호출되므로 GET 조회성 요청은 제한하지 않습니다.
// 제한은 로그인/회원가입/POST·PATCH·DELETE 같은 변경 요청 위주로만 적용합니다.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 600 : 3000,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (req.method === 'GET' || req.method === 'OPTIONS') return true;
    if (req.path.startsWith('/uploads') || req.path.startsWith('/pages')) return true;
    return false;
  }
});

app.use('/api/auth/login',  authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api',             apiLimiter);

// ── 업로드 파일 공개 ──────────────────────
app.use('/uploads', express.static(uploadDir));

// ── 프론트엔드 정적 파일 (HTML은 캐시 방지) ──
app.use(express.static(path.join(__dirname, '../frontend'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ── API 라우터 ───────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/profiles',  require('./routes/profiles'));
app.use('/api/matches',   require('./routes/matches'));
app.use('/api/chat',      require('./routes/chat'));
const { chemiRouter } = require('./routes/chat');
app.use('/api/chat', chemiRouter);
app.use('/api/chemi', chemiRouter);  // /api/chemi/top 경로도 지원
app.use('/api/room',      require('./routes/room'));
app.use('/api/safety',    require('./routes/safety'));
app.use('/api/inquiry',   require('./routes/inquiry'));
app.use('/api/managers',  require('./routes/managers'));
app.use('/api/matching',  require('./routes/matching'));
app.use('/api/settings',  require('./routes/settings'));
app.use('/api/admin',     require('./routes/admin'));

// 관리자 채팅 내역 조회 — 독립 핸들러 (import 없이 직접 구현)
app.get('/api/admin-chat/:roomId', async (req, res) => {
  try {
    // 인증 확인
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: '로그인이 필요합니다.' });
    const jwt = require('jsonwebtoken');
    let user;
    try { user = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET); }
    catch { return res.status(401).json({ error: '인증 오류' }); }
    if (user.role !== 'admin') return res.status(403).json({ error: '관리자만 접근 가능합니다.' });

    const roomId = req.params.roomId;

    // messages 컬럼 보정
    await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_type VARCHAR(20) DEFAULT 'text'`).catch(() => {});
    await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read  BOOLEAN DEFAULT FALSE`).catch(() => {});

    // 채팅방 정보
    const roomRes = await db.query(`
      SELECT cr.id,
             COALESCE(op.name, split_part(ou.email,'@',1)) AS owner_name,
             COALESCE(vp.name, split_part(vu.email,'@',1)) AS visual_name
      FROM   chat_rooms cr
      JOIN   matches m  ON m.id  = cr.match_id
      JOIN   users ou   ON ou.id = m.owner_id
      JOIN   users vu   ON vu.id = m.visual_id
      LEFT JOIN profiles op ON op.user_id = m.owner_id
      LEFT JOIN profiles vp ON vp.user_id = m.visual_id
      WHERE  cr.id = $1
    `, [roomId]);

    if (!roomRes.rows[0]) return res.status(404).json({ error: '채팅방을 찾을 수 없습니다.' });

    // 메시지 목록
    const msgRes = await db.query(`
      SELECT msg.id, msg.sender_id,
             COALESCE(msg.content, '')          AS content,
             COALESCE(msg.msg_type, 'text')     AS msg_type,
             msg.created_at,
             COALESCE(p.name, split_part(u.email,'@',1)) AS sender_name
      FROM   messages msg
      LEFT JOIN users    u ON u.id       = msg.sender_id
      LEFT JOIN profiles p ON p.user_id  = msg.sender_id
      WHERE  msg.room_id = $1
      ORDER  BY msg.created_at ASC
      LIMIT  500
    `, [roomId]);

    res.json({ room: roomRes.rows[0], messages: msgRes.rows });
  } catch (err) {
    console.error('[admin-chat] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── 페이지 라우팅 ────────────────────────
app.get('/', (req, res) => {
  const f = path.join(__dirname, '../frontend/index.html');
  fs.existsSync(f) ? res.sendFile(f) : res.status(404).send('index.html not found');
});
app.get('*', (req, res) => {
  const f = path.join(__dirname, '../frontend', req.path);
  if (fs.existsSync(f)) return res.sendFile(f);
  // 존재하지 않는 경로는 메인으로
  const index = path.join(__dirname, '../frontend/index.html');
  fs.existsSync(index) ? res.sendFile(index) : res.status(404).end();
});

// ── WebSocket ────────────────────────────
const { setupWebSocket } = require('./routes/chat');
setupWebSocket(wss, db);

// ── 전역 에러 핸들러 ─────────────────────
app.use((err, req, res, next) => {
  console.error('서버 오류:', err.message);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

const PORT = parseInt(process.env.PORT) || 4000;
server.listen(PORT, () => {
  console.log(`🚀 사소한 서버: http://localhost:${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`🌍 환경: ${process.env.NODE_ENV || 'development'}`);
});
