CREATE UNIQUE INDEX secret_one_completed_sale ON secret_purchases(point_id) WHERE sold_at IS NOT NULL;
