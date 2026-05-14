-- 매칭방 추가 컬럼 (matches 테이블)
ALTER TABLE matches ADD COLUMN IF NOT EXISTS matched_by    VARCHAR(20) DEFAULT 'user';
ALTER TABLE matches ADD COLUMN IF NOT EXISTS room_status   VARCHAR(30) DEFAULT 'chatting';
-- room_status: 'chatting'(대화중) | 'scheduling'(일정조율중) | 'met'(만남완료) | 'closed'(종료)
ALTER TABLE matches ADD COLUMN IF NOT EXISTS manager_comment TEXT;

-- 메시지 타입 추가 (messages 테이블)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_type VARCHAR(20) DEFAULT 'text';
-- msg_type: 'text' | 'image' | 'manager' | 'date_suggest' | 'place_suggest' | 'system'
ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta JSONB;

-- 후기/평가 테이블
CREATE TABLE IF NOT EXISTS reviews (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id    UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  rating      VARCHAR(10) NOT NULL, -- 'good' | 'okay' | 'bad'
  comment     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(match_id, reviewer_id)
);

-- 매니저 호출 테이블
CREATE TABLE IF NOT EXISTS manager_calls (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id    UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  caller_id   UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  reason      TEXT,
  status      VARCHAR(20) DEFAULT 'pending', -- 'pending' | 'resolved'
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_match   ON reviews(match_id);
CREATE INDEX IF NOT EXISTS idx_mgr_calls_match ON manager_calls(match_id);


-- 관리자 매칭 신청 처리용 컬럼
ALTER TABLE matches ADD COLUMN IF NOT EXISTS matched_by VARCHAR(20) DEFAULT 'user';
ALTER TABLE matches ADD COLUMN IF NOT EXISTS manager_comment TEXT;


-- 소개팅 신청 관리 기능 보강
ALTER TABLE matches ADD COLUMN IF NOT EXISTS matched_by VARCHAR(20) DEFAULT 'user';
ALTER TABLE matches ADD COLUMN IF NOT EXISTS manager_comment TEXT;


-- 회원가입 프로필/사진 등록 기능 보강
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS photos TEXT[] DEFAULT ARRAY[]::text[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS height SMALLINT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS weight SMALLINT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS taste TEXT[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hobby TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_user_id_unique'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_user_id_unique UNIQUE (user_id);
  END IF;
EXCEPTION WHEN duplicate_table THEN
  NULL;
WHEN duplicate_object THEN
  NULL;
END $$;


-- 채팅방 기준 재신청 기능 보강
ALTER TABLE matches ADD COLUMN IF NOT EXISTS room_status VARCHAR(30) DEFAULT 'chatting';
ALTER TABLE matches ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS proposal_reject_count INT DEFAULT 0;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS manager_comment TEXT;


-- 현재 채팅방 존재 여부 기준 재신청 기능 보강
ALTER TABLE matches ADD COLUMN IF NOT EXISTS room_status VARCHAR(30) DEFAULT 'chatting';
ALTER TABLE matches ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS proposal_reject_count INT DEFAULT 0;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS manager_comment TEXT;


-- 매칭 수락 팝업 알림 기능 보강
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL,
  message    TEXT NOT NULL,
  is_read    BOOLEAN DEFAULT FALSE,
  link       VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link VARCHAR(200);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);


-- 회원가입란에서 프로필 설정 전체 입력 기능 보강
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS photos TEXT[] DEFAULT ARRAY[]::text[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS height SMALLINT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS weight SMALLINT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS taste TEXT[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hobby TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_user_id_unique'
  ) THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_user_id_unique UNIQUE (user_id);
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;


-- 프로필 추가사진 수정 기능 보강
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS photos TEXT[] DEFAULT ARRAY[]::text[];


-- 캐미라인 게임 재신청/취소 안정화
CREATE TABLE IF NOT EXISTS chemi_games (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID NOT NULL,
  topic      TEXT NOT NULL,
  round      INT  DEFAULT 1,
  score      INT  DEFAULT 0,
  status     TEXT DEFAULT 'active',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at   TIMESTAMPTZ,
  answers    JSONB DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_chemi_games_room_status ON chemi_games(room_id, status);


-- 알림/채팅 배지 분리 유지 보강
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_user_type_read ON notifications(user_id, type, is_read);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_messages_room_sender_read ON messages(room_id, sender_id, is_read);


-- 사진 채팅 알림 / 좋아요 알림 / 채팅-알림 분리
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_type VARCHAR(20) DEFAULT 'text';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link VARCHAR(200);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_user_type_read_created ON notifications(user_id, type, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_room_sender_read_created ON messages(room_id, sender_id, is_read, created_at DESC);


-- 알림센터 복구 및 채팅/일반 알림 분리
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(50) NOT NULL,
  message    TEXT NOT NULL,
  link       VARCHAR(200),
  is_read    BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link VARCHAR(200);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_user_type_read_created ON notifications(user_id, type, is_read, created_at DESC);


-- 사진 메시지 저장 실패 방지 및 사진 채팅 알림
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_type VARCHAR(20) DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta JSONB;
CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_room_sender_read ON messages(room_id, sender_id, is_read);


-- 사진 메시지 표시 및 채팅 알림 안정화
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_type VARCHAR(20) DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_room_sender_read ON messages(room_id, sender_id, is_read);


-- 채팅 페이지 작동 복구 보강
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_type VARCHAR(20) DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_room_sender_read ON messages(room_id, sender_id, is_read);
