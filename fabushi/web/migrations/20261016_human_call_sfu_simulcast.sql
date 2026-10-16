ALTER TABLE human_call_media_publications
  ADD COLUMN simulcast_rids_json TEXT;

ALTER TABLE human_call_media_subscriptions
  ADD COLUMN preferred_rid TEXT;

ALTER TABLE human_call_media_subscriptions
  ADD COLUMN priority_ordering TEXT
  CHECK (priority_ordering IS NULL OR priority_ordering IN ('none', 'asciibetical'));

ALTER TABLE human_call_media_subscriptions
  ADD COLUMN rid_not_available TEXT
  CHECK (rid_not_available IS NULL OR rid_not_available IN ('none', 'asciibetical'));
