CREATE TABLE IF NOT EXISTS points (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('message','place','event','art')),
  lat REAL NOT NULL CHECK(lat BETWEEN -85 AND 85), lng REAL NOT NULL CHECK(lng BETWEEN -180 AND 180),
  mode TEXT NOT NULL CHECK(mode IN ('free','paid')), status TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, votes INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS points_viewport ON points(lat,lng,expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS points_owner ON points(owner,created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, point_id TEXT NOT NULL UNIQUE REFERENCES points(id),
  address TEXT NOT NULL UNIQUE, subaddress INTEGER NOT NULL UNIQUE,
  amount_atomic TEXT NOT NULL, received_atomic TEXT NOT NULL DEFAULT '0',
  confirmations INTEGER NOT NULL DEFAULT 0, txids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_checked INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS votes (point_id TEXT NOT NULL REFERENCES points(id), actor TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(point_id,actor));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS nonces (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rate_limits (id TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
