const { notifyUser } = require('./chat');
const router = require('express').Router();
const db     = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

// 추천 캐미 목록
router.get('/recommend', authMiddleware, async (req, res) => {
  try {
    const { region, taste, hobby } = req.query;

    const filterRegion = region || '';

    const filterTaste = taste
      ? taste.split(',').map(v => v.trim()).filter(Boolean)
      : [];

    const filterHobby = hobby
      ? hobby.split(',').map(v => v.trim()).filter(Boolean)
      : [];

    function regionAliases(regionValue) {
      const map = {
        '서울 강남·서초': ['서울 강남·서초', '강남', '서초'],
        '서울 마포·홍대': ['서울 마포·홍대', '마포', '홍대'],
        '서울 용산·이태원': ['서울 용산·이태원', '용산', '이태원'],
        '서울 기타': ['서울 기타', '서울'],
        '경기·인천': ['경기·인천', '경기', '인천'],
        '부산·경남': ['부산·경남', '부산', '경남'],
        '대구·경북': ['대구·경북', '대구', '경북'],
        '대전·충청': ['대전·충청', '대전', '충북', '충남', '충청'],
        '광주·전라': ['광주·전라', '광주', '전북', '전남', '전라'],
        '강원·제주': ['강원·제주', '강원', '제주'],
        '그 외': ['그 외', '기타', '해외']
      };

      return map[regionValue] || (regionValue ? [regionValue] : []);
    }

    const filterRegionAliases = regionAliases(filterRegion);

    const { rows } = await db.query(`
      WITH me_profile AS (
        SELECT gender FROM profiles WHERE user_id = $1
      ),
      candidate_profiles AS (
        SELECT
          u.id,
          u.email,
          u.status,
          u.role,
          COALESCE(p.user_id, u.id) as user_id,
          p.name,
          p.age,
          p.gender,
          p.region,
          p.job,
          p.bio,
          p.photos,
          COALESCE(p.taste,'{}') as taste,
          COALESCE(p.hobby,'{}') as hobby,
          (COALESCE(p.taste,'{}') || COALESCE(p.hobby,'{}')) as interests,
          p.height,
          p.weight,
          COALESCE(p.likes_count, 0) as likes_count
        FROM users u
        LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.id != $1
          AND u.status != 'blocked'
          AND u.role = 'cami'
          AND p.user_id IS NOT NULL
          AND p.name IS NOT NULL
          AND p.gender IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM me_profile me
            WHERE me.gender IS NOT NULL AND p.gender <> me.gender
          )
          AND NOT EXISTS (
            SELECT 1
            FROM chat_rooms cr
            JOIN matches m ON m.id = cr.match_id
            WHERE ((m.owner_id=$1 AND m.visual_id=u.id) OR (m.owner_id=u.id AND m.visual_id=$1))
          )
      )
      SELECT *,
        (
          CASE WHEN COALESCE(array_length($2::text[], 1), 0) > 0 AND region = ANY($2::text[]) THEN 3 ELSE 0 END
          + COALESCE((SELECT COUNT(*) FROM unnest(interests) i WHERE i = ANY($3::text[])),0) * 2
          + COALESCE((SELECT COUNT(*) FROM unnest(interests) i WHERE i = ANY($4::text[])),0) * 2
        ) as score
      FROM candidate_profiles
      WHERE
        -- 지역 필터: 선택 지역 카테고리에 속하는 회원만
        (
          COALESCE(array_length($2::text[], 1), 0) = 0
          OR region = ANY($2::text[])
          OR EXISTS (
            SELECT 1
            FROM unnest($2::text[]) alias
            WHERE region ILIKE '%' || alias || '%'
          )
        )

        -- 취향 필터: 선택한 취향/취미값을 interests 안에 가진 회원만
        AND (
          COALESCE(array_length($3::text[], 1), 0) = 0
          OR interests && $3::text[]
          OR EXISTS (
            SELECT 1
            FROM unnest(interests) item
            WHERE regexp_replace(item, '\s', '', 'g') = ANY(
              SELECT regexp_replace(x, '\s', '', 'g') FROM unnest($3::text[]) x
            )
          )
        )

        -- 취미 필터: 선택한 취미값을 interests 안에 가진 회원만
        AND (
          COALESCE(array_length($4::text[], 1), 0) = 0
          OR interests && $4::text[]
          OR EXISTS (
            SELECT 1
            FROM unnest(interests) item
            WHERE regexp_replace(item, '\s', '', 'g') = ANY(
              SELECT regexp_replace(x, '\s', '', 'g') FROM unnest($4::text[]) x
            )
          )
        )
      ORDER BY score DESC, likes_count DESC, RANDOM()
      LIMIT 30
    `, [req.user.id, filterRegionAliases, filterTaste, filterHobby]);

    res.json(rows);
  } catch (err) {
    console.error('recommend 오류:', err.message);
    res.status(500).json({ error: '서버 오류: ' + err.message });
  }
});

// 이달의 TOP 3
router.get('/top', async (req, res) => {
  try {
    const tblCheck = await db.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='profile_likes')`
    );
    if (!tblCheck.rows[0].exists) return res.json([]);

    const firstDay = new Date();
    firstDay.setDate(1); firstDay.setHours(0,0,0,0);

    const { rows } = await db.query(`
      SELECT p.name, p.age, p.region, p.job, p.photos, p.taste, p.hobby, p.bio,
             u.id as user_id,
             COUNT(pl.id) as month_likes
      FROM profile_likes pl
      JOIN users u ON u.id = pl.liked_id
      JOIN profiles p ON p.user_id = u.id
      WHERE pl.created_at >= $1
        AND u.status != 'blocked'
        AND u.role = 'cami'
      GROUP BY p.name,p.age,p.region,p.job,p.photos,p.taste,p.hobby,p.bio,u.id
      ORDER BY month_likes DESC
      LIMIT 3
    `, [firstDay]);

    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

// 좋아요 토글
router.post('/like/:targetId', authMiddleware, async (req, res) => {
  const { targetId } = req.params;
  if (targetId === req.user.id) return res.status(400).json({ error: '본인에게 좋아요할 수 없습니다.' });
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS profile_likes (
        id SERIAL PRIMARY KEY,
        liker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        liked_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(liker_id, liked_id)
      )
    `);
    const existing = await db.query(
      'SELECT id FROM profile_likes WHERE liker_id=$1 AND liked_id=$2',
      [req.user.id, targetId]
    );
    if (existing.rows.length) {
      await db.query('DELETE FROM profile_likes WHERE liker_id=$1 AND liked_id=$2', [req.user.id, targetId]);
      await db.query('UPDATE profiles SET likes_count=GREATEST(0,COALESCE(likes_count,0)-1) WHERE user_id=$1', [targetId]).catch(()=>{});
      return res.json({ ok: true, liked: false });
    }
    await db.query('INSERT INTO profile_likes (liker_id, liked_id) VALUES ($1,$2)', [req.user.id, targetId]);
    await db.query('UPDATE profiles SET likes_count=COALESCE(likes_count,0)+1 WHERE user_id=$1', [targetId]).catch(()=>{});

    const liker = await db.query(
      `SELECT COALESCE(p.name, split_part(u.email,'@',1)) AS name
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id=$1`,
      [req.user.id]
    ).catch(() => ({ rows: [] }));

    const likerName = liker.rows[0]?.name || '누군가';

    await db.query(
      `INSERT INTO notifications (user_id, type, message, link)
       VALUES ($1,$2,$3,$4)`,
      [targetId, 'profile_like', `${likerName}님이 회원님에게 좋아요를 눌렀습니다.`, '/pages/match.html']
    ).catch(() => {});

    notifyUser(targetId, {
      type: 'notification',
      event: 'profile_like',
      message: `${likerName}님이 회원님에게 좋아요를 눌렀습니다.`,
      link: '/pages/match.html'
    });

    res.json({ ok: true, liked: true });
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

// 내가 좋아요한 목록
router.get('/my-likes', authMiddleware, async (req, res) => {
  try {
    const tblCheck = await db.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='profile_likes')`
    );
    if (!tblCheck.rows[0].exists) return res.json([]);
    const { rows } = await db.query(
      'SELECT liked_id FROM profile_likes WHERE liker_id=$1',
      [req.user.id]
    );
    res.json(rows.map(r => r.liked_id));
  } catch (err) {
    res.json([]);
  }
});

router.get('/admin/list', authMiddleware, async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '관리자만 접근 가능합니다.' });
    try {
        const result = await db.query(`
      SELECT
        m.id,
        m.status,
        m.created_at,
        u1.id AS owner_id,
        u1.name AS owner_name,
        u2.id AS target_id,
        u2.name AS target_name
      FROM matches m
      JOIN users u1 ON m.owner_id = u1.id
      JOIN users u2 ON m.visual_id = u2.id
      ORDER BY m.created_at DESC
    `);

        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '관리자 신청 조회 실패' });
    }
});

router.post('/reject/:matchId', authMiddleware, async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '관리자만 접근 가능합니다.' });
    try {
        await db.query(
            "UPDATE matches SET status='rejected' WHERE id=$1",
            [req.params.matchId]
        );

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: '거절 실패' });
    }
});

module.exports = router;
