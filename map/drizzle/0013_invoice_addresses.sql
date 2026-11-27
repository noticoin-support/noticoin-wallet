CREATE TABLE invoices_by_address (
  id TEXT PRIMARY KEY, point_id TEXT NOT NULL UNIQUE REFERENCES points(id),
  address TEXT NOT NULL UNIQUE, subaddress INTEGER NOT NULL,
  amount_atomic TEXT NOT NULL, received_atomic TEXT NOT NULL DEFAULT '0',
  confirmations INTEGER NOT NULL DEFAULT 0, txids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_checked INTEGER NOT NULL DEFAULT 0,
  wallet TEXT NOT NULL CHECK(wallet IN ('legacy','fund'))
);
--> statement-breakpoint
INSERT INTO invoices_by_address (id,point_id,address,subaddress,amount_atomic,received_atomic,confirmations,txids,created_at,expires_at,last_checked,wallet)
SELECT id,point_id,address,subaddress,amount_atomic,received_atomic,confirmations,txids,created_at,expires_at,last_checked,wallet FROM invoices;
--> statement-breakpoint
DROP TABLE invoices;
--> statement-breakpoint
ALTER TABLE invoices_by_address RENAME TO invoices;
--> statement-breakpoint
CREATE INDEX invoices_wallet_checked ON invoices(wallet,last_checked);
