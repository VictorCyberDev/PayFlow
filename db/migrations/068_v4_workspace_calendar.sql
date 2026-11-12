-- V4: PayFlow's own calendar. Additive only.
--
-- A founder's week is the thing every other surface keeps referring to — a flight they booked, a milestone they agreed,
-- an invoice that falls due. Until now PayFlow had nowhere to put any of it, so it could not answer "what does my week
-- look like" and could not honour the mandate's calendar-aware travel at all.
--
-- WHAT AN EVENT IS NOT: it is not an authorization and it is not evidence that anything happened. Writing "flight to
-- JFK" here does not mean a seat is held; the booking reference on the order is what means that. An event is a note in
-- a diary, and it carries `source` and `source_ref` precisely so a reader can tell a note somebody typed from one
-- PayFlow added because a provider confirmed something.
--
-- Scoped to an organization, like every other tenant table, so one workspace never sees another's week.
CREATE TABLE workspace_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^evt_[a-f0-9]{24}$'),
  organization_id text NOT NULL REFERENCES organizations(id),
  -- The member who created it, so a shared workspace can tell who put it there.
  created_by text NOT NULL REFERENCES organization_members(member_id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  starts_at timestamptz NOT NULL,
  -- NULL means "no stated end", which is different from a zero-length event and is preserved rather than guessed.
  ends_at timestamptz,
  all_day boolean NOT NULL DEFAULT false,
  location text CHECK (location IS NULL OR length(location) <= 200),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  -- Where this came from. MANUAL is a person typing; the others are PayFlow recording something a provider confirmed.
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','FLIGHT','INVOICE','MILESTONE')),
  -- The provider's own identifier for whatever this records, when there is one. Never invented.
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) <= 128),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

-- The one query the calendar actually makes: this organization's events in a window, in order.
CREATE INDEX workspace_events_window
  ON workspace_events (organization_id, starts_at);

-- A provider-sourced event is recorded once. Booking the same flight twice does not put it in the diary twice.
CREATE UNIQUE INDEX workspace_events_source_ref
  ON workspace_events (organization_id, source, source_ref)
  WHERE source_ref IS NOT NULL;
