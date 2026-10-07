-- 013_safety_helpers.sql — Phase 10
-- Severity ranking for in-SQL escalation bumps (GREATEST_SEVERITY).
CREATE OR REPLACE FUNCTION greatest_severity(a VARCHAR, b VARCHAR)
RETURNS VARCHAR AS $$
DECLARE
  rank_map CONSTANT JSONB := '{"LOW":0,"MEDIUM":1,"HIGH":2,"CRITICAL":3}'::jsonb;
BEGIN
  IF COALESCE(rank_map->>b, '0')::int > COALESCE(rank_map->>a, '0')::int THEN
    RETURN b;
  END IF;
  RETURN a;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
