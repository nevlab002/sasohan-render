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

app.use(express.json({ limit: '2mb' }));

// ── Rate Limiting ─────────────────────────
// 로그인/회원가입: 10분에 10회
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { error: '너무 많은 요청입니다. 10분 후 다시 시도해주세요.' },
  standardHeaders: true, legacyHeaders: false
});
// 일반 API: 1분에 100회
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: '너무 많은 요청입니다. 잠시 후 다시 시도해주세요.' },
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path.startsWith('/uploads') || req.path.startsWith('/pages')
});

app.use('/api/auth/login',  authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api',             apiLimiter);

// ── 업로드 파일 공개 ──────────────────────
app.use('/uploads', express.static(uploadDir));

// ── 프론트엔드 정적 파일 ─────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

// ── API 라우터 ───────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/profiles',  require('./routes/profiles'));
app.use('/api/matches',   require('./routes/matches'));
app.use('/api/chat',      require('./routes/chat'));
const { chemiRouter } = require('./routes/chat');
app.use('/api/chat', chemiRouter);   // /api/chat/:roomId/chemi/*
app.use('/api/chemi', chemiRouter);  // /api/chemi/top
app.use('/api/room',      require('./routes/room'));
app.use('/api/safety',    require('./routes/safety'));
app.use('/api/inquiry',   require('./routes/inquiry'));
app.use('/api/managers',  require('./routes/managers'));
app.use('/api/matching',  require('./routes/matching'));
app.use('/api/settings',  require('./routes/settings'));
app.use('/api/admin',     require('./routes/admin'));

// 관리자 채팅내역 조회 — admin 라우터 외부에 별도 등록 (라우팅 충돌 방지)
const { authMiddleware, adminOnly } = require('./middleware/auth');
const { getRoomChatLog } = require('./routes/admin');
app.get('/api/admin-chat/:roomId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await getRoomChatLog(req.params.roomId);
    if (!result) return res.status(404).json({ error: '채팅방을 찾을 수 없습니다.' });
    res.json(result);
  } catch (err) {
    console.error('채팅 내역 조회 오류:', err.message);
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
