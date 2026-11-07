-- V3 M38: one monotonic order for everything said in a negotiation. Additive only.
--
-- Timestamps can tie (two writes in the same millisecond, or a test clock that does not move), so "our counter went out after their
-- quote" cannot be read from time. Quotes and messages share one sequence that is assigned when the row is written and never changes.
CREATE SEQUENCE mission_timeline_seq;
ALTER TABLE mission_quotes ADD COLUMN timeline_seq bigint NOT NULL DEFAULT nextval('mission_timeline_seq');
ALTER TABLE mission_messages ADD COLUMN timeline_seq bigint NOT NULL DEFAULT nextval('mission_timeline_seq');
CREATE UNIQUE INDEX mission_quotes_timeline_seq ON mission_quotes (timeline_seq);
CREATE UNIQUE INDEX mission_messages_timeline_seq ON mission_messages (timeline_seq);
