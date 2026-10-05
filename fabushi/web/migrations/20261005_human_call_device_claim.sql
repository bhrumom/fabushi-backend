ALTER TABLE human_call_channels
  ADD COLUMN creator_device_id TEXT;

ALTER TABLE human_call_channels
  ADD COLUMN peer_device_id TEXT;
