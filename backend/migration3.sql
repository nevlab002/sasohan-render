ALTER TABLE users ALTER COLUMN role SET DEFAULT 'cami';
UPDATE users SET role='cami' WHERE role IN ('owner','visual');

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS region_detail  VARCHAR(100);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS height         SMALLINT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS weight         SMALLINT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hobby          TEXT[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS taste          TEXT[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS manager_id     UUID;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS likes_count    INT DEFAULT 0;

CREATE TABLE IF NOT EXISTS profile_likes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  liker_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  liked_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(liker_id, liked_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_likes_liked ON profile_likes(liked_id);

CREATE TABLE IF NOT EXISTS managers (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,
  photo       TEXT,
  title       VARCHAR(100),
  intro       TEXT,
  specialty   TEXT[],
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_managers_active ON managers(is_active);
