const router = require('express').Router();
const db     = require('../models/db');
const { authMiddleware, adminOnly } = require('../middleware/auth');
let _notifyUser = null;
// chat.js의 notifyUser는 WS 초기화 후에야 사용 가능하므로 지연 require
function notifyUserLazy(userId, payload) {
  if (!_notifyUser) {
    try { _notifyUser = require('./chat').notifyUser; } catch {}
  }
  if (_notifyUser) _notifyUser(userId, payload);
}

async function notifyAdmins(type, message, link) {
  try {
    const admins = await db.query("SELECT id FROM users WHERE role='admin'");
    for (const admin of admins.rows) {
      await db.query(
        'INSERT INTO notifications (user_id,type,message,link) VALUES ($1,$2,$3,$4)',
        [admin.id, type, message, link || '/pages/admin.html']
      ).catch(() => {});
    }
  } catch (err) {
    // notifications 테이블이 아직 없거나 알림 생성 실패해도 신고/차단 기능은 막지 않음
  }
}

// ── 신고 ─────────────────────────────────
// 지원 방식:
// 1) POST /api/safety/report/:targetId
// 2) POST /api/safety/report  body: { reported_id }
async function createReport(req, res) {
  const targetId = req.params.targetId || req.body.reported_id || req.body.target_id;
  const { reason, room_id } = req.body;

  if (!targetId) return res.status(400).json({ error: '신고 대상이 없습니다.' });
  if (!reason?.trim()) return res.status(400).json({ error: '신고 사유를 입력해주세요.' });
  if (targetId === req.user.id) return res.status(400).json({ error: '본인은 신고할 수 없습니다.' });

  try {
    // type·room_id 컬럼이 있으면 함께 저장, 없으면 기본 INSERT
    let result;
    try {
      result = await db.query(
        `INSERT INTO reports (reporter_id, reported_id, reason, type, room_id)
         VALUES ($1,$2,$3,'report',$4) RETURNING id`,
        [req.user.id, targetId, reason.trim(), room_id || null]
      );
    } catch {
      result = await db.query(
        'INSERT INTO reports (reporter_id, reported_id, reason) VALUES ($1,$2,$3) RETURNING id',
        [req.user.id, targetId, reason.trim()]
      );
    }

    await notifyAdmins(
      'report',
      `새 신고가 접수되었습니다: ${reason.trim()}`,
      '/pages/admin.html'
    );

    res.json({
      ok: true,
      id: result.rows[0].id,
      message: '신고가 접수되었습니다.'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '신고 처리 중 서버 오류가 발생했습니다.' });
  }
}

router.post('/report/:targetId', authMiddleware, createReport);
router.post('/report', authMiddleware, createReport);

// ── 차단 ─────────────────────────────────
// 지원 방식:
// 1) POST /api/safety/block/:targetId
// 2) POST /api/safety/block  body: { blocked_id }
async function createBlock(req, res) {
  const targetId = req.params.targetId || req.body.blocked_id || req.body.target_id;
  const reason = req.body.reason || '채팅방에서 상대방을 차단했습니다.';

  if (!targetId) return res.status(400).json({ error: '차단 대상이 없습니다.' });
  if (targetId === req.user.id) return res.status(400).json({ error: '본인은 차단할 수 없습니다.' });

  try {
    await db.query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.user.id, targetId]
    );

    // 관리자 사이트 신고 관리에서도 확인 가능하도록 차단 내역을 신고성 기록으로 남김
    await db.query(
      'INSERT INTO reports (reporter_id, reported_id, reason) VALUES ($1,$2,$3)',
      [req.user.id, targetId, `[차단] ${reason}`]
    ).catch(() => {});

    await notifyAdmins(
      'block',
      `회원 차단이 발생했습니다: ${reason}`,
      '/pages/admin.html'
    );

    // 차단한 사람 이름 조회
    const nameRes = await db.query(
      `SELECT COALESCE(p.name, split_part(u.email,'@',1)) AS name
       FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=$1`,
      [req.user.id]
    ).catch(() => ({ rows: [] }));
    const blockerName = nameRes.rows[0]?.name || '상대방';

    // 차단당한 사용자 — DB 알림 저장 + 실시간 WS 알림
    const blockMsg = `${blockerName}님이 회원님을 차단했습니다. 해당 채팅방에서 메시지를 보낼 수 없습니다.`;
    await db.query(
      'INSERT INTO notifications (user_id, type, message, link) VALUES ($1,$2,$3,$4)',
      [targetId, 'blocked_by', blockMsg, '/pages/chat.html']
    ).catch(() => {});
    notifyUserLazy(targetId, {
      type: 'notification',
      event: 'blocked_by',
      message: blockMsg,
      blocker_id: req.user.id
    });

    res.json({
      ok: true,
      message: '차단되었습니다. 관리자 신고 관리에도 기록됩니다.'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '차단 처리 중 서버 오류가 발생했습니다.' });
  }
}

router.post('/block/:targetId', authMiddleware, createBlock);
router.post('/block', authMiddleware, createBlock);

// ── 차단 상태 조회 ────────────────────────
router.get('/block/:targetId', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT 1 FROM blocks WHERE blocker_id=$1 AND blocked_id=$2',
      [req.user.id, req.params.targetId]
    );
    res.json({ blocked: rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 상대방이 나를 차단했는지 조회 ────────────
router.get('/blocked-by/:targetId', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT 1 FROM blocks WHERE blocker_id=$1 AND blocked_id=$2',
      [req.params.targetId, req.user.id]
    );
    res.json({ blocked: rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 차단 해제 ─────────────────────────────
router.delete('/block/:targetId', authMiddleware, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2',
      [req.user.id, req.params.targetId]
    );
    // 차단 해제한 사람 이름 조회
    const nameRes2 = await db.query(
      `SELECT COALESCE(p.name, split_part(u.email,'@',1)) AS name
       FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=$1`,
      [req.user.id]
    ).catch(() => ({ rows: [] }));
    const unblockerName = nameRes2.rows[0]?.name || '상대방';

    // 차단 해제된 사용자 — DB 알림 저장 + 실시간 WS 알림
    const unblockMsg = `${unblockerName}님이 차단을 해제했습니다. 이제 다시 메시지를 보낼 수 있습니다.`;
    await db.query(
      'INSERT INTO notifications (user_id, type, message, link) VALUES ($1,$2,$3,$4)',
      [req.params.targetId, 'unblocked_by', unblockMsg, '/pages/chat.html']
    ).catch(() => {});
    notifyUserLazy(req.params.targetId, {
      type: 'notification',
      event: 'unblocked_by',
      message: unblockMsg,
      blocker_id: req.user.id
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 관리자: 신고 목록 조회 ───────────────
router.get('/reports', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*,
              rp.name as reporter_name, ru.email as reporter_email,
              rd.name as reported_name, du.email as reported_email
       FROM reports r
       JOIN users ru ON ru.id = r.reporter_id
       JOIN users du ON du.id = r.reported_id
       LEFT JOIN profiles rp ON rp.user_id = r.reporter_id
       LEFT JOIN profiles rd ON rd.user_id = r.reported_id
       ORDER BY r.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 관리자: 신고 처리 ────────────────────
router.patch('/reports/:reportId', authMiddleware, adminOnly, async (req, res) => {
  const { action } = req.body; // 'resolve' | 'block_user'
  try {
    await db.query('UPDATE reports SET status=$1 WHERE id=$2', ['resolved', req.params.reportId]);
    if (action === 'block_user') {
      const { rows } = await db.query('SELECT reported_id FROM reports WHERE id=$1', [req.params.reportId]);
      if (rows[0]) await db.query('UPDATE users SET status=$1 WHERE id=$2', ['blocked', rows[0].reported_id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

module.exports = router;
