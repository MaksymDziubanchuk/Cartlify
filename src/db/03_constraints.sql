----------------------------------------
-- FAVORITES: CHECK (userId XOR guestId)
----------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'favorites_actor_xor_chk'
      AND conrelid = 'cartlify.favorites'::regclass
  ) THEN
    ALTER TABLE cartlify.favorites
    ADD CONSTRAINT favorites_actor_xor_chk
    CHECK ( ("userId" IS NULL) <> ("guestId" IS NULL) );
  END IF;
END $$;


----------------------------------------
-- CHAT THREADS: CHECK (userId XOR guestId)
----------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chat_threads_actor_xor_chk'
      AND conrelid = 'cartlify.chat_threads'::regclass
  ) THEN
    ALTER TABLE cartlify.chat_threads
    ADD CONSTRAINT chat_threads_actor_xor_chk
    CHECK ( ("userId" IS NULL) <> ("guestId" IS NULL) );
  END IF;
END $$;