require('dotenv').config();
const db  = require('./models/db');
const jwt = require('jsonwebtoken');

async function run() {
  console.log('\n🔍 API 직접 테스트\n' + '='.repeat(40));

  // 1. 첫 번째 cami 회원으로 토큰 생성
  const { rows: users } = await db.query(
    "SELECT id, email FROM users WHERE role='cami' AND status='active' LIMIT 1"
  );
  if (!users.length) { console.log('❌ cami 회원 없음'); process.exit(1); }
  const u = users[0];
  const token = jwt.sign({ id: u.id, role: 'cami' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  console.log(`테스트 유저: ${u.email}`);

  // 2. recommend 쿼리 직접 실행
  console.log('\n① recommend 쿼리:');
  try {
    const { rows } = await db.query(`
      SELECT
        u.id AS user_id, u.email, u.status, u.role,
        COALESCE(p.name, split_part(u.email,'@',1)) AS name,
        p.age, p.region, p.job,
        COALESCE(p.photos, '{}') AS photos,
        COALESCE(p.likes_count, 0) AS likes_count
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id != $1
        AND u.status = 'active'
        AND u.role = 'cami'
      ORDER BY RANDOM()
      LIMIT 10
    `, [u.id]);
    console.log(`  결과: ${rows.length}명`);
    rows.forEach(r => console.log(`    - ${r.name} (${r.email}) 사진:${r.photos?.length||0}장`));
  } catch(e) { console.log(`  ❌ 에러: ${e.message}`); }

  // 3. API 서버로 직접 HTTP 요청
  console.log('\n② HTTP GET /api/matching/recommend:');
  const http = require('http');
  await new Promise(resolve => {
    const req = http.request({
      hostname: 'localhost', port: process.env.PORT || 4000,
      path: '/api/matching/recommend',
      headers: { Authorization: `Bearer ${token}` }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        console.log(`  상태코드: ${res.statusCode}`);
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) console.log(`  응답: ${parsed.length}명`);
          else console.log(`  응답(에러):`, parsed);
        } catch { console.log(`  응답(raw):`, data.slice(0, 200)); }
        resolve();
      });
    });
    req.on('error', e => { console.log(`  ❌ 연결 실패: ${e.message}`); resolve(); });
    req.end();
  });

  // 4. matching.js 파일 현재 상태
  console.log('\n③ 현재 matching.js 경로:');
  const fs = require('fs');
  const path = require('path');
  const mpath = path.join(__dirname, 'routes/matching.js');
  const content = fs.readFileSync(mpath, 'utf8');
  console.log(`  파일 크기: ${content.length}자`);
  console.log(`  recommend 라우터: ${content.includes("router.get('/recommend'") ? '✅ 있음' : '❌ 없음'}`);
  console.log(`  exports: ${content.includes('module.exports') ? '✅ 있음' : '❌ 없음'}`);
  // 라우터 등록 확인
  const serverPath = path.join(__dirname, 'server.js');
  const serverContent = fs.readFileSync(serverPath, 'utf8');
  const matchingLine = serverContent.split('\n').find(l => l.includes('matching'));
  console.log(`  server.js 등록: ${matchingLine || '❌ 없음'}`);

  process.exit(0);
}

run().catch(e => { console.error('실패:', e.message); process.exit(1); });
