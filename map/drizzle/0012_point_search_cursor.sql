CREATE INDEX points_search_cursor ON points(created_at DESC, id DESC) WHERE deleted=0;
