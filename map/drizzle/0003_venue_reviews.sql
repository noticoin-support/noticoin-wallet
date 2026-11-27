CREATE TABLE venue_reviews (
  venue_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  body TEXT NOT NULL CHECK(length(body) <= 500),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(venue_id, owner)
);
--> statement-breakpoint
CREATE INDEX venue_reviews_recent ON venue_reviews(venue_id, updated_at DESC);
