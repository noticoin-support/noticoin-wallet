ALTER TABLE point_details ADD COLUMN secret_copies INTEGER NOT NULL DEFAULT 1 CHECK(secret_copies BETWEEN 1 AND 100);
ALTER TABLE point_details ADD COLUMN sale_address TEXT;
ALTER TABLE secret_purchases ADD COLUMN direct_address TEXT;
ALTER TABLE secret_purchases ADD COLUMN seller_ready_at INTEGER;
ALTER TABLE secret_purchases ADD COLUMN proof_txid TEXT;
ALTER TABLE secret_purchases ADD COLUMN payment_proof TEXT;
DROP INDEX secret_one_active_purchase;
DROP INDEX secret_one_completed_sale;
CREATE UNIQUE INDEX secret_one_order_per_buyer ON secret_purchases(point_id,buyer) WHERE status!='released' OR sold_at IS NOT NULL;
CREATE UNIQUE INDEX secret_unique_payment ON secret_purchases(proof_txid) WHERE proof_txid IS NOT NULL;
CREATE INDEX secret_orders_for_pin ON secret_purchases(point_id,status,sold_at);
CREATE UNIQUE INDEX secret_unique_payout ON point_details(sale_address) WHERE sale_address IS NOT NULL;
CREATE TRIGGER secret_edition_capacity BEFORE INSERT ON secret_purchases
WHEN NEW.status!='released' OR NEW.sold_at IS NOT NULL
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM secret_purchases WHERE point_id=NEW.point_id AND (status!='released' OR sold_at IS NOT NULL))
   >= COALESCE((SELECT secret_copies FROM point_details WHERE point_id=NEW.point_id),1) THEN RAISE(ABORT,'Note edition is full') END;
END;
