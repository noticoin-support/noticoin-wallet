CREATE TABLE permanent_points (
  point_id TEXT PRIMARY KEY REFERENCES points(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('place','wifi')),
  donation_address TEXT
);
