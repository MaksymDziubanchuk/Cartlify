
BEGIN;

------------------------------------------------------------
-- 1. РОЛІ
------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cartlify_owner') THEN
    -- Роль-власник схеми та всіх об'єктів (DDL, міграції)
    CREATE ROLE cartlify_owner LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cartlify_app') THEN
    -- Роль для прод/дев API (CRUD, без DDL)
    CREATE ROLE cartlify_app LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cartlify_readonly') THEN
    -- Роль тільки для читання (аналітика/репорти)
    CREATE ROLE cartlify_readonly LOGIN;
  END IF;
END
$$;

------------------------------------------------------------
-- 1a. SEARCH_PATH + обмеження на public
------------------------------------------------------------

-- Працюємо в схемі cartlify за замовчуванням
ALTER ROLE cartlify_owner    SET search_path = 'cartlify', 'public';
ALTER ROLE cartlify_app      SET search_path = 'cartlify';
ALTER ROLE cartlify_readonly SET search_path = 'cartlify';

-- Забороняємо app/readonly щось робити в public (все наше – в cartlify)
REVOKE ALL ON SCHEMA public FROM cartlify_app;
REVOKE ALL ON SCHEMA public FROM cartlify_readonly;

------------------------------------------------------------
-- 2. СХЕМА cartlify
------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.schemata
    WHERE schema_name = 'cartlify'
  ) THEN
    EXECUTE 'CREATE SCHEMA cartlify AUTHORIZATION cartlify_owner';
  ELSE
    -- На всякий випадок передаємо власність схемою cartlify_owner
    EXECUTE 'ALTER SCHEMA cartlify OWNER TO cartlify_owner';
  END IF;
END
$$;

------------------------------------------------------------
-- 3. БАЗОВІ ПРАВА НА СХЕМУ
------------------------------------------------------------

-- Ніхто з PUBLIC не має права лазити в нашу схему
REVOKE ALL ON SCHEMA cartlify FROM PUBLIC;

-- Дозволяємо app/readonly бачити схему
GRANT USAGE ON SCHEMA cartlify TO cartlify_app;
GRANT USAGE ON SCHEMA cartlify TO cartlify_readonly;

------------------------------------------------------------
-- 4. ПРАВА ДЛЯ ВЖЕ ІСНУЮЧИХ ТАБЛИЦ/СЕКВЕНСІВ
--   (на dev може бути порожньо, але скрипт тоді просто нічого не зробить)
------------------------------------------------------------

-- Таблиці (включно з VIEW)
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA cartlify
  TO cartlify_app;

GRANT SELECT
  ON ALL TABLES IN SCHEMA cartlify
  TO cartlify_readonly;

-- Секвенси (identity / serial)
GRANT USAGE, SELECT, UPDATE
  ON ALL SEQUENCES IN SCHEMA cartlify
  TO cartlify_app;

GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA cartlify
  TO cartlify_readonly;

------------------------------------------------------------
-- 5. DEFAULT PRIVILEGES ДЛЯ МАЙБУТНІХ ОБ'ЄКТІВ (ТАБЛИЦІ + СЕКВЕНСИ)
------------------------------------------------------------

-- Нові ТАБЛИЦІ, створені cartlify_owner
ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cartlify_app;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
  GRANT SELECT ON TABLES TO cartlify_readonly;

-- Нові СЕКВЕНСИ, створені cartlify_owner
ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO cartlify_app;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
  GRANT USAGE, SELECT ON SEQUENCES TO cartlify_readonly;

------------------------------------------------------------
-- 5a. ФУНКЦІЇ
------------------------------------------------------------

-- Існуючі функції в схемі cartlify
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cartlify TO cartlify_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cartlify TO cartlify_readonly;

-- Дефолтні привілеї для майбутніх функцій, створених cartlify_owner
ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
  GRANT EXECUTE ON FUNCTIONS TO cartlify_app;

ALTER DEFAULT PRIVILEGES FOR ROLE cartlify_owner IN SCHEMA cartlify
  GRANT EXECUTE ON FUNCTIONS TO cartlify_readonly;

------------------------------------------------------------
-- Нагадування про паролі (ВИКОНУВАТИ ОКРЕМО, НЕ КОМІТИТИ В GIT)
------------------------------------------------------------

-- ALTER ROLE cartlify_owner    WITH PASSWORD '...';
-- ALTER ROLE cartlify_app      WITH PASSWORD '...';
-- ALTER ROLE cartlify_readonly WITH PASSWORD '...';

COMMIT;