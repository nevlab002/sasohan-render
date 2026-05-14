# 사소한 — 소개팅 서비스

프리미엄 소개팅 플랫폼. 오너 회원 ↔ 비주얼 회원 매칭 시스템.

---

## 📁 프로젝트 구조

```
sasohan/
├── backend/
│   ├── server.js          ← 메인 서버 (Express + WebSocket)
│   ├── schema.sql         ← DB 테이블 정의
│   ├── .env.example       ← 환경변수 템플릿
│   ├── models/
│   │   └── db.js          ← PostgreSQL 연결
│   ├── middleware/
│   │   └── auth.js        ← JWT 인증 미들웨어
│   └── routes/
│       ├── auth.js        ← 회원가입 / 로그인 / 내 정보
│       ├── profiles.js    ← 프로필 CRUD + 사진 업로드
│       ├── matches.js     ← 좋아요 / 매칭
│       ├── chat.js        ← 채팅방 + WebSocket
│       └── safety.js      ← 신고 / 차단
└── frontend/
    ├── assets/
    │   └── api.js         ← 공통 API 클라이언트
    └── pages/
        ├── login.html     ← 로그인 / 회원가입
        ├── profile.html   ← 프로필 작성
        ├── match.html     ← 카드 스와이프 매칭
        ├── chat.html      ← 1:1 채팅
        └── admin.html     ← 관리자 패널
```

---

## 🚀 실행 방법

### 1. PostgreSQL 설치 및 DB 생성

```bash
# PostgreSQL 설치 후
psql -U postgres
CREATE DATABASE sasohan;
\c sasohan
\i backend/schema.sql
```

### 2. 백엔드 설정

```bash
cd backend
npm install

# .env 파일 생성
cp .env.example .env
# .env 파일 열어서 DATABASE_URL, JWT_SECRET 설정
```

**.env 예시:**
```
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/sasohan
JWT_SECRET=sasohan_super_secret_2024
PORT=4000
CLIENT_URL=http://localhost:4000
```

### 3. 서버 실행

```bash
# 개발 모드 (자동 재시작)
npm run dev

# 또는 일반 실행
npm start
```

### 4. 접속

| URL | 설명 |
|-----|------|
| `http://localhost:4000` | 랜딩 페이지 |
| `http://localhost:4000/pages/login.html` | 로그인/회원가입 |
| `http://localhost:4000/pages/match.html` | 매칭 |
| `http://localhost:4000/pages/chat.html` | 채팅 |
| `http://localhost:4000/pages/admin.html` | 관리자 |

---

## 🔑 관리자 계정 만들기

DB에서 직접 role을 admin으로 변경:

```sql
UPDATE users SET role = 'admin' WHERE email = 'admin@sasohan.com';
```

---

## 🌐 배포 (Railway 기준)

1. [Railway.app](https://railway.app) 가입
2. New Project → Deploy from GitHub
3. PostgreSQL 플러그인 추가
4. 환경변수 설정 (DATABASE_URL 자동 주입)
5. `npm start` 로 시작

---

## 📡 API 목록

| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | /api/auth/signup | 회원가입 |
| POST | /api/auth/login | 로그인 |
| GET  | /api/auth/me | 내 정보 |
| GET  | /api/profiles | 추천 비주얼 목록 |
| POST | /api/profiles/me | 프로필 저장 |
| POST | /api/profiles/photos | 사진 업로드 |
| POST | /api/matches/like/:id | 좋아요 |
| GET  | /api/matches | 내 매칭 목록 |
| GET  | /api/chat | 채팅방 목록 |
| GET  | /api/chat/:roomId/messages | 메시지 조회 |
| POST | /api/safety/report/:id | 신고 |
| POST | /api/safety/block/:id | 차단 |
| WS   | ws://host/ws | 실시간 채팅 |
