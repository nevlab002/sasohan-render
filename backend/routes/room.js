const { notifyUser } = require('./chat');
const router = require('express').Router();
const db     = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

// 알림 생성 헬퍼
async function createNotif(userId, type, message, link) {
  try {
    await db.query(
      'INSERT INTO notifications (user_id, type, message, link) VALUES ($1,$2,$3,$4)',
      [userId, type, message, link || null]
    );
  } catch(e) { console.error('알림 생성 오류:', e.message); }
}

// 채팅방 접근 권한 확인
async function getRoomMatch(roomId, userId) {
  const { rows } = await db.query(
    `SELECT cr.id as room_id, m.id as match_id, m.owner_id, m.visual_id,
            m.status, m.room_status, m.manager_comment, m.matched_by,
            m.proposal_reject_count, m.cancel_reason
     FROM chat_rooms cr JOIN matches m ON m.id=cr.match_id
     WHERE cr.id=$1 AND (m.owner_id=$2 OR m.visual_id=$2)`,
    [roomId, userId]
  );
  return rows[0] || null;
}

// ── 채팅방 상세 정보 ──────────────────────
router.get('/:roomId', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT cr.id as room_id, cr.created_at as room_created_at,
              m.id as match_id, m.status, m.room_status, m.matched_at,
              m.manager_comment, m.matched_by, m.proposal_reject_count,
              m.owner_id, m.visual_id,
              op.name as owner_name, op.age as owner_age, op.region as owner_region,
              op.job as owner_job, op.photos as owner_photos, op.bio as owner_bio,
              vp.name as visual_name, vp.age as visual_age, vp.region as visual_region,
              vp.job as visual_job, vp.photos as visual_photos, vp.bio as visual_bio
       FROM chat_rooms cr
       JOIN matches m ON m.id = cr.match_id
       JOIN profiles op ON op.user_id = m.owner_id
       JOIN profiles vp ON vp.user_id = m.visual_id
       WHERE cr.id=$1 AND (m.owner_id=$2 OR m.visual_id=$2)`,
      [req.params.roomId, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: '채팅방을 찾을 수 없습니다.' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 만남 제안 (날짜+장소 통합) ───────────
router.post('/:roomId/propose', authMiddleware, async (req, res) => {
  const { date_time, place, note } = req.body;
  if (!date_time || !place) return res.status(400).json({ error: '날짜와 장소를 모두 입력해주세요.' });
  try {
    const rm = await getRoomMatch(req.params.roomId, req.user.id);
    if (!rm) return res.status(403).json({ error: '접근 권한이 없습니다.' });
    if (rm.room_status === 'closed') return res.status(400).json({ error: '종료된 소개팅방입니다.' });

    // 진행 중인 제안이 있으면 차단
    const existing = await db.query(
      "SELECT id FROM proposals WHERE room_id=$1 AND status='pending'",
      [req.params.roomId]
    );
    if (existing.rows.length) return res.status(409).json({ error: '이미 진행 중인 만남 제안이 있습니다.' });

    const content = `📅 ${date_time}\n📍 ${place}${note ? '\n💬 ' + note : ''}`;

    // proposals 테이블에 저장
    const prop = await db.query(
      'INSERT INTO proposals (room_id, proposer_id, date_time, place, note) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.params.roomId, req.user.id, date_time, place, note || null]
    );

    // 채팅 메시지로도 삽입
    await db.query(
      `INSERT INTO messages (room_id, sender_id, content, msg_type, meta)
       VALUES ($1,$2,$3,'meet_propose',$4)`,
      [req.params.roomId, req.user.id, content,
       JSON.stringify({ proposal_id: prop.rows[0].id, date_time, place, note })]
    );

    // 상대방에게 알림
    const partnerId = rm.owner_id === req.user.id ? rm.visual_id : rm.owner_id;
    await createNotif(partnerId, 'proposal', '새로운 만남 제안이 왔습니다!', `/pages/chat.html?room=${req.params.roomId}`);
    notifyUser(partnerId, {
      event: 'proposal',
      message: '📅 새로운 만남 제안이 도착했습니다!',
      roomId: req.params.roomId,
      date_time, place, note
    });

    // 상태 → 일정 조율 중
    await db.query(
      "UPDATE matches SET room_status='scheduling' WHERE id=$1",
      [rm.match_id]
    );
    res.status(201).json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: '서버 오류' }); }
});

// ── 만남 제안 수락 ───────────────────────
router.patch('/:roomId/propose/:propId/accept', authMiddleware, async (req, res) => {
  try {
    const rm = await getRoomMatch(req.params.roomId, req.user.id);
    if (!rm) return res.status(403).json({ error: '접근 권한이 없습니다.' });

    await db.query(
      "UPDATE proposals SET status='accepted' WHERE id=$1 AND room_id=$2",
      [req.params.propId, req.params.roomId]
    );
    // 상태 → 만남 완료
    await db.query("UPDATE matches SET room_status='met' WHERE id=$1", [rm.match_id]);

    // 수락 메시지
    await db.query(
      `INSERT INTO messages (room_id, sender_id, content, msg_type)
       VALUES ($1,$2,'✅ 만남 제안을 수락했습니다! 즐거운 만남이 되세요 ✦','system')`,
      [req.params.roomId, req.user.id]
    );

    // 제안자에게 알림
    const prop = await db.query('SELECT proposer_id FROM proposals WHERE id=$1', [req.params.propId]);
    await createNotif(prop.rows[0].proposer_id, 'proposal_accept', '만남 제안이 수락됐습니다!', `/pages/chat.html?room=${req.params.roomId}`);
    notifyUser(prop.rows[0].proposer_id, {
      event: 'proposal_accepted',
      message: '✅ 만남 제안이 수락됐습니다! 즐거운 만남이 되세요.',
      roomId: req.params.roomId
    });

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 만남 제안 거절 (최대 3회) ────────────
router.patch('/:roomId/propose/:propId/reject', authMiddleware, async (req, res) => {
  try {
    const rm = await getRoomMatch(req.params.roomId, req.user.id);
    if (!rm) return res.status(403).json({ error: '접근 권한이 없습니다.' });

    // 거절 횟수 증가
    const result = await db.query(
      'UPDATE matches SET proposal_reject_count = proposal_reject_count + 1 WHERE id=$1 RETURNING proposal_reject_count',
      [rm.match_id]
    );
    const count = result.rows[0].proposal_reject_count;

    await db.query("UPDATE proposals SET status='rejected' WHERE id=$1", [req.params.propId]);

    if (count >= 3) {
      // 3회 초과 → 자동 종료
      await db.query("UPDATE matches SET room_status='closed', status='closed' WHERE id=$1", [rm.match_id]);
      await db.query(
        `INSERT INTO messages (room_id, sender_id, content, msg_type)
         VALUES ($1,$2,'만남 제안이 3회 거절되어 소개팅이 자동 종료됐습니다.','system')`,
        [req.params.roomId, req.user.id]
      );
      return res.json({ ok: true, closed: true, message: '3회 거절로 소개팅이 종료됐습니다.' });
    }

    await db.query(
      `INSERT INTO messages (room_id, sender_id, content, msg_type)
       VALUES ($1,$2,$3,'system')`,
      [req.params.roomId, req.user.id, `만남 제안을 거절했습니다. (${count}/3회)`]
    );
    await db.query("UPDATE matches SET room_status='chatting' WHERE id=$1", [rm.match_id]);

    res.json({ ok: true, reject_count: count });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 현재 진행 중인 제안 조회 ─────────────
router.get('/:roomId/propose', authMiddleware, async (req, res) => {
  try {
    const rm = await getRoomMatch(req.params.roomId, req.user.id);
    if (!rm) return res.status(403).json({ error: '접근 권한이 없습니다.' });
    const { rows } = await db.query(
      "SELECT * FROM proposals WHERE room_id=$1 ORDER BY created_at DESC LIMIT 1",
      [req.params.roomId]
    );
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 매칭 취소 / 매칭 종료 (사유 포함) ─────────
async function cancelRoomMatch(req, res) {
  const { reason } = req.body || {};
  const cancelReason = reason?.trim() || '사용자 요청으로 매칭 종료';

  try {
    const rm = await getRoomMatch(req.params.roomId, req.user.id);
    if (!rm) return res.status(404).json({ error: '채팅방을 찾을 수 없습니다.' });

    await db.query(
      "UPDATE matches SET status='cancelled', room_status='closed', cancel_reason=$1 WHERE id=$2",
      [cancelReason, rm.match_id]
    );

    await db.query('DELETE FROM chat_rooms WHERE match_id=$1', [rm.match_id]).catch(() => {});

    // 관리자에게 알림
    const admins = await db.query("SELECT id FROM users WHERE role='admin'");
    for (const admin of admins.rows) {
      await createNotif(admin.id, 'cancel', `매칭 종료: ${cancelReason}`, '/pages/admin.html');
    }

    // 상대방에게 매칭 종료 알림
    const partnerId = rm.owner_id === req.user.id ? rm.visual_id : rm.owner_id;
    notifyUser(partnerId, {
      event: 'match_cancelled',
      message: '💔 상대방이 매칭을 종료했습니다.',
      roomId: req.params.roomId
    });

    res.json({
      ok: true,
      message: '매칭이 종료되었습니다. 관리자 사이트의 매칭 취소 이력에서 확인할 수 있습니다.'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '매칭 종료 중 서버 오류가 발생했습니다.' });
  }
}

router.delete('/:roomId/cancel', authMiddleware, cancelRoomMatch);
router.post('/:roomId/cancel', authMiddleware, cancelRoomMatch);

// ── 매칭 상태 변경 ───────────────────────
router.patch('/:roomId/status', authMiddleware, async (req, res) => {
  const { room_status } = req.body;
  const allowed = ['chatting','scheduling','met','closed'];
  if (!allowed.includes(room_status)) return res.status(400).json({ error: '올바르지 않은 상태값입니다.' });
  try {
    const rm = await getRoomMatch(req.params.roomId, req.user.id);
    if (!rm) return res.status(403).json({ error: '접근 권한이 없습니다.' });
    await db.query('UPDATE matches SET room_status=$1 WHERE id=$2', [room_status, rm.match_id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 신고 / 매니저 호출 (reports 테이블로 통합) ──
router.post('/:roomId/call-manager', authMiddleware, async (req, res) => {
  const { reason } = req.body || {};
  const callReason = reason?.trim() || '매니저 상담 요청';

  try {
    const rm = await getRoomMatch(req.params.roomId, req.user.id);
    if (!rm) return res.status(403).json({ error: '접근 권한이 없습니다.' });
    if (rm.room_status === 'closed') return res.status(400).json({ error: '종료된 소개팅방입니다.' });

    // 상대방 ID 파악
    const partnerId = rm.owner_id === req.user.id ? rm.visual_id : rm.owner_id;

    // reports 테이블에 신고 기록 (type/room_id 컬럼이 없어도 안전하게 처리)
    await db.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS type    VARCHAR(20) DEFAULT 'report'`).catch(() => {});
    await db.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS room_id TEXT`).catch(() => {});

    let inserted;
    try {
      inserted = await db.query(
        `INSERT INTO reports (reporter_id, reported_id, reason, type, room_id)
         VALUES ($1,$2,$3,'manager_call',$4) RETURNING id`,
        [req.user.id, partnerId, callReason, String(req.params.roomId)]
      );
    } catch {
      // 컬럼이 아직 없는 경우 기본 INSERT
      inserted = await db.query(
        `INSERT INTO reports (reporter_id, reported_id, reason) VALUES ($1,$2,$3) RETURNING id`,
        [req.user.id, partnerId, callReason]
      );
    }

    // 관리자에게 알림
    const admins = await db.query("SELECT id FROM users WHERE role='admin'");
    for (const admin of admins.rows) {
      await createNotif(admin.id, 'manager_call', `신고/호출: ${callReason}`, '/pages/admin.html');
    }

    // 채팅방 시스템 메시지
    await db.query(
      `INSERT INTO messages (room_id, sender_id, content, msg_type) VALUES ($1,$2,$3,'system')`,
      [req.params.roomId, req.user.id, `신고/매니저 호출이 접수됐습니다. 사유: ${callReason}`]
    ).catch(() => {});

    res.json({ ok: true, id: inserted.rows[0].id, message: '신고/매니저 호출이 접수되었습니다.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '처리 중 서버 오류가 발생했습니다.' });
  }
});

// ── 후기 (소개팅 종료 후만) ──────────────
router.post('/:roomId/review', authMiddleware, async (req, res) => {
  const { rating, comment } = req.body;
  if (!['good','okay','bad'].includes(rating)) return res.status(400).json({ error: '올바른 평가를 선택해주세요.' });
  try {
    const rm = await getRoomMatch(req.params.roomId, req.user.id);
    if (!rm) return res.status(403).json({ error: '접근 권한이 없습니다.' });
    if (rm.room_status !== 'met' && rm.room_status !== 'closed') {
      return res.status(400).json({ error: '만남이 완료된 후에만 후기를 작성할 수 있습니다.' });
    }
    await db.query(
      `INSERT INTO reviews (match_id, reviewer_id, rating, comment)
       VALUES ($1,$2,$3,$4) ON CONFLICT (match_id, reviewer_id)
       DO UPDATE SET rating=$3, comment=$4`,
      [rm.match_id, req.user.id, rating, comment || '']
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 내 후기 조회 ─────────────────────────
router.get('/:roomId/review', authMiddleware, async (req, res) => {
  try {
    const rm = await getRoomMatch(req.params.roomId, req.user.id);
    if (!rm) return res.status(403).json({ error: '접근 권한이 없습니다.' });
    const { rows } = await db.query(
      'SELECT * FROM reviews WHERE match_id=$1 AND reviewer_id=$2',
      [rm.match_id, req.user.id]
    );
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});


// 알림/채팅 배지 개수 분리 조회
router.get('/notifications/counts', authMiddleware, async (req, res) => {
  try {
    const n = await db.query(
      `SELECT COUNT(*)::int AS unread
       FROM notifications
       WHERE user_id=$1
         AND is_read=FALSE
         AND COALESCE(type,'') NOT IN ('message','chat','new_message')`,
      [req.user.id]
    );

    const c = await db.query(
      `SELECT COUNT(*)::int AS unread
       FROM messages msg
       JOIN chat_rooms cr ON cr.id = msg.room_id
       JOIN matches m ON m.id = cr.match_id
       WHERE msg.sender_id != $1
         AND msg.is_read = FALSE
         AND (m.owner_id = $1 OR m.visual_id = $1)`,
      [req.user.id]
    );

    res.json({
      notifications: n.rows[0]?.unread || 0,
      chat: c.rows[0]?.unread || 0
    });
  } catch (err) {
    console.error('알림 개수 조회 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 알림 목록 ────────────────────────────
router.get('/notifications/list', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, type, message, link, is_read, created_at
       FROM notifications
       WHERE user_id=$1
         AND COALESCE(type,'') NOT IN ('message','chat','new_message')
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );

    res.json(rows);
  } catch (err) {
    console.error('알림 목록 조회 오류:', err.message);
    res.status(500).json({ error: '알림 목록 조회 실패: ' + err.message });
  }
});


// 일반 알림만 모두 확인 처리 - 채팅 미읽음과 message 타입 알림은 건드리지 않음
router.patch('/notifications/read-notifs', authMiddleware, async (req, res) => {
  try {
    await db.query(
      `UPDATE notifications
       SET is_read=TRUE
       WHERE user_id=$1
         AND COALESCE(type,'') NOT IN ('message','chat','new_message')`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── 알림 읽음 처리 ───────────────────────
router.patch('/notifications/read', authMiddleware, async (req, res) => {
  try {
    await db.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 특정 알림 읽음 처리 ───────────────────
router.patch('/notifications/:notifId/read', authMiddleware, async (req, res) => {
  try {
    await db.query(
      'UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2',
      [req.params.notifId, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

module.exports = router;
