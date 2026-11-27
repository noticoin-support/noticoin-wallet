ALTER TABLE points ADD COLUMN chain_required INTEGER NOT NULL DEFAULT 0;

CREATE TABLE point_chain_records (
  point_id TEXT NOT NULL REFERENCES points(id),
  operation TEXT NOT NULL CHECK(operation IN ('publish', 'withdraw')),
  txid TEXT NOT NULL UNIQUE,
  record TEXT NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 0,
  last_checked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (point_id, operation)
);

CREATE INDEX point_chain_recheck ON point_chain_records(last_checked);
