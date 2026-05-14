const { notifyUser } = require('./chat');
const router = require('express').Router();
const db     = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

// ── 소개팅 신청 (cami → cami) ────────────
router.post('/request/:targetId', authMiddleware, async (req, res) => {
  const { targetId } = req.params;
  const myId = req.user.id;
  if (myId === targetId) return res.status(400).json({ error: '본인에게 신청할 수 없습니다.' });

  try {
    const me = await db.query("SELECT role, status FROM users WHERE id=$1", [myId]);
    if (!me.rows[0] || me.rows[0]?.status === 'blocked') {
      return res.status(403).json({ error: '이용할 수 없는 계정입니다.' });
    }

    const target = await db.query("SELECT u.role, u.status, p.gender FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=$1", [targetId]);
    if (!target.rows[0] || target.rows[0].status === 'blocked') {
      return res.status(404).json({ error: '존재하지 않는 회원입니다.' });
    }

    // 기존 매칭 확인 (양방향)
    const myProfile = await db.query("SELECT gender FROM profiles WHERE user_id=$1", [myId]);
    if (!myProfile.rows[0]?.gender || !target.rows[0].gender) {
      return res.status(400).json({ error: '성별 정보가 있는 회원끼리만 매칭을 신청할 수 있습니다.' });
    }
    if (myProfile.rows[0].gender === target.rows[0].gender) {
      return res.status(400).json({ error: '서로 다른 성별의 회원에게만 매칭을 신청할 수 있습니다.' });
    }

    const existing = await db.query(
      `SELECT m.id, m.status, cr.id as room_id
       FROM matches m
       LEFT JOIN chat_rooms cr ON cr.match_id = m.id
       WHERE (m.owner_id=$1 AND m.visual_id=$2) OR (m.owner_id=$2 AND m.visual_id=$1)
       ORDER BY m.created_at DESC LIMIT 1`,
      [myId, targetId]
    );

    if (existing.rows.length) {
      const prev = existing.rows[0];

      // ① pending 상태 → 아직 검토 중, 재신청 불가
      if (prev.status === 'pending') {
        return res.status(409).json({
          error: '이미 신청한 상대입니다. 매니저가 검토 중입니다.',
          status: 'pending'
        });
      }

      // ② accepted + 채팅방 있음 → 현재 매칭 진행 중, 재신청 불가
      if (prev.status === 'accepted' && prev.room_id) {
        return res.status(409).json({
          error: '이미 매칭된 상대입니다. 채팅방에서 대화해보세요.',
          status: 'accepted',
          room_id: prev.room_id
        });
      }

      // ③ rejected / cancelled / accepted(채팅방 없음) → 기존 매칭 삭제 후 재신청 허용
      await db.query('DELETE FROM matches WHERE id=$1', [prev.id]);
    }

    // 새 신청 등록
    const { rows } = await db.query(
      "INSERT INTO matches (owner_id, visual_id, status) VALUES ($1,$2,'pending') RETURNING *",
      [myId, targetId]
    );

    // 상대방에게 알림 (DB)
    await db.query(
      'INSERT INTO notifications (user_id, type, message) VALUES ($1,$2,$3)',
      [targetId, 'match_request', '새로운 소개팅 신청이 도착했습니다!']
    ).catch(() => {});

    // 상대방에게 WS 실시간 알림
    notifyUser(targetId, {
      event: 'match_request',
      message: '💌 새로운 소개팅 신청이 도착했습니다!',
      matchId: rows[0].id
    });

    res.status(201).json({ ok: true, match: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 신청 거절 ─────────────────────────────
router.post('/reject/:matchId', authMiddleware, async (req, res) => {
  try {
    await db.query(
      "UPDATE matches SET status='rejected' WHERE id=$1 AND visual_id=$2",
      [req.params.matchId, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 신청 수락 ─────────────────────────────
router.post('/accept/:matchId', authMiddleware, async (req, res) => {
  try {
    const match = await db.query(
      "SELECT * FROM matches WHERE id=$1 AND visual_id=$2 AND status='pending'",
      [req.params.matchId, req.user.id]
    );
    if (!match.rows[0]) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });

    await db.query(
      "UPDATE matches SET status='accepted', matched_at=NOW() WHERE id=$1",
      [req.params.matchId]
    );
    // 채팅방 생성
    const room = await db.query(
      'INSERT INTO chat_rooms (match_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id',
      [req.params.matchId]
    );

    // 양쪽 알림
    for (const uid of [match.rows[0].owner_id, match.rows[0].visual_id]) {
      await db.query(
        'INSERT INTO notifications (user_id, type, message, link) VALUES ($1,$2,$3,$4)',
        [uid, 'match_accept', '매칭이 성사됐습니다! 대화를 시작해보세요.', `/pages/chat.html?room=${room.rows[0]?.id}`]
      ).catch(() => {});
    }

    res.json({ ok: true, roomId: room.rows[0]?.id });
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 받은 신청 목록 ────────────────────────
router.get('/received', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT m.*, p.name as owner_name, p.age as owner_age, p.photos as owner_photos
       FROM matches m JOIN profiles p ON p.user_id = m.owner_id
       WHERE m.visual_id=$1 AND m.status='pending' ORDER BY m.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 보낸 신청 목록 ────────────────────────
router.get('/sent', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT m.*,
              COALESCE(p.name, split_part(u.email,'@',1)) as visual_name,
              p.age as visual_age, p.photos as visual_photos,
              cr.id as room_id
       FROM matches m
       LEFT JOIN profiles p ON p.user_id = m.visual_id
       LEFT JOIN users u ON u.id = m.visual_id
       LEFT JOIN chat_rooms cr ON cr.match_id = m.id
       WHERE m.owner_id=$1
       ORDER BY m.created_at DESC
       LIMIT 20`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 내 매칭 목록 ──────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT m.*,
              op.name as owner_name, op.photos as owner_photos,
              vp.name as visual_name, vp.photos as visual_photos,
              cr.id as room_id
       FROM matches m
       JOIN profiles op ON op.user_id = m.owner_id
       JOIN profiles vp ON vp.user_id = m.visual_id
       LEFT JOIN chat_rooms cr ON cr.match_id = m.id
       WHERE m.owner_id=$1 OR m.visual_id=$1
       ORDER BY m.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

module.exports = router;
