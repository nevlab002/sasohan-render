const { notifyUser } = require('./chat');
const router = require('express').Router();
const db     = require('../models/db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

router.use(authMiddleware, adminOnly);

async function ensureInquiriesTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
      title       VARCHAR(200) NOT NULL,
      content     TEXT NOT NULL,
      topic       VARCHAR(50) DEFAULT 'general',
      status      VARCHAR(20) DEFAULT 'pending',
      answer      TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      answered_at TIMESTAMPTZ
    )
  `);
  await db.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS topic VARCHAR(50) DEFAULT 'general'`);
  await db.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'`);
  await db.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS answer TEXT`);
  await db.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS answered_at TIMESTAMPTZ`);
  await db.query(`ALTER TABLE inquiries ALTER COLUMN user_id DROP NOT NULL`).catch(() => {});
}


// ── 전체 회원 목록 ───────────────────────
router.get('/users', async (req, res) => {
  try {
    const { role, status } = req.query;
    let q = `SELECT u.id, u.email, u.role, u.status, u.created_at,
             p.name, p.age, p.gender, p.region, p.job, p.photos,
             COALESCE(p.taste, '{}') as taste,
             COALESCE(p.hobby, '{}') as hobby
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.role != 'admin'`;
    const params = [];
    if (role)   { params.push(role);   q += ` AND u.role=$${params.length}`; }
    if (status) { params.push(status); q += ` AND u.status=$${params.length}`; }
    q += ' ORDER BY u.created_at DESC';
    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: '서버 오류' }); }
});

// ── 회원 차단 / 해제 / 삭제 ─────────────
router.patch('/users/:id/block',   async (req, res) => {
  await db.query('UPDATE users SET status=$1 WHERE id=$2', ['blocked', req.params.id]);
  res.json({ ok: true });
});
router.patch('/users/:id/unblock', async (req, res) => {
  await db.query('UPDATE users SET status=$1 WHERE id=$2', ['active', req.params.id]);
  res.json({ ok: true });
});
router.delete('/users/:id', async (req, res) => {
  try {
    const result = await db.query(
      "DELETE FROM users WHERE id=$1 AND role!='admin' RETURNING id", [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: '회원을 찾을 수 없습니다.' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: '서버 오류' }); }
});

// ── 캐미 회원 심사 승인/거절 (role=cami 기준) ─
router.patch('/users/:id/approve', async (req, res) => {
  try {
    // role 무관하게 status만 active로
    await db.query("UPDATE users SET status='active' WHERE id=$1", [req.params.id]);
    notifyUser(req.params.id, { type: 'notification', event: 'account_approved', message: '계정이 승인됐습니다! 이제 서비스를 이용할 수 있습니다.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});
router.patch('/users/:id/reject', async (req, res) => {
  try {
    await db.query("UPDATE users SET status='blocked' WHERE id=$1 AND role='cami'", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 매칭 목록 ────────────────────────────
router.get('/matches', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT m.*,
             op.name as owner_name, op.age as owner_age,
             vp.name as visual_name, vp.age as visual_age,
             cr.id as room_id
      FROM matches m
      JOIN profiles op ON op.user_id = m.owner_id
      JOIN profiles vp ON vp.user_id = m.visual_id
      LEFT JOIN chat_rooms cr ON cr.match_id = m.id
      ORDER BY m.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});




// ── 소개팅 신청 관리 목록 (관리자) ─────────
router.get('/match-requests', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        m.id,
        m.owner_id,
        m.visual_id,
        m.status,
        m.created_at,
        m.matched_at,

        ou.email AS owner_email,
        op.name AS owner_name,
        op.age AS owner_age,
        op.gender AS owner_gender,
        op.region AS owner_region,
        op.job AS owner_job,
        op.photos AS owner_photos,

        vu.email AS visual_email,
        vp.name AS visual_name,
        vp.age AS visual_age,
        vp.gender AS visual_gender,
        vp.region AS visual_region,
        vp.job AS visual_job,
        vp.photos AS visual_photos,

        cr.id AS room_id
      FROM matches m
      LEFT JOIN users ou ON ou.id = m.owner_id
      LEFT JOIN users vu ON vu.id = m.visual_id
      LEFT JOIN profiles op ON op.user_id = m.owner_id
      LEFT JOIN profiles vp ON vp.user_id = m.visual_id
      LEFT JOIN chat_rooms cr ON cr.match_id = m.id
      ORDER BY m.created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '신청 목록을 불러오지 못했습니다.' });
  }
});

// ── 소개팅 신청 수락 (관리자) ──────────────
router.patch('/matches/:matchId/accept', async (req, res) => {
  const { matchId } = req.params;

  try {
    const found = await db.query(
      "SELECT * FROM matches WHERE id=$1 AND status='pending'",
      [matchId]
    );

    if (!found.rows.length) {
      return res.status(404).json({ error: '대기 중인 신청을 찾을 수 없습니다.' });
    }

    const match = found.rows[0];

    await db.query(
      "UPDATE matches SET status='accepted', room_status='chatting', matched_at=NOW() WHERE id=$1",
      [matchId]
    );

    await db.query(
      "INSERT INTO chat_rooms (match_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [matchId]
    );

    const cr = await db.query(
      "SELECT id FROM chat_rooms WHERE match_id=$1",
      [matchId]
    );

    const roomId = cr.rows[0]?.id || null;
    const link = roomId ? `/pages/chat.html?room=${roomId}` : '/pages/chat.html';

    for (const uid of [match.owner_id, match.visual_id]) {
      await db.query(
        "INSERT INTO notifications (user_id,type,message,link) VALUES ($1,$2,$3,$4)",
        [
          uid,
          'match_accept',
          '소개팅 신청이 수락되었습니다. 채팅을 시작해보세요.',
          link
        ]
      ).catch(() => {});
    }

    res.json({
      ok: true,
      message: '소개팅 신청을 수락했습니다.',
      roomId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '수락 처리 중 서버 오류가 발생했습니다.' });
  }
});

// ── 소개팅 신청 반려 (관리자) ──────────────
router.patch('/matches/:matchId/reject', async (req, res) => {
  const { matchId } = req.params;

  try {
    const found = await db.query(
      "SELECT * FROM matches WHERE id=$1 AND status='pending'",
      [matchId]
    );

    if (!found.rows.length) {
      return res.status(404).json({ error: '대기 중인 신청을 찾을 수 없습니다.' });
    }

    const match = found.rows[0];

    await db.query(
      "UPDATE matches SET status='rejected' WHERE id=$1",
      [matchId]
    );

    await db.query(
      "INSERT INTO notifications (user_id,type,message,link) VALUES ($1,$2,$3,$4)",
      [
        match.owner_id,
        'match_reject',
        '소개팅 신청이 반려되었습니다.',
        '/pages/match.html'
      ]
    ).catch(() => {});

    res.json({
      ok: true,
      message: '소개팅 신청을 반려했습니다.'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '반려 처리 중 서버 오류가 발생했습니다.' });
  }
});

// ── 매칭 가능 회원 목록 (캐미 role) ──────
router.get('/matchable/owners', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.email, u.status,
             p.name, p.age, p.gender, p.region, p.job, p.photos
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.role='cami' AND u.status='active'
      ORDER BY p.name ASC NULLS LAST
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});
router.get('/matchable/visuals', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.email, u.status,
             p.name, p.age, p.gender, p.region, p.job, p.photos
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.role='cami' AND u.status='active'
      ORDER BY p.name ASC NULLS LAST
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 매니저 직접 매칭 (cami ↔ cami) ──────
router.post('/match', async (req, res) => {
  const { ownerId, visualId } = req.body;
  if (!ownerId || !visualId || ownerId === visualId)
    return res.status(400).json({ error: '서로 다른 두 명의 캐미 회원을 선택해주세요.' });
  try {
    // 두 회원 모두 cami+active 확인
    const [a, b] = await Promise.all([
      db.query("SELECT id, status FROM users WHERE id=$1 AND role='cami'", [ownerId]),
      db.query("SELECT id, status FROM users WHERE id=$1 AND role='cami'", [visualId]),
    ]);
    if (!a.rows.length) return res.status(404).json({ error: '캐미 회원 A를 찾을 수 없습니다.' });
    if (!b.rows.length) return res.status(404).json({ error: '캐미 회원 B를 찾을 수 없습니다.' });
    if (a.rows[0].status !== 'active') return res.status(400).json({ error: '캐미 회원 A가 비활성 상태입니다.' });
    if (b.rows[0].status !== 'active') return res.status(400).json({ error: '캐미 회원 B가 비활성 상태입니다.' });

    // 이미 매칭됐는지 확인
    const existing = await db.query(
      `SELECT id, status FROM matches
       WHERE (owner_id=$1 AND visual_id=$2) OR (owner_id=$2 AND visual_id=$1)`,
      [ownerId, visualId]
    );
    let matchId;
    if (existing.rows.length) {
      if (existing.rows[0].status === 'accepted')
        return res.status(409).json({ error: '이미 매칭된 두 회원입니다.' });
      const upd = await db.query(
        "UPDATE matches SET status='accepted', matched_at=NOW(), matched_by='admin' WHERE id=$1 RETURNING id",
        [existing.rows[0].id]
      );
      matchId = upd.rows[0].id;
      await db.query('INSERT INTO chat_rooms (match_id) VALUES ($1) ON CONFLICT DO NOTHING', [matchId]);
    } else {
      const m = await db.query(
        "INSERT INTO matches (owner_id,visual_id,status,matched_at,matched_by) VALUES ($1,$2,'accepted',NOW(),'admin') RETURNING id",
        [ownerId, visualId]
      );
      matchId = m.rows[0].id;
      await db.query('INSERT INTO chat_rooms (match_id) VALUES ($1)', [matchId]);
    }

    // 알림 발송
    const cr = await db.query('SELECT id FROM chat_rooms WHERE match_id=$1', [matchId]);
    const roomId = cr.rows[0]?.id;
    const link = roomId ? `/pages/room.html?room=${roomId}` : '/pages/chat.html';
    for (const uid of [ownerId, visualId]) {
      await db.query(
        'INSERT INTO notifications (user_id,type,message,link) VALUES ($1,$2,$3,$4)',
        [uid, 'manager_match', '매니저가 새로운 매칭을 연결해드렸습니다! 채팅을 시작해보세요.', link]
      ).catch(() => {});
    }
    res.status(201).json({ ok: true, message: '매칭 완료!', matchId });
  } catch (err) { console.error(err); res.status(500).json({ error: '서버 오류' }); }
});

// ── 매칭 취소 (관리자) ───────────────────
router.delete('/match/:matchId', async (req, res) => {
  try {
    await db.query('DELETE FROM chat_rooms WHERE match_id=$1', [req.params.matchId]);
    await db.query('DELETE FROM matches WHERE id=$1', [req.params.matchId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// reports 테이블 컬럼 보정 (서버 시작 시 1회 실행)
(async () => {
  await db.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS type    VARCHAR(20) DEFAULT 'report'`).catch(() => {});
  await db.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS room_id TEXT`).catch(() => {});
})();

// ── 신고 목록 (매니저 호출 통합) ──────────
router.get('/reports', async (req, res) => {
  try {
    // type·room_id 컬럼이 있는 경우와 없는 경우를 모두 처리
    let rows;
    try {
      const r = await db.query(`
        SELECT r.id, r.reporter_id, r.reported_id, r.reason, r.status, r.created_at,
               COALESCE(r.type, 'report') AS type,
               r.room_id,
               rp.name  AS reporter_name, ru.email AS reporter_email,
               dp.name  AS reported_name, du.email AS reported_email
        FROM   reports r
        JOIN   users ru ON ru.id = r.reporter_id
        JOIN   users du ON du.id = r.reported_id
        LEFT JOIN profiles rp ON rp.user_id = r.reporter_id
        LEFT JOIN profiles dp ON dp.user_id = r.reported_id
        ORDER  BY r.created_at DESC
      `);
      rows = r.rows;
    } catch {
      // type·room_id 컬럼이 아직 없는 구버전 테이블 fallback
      const r = await db.query(`
        SELECT r.id, r.reporter_id, r.reported_id, r.reason, r.status, r.created_at,
               'report'::text AS type, NULL::text AS room_id,
               rp.name  AS reporter_name, ru.email AS reporter_email,
               dp.name  AS reported_name, du.email AS reported_email
        FROM   reports r
        JOIN   users ru ON ru.id = r.reporter_id
        JOIN   users du ON du.id = r.reported_id
        LEFT JOIN profiles rp ON rp.user_id = r.reporter_id
        LEFT JOIN profiles dp ON dp.user_id = r.reported_id
        ORDER  BY r.created_at DESC
      `);
      rows = r.rows;
    }
    res.json(rows);
  } catch (err) {
    console.error('reports 조회 오류:', err.message);
    res.status(500).json({ error: '서버 오류: ' + err.message });
  }
});

router.patch('/reports/:id/resolve', async (req, res) => {
  try {
    await db.query("UPDATE reports SET status='resolved' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

router.patch('/reports/:id/resolve-block', async (req, res) => {
  try {
    const { rows } = await db.query("UPDATE reports SET status='resolved' WHERE id=$1 RETURNING reported_id", [req.params.id]);
    if (rows[0]) await db.query("UPDATE users SET status='blocked' WHERE id=$1", [rows[0].reported_id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 후기 목록 ────────────────────────────
router.get('/reviews', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT rv.*, rp.name as reviewer_name,
             op.name as owner_name, vp.name as visual_name
      FROM reviews rv
      JOIN matches m  ON m.id = rv.match_id
      JOIN profiles op ON op.user_id = m.owner_id
      JOIN profiles vp ON vp.user_id = m.visual_id
      JOIN profiles rp ON rp.user_id = rv.reviewer_id
      ORDER BY rv.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 매니저 호출 (이전 데이터 호환용 — reports로 통합됨) ──
router.get('/manager-calls', async (req, res) => {
  try {
    // 구버전 manager_calls 테이블이 있으면 반환, 없으면 빈 배열
    const exists = await db.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='manager_calls')`
    );
    if (!exists.rows[0].exists) return res.json([]);
    const { rows } = await db.query(`
      SELECT mc.*, p.name as caller_name,
             op.name as owner_name, vp.name as visual_name,
             cr.id as room_id
      FROM manager_calls mc
      JOIN profiles p  ON p.user_id  = mc.caller_id
      JOIN matches m   ON m.id       = mc.match_id
      JOIN profiles op ON op.user_id = m.owner_id
      JOIN profiles vp ON vp.user_id = m.visual_id
      LEFT JOIN chat_rooms cr ON cr.match_id = m.id
      ORDER BY mc.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.json([]); }
});

// 채팅 내역 조회 함수 (server.js에서 직접 호출 가능하도록 export)
async function getRoomChatLog(roomId) {
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_type VARCHAR(20) DEFAULT 'text'`).catch(() => {});
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read  BOOLEAN DEFAULT FALSE`).catch(() => {});
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta     JSONB`).catch(() => {});

  const roomCheck = await db.query(
    `SELECT cr.id,
            COALESCE(op.name, split_part(ou.email,'@',1)) AS owner_name,
            COALESCE(vp.name, split_part(vu.email,'@',1)) AS visual_name,
            ou.email AS owner_email, vu.email AS visual_email
     FROM   chat_rooms cr
     JOIN   matches m  ON m.id  = cr.match_id
     JOIN   users ou   ON ou.id = m.owner_id
     JOIN   users vu   ON vu.id = m.visual_id
     LEFT JOIN profiles op ON op.user_id = m.owner_id
     LEFT JOIN profiles vp ON vp.user_id = m.visual_id
     WHERE  cr.id = $1`,
    [roomId]
  );
  if (!roomCheck.rows[0]) return null;

  const { rows } = await db.query(`
    SELECT msg.id, msg.sender_id,
           COALESCE(msg.content, '')             AS content,
           COALESCE(msg.msg_type, 'text')        AS msg_type,
           msg.created_at,
           COALESCE(p.name, split_part(u.email,'@',1)) AS sender_name
    FROM   messages msg
    LEFT JOIN users    u ON u.id       = msg.sender_id
    LEFT JOIN profiles p ON p.user_id  = msg.sender_id
    WHERE  msg.room_id = $1
    ORDER  BY msg.created_at ASC
    LIMIT  500
  `, [roomId]);

  return { room: roomCheck.rows[0], messages: rows };
}
router.getRoomChatLog = getRoomChatLog; // module.exports = router 이후에도 접근 가능

// router 레벨 등록도 유지 (직접 접근용)
router.get('/chatlog/:roomId', async (req, res) => {
  try {
    const result = await getRoomChatLog(req.params.roomId);
    if (!result) return res.status(404).json({ error: '채팅방을 찾을 수 없습니다.' });
    res.json(result);
  } catch (err) {
    console.error('채팅 내역 조회 오류:', err.message);
    res.status(500).json({ error: '채팅 내역 조회 실패: ' + err.message });
  }
});

// ── 매칭 코멘트 수정 ─────────────────────
router.patch('/match/:matchId/comment', async (req, res) => {
  const { comment } = req.body;
  try {
    await db.query('UPDATE matches SET manager_comment=$1 WHERE id=$2', [comment, req.params.matchId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 1대1 문의 ────────────────────────────
router.get('/inquiries', async (req, res) => {
  try {
    await ensureInquiriesTable();

    const { rows } = await db.query(`
      SELECT i.*, p.name as user_name, u.email
      FROM inquiries i
      LEFT JOIN users u ON u.id = i.user_id
      LEFT JOIN profiles p ON p.user_id = i.user_id
      ORDER BY i.created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '문의 목록을 불러오지 못했습니다.' });
  }
});
router.patch('/inquiries/:id/answer', async (req, res) => {
  const { answer } = req.body;
  if (!answer?.trim()) return res.status(400).json({ error: '답변 내용을 입력해주세요.' });

  try {
    await ensureInquiriesTable();

    const { rows } = await db.query(
      "UPDATE inquiries SET answer=$1, status='answered', answered_at=NOW() WHERE id=$2 RETURNING *",
      [answer.trim(), req.params.id]
    );

    if (!rows.length) return res.status(404).json({ error: '문의를 찾을 수 없습니다.' });

    // 문의자에게 WS 알림 (user_id가 있을 때만)
    if (rows[0].user_id) {
      notifyUser(rows[0].user_id, {
        event: 'inquiry_answered',
        message: '📩 문의하신 내용에 답변이 등록됐습니다.',
        inquiryId: rows[0].id,
        title: rows[0].title
      });
    }

    res.json({ ok: true, inquiry: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '답변 저장 중 서버 오류가 발생했습니다.' });
  }
});

// ── 매칭 취소 이력 ───────────────────────
router.get('/cancelled-matches', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT m.id, m.cancel_reason, m.created_at, m.matched_at,
             op.name as owner_name, vp.name as visual_name
      FROM matches m
      JOIN profiles op ON op.user_id = m.owner_id
      JOIN profiles vp ON vp.user_id = m.visual_id
      WHERE m.status='cancelled' AND m.cancel_reason IS NOT NULL
      ORDER BY m.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 관리자 계정 CRUD ─────────────────────
router.post('/create-admin', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
  if (password.length < 8) return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
  try {
    const bcrypt = require('bcryptjs');
    const ex = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if (ex.rows.length) return res.status(409).json({ error: '이미 사용중인 이메일입니다.' });
    const hashed = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      "INSERT INTO users (email,password,role,status) VALUES ($1,$2,'admin','active') RETURNING id,email,role",
      [email, hashed]
    );
    if (name?.trim()) {
      await db.query(
        "INSERT INTO profiles (user_id,name,age,gender) VALUES ($1,$2,30,'male') ON CONFLICT DO NOTHING",
        [rows[0].id, name.trim()]
      );
    }
    res.status(201).json({ ok: true, message: '관리자 계정이 생성됐습니다.', user: rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: '서버 오류' }); }
});
router.get('/admins', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.created_at, p.name
       FROM users u LEFT JOIN profiles p ON p.user_id=u.id
       WHERE u.role='admin' ORDER BY u.created_at ASC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});
router.delete('/admins/:id', async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: '본인 계정은 삭제할 수 없습니다.' });
    const count = await db.query("SELECT COUNT(*) FROM users WHERE role='admin'");
    if (parseInt(count.rows[0].count) <= 1)
      return res.status(400).json({ error: '관리자가 1명이면 삭제할 수 없습니다.' });
    await db.query("DELETE FROM users WHERE id=$1 AND role='admin'", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 알림 발송 ────────────────────────────
router.post('/notify/:userId', async (req, res) => {
  const { type, message, link } = req.body;
  try {
    await db.query(
      'INSERT INTO notifications (user_id,type,message,link) VALUES ($1,$2,$3,$4)',
      [req.params.userId, type, message, link || null]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: '서버 오류' }); }
});

module.exports = router;
