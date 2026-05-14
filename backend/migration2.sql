-- 매칭 취소 사유 컬럼 추가
ALTER TABLE matches ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- 만남 제안 거절 횟수
ALTER TABLE matches ADD COLUMN IF NOT EXISTS proposal_reject_count INT DEFAULT 0;

-- 차단 시 메시지 수신 차단을 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

-- 1대1 문의 테이블
CREATE TABLE IF NOT EXISTS inquiries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,
  content     TEXT NOT NULL,
  status      VARCHAR(20) DEFAULT 'pending', -- 'pending' | 'answered'
  answer      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  answered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inquiries_user ON inquiries(user_id);

-- 알림 테이블
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL, -- 'manager_match' | 'match_request' | 'match_accept' | 'manager_call'
  message    TEXT NOT NULL,
  is_read    BOOLEAN DEFAULT FALSE,
  link       VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);

-- 만남 제안 테이블 (날짜+장소 통합)
CREATE TABLE IF NOT EXISTS proposals (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id      UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  proposer_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date_time    VARCHAR(200),
  place        VARCHAR(200),
  note         TEXT,
  status       VARCHAR(20) DEFAULT 'pending', -- 'pending' | 'accepted' | 'rejected'
  reject_count INT DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proposals_room ON proposals(room_id);
