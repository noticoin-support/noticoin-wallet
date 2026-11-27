ALTER TABLE point_details ADD COLUMN offline_offer TEXT;
ALTER TABLE secret_purchases ADD COLUMN offline_slot INTEGER CHECK(offline_slot BETWEEN 0 AND 99);
CREATE UNIQUE INDEX secret_offline_copy ON secret_purchases(point_id,offline_slot)
 WHERE offline_slot IS NOT NULL AND (status!='released' OR sold_at IS NOT NULL);
