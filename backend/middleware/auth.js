const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET이 설정되지 않았습니다.');
    return res.status(500).json({ error: '서버 설정 오류' });
  }
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError') return res.status(401).json({ error: '로그인이 만료됐습니다. 다시 로그인해주세요.' });
    return res.status(401).json({ error: '유효하지 않은 인증입니다.' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '관리자만 접근 가능합니다.' });
  }
  next();
}

module.exports = { authMiddleware, adminOnly };
