ALTER TABLE human_call_channels
  ADD COLUMN state TEXT NOT NULL DEFAULT 'invited';

CREATE INDEX IF NOT EXISTS idx_human_call_channels_participant_state_updated
  ON human_call_channels(state, updated_at DESC);
