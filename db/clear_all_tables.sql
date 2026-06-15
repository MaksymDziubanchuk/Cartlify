\set ON_ERROR_STOP on

DO $$
DECLARE
  tables_list text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
  INTO tables_list
  FROM pg_tables
  WHERE schemaname = 'cartlify';

  IF tables_list IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || tables_list || ' CASCADE';
  END IF;
END
$$;