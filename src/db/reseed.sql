\set ON_ERROR_STOP on
SET search_path = cartlify, public;

-- 1) Temporarily disable RLS + FORCE for all app tables (keep policies as-is)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'cartlify'
      AND tablename <> '_prisma_migrations'
  LOOP
    EXECUTE format('ALTER TABLE cartlify.%I NO FORCE ROW LEVEL SECURITY', r.tablename);
    EXECUTE format('ALTER TABLE cartlify.%I DISABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

-- 2) Truncate all app tables (keeps _prisma_migrations)
DO $$
DECLARE stmt text;
BEGIN
  SELECT
    'TRUNCATE TABLE ' ||
    string_agg(format('cartlify.%I', tablename), ', ') ||
    ' RESTART IDENTITY CASCADE'
  INTO stmt
  FROM pg_tables
  WHERE schemaname = 'cartlify'
    AND tablename <> '_prisma_migrations';

  IF stmt IS NOT NULL THEN
    EXECUTE stmt;
  END IF;
END $$;

-- 3) Import CSV (order matters: parents -> children)
\copy cartlify.categories                FROM 'db/seeds/csv/categories.csv'                WITH (FORMAT csv, HEADER true);
\copy cartlify.products                  FROM 'db/seeds/csv/products.csv'                  WITH (FORMAT csv, HEADER true);
\copy cartlify.product_images            FROM 'db/seeds/csv/product_images.csv'            WITH (FORMAT csv, HEADER true);

\copy cartlify.users                     FROM 'db/seeds/csv/users.csv'                     WITH (FORMAT csv, HEADER true);
\copy cartlify.user_tokens               FROM 'db/seeds/csv/user_tokens.csv'               WITH (FORMAT csv, HEADER true);
\copy cartlify.login_logs                FROM 'db/seeds/csv/login_logs.csv'                WITH (FORMAT csv, HEADER true);

\copy cartlify.reviews                   FROM 'db/seeds/csv/reviews.csv'                   WITH (FORMAT csv, HEADER true);
\copy cartlify.review_votes              FROM 'db/seeds/csv/review_votes.csv'              WITH (FORMAT csv, HEADER true);
\copy cartlify.favorites                 FROM 'db/seeds/csv/favorites.csv'                 WITH (FORMAT csv, HEADER true);

\copy cartlify.orders                    FROM 'db/seeds/csv/orders.csv'                    WITH (FORMAT csv, HEADER true);
\copy cartlify.order_items               FROM 'db/seeds/csv/order_items.csv'               WITH (FORMAT csv, HEADER true);

\copy cartlify.chat_threads              FROM 'db/seeds/csv/chat_threads.csv'              WITH (FORMAT csv, HEADER true);
\copy cartlify.chat_messages             FROM 'db/seeds/csv/chat_messages.csv'             WITH (FORMAT csv, HEADER true);

\copy cartlify.product_price_change_logs FROM 'db/seeds/csv/product_price_change_logs.csv' WITH (FORMAT csv, HEADER true);
\copy cartlify.admin_audit_log           FROM 'db/seeds/csv/admin_audit_log.csv'           WITH (FORMAT csv, HEADER true);

-- 4) Fix sequences (after explicit ID inserts)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT
      pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq_name,
      format('%I.%I', n.nspname, c.relname) AS tbl_name,
      a.attname AS col_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'cartlify'
      AND c.relkind = 'r'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
  LOOP
    EXECUTE format(
      'SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %s), 1), true)',
      r.seq_name, r.col_name, r.tbl_name
    );
  END LOOP;
END $$;

-- 5) Enable RLS + FORCE back
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'cartlify'
      AND tablename <> '_prisma_migrations'
  LOOP
    EXECUTE format('ALTER TABLE cartlify.%I ENABLE ROW LEVEL SECURITY', r.tablename);
    EXECUTE format('ALTER TABLE cartlify.%I FORCE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;
