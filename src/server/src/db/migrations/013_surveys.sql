-- 013: Survey responses table
CREATE TABLE IF NOT EXISTS surveys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL DEFAULT 'nps',
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 10),
  feedback TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_surveys_user_id ON surveys(user_id);
CREATE INDEX idx_surveys_type ON surveys(type);
CREATE INDEX idx_surveys_created_at ON surveys(created_at);
