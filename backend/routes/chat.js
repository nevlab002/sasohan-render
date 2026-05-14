const router = require('express').Router();
const db     = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

// 사용자별/채팅방별 WebSocket 연결 저장소
const userConnections = new Map(); // userId → Set<ws>
const activeRooms = new Map(); // roomId → Set<ws>

async function tableExists(tableName) {
  const { rows } = await db.query(`SELECT to_regclass($1) AS name`, [`public.${tableName}`]);
  return !!rows[0]?.name;
}

// 채팅방 선택 전 요약 보드
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    await ensureMessagePhotoColumns();
    const { rows: rooms } = await db.query(
      `SELECT cr.id::text as room_id,
              cr.created_at as room_created_at,
              m.room_status,
              m.matched_at,
              CASE WHEN m.owner_id=$1 THEN m.visual_id ELSE m.owner_id END as partner_id,
              CASE WHEN m.owner_id=$1 THEN COALESCE(vp.name, split_part(ve.email,'@',1)) ELSE COALESCE(op.name, split_part(oe.email,'@',1)) END as partner_name,
              CASE WHEN m.owner_id=$1 THEN vp.photos ELSE op.photos END as partner_photos,
              COUNT(msg.id)::int as message_count,
              COUNT(msg.id) FILTER (WHERE msg.msg_type='photo')::int as photo_count,
              COUNT(msg.id) FILTER (WHERE msg.sender_id!=$1 AND msg.is_read=FALSE)::int as unread,
              MAX(msg.created_at) as last_at
       FROM chat_rooms cr
       JOIN matches m ON m.id = cr.match_id
       LEFT JOIN profiles op ON op.user_id = m.owner_id
       LEFT JOIN profiles vp ON vp.user_id = m.visual_id
       LEFT JOIN users oe ON oe.id = m.owner_id
       LEFT JOIN users ve ON ve.id = m.visual_id
       LEFT JOIN messages msg ON msg.room_id = cr.id
       WHERE m.owner_id=$1 OR m.visual_id=$1
       GROUP BY cr.id, cr.created_at, m.room_status, m.matched_at,
                m.owner_id, m.visual_id, op.name, vp.name, oe.email, ve.email,
                op.photos, vp.photos
       ORDER BY COALESCE(MAX(msg.created_at), cr.created_at) DESC`,
      [req.user.id]
    );

    const roomIds = rooms.map(r => r.room_id);
    const proposalMap = new Map();
    const chemiMap = new Map();

    if (roomIds.length && await tableExists('proposals')) {
      try {
        const { rows: proposals } = await db.query(
          `WITH latest AS (
             SELECT DISTINCT ON (room_id::text)
                    room_id::text, id, date_time, place, note, status, created_at
             FROM proposals
             WHERE room_id::text = ANY($1::text[])
             ORDER BY room_id::text, created_at DESC
           ),
           counts AS (
             SELECT room_id::text,
                    COUNT(*)::int as total,
                    COUNT(*) FILTER (WHERE status='accepted')::int as accepted,
                    COUNT(*) FILTER (WHERE status='pending')::int as pending
             FROM proposals
             WHERE room_id::text = ANY($1::text[])
             GROUP BY room_id::text
           )
           SELECT c.room_id, c.total, c.accepted, c.pending,
                  l.id as latest_id, l.date_time, l.place, l.note, l.status, l.created_at
           FROM counts c
           LEFT JOIN latest l ON l.room_id = c.room_id`,
          [roomIds]
        );
        proposals.forEach(p => proposalMap.set(p.room_id, p));
      } catch (e) {
        console.warn('채팅 요약 약속 조회 생략:', e.message);
      }
    }

    if (roomIds.length && await tableExists('chemi_games')) {
      try {
        const { rows: chemi } = await db.query(
          `WITH latest AS (
             SELECT DISTINCT ON (room_id)
                    room_id, id, status, score, round, topic, started_at, ended_at
             FROM chemi_games
             WHERE room_id = ANY($1::text[])
             ORDER BY room_id, started_at DESC
           ),
           counts AS (
             SELECT room_id,
                    COUNT(*)::int as total,
                    COALESCE(MAX(score),0)::int as best_score
             FROM chemi_games
             WHERE room_id = ANY($1::text[])
             GROUP BY room_id
           )
           SELECT c.room_id, c.total, c.best_score,
                  l.id as latest_id, l.status, l.score, l.round, l.topic, l.started_at, l.ended_at
           FROM counts c
           LEFT JOIN latest l ON l.room_id = c.room_id`,
          [roomIds]
        );
        chemi.forEach(c => chemiMap.set(c.room_id, c));
      } catch (e) {
        console.warn('채팅 요약 케미 조회 생략:', e.message);
      }
    }

    res.json({
      total_rooms: rooms.length,
      rooms: rooms.map(room => ({
        ...room,
        proposal: proposalMap.get(room.room_id) || null,
        chemi: chemiMap.get(room.room_id) || null
      }))
    });
  } catch (err) {
    console.error('채팅 요약 조회 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 사용자별/채팅방별 WebSocket 연결 저장소
async function checkRoomAccess(roomId, userId) {
  const result = await db.query(
    `SELECT cr.id FROM chat_rooms cr
     JOIN matches m ON m.id = cr.match_id
     WHERE cr.id=$1 AND (m.owner_id=$2 OR m.visual_id=$2)`,
    [roomId, userId]
  );
  return result.rows.length > 0;
}

// 메시지 조회
// 채팅방에 들어오면 상대가 보낸 메시지를 읽음 처리합니다.
router.get('/:roomId/messages', authMiddleware, async (req, res) => {
  const { roomId } = req.params;
  const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;

  try {
    const hasAccess = await checkRoomAccess(roomId, req.user.id);
    if (!hasAccess) return res.status(403).json({ error: '접근 권한이 없습니다.' });

    // 읽음 처리는 WS join 이벤트에서만 수행 (read 이벤트 전송 보장)
    // 여기서 UPDATE 하면 WS join 시 미읽음이 없어 read 이벤트가 발송되지 않음

    const { rows } = await db.query(
      `SELECT msg.id, msg.room_id, msg.sender_id, msg.content, msg.msg_type,
              msg.is_read, msg.created_at, msg.meta,
              COALESCE(p.name, split_part(u.email,'@',1)) as sender_name,
              p.photos as sender_photos
       FROM messages msg
       LEFT JOIN profiles p ON p.user_id = msg.sender_id
       LEFT JOIN users u ON u.id = msg.sender_id
       WHERE msg.room_id=$1
       ORDER BY msg.created_at ASC
       LIMIT $2 OFFSET $3`,
      [roomId, limit, offset]
    );

    res.json(rows);
  } catch (err) {
    console.error('메시지 조회 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});


// 전체 채팅 미읽음 개수
router.get('/unread-count', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS unread
       FROM messages msg
       JOIN chat_rooms cr ON cr.id = msg.room_id
       JOIN matches m ON m.id = cr.match_id
       WHERE msg.sender_id != $1
         AND msg.is_read = FALSE
         AND (m.owner_id = $1 OR m.visual_id = $1)`,
      [req.user.id]
    );

    res.json({ unread: rows[0]?.unread || 0 });
  } catch (err) {
    console.error('전체 채팅 미읽음 개수 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 채팅방 목록
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT cr.id as room_id,
              CASE WHEN m.owner_id=$1 THEN m.visual_id ELSE m.owner_id END as partner_id,
              CASE WHEN m.owner_id=$1 THEN COALESCE(vp.name, split_part(ve.email,'@',1)) ELSE COALESCE(op.name, split_part(oe.email,'@',1)) END as partner_name,
              CASE WHEN m.owner_id=$1 THEN vp.photos ELSE op.photos END as partner_photos,
              (SELECT content    FROM messages WHERE room_id=cr.id ORDER BY created_at DESC LIMIT 1) as last_message,
              (SELECT msg_type  FROM messages WHERE room_id=cr.id ORDER BY created_at DESC LIMIT 1) as last_msg_type,
              (SELECT created_at FROM messages WHERE room_id=cr.id ORDER BY created_at DESC LIMIT 1) as last_at,
              (SELECT COUNT(*)   FROM messages WHERE room_id=cr.id AND sender_id!=$1 AND is_read=FALSE)::int as unread
       FROM chat_rooms cr
       JOIN matches m ON m.id = cr.match_id
       LEFT JOIN profiles op ON op.user_id = m.owner_id
       LEFT JOIN profiles vp ON vp.user_id = m.visual_id
       LEFT JOIN users oe ON oe.id = m.owner_id
       LEFT JOIN users ve ON ve.id = m.visual_id
       WHERE m.owner_id=$1 OR m.visual_id=$1
       ORDER BY last_at DESC NULLS LAST`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('채팅방 목록 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});


async function ensureMessagePhotoColumns() {
  const cols = [
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read  BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_type VARCHAR(20) DEFAULT 'text'`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta     JSONB`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS content  TEXT`,
  ];
  for (const sql of cols) {
    await db.query(sql).catch(() => {});
  }
}

async function getRoomPartnerId(roomId, senderId) {
  const roomInfo = await db.query(
    `SELECT CASE WHEN m.owner_id=$1 THEN m.visual_id ELSE m.owner_id END AS partner_id
     FROM chat_rooms cr
     JOIN matches m ON m.id = cr.match_id
     WHERE cr.id=$2`,
    [senderId, roomId]
  ).catch(() => ({ rows: [] }));

  return roomInfo.rows[0]?.partner_id || null;
}


// 사진 전송
router.post('/:roomId/photo', authMiddleware, async (req, res) => {
  const multer = require('multer');
  const path   = require('path');
  const fs     = require('fs');

  const roomId = decodeURIComponent(req.params.roomId || '');

  if (!roomId || roomId === 'undefined' || roomId === 'null') {
    return res.status(400).json({ error: '채팅방 ID가 올바르지 않습니다.' });
  }

  const uploadDir = path.resolve(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      const safeName = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
      cb(null, safeName);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!file.mimetype || !file.mimetype.startsWith('image/')) {
        return cb(new Error('이미지 파일만 전송할 수 있습니다.'));
      }
      cb(null, true);
    }
  }).single('photo');

  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: '업로드 실패: ' + err.message });
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

    try {
      const hasAccess = await checkRoomAccess(roomId, req.user.id).catch(() => false);
      if (!hasAccess) return res.status(403).json({ error: '접근 권한이 없습니다.' });

      await ensureMessagePhotoColumns();

      // 이미지 최적화 (GIF는 애니메이션 보존을 위해 변환 생략)
      let finalFilename = req.file.filename;
      const isGif = req.file.mimetype === 'image/gif';
      if (!isGif) {
        try {
          const sharp = require('sharp');
          const rawPath = path.resolve(__dirname, '..', 'uploads', req.file.filename);
          const base    = path.basename(req.file.filename, path.extname(req.file.filename));
          const outPath = path.resolve(__dirname, '..', 'uploads', `${base}.jpg`);
          await sharp(rawPath)
            .rotate()
            .resize(1400, 1400, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 88, progressive: true })
            .toFile(outPath);
          if (outPath !== rawPath) fs.unlink(rawPath, () => {});
          finalFilename = `${base}.jpg`;
        } catch {}
      }

      const url = '/uploads/' + finalFilename;
      const roomClients = activeRooms.get(roomId) || new Set();

      const partnerIsInRoom = [...roomClients].some(
        client => client.readyState === 1 && client.userId && client.userId !== req.user.id
      );

      const { rows } = await db.query(
        `INSERT INTO messages (room_id, sender_id, content, msg_type, is_read)
         VALUES ($1,$2,$3,'photo',$4)
         RETURNING id, room_id, sender_id, content, msg_type, is_read, created_at, meta`,
        [roomId, req.user.id, url, partnerIsInRoom]
      );

      const profileRes = await db.query(
        'SELECT name, photos FROM profiles WHERE user_id=$1',
        [req.user.id]
      ).catch(() => ({ rows: [] }));

      const msgWithProfile = {
        ...rows[0],
        roomId,
        sender_name: profileRes.rows[0]?.name || null,
        sender_photos: profileRes.rows[0]?.photos || []
      };

      // 현재 방 접속자에게 즉시 표시
      roomClients.forEach(client => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: 'message', data: msgWithProfile }));
        }
      });

      // 상대가 방 밖이면 텍스트 채팅처럼 채팅 숫자/토스트 알림
      if (!partnerIsInRoom) {
        const partnerId = await getRoomPartnerId(roomId, req.user.id);
        if (partnerId) {
          notifyUser(partnerId, {
            type: 'message',
            event: 'new_message',
            room_id: roomId,
            roomId,
            preview: '사진',
            data: msgWithProfile
          });
        }
      }

      if (partnerIsInRoom) {
        roomClients.forEach(client => {
          if (client.readyState === 1 && client.userId === req.user.id) {
            client.send(JSON.stringify({
              type: 'read',
              room_id: roomId,
              reader_id: 'partner'
            }));
          }
        });
      }

      res.json({ ok: true, url, message: msgWithProfile });
    } catch(e) {
      console.error('사진 메시지 저장 오류:', e);
      res.status(500).json({ error: '사진 저장 실패: ' + e.message });
    }
  });
});


module.exports = router;

// WebSocket
// 사용자별 WS 연결 맵 (글로벌 알림용) - module level

// 특정 사용자에게 이벤트 전송
function notifyUser(userId, payload) {
  const conns = userConnections.get(userId);
  if (!conns || conns.size === 0) return;
  // type이 명시된 경우 그대로, 없으면 notification
  const finalPayload = payload.type ? payload : { type: 'notification', ...payload };
  const msg = JSON.stringify(finalPayload);
  conns.forEach(client => {
    if (client && client.readyState === 1) {
      try { client.send(msg); } catch(e) {}
    }
  });
}

// 방 전체에 브로드캐스트
function broadcastToRoom(roomId, payload) {
  const roomClients = activeRooms.get(roomId);
  if (!roomClients) return;

  const msg = JSON.stringify(payload);

  roomClients.forEach(client => {
    if (client && client.readyState === 1) {
      try { client.send(msg); } catch(e) {}
    }
  });
}
module.exports.broadcastToRoom = broadcastToRoom;

// 외부에서 사용할 수 있도록 export
module.exports.notifyUser = notifyUser;

function setupWebSocket(wss, db) {
  const rooms = activeRooms;

  wss.on('connection', (ws) => {
    let userId = null;
    let roomId = null;
    let pingInterval = null;

    pingInterval = setInterval(() => {
      if (ws.readyState === 1) ws.ping();
    }, 25000);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      if (data.type === 'auth') {
        try {
          const jwt = require('jsonwebtoken');
          const payload = jwt.verify(data.token, process.env.JWT_SECRET);
          userId = payload.id;
          ws.userId = userId;
          // 사용자별 연결 맵에 등록
          if (!userConnections.has(userId)) userConnections.set(userId, new Set());
          userConnections.get(userId).add(ws);
          ws.send(JSON.stringify({ type: 'authed', ok: true }));
        } catch { ws.close(1008, 'Invalid token'); }
        return;
      }

      if (!userId) { ws.close(1008, 'Not authenticated'); return; }

      if (data.type === 'join') {
        const hasAccess = await checkRoomAccess(data.roomId, userId).catch(() => false);
        if (!hasAccess) {
          ws.send(JSON.stringify({ type: 'error', message: '접근 권한이 없습니다.' }));
          return;
        }

        // 이전 방 퇴장
        if (roomId && rooms.has(roomId)) rooms.get(roomId).delete(ws);

        roomId = data.roomId;
        if (!rooms.has(roomId)) rooms.set(roomId, new Set());
        rooms.get(roomId).add(ws);

        // 내가 채팅방에 들어온 순간, 상대가 보낸 미읽음 메시지 읽음 처리
        const readResult = await db.query(
          'UPDATE messages SET is_read=TRUE WHERE room_id=$1 AND sender_id!=$2 AND is_read=FALSE RETURNING sender_id',
          [roomId, userId]
        ).catch(() => ({ rows: [] }));

        ws.send(JSON.stringify({ type: 'joined', roomId }));

        // 상대방 화면의 "읽지않음" 표시를 "읽음"으로 즉시 변경
        // userConnections 기반으로 전송해야 상대가 다른 화면에 있어도 실시간 반영됨
        if (readResult.rows.length) {
          const readPayload = JSON.stringify({ type: 'read', room_id: roomId, reader_id: userId });
          const senderIds = [...new Set(readResult.rows.map(r => String(r.sender_id)))];
          for (const sid of senderIds) {
            // 같은 방에 있는 경우
            rooms.get(roomId)?.forEach(client => {
              if (client.readyState === 1 && String(client.userId) === sid) client.send(readPayload);
            });
            // 다른 화면에 있어도 userConnections로 전달
            const conns = userConnections.get(sid);
            if (conns) conns.forEach(c => { if (c.readyState === 1) { try { c.send(readPayload); } catch {} } });
          }
        }

        return;
      }

      // 캐미라인 게임 이벤트 브로드캐스트
      if (data.type === 'chemi_event' && roomId) {
        const roomClients = rooms.get(roomId) || new Set();

        // invite는 먼저 상대 접속 여부를 확인해야 한다.
        // 기존 코드는 초대를 먼저 브로드캐스트한 뒤 실패를 보냈기 때문에
        // 초대자 본인 화면까지 수신자 상태로 꼬이는 문제가 있었다.
        if (data.data?.event === 'invite') {
          const partnerInRoom = [...roomClients].some(
            cl => cl.userId !== userId && cl.readyState === 1
          );
          if (!partnerInRoom) {
            const inviterWs = [...roomClients].find(cl => cl.userId === userId && cl.readyState === 1);
            if (inviterWs) {
              inviterWs.send(JSON.stringify({
                type: 'chemi_event',
                data: { event: 'invite_failed', reason: 'partner_not_in_room' },
                from: userId
              }));
            }
            return;
          }
        }

        // 보낸 사람에게 다시 보내지 않는다.
        // 보낸 사람은 이미 로컬에서 화면 전환을 처리하고 있으므로,
        // self echo가 들어오면 showChemiReady/showRoundResult가 중복 실행되어 타이머가 여러 개 생긴다.
        const chemiPayload = JSON.stringify({ type: 'chemi_event', data: data.data, from: userId });
        roomClients.forEach(client => {
          if (client.readyState === 1 && client.userId !== userId) client.send(chemiPayload);
        });
        return;
      }

      // 타이핑 인디케이터: 상대방에게만 전달
      if (data.type === 'typing' && roomId) {
        const roomClients = rooms.get(roomId) || new Set();
        const payload = JSON.stringify({ type: 'typing', isTyping: !!data.isTyping, userId });
        roomClients.forEach(client => {
          if (client.readyState === 1 && client.userId !== userId) client.send(payload);
        });
        return;
      }

      if (data.type === 'message' && roomId) {
        const content = (data.content || '').toString().trim().slice(0, 1000);
        if (!content) return;

        try {
          // 차단 관계가 있으면 (내가 차단 or 상대가 나를 차단) 메시지 드롭
          const partnerRes = await db.query(
            `SELECT CASE WHEN m.owner_id=$1 THEN m.visual_id ELSE m.owner_id END as partner_id
             FROM chat_rooms cr JOIN matches m ON m.id=cr.match_id WHERE cr.id=$2`,
            [userId, roomId]
          ).catch(() => ({ rows: [] }));
          const partnerId = partnerRes.rows[0]?.partner_id;
          if (partnerId) {
            const blk = await db.query(
              `SELECT 1 FROM blocks
               WHERE (blocker_id=$1 AND blocked_id=$2)
                  OR (blocker_id=$2 AND blocked_id=$1)`,
              [userId, partnerId]
            ).catch(() => ({ rows: [] }));
            if (blk.rows.length) return; // 차단 관계 → 메시지 드롭
          }
          const roomClients = rooms.get(roomId) || new Set();
          const partnerIsInRoom = [...roomClients].some(
            client => client.readyState === 1 && client.userId && client.userId !== userId
          );

          // 상대가 이미 방에 들어와 있으면 저장 순간부터 읽음 처리
          const { rows } = await db.query(
            `INSERT INTO messages (room_id, sender_id, content, is_read)
             VALUES ($1,$2,$3,$4)
             RETURNING *`,
            [roomId, userId, content, partnerIsInRoom]
          );

          const profileRes = await db.query(
            'SELECT name, photos FROM profiles WHERE user_id=$1',
            [userId]
          );

          const msgWithProfile = {
            ...rows[0],
            roomId,
            sender_name:   profileRes.rows[0]?.name   || null,
            sender_photos: profileRes.rows[0]?.photos || []
          };

          roomClients.forEach(client => {
            if (client.readyState === 1) {
              client.send(JSON.stringify({ type: 'message', data: msgWithProfile }));
            }
          });

          // 상대가 방에 없으면 userConnections로 알림 (다른 페이지에 있어도 수신)
          if (!partnerIsInRoom) {
            const roomInfo = await db.query(
              `SELECT CASE WHEN m.owner_id=$1 THEN m.visual_id ELSE m.owner_id END as partner_id
               FROM chat_rooms cr JOIN matches m ON m.id=cr.match_id WHERE cr.id=$2`,
              [userId, roomId]
            ).catch(() => ({ rows: [] }));
            if (roomInfo.rows[0]?.partner_id) {
              notifyUser(roomInfo.rows[0].partner_id, {
                type: 'message',
                event: 'new_message',
                room_id: roomId,
                preview: content.slice(0, 30),
                data: msgWithProfile
              });
            }
          }

          // 상대가 들어와 있던 경우, 보낸 사람 화면에 읽음 상태를 확실히 반영
          if (partnerIsInRoom) {
            roomClients.forEach(client => {
              if (client.readyState === 1 && client.userId === userId) {
                client.send(JSON.stringify({
                  type: 'read',
                  room_id: roomId,
                  reader_id: 'partner'
                }));
              }
            });
          }
        } catch (err) {
          console.error('메시지 저장 오류:', err);
        }
      }
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      const leftRoomId = roomId;
      if (roomId && rooms.has(roomId)) {
        rooms.get(roomId).delete(ws);
        if (rooms.get(roomId).size === 0) rooms.delete(roomId);
      }
      // 케미게임 중 채팅방 이탈/브라우저 종료 시 자동 종료
      // 단, 네트워크 순간 재연결로 같은 사용자가 같은 방에 즉시 다시 들어오면 종료하지 않는다.
      if (leftRoomId) {
        setTimeout(() => {
          const roomClients = rooms.get(leftRoomId) || new Set();
          const sameUserStillInRoom = [...roomClients].some(
            client => client.readyState === 1 && String(client.userId) === String(userId)
          );
          if (!sameUserStillInRoom) {
            cancelGame(leftRoomId, 'disconnect').catch(e => {
              console.error('chemi disconnect 종료 오류:', e.message);
            });
          }
        }, 1500);
      }
      // userConnections에서도 제거
      if (userId && userConnections.has(userId)) {
        userConnections.get(userId).delete(ws);
        if (userConnections.get(userId).size === 0) userConnections.delete(userId);
      }
    });

    ws.on('error', (err) => console.error('WS 오류:', err.message));
  });
}

module.exports.setupWebSocket = setupWebSocket;


// ═══════════════════════════════════════════
// 케미라인 게임 (완전 재작성)
// 규칙: 신청→수락→주제3초→답변10초→정답+10점→3번틀리면종료
// ═══════════════════════════════════════════
const chemiRouter = require('express').Router();

// 주제 6개 고정 (프론트엔드와 동일)
const CHEMI_TOPICS  = ['동물', '연예인', '아이돌', '계절', '예능프로', '만화'];
const CHEMI_SET     = new Set(CHEMI_TOPICS);
const INTRO_MS      = 3000;   // 주제 확인 시간
const ANSWER_MS     = 10000;  // 답변 입력 시간
const RESULT_MS     = 3000;   // 결과 표시 시간 (다음 라운드 시작 전 여유)
const MAX_WRONG     = 3;      // 오답 횟수 한도

const gameTimers = new Map(); // gameId → timeout
function clearGameTimer(id) { const t = gameTimers.get(id); if (t) { clearTimeout(t); gameTimers.delete(id); } }
function setGameTimer(id, fn, ms) { clearGameTimer(id); gameTimers.set(id, setTimeout(fn, ms)); }

async function ensureChemiTables() {
  await db.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`).catch(() => {});

  // 필수 컬럼이 없으면 구버전 테이블이므로 드롭 후 재생성 (점수 테이블은 유지)
  const colCheck = await db.query(`
    SELECT COUNT(*)::int AS cnt
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='chemi_games'
      AND column_name IN ('inviter_id','responder_id','wrong_count','deadline_at','answer_started_at')
  `).catch(() => ({ rows: [{ cnt: 0 }] }));

  if (Number(colCheck.rows[0]?.cnt || 0) < 5) {
    console.log('[chemi] 구버전 테이블 감지 → 재생성');
    await db.query(`DROP TABLE IF EXISTS chemi_games CASCADE`).catch(() => {});
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS chemi_games (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      room_id           TEXT NOT NULL,
      inviter_id        TEXT DEFAULT '',
      responder_id      TEXT DEFAULT '',
      topic             TEXT NOT NULL DEFAULT '',
      used_topics       TEXT[] DEFAULT '{}',
      round             INT  DEFAULT 1,
      score             INT  DEFAULT 0,
      wrong_count       INT  DEFAULT 0,
      answers           JSONB DEFAULT '[]',
      status            TEXT DEFAULT 'pending',
      round_started_at  TIMESTAMPTZ,
      answer_started_at TIMESTAMPTZ,
      deadline_at       TIMESTAMPTZ,
      started_at        TIMESTAMPTZ DEFAULT NOW(),
      ended_at          TIMESTAMPTZ
    )
  `).catch(e => console.error('[chemi] 테이블 생성 오류:', e.message));

  await db.query(`
    CREATE TABLE IF NOT EXISTS chemi_scores (
      room_id    TEXT PRIMARY KEY,
      score      INT  DEFAULT 0,
      month      TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
}

async function saveChemiScore(roomId, score) {
  if (score <= 0) return;
  const month = new Date().toISOString().slice(0, 7);
  await db.query(`
    INSERT INTO chemi_scores (room_id, score, month)
    VALUES ($1,$2,$3)
    ON CONFLICT (room_id)
    DO UPDATE SET score=GREATEST(chemi_scores.score,$2), month=$3, updated_at=NOW()
  `, [String(roomId), score, month]).catch(e => console.error('chemi score 저장 오류:', e.message));
}

function norm(v) { return String(v || '').trim().replace(/\s+/g, '').toLowerCase(); }

function pickNext(current, used) {
  const blocked = new Set([...used, current]);
  const pool = CHEMI_TOPICS.filter(t => !blocked.has(t));
  const src = pool.length ? pool : CHEMI_TOPICS;
  return src[Math.floor(Math.random() * src.length)];
}

function bcast(roomId, data) {
  broadcastToRoom(String(roomId), { type: 'chemi_event', data });
}

// 라운드 타임스탬프 생성 (fromNow: 결과 표시 여유 시간 ms)
function mkTs(fromNow = 0) {
  const rStart  = new Date(Date.now() + fromNow);
  const aStart  = new Date(rStart.getTime() + INTRO_MS);
  const dead    = new Date(aStart.getTime() + ANSWER_MS);
  return { roundStartedAt: rStart, answerStartedAt: aStart, deadlineAt: dead };
}

// 라운드 결과 처리 (트랜잭션 보장)
async function resolveRound(gameId, round, timeout = false) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM chemi_games WHERE id=$1 AND status='active' AND round=$2 FOR UPDATE`,
      [gameId, round]
    );
    const g = rows[0];
    if (!g) { await client.query('ROLLBACK'); return; }

    clearGameTimer(gameId);

    const answers = Array.isArray(g.answers) ? g.answers : JSON.parse(g.answers || '[]');
    // 이번 라운드의 답변 2개를 가져옴 (inviter_id/responder_id 칼럼 없을 경우 제출 순서로 대체)
    const roundAnswers = answers.filter(a => Number(a.round) === Number(round));
    const a1r = g.inviter_id
      ? roundAnswers.find(a => String(a.user_id).toLowerCase() === String(g.inviter_id).toLowerCase())
      : roundAnswers[0];
    const a2r = g.responder_id
      ? roundAnswers.find(a => String(a.user_id).toLowerCase() === String(g.responder_id).toLowerCase())
      : roundAnswers[1];
    const a1  = norm(a1r?.answer);
    const a2  = norm(a2r?.answer);
    const matched    = !!(a1 && a2 && a1 === a2);
    const newScore   = g.score + (matched ? 10 : 0);
    const newWrong   = g.wrong_count + (matched ? 0 : 1);

    if (newWrong >= MAX_WRONG) {
      await client.query(
        `UPDATE chemi_games SET score=$1, wrong_count=$2, status='done', ended_at=NOW() WHERE id=$3`,
        [newScore, newWrong, gameId]
      );
      await client.query('COMMIT');
      await saveChemiScore(g.room_id, newScore);
      bcast(g.room_id, {
        event: 'game_end', matched, timeout, finalScore: newScore,
        wrongCount: newWrong, maxWrong: MAX_WRONG, round,
        a1answer: a1r?.answer || '(미응답)', a2answer: a2r?.answer || '(미응답)'
      });
      return;
    }

    // 다음 라운드 준비 (RESULT_MS 뒤에 시작)
    const used      = Array.isArray(g.used_topics) ? g.used_topics : [];
    const nextTopic = pickNext(g.topic, used);
    const nextUsed  = [...used, g.topic];
    const nextRound = round + 1;
    const ts        = mkTs(RESULT_MS);

    await client.query(
      `UPDATE chemi_games
       SET score=$1, wrong_count=$2, round=$3, topic=$4, used_topics=$5,
           round_started_at=$6, answer_started_at=$7, deadline_at=$8, answers='[]'
       WHERE id=$9`,
      [newScore, newWrong, nextRound, nextTopic, nextUsed,
       ts.roundStartedAt, ts.answerStartedAt, ts.deadlineAt, gameId]
    );
    await client.query('COMMIT');

    // 클라이언트에 결과 + 다음 라운드 타임스탬프 전달
    bcast(g.room_id, {
      event: 'round_result', matched, timeout, score: newScore,
      wrongCount: newWrong, maxWrong: MAX_WRONG, round,
      a1answer: a1r?.answer || '(미응답)', a2answer: a2r?.answer || '(미응답)',
      nextRound, nextTopic,
      serverNow:       Date.now(),
      roundStartedAt:  ts.roundStartedAt.toISOString(),
      answerStartedAt: ts.answerStartedAt.toISOString(),
      deadlineAt:      ts.deadlineAt.toISOString()
    });

    // 서버 측 마감 타이머
    setGameTimer(gameId,
      () => resolveRound(gameId, nextRound, true).catch(e => console.error('chemi timeout 오류:', e.message)),
      ts.deadlineAt.getTime() - Date.now() + 400
    );
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('chemi resolveRound 오류:', e.message);
  } finally {
    client.release();
  }
}

async function cancelGame(roomId, reason = 'cancelled') {
  await ensureChemiTables();
  const { rows } = await db.query(
    `UPDATE chemi_games SET status='cancelled', ended_at=NOW()
     WHERE room_id=$1 AND status IN ('pending','active') RETURNING *`,
    [String(roomId)]
  ).catch(() => ({ rows: [] }));
  for (const g of rows) {
    clearGameTimer(g.id);
    if (Number(g.score) > 0) await saveChemiScore(g.room_id, g.score).catch(() => {});
    bcast(g.room_id, { event: 'game_cancelled', reason, finalScore: Number(g.score || 0) });
  }
  return rows[0] || null;
}

// ── 게임 신청 ─────────────────────────────
chemiRouter.post('/:roomId/chemi/start', authMiddleware, async (req, res) => {
  const { roomId } = req.params;
  const userId = req.user.id;
  try {
    await ensureChemiTables();
    if (!await checkRoomAccess(roomId, userId)) return res.status(403).json({ error: '접근 권한이 없습니다.' });

    // 상대방 ID 조회 (UUID 타입 명시 캐스트로 비교 오류 방지)
    const { rows: mr } = await db.query(
      `SELECT CASE WHEN m.owner_id=$1::uuid THEN m.visual_id::text ELSE m.owner_id::text END as pid
       FROM chat_rooms cr JOIN matches m ON m.id=cr.match_id WHERE cr.id=$2::uuid`,
      [userId, roomId]
    );
    if (!mr[0]) return res.status(404).json({ error: '상대방을 찾을 수 없습니다.' });
    const partnerId = String(mr[0].pid).toLowerCase();

    // 상대방 WS 접속 확인
    const roomClients = activeRooms.get(String(roomId)) || new Set();
    const partnerWs = [...roomClients].find(ws => ws.readyState === 1 && String(ws.userId) === partnerId);
    if (!partnerWs) return res.status(409).json({ error: '상대방이 채팅방에 접속해 있지 않습니다.' });

    await cancelGame(roomId, 'new_invite');

    const reqTopic = String(req.body?.topic || '').trim();
    const topic = CHEMI_SET.has(reqTopic) ? reqTopic : CHEMI_TOPICS[0];

    const { rows } = await db.query(
      `INSERT INTO chemi_games (room_id, inviter_id, responder_id, topic)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [String(roomId), String(userId), partnerId, topic]
    );

    // 상대방에게 직접 초대 이벤트 전송 (roomId 포함 → accept 시 올바른 room 보장)
    partnerWs.send(JSON.stringify({
      type: 'chemi_event',
      data: { event: 'invite', topic, gameId: rows[0].id, roomId: String(roomId) }
    }));

    res.json({ ok: true, topic, gameId: rows[0].id });
  } catch (e) {
    console.error('chemi start 오류:', e.message);
    res.status(500).json({ error: '서버 오류', detail: e.message });
  }
});

// ── 게임 수락 ─────────────────────────────
chemiRouter.post('/:roomId/chemi/accept', authMiddleware, async (req, res) => {
  const { roomId } = req.params;
  const userId = req.user.id;
  try {
    await ensureChemiTables();
    if (!await checkRoomAccess(roomId, userId)) return res.status(403).json({ error: '접근 권한이 없습니다.' });

    const client = await db.connect();
    let game;
    try {
      await client.query('BEGIN');
      // responder_id 필터 제거 - UUID 포맷 불일치로 인한 조회 실패 방지
      // 대신 해당 방의 최신 pending 게임을 가져온 후 본인이 초대자가 아닌지만 확인
      const { rows } = await client.query(
        `SELECT * FROM chemi_games
         WHERE room_id=$1 AND status='pending'
         ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
        [String(roomId)]
      );
      if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: '수락할 초대가 없습니다.' }); }
      if (rows[0].inviter_id && rows[0].inviter_id.toLowerCase() === String(userId).toLowerCase()) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: '본인이 신청한 게임입니다.' });
      }

      const ts = mkTs(0); // 라운드 1은 즉시 시작
      const { rows: up } = await client.query(
        `UPDATE chemi_games
         SET status='active', round=1, score=0, wrong_count=0, answers='[]',
             round_started_at=$1, answer_started_at=$2, deadline_at=$3
         WHERE id=$4 RETURNING *`,
        [ts.roundStartedAt, ts.answerStartedAt, ts.deadlineAt, rows[0].id]
      );
      game = up[0];
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // 마감 타이머 예약
    setGameTimer(game.id,
      () => resolveRound(game.id, 1, true).catch(e => console.error('chemi timeout 오류:', e.message)),
      new Date(game.deadline_at).getTime() - Date.now() + 400
    );

    // 양쪽에 게임 시작 이벤트 브로드캐스트
    bcast(roomId, {
      event: 'game_started',
      topic: game.topic, round: 1, score: 0, wrongCount: 0, maxWrong: MAX_WRONG,
      serverNow:       Date.now(),
      roundStartedAt:  game.round_started_at,
      answerStartedAt: game.answer_started_at,
      deadlineAt:      game.deadline_at
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('chemi accept 오류:', e.message);
    res.status(500).json({ error: '서버 오류', detail: e.message });
  }
});

// ── 게임 거절 ─────────────────────────────
chemiRouter.post('/:roomId/chemi/reject', authMiddleware, async (req, res) => {
  try {
    await cancelGame(req.params.roomId, 'rejected');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 게임 취소 ─────────────────────────────
chemiRouter.post('/:roomId/chemi/cancel', authMiddleware, async (req, res) => {
  try {
    await cancelGame(req.params.roomId, req.body?.reason || 'cancelled');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// ── 답변 제출 ─────────────────────────────
chemiRouter.post('/:roomId/chemi/answer', authMiddleware, async (req, res) => {
  const { roomId } = req.params;
  const userId = req.user.id;
  const answer = String(req.body?.answer || '').trim().slice(0, 20);
  const clientRound = Number(req.body?.round || 0);
  try {
    await ensureChemiTables();
    if (!await checkRoomAccess(roomId, userId)) return res.status(403).json({ error: '접근 권한이 없습니다.' });

    const client = await db.connect();
    let shouldResolve = false, gameId, round;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT * FROM chemi_games WHERE room_id=$1 AND status='active' ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
        [String(roomId)]
      );
      const g = rows[0];
      if (!g) { await client.query('ROLLBACK'); return res.status(409).json({ error: '진행 중인 게임이 없습니다.' }); }
      if (Number(g.round) !== clientRound) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: '라운드가 맞지 않습니다.', currentRound: g.round });
      }
      const now = new Date();
      if (now < new Date(g.answer_started_at)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: '아직 답변 시간이 시작되지 않았습니다.' });
      }
      const answers = Array.isArray(g.answers) ? g.answers : JSON.parse(g.answers || '[]');
      if (answers.some(a => a.round === clientRound && a.user_id === userId)) {
        await client.query('ROLLBACK');
        return res.json({ ok: true, state: 'already_answered' });
      }
      answers.push({ user_id: userId, answer, round: clientRound, at: now.toISOString() });
      await client.query(`UPDATE chemi_games SET answers=$1 WHERE id=$2`, [JSON.stringify(answers), g.id]);
      gameId = g.id; round = g.round;
      const both = answers.filter(a => a.round === clientRound).length >= 2;
      shouldResolve = both || now > new Date(g.deadline_at);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    if (shouldResolve) {
      await resolveRound(gameId, round, false);
      return res.json({ ok: true, state: 'resolved' });
    }
    bcast(roomId, { event: 'answer_submitted', by: userId, round: clientRound });
    res.json({ ok: true, state: 'waiting' });
  } catch (e) {
    console.error('chemi answer 오류:', e.message);
    res.status(500).json({ error: '서버 오류', detail: e.message });
  }
});

// ── 현재 게임 상태 조회 ───────────────────
chemiRouter.get('/:roomId/chemi', authMiddleware, async (req, res) => {
  try {
    await ensureChemiTables();
    if (!await checkRoomAccess(req.params.roomId, req.user.id)) return res.status(403).json({ error: '권한 없음' });
    const { rows } = await db.query(
      `SELECT * FROM chemi_games WHERE room_id=$1 ORDER BY started_at DESC LIMIT 1`,
      [String(req.params.roomId)]
    );
    const g = rows[0];
    if (!g) return res.json(null);
    res.json({
      id: g.id, status: g.status, topic: g.topic, round: g.round,
      score: g.score, wrongCount: g.wrong_count, maxWrong: MAX_WRONG,
      inviterId: g.inviter_id, responderId: g.responder_id,
      roundStartedAt:  g.round_started_at,
      answerStartedAt: g.answer_started_at,
      deadlineAt:      g.deadline_at
    });
  } catch (e) { res.json(null); }
});

// ── 이달의 TOP 랭킹 ───────────────────────
chemiRouter.get('/top', async (req, res) => {
  try {
    await ensureChemiTables();
    const month = new Date().toISOString().slice(0, 7);
    const { rows } = await db.query(`
      SELECT cs.room_id, cs.score, cs.updated_at,
             COALESCE(p1.name, split_part(u1.email,'@',1)) AS owner_name,
             COALESCE(p2.name, split_part(u2.email,'@',1)) AS visual_name,
             p1.photos AS owner_photos, p2.photos AS visual_photos
      FROM chemi_scores cs
      JOIN chat_rooms cr ON cr.id::text = cs.room_id::text
      JOIN matches m ON m.id = cr.match_id
      LEFT JOIN users u1 ON u1.id = m.owner_id
      LEFT JOIN users u2 ON u2.id = m.visual_id
      LEFT JOIN profiles p1 ON p1.user_id = m.owner_id
      LEFT JOIN profiles p2 ON p2.user_id = m.visual_id
      WHERE cs.month = $1
      ORDER BY cs.score DESC, cs.updated_at ASC
      LIMIT 10
    `, [month]);
    const now = new Date();
    const eom = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    res.json({ rows, resetIn: Math.ceil((eom - now) / 86400000), month });
  } catch (e) {
    res.json({ rows: [], resetIn: 0, month: '' });
  }
});

module.exports.chemiRouter = chemiRouter;
