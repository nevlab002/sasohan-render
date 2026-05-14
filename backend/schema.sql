-- 사소한 데이터베이스 스키마
-- PostgreSQL

-- UUID 확장
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ───────────────────────────────
-- 1. 사용자 (users)
-- ───────────────────────────────
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       VARCHAR(255) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,
  role        VARCHAR(20) NOT NULL DEFAULT 'owner',
  -- role: 'owner'(오너회원), 'visual'(비주얼회원), 'admin'(관리자)
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- status: 'pending'(심사중), 'active'(활성), 'blocked'(차단)
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────
-- 2. 프로필 (profiles)
-- ───────────────────────────────
CREATE TABLE profiles (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(50) NOT NULL,
  age         SMALLINT NOT NULL CHECK (age >= 19 AND age <= 70),
  gender      VARCHAR(10) NOT NULL, -- 'male' | 'female'
  region      VARCHAR(50),
  bio         TEXT,
  job         VARCHAR(100),
  photos      TEXT[] DEFAULT '{}',  -- 사진 URL 배열
  is_verified BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────
-- 3. 매칭 (matches)
-- ───────────────────────────────
CREATE TABLE matches (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visual_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        VARCHAR(20) DEFAULT 'pending',
  -- status: 'pending', 'accepted', 'rejected', 'completed'
  matched_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(owner_id, visual_id)
);

-- ───────────────────────────────
-- 4. 좋아요 (likes)  -- 스와이프/추천용
-- ───────────────────────────────
CREATE TABLE likes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_user   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_user, to_user)
);

-- ───────────────────────────────
-- 5. 채팅방 (chat_rooms)
-- ───────────────────────────────
CREATE TABLE chat_rooms (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id    UUID UNIQUE NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────
-- 6. 메시지 (messages)
-- ───────────────────────────────
CREATE TABLE messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id     UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  sender_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  is_read     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────
-- 7. 신고 (reports)
-- ───────────────────────────────
CREATE TABLE reports (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  status        VARCHAR(20) DEFAULT 'pending', -- 'pending' | 'resolved'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────
-- 8. 차단 (blocks)
-- ───────────────────────────────
CREATE TABLE blocks (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  blocker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(blocker_id, blocked_id)
);

-- ───────────────────────────────
-- 인덱스
-- ───────────────────────────────
CREATE INDEX idx_profiles_user_id   ON profiles(user_id);
CREATE INDEX idx_matches_owner      ON matches(owner_id);
CREATE INDEX idx_matches_visual     ON matches(visual_id);
CREATE INDEX idx_messages_room      ON messages(room_id);
CREATE INDEX idx_messages_sender    ON messages(sender_id);
CREATE INDEX idx_likes_from         ON likes(from_user);
CREATE INDEX idx_likes_to           ON likes(to_user);
CREATE INDEX idx_blocks_blocker     ON blocks(blocker_id);
