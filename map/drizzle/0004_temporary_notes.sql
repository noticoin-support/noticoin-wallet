CREATE TABLE point_details (
  point_id TEXT PRIMARY KEY REFERENCES points(id),
  category TEXT,
  venue_id TEXT,
  venue_name TEXT,
  icon TEXT NOT NULL DEFAULT 'default',
  duration_days INTEGER NOT NULL DEFAULT 7 CHECK(duration_days IN (7,30)),
  donation_address TEXT,
  donation_amount TEXT,
  donation_note TEXT,
  secret_price TEXT
);
--> statement-breakpoint
CREATE INDEX point_details_venue ON point_details(venue_id);
--> statement-breakpoint
INSERT INTO point_details(point_id,category,donation_address)
  SELECT point_id,kind,donation_address FROM permanent_points;
--> statement-breakpoint
UPDATE points SET expires_at=(CAST(strftime('%s','now') AS INTEGER)+604800)*1000
  WHERE id IN (SELECT point_id FROM permanent_points);
--> statement-breakpoint
CREATE TABLE secret_purchases (
  id TEXT PRIMARY KEY,
  point_id TEXT NOT NULL REFERENCES points(id),
  buyer TEXT NOT NULL,
  address TEXT UNIQUE,
  subaddress INTEGER UNIQUE,
  amount_atomic TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_checked INTEGER NOT NULL DEFAULT 0,
  received_atomic TEXT NOT NULL DEFAULT '0',
  confirmations INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserving',
  sold_at INTEGER,
  opened_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX secret_one_active_purchase ON secret_purchases(point_id) WHERE status!='released';
