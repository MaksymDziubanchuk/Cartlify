----------------------------------------
-- REVIEWS: rating + votes
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reviews_rating_1_5'
  ) THEN
    ALTER TABLE cartlify.reviews
      ADD CONSTRAINT reviews_rating_1_5
      CHECK (rating BETWEEN 1 AND 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reviews_votes_non_negative'
  ) THEN
    ALTER TABLE cartlify.reviews
      ADD CONSTRAINT reviews_votes_non_negative
      CHECK ("upVotes" >= 0 AND "downVotes" >= 0);
  END IF;
END $$;

----------------------------------------
-- PRODUCTS: price + counters
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_price_non_negative'
  ) THEN
    ALTER TABLE cartlify.products
      ADD CONSTRAINT products_price_non_negative
      CHECK (price >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_counters_non_negative'
  ) THEN
    ALTER TABLE cartlify.products
      ADD CONSTRAINT products_counters_non_negative
      CHECK (
        views >= 0
        AND popularity >= 0
        AND "reviewsCount" >= 0
        AND "avgRating" >= 0
        AND "avgRating" <= 5
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_pop_override_non_negative'
  ) THEN
    ALTER TABLE cartlify.products
      ADD CONSTRAINT products_pop_override_non_negative
      CHECK ("popularityOverride" IS NULL OR "popularityOverride" >= 0);
  END IF;
END $$;

----------------------------------------
-- FAVORITES / CHAT_THREADS: exactly one owner (you already had these)
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'favorites_actor_xor_chk'
  ) THEN
    ALTER TABLE cartlify.favorites
      ADD CONSTRAINT favorites_actor_xor_chk
      CHECK (("userId" IS NULL) <> ("guestId" IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_threads_actor_xor_chk'
  ) THEN
    ALTER TABLE cartlify.chat_threads
      ADD CONSTRAINT chat_threads_actor_xor_chk
      CHECK (("userId" IS NULL) <> ("guestId" IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_threads_unread_non_negative'
  ) THEN
    ALTER TABLE cartlify.chat_threads
      ADD CONSTRAINT chat_threads_unread_non_negative
      CHECK ("unreadCount" >= 0);
  END IF;
END $$;

----------------------------------------
-- ORDERS / ORDER_ITEMS: totals >= 0, qty > 0
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_total_non_negative'
  ) THEN
    ALTER TABLE cartlify.orders
      ADD CONSTRAINT orders_total_non_negative
      CHECK (total >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_qty_positive'
  ) THEN
    ALTER TABLE cartlify.order_items
      ADD CONSTRAINT order_items_qty_positive
      CHECK (quantity > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_prices_non_negative'
  ) THEN
    ALTER TABLE cartlify.order_items
      ADD CONSTRAINT order_items_prices_non_negative
      CHECK ("unitPrice" >= 0 AND "totalPrice" >= 0);
  END IF;
END $$;

----------------------------------------
-- USER_TOKENS: expires must be after created
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_tokens_expires_after_created'
  ) THEN
    ALTER TABLE cartlify.user_tokens
      ADD CONSTRAINT user_tokens_expires_after_created
      CHECK ("expiresAt" > "createdAt");
  END IF;
END $$;

----------------------------------------
-- PRICE CHANGE LOG: prices/value >= 0
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_change_non_negative'
  ) THEN
    ALTER TABLE cartlify.product_price_change_logs
      ADD CONSTRAINT price_change_non_negative
      CHECK ("oldPrice" >= 0 AND "newPrice" >= 0 AND value >= 0);
  END IF;
END $$;
