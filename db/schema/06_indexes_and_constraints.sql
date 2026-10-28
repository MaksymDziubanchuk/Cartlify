-- Indexes and CHECK constraints. The script has no transaction, and every statement can be run
-- again:
--   * A constraint that is added only when it is missing keeps the rule it was first added with.
--     A constraint that is dropped and added again takes the current rule at every run.
--   * A constraint is checked against every old row when it is added, so the script stops if a
--     row breaks it. A NOT VALID constraint checks only new and changed rows.

-- On a live database a busy table makes the script wait for its lock, and every request of the
-- app waits behind the script. After 5 s the script stops and is run again (db-run-sql.yml).
SET lock_timeout = '5s';

-- Everything below is created and owned by cartlify_owner, whoever runs the script.
SET ROLE cartlify_owner;

----------------------------------------
-- REVIEWS: the range of a rating, the vote counters
----------------------------------------
-- A rating is 1 to 5 (it may be empty). The counters of votes are not negative.
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
-- CATEGORIES: the picture
----------------------------------------
-- A category has a picture with its id on Cloudinary, or none of the two.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'categories_image_chk'
  ) THEN
    ALTER TABLE cartlify.categories
      ADD CONSTRAINT categories_image_chk
      CHECK (("imageUrl" IS NULL) = ("imagePublicId" IS NULL));
  END IF;
END $$;

----------------------------------------
-- PRODUCTS: price, counters, sale, article number
----------------------------------------
-- The price and the counters (views, popularity, reviewsCount) are not negative, the average
-- rating is 0 to 5, a popularity set by hand is not negative.
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

  -- A sale has a price and an end, or neither. The sale price is 0 (free) or more, and below
  -- the price. A price lowered to the sale price or below ends the sale first
  -- (products_before_price_change, db/05), so this check does not stop that update.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_sale_chk'
  ) THEN
    ALTER TABLE cartlify.products
      ADD CONSTRAINT products_sale_chk
      CHECK (
        ("salePrice" IS NULL AND "saleEndsAt" IS NULL)
        OR (
          "salePrice" IS NOT NULL
          AND "saleEndsAt" IS NOT NULL
          AND "salePrice" >= 0
          AND "salePrice" < price
        )
      );
  END IF;

  -- The lowest price of the 30 days before a sale exists only while there is a sale. A sale may
  -- have none.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_sale_prior_price_chk'
  ) THEN
    ALTER TABLE cartlify.products
      ADD CONSTRAINT products_sale_prior_price_chk
      CHECK (
        "salePriorPrice" IS NULL
        OR ("salePrice" IS NOT NULL AND "salePriorPrice" >= 0)
      );
  END IF;

  -- An article number is trimmed and not empty (the server turns an empty one into none).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_sku_chk'
  ) THEN
    ALTER TABLE cartlify.products
      ADD CONSTRAINT products_sku_chk
      CHECK (sku IS NULL OR (sku = btrim(sku) AND length(sku) > 0));
  END IF;
END $$;

----------------------------------------
-- FAVORITES and CHAT_THREADS: the owner, the unread counter, the admin state of a thread
----------------------------------------
-- A favorite and a chat thread belong to a user or to a guest, never to both and never to none.
-- The unread counter of a thread is not negative.
-- chat_threads_admin_state_chk: the marks of a thread for the admins. adminRequestedAt is when
-- the customer asked for an admin, until an admin takes the thread; adminUnreadSince is when the
-- oldest message no admin has read was written, until an admin reads or answers. A bot thread and
-- a closed admin thread have neither mark; an open admin thread has any of the two states (an
-- admin took it and read it: neither).
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

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_threads_admin_state_chk'
  ) THEN
    ALTER TABLE cartlify.chat_threads
      DROP CONSTRAINT chat_threads_admin_state_chk;
  END IF;

  ALTER TABLE cartlify.chat_threads
  ADD CONSTRAINT chat_threads_admin_state_chk
  CHECK (
    (
      type = 'bot'
      AND "adminRequestedAt" IS NULL
      AND "adminUnreadSince" IS NULL
    )
    OR (
      type = 'admin'
      AND (
        (
          status = 'closed'
          AND "adminRequestedAt" IS NULL
          AND "adminUnreadSince" IS NULL
        )
        OR status = 'open'
      )
    )
  );
END $$;

----------------------------------------
-- ORDERS and ORDER_ITEMS: amounts and quantities
----------------------------------------
-- The total of an order and the prices of an item are not negative. An item has at least one
-- unit.
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
-- ORDERS: the status matches the confirmed flag, the reservation and the payment
----------------------------------------
-- pending, unconfirmed: an order that is still a cart - not confirmed, no reservation, no
--   payment.
-- waiting: confirmed, the reservation has an end, no payment yet.
-- paid: confirmed, no reservation, a payment.
-- shipped, delivered, cancelled: confirmed; the rest is not checked.
-- NOT VALID: the rule applies to new and updated rows, rows written before it are not rechecked.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_state_consistency_chk'
  ) THEN
    ALTER TABLE cartlify.orders
      DROP CONSTRAINT orders_state_consistency_chk;
  END IF;

  ALTER TABLE cartlify.orders
    ADD CONSTRAINT orders_state_consistency_chk
    CHECK (
      (
        status IN ('pending', 'unconfirmed')
        AND confirmed = false
        AND "reservationExpiresAt" IS NULL
        AND "paymentId" IS NULL
      )
      OR (
        status = 'waiting'
        AND confirmed = true
        AND "reservationExpiresAt" IS NOT NULL
        AND "paymentId" IS NULL
      )
      OR (
        status = 'paid'
        AND confirmed = true
        AND "reservationExpiresAt" IS NULL
        AND "paymentId" IS NOT NULL
      )
      OR (
        status IN ('shipped', 'delivered', 'cancelled')
        AND confirmed = true
      )
    ) NOT VALID;
END $$;

----------------------------------------
-- ORDERS: a payment always names who took it
----------------------------------------
-- The payment id and the provider are both empty or both set; pay_order writes them together.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_payment_provider_chk'
  ) THEN
    ALTER TABLE cartlify.orders
      DROP CONSTRAINT orders_payment_provider_chk;
  END IF;

  ALTER TABLE cartlify.orders
    ADD CONSTRAINT orders_payment_provider_chk
    CHECK (("paymentId" IS NULL) = ("paymentProvider" IS NULL));
END $$;

----------------------------------------
-- ORDERS: the time of the payment and of the cancel
----------------------------------------
-- paidAt is set together with the payment (pay_order) and only then. cancelledAt is set with
-- the cancel and only then: only a paid or shipped order is cancelled (cancel_paid_order), and never
-- before its payment time.
-- An order paid or cancelled before these columns existed has no such time and breaks the
-- checks: clear those rows before the script runs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_paid_at_chk'
  ) THEN
    ALTER TABLE cartlify.orders
      DROP CONSTRAINT orders_paid_at_chk;
  END IF;

  ALTER TABLE cartlify.orders
    ADD CONSTRAINT orders_paid_at_chk
    CHECK (("paidAt" IS NULL) = ("paymentId" IS NULL));

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_cancelled_at_chk'
  ) THEN
    ALTER TABLE cartlify.orders
      DROP CONSTRAINT orders_cancelled_at_chk;
  END IF;

  ALTER TABLE cartlify.orders
    ADD CONSTRAINT orders_cancelled_at_chk
    CHECK (
      ("cancelledAt" IS NULL) = (status <> 'cancelled')
      AND ("cancelledAt" IS NULL OR ("paidAt" IS NOT NULL AND "cancelledAt" >= "paidAt"))
    );
END $$;

----------------------------------------
-- ORDER_DELIVERIES: the recipient and the address in the form the server writes them
----------------------------------------
-- recipient_first_name_chk, recipient_last_name_chk: trimmed, 1-100 characters, no digits. The
--   server also wants a letter in a name; the database does not check letters, because what is
--   a letter depends on the database locale.
-- recipient_phone_chk: a plus and 8-15 digits, the first one is not zero (as the profile phone).
-- price_non_negative: the price of the delivery is 0 or more.
-- address_chk: the manual method has a country (two capital letters), a city, a street and a
--   house, each trimmed and not empty; the postal code and the apartment are optional (the
--   server checks the postal code by country). A pickup has no address at all and costs nothing.
-- note_chk: a note, when given, is trimmed and not empty.
-- A length is written as two comparisons, never as BETWEEN as the first part of an AND: a dump
-- writes such a check back with other brackets, and a database restored from it would differ
-- from the structure snapshot.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_deliveries_recipient_first_name_chk'
  ) THEN
    ALTER TABLE cartlify.order_deliveries
      DROP CONSTRAINT order_deliveries_recipient_first_name_chk;
  END IF;

  ALTER TABLE cartlify.order_deliveries
    ADD CONSTRAINT order_deliveries_recipient_first_name_chk
    CHECK (
      char_length("recipientFirstName") >= 1
      AND char_length("recipientFirstName") <= 100
      AND "recipientFirstName" = btrim("recipientFirstName")
      AND "recipientFirstName" !~ '[0-9]'
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_deliveries_recipient_last_name_chk'
  ) THEN
    ALTER TABLE cartlify.order_deliveries
      DROP CONSTRAINT order_deliveries_recipient_last_name_chk;
  END IF;

  ALTER TABLE cartlify.order_deliveries
    ADD CONSTRAINT order_deliveries_recipient_last_name_chk
    CHECK (
      char_length("recipientLastName") >= 1
      AND char_length("recipientLastName") <= 100
      AND "recipientLastName" = btrim("recipientLastName")
      AND "recipientLastName" !~ '[0-9]'
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_deliveries_recipient_phone_chk'
  ) THEN
    ALTER TABLE cartlify.order_deliveries
      DROP CONSTRAINT order_deliveries_recipient_phone_chk;
  END IF;

  ALTER TABLE cartlify.order_deliveries
    ADD CONSTRAINT order_deliveries_recipient_phone_chk
    CHECK (
      "recipientPhone" ~ '^\+[1-9][0-9]{7,14}$'
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_deliveries_price_non_negative'
  ) THEN
    ALTER TABLE cartlify.order_deliveries
      DROP CONSTRAINT order_deliveries_price_non_negative;
  END IF;

  ALTER TABLE cartlify.order_deliveries
    ADD CONSTRAINT order_deliveries_price_non_negative
    CHECK (
      "price" >= 0
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_deliveries_address_chk'
  ) THEN
    ALTER TABLE cartlify.order_deliveries
      DROP CONSTRAINT order_deliveries_address_chk;
  END IF;

  ALTER TABLE cartlify.order_deliveries
    ADD CONSTRAINT order_deliveries_address_chk
    CHECK (
      (
        method = 'manual'
        AND country IS NOT NULL
        AND country ~ '^[A-Z]{2}$'
        AND city IS NOT NULL
        AND char_length(city) >= 1
        AND city = btrim(city)
        AND street IS NOT NULL
        AND char_length(street) >= 1
        AND street = btrim(street)
        AND house IS NOT NULL
        AND char_length(house) >= 1
        AND house = btrim(house)
        AND ("postalCode" IS NULL OR (char_length("postalCode") >= 1 AND "postalCode" = btrim("postalCode")))
        AND (apartment IS NULL OR (char_length(apartment) >= 1 AND apartment = btrim(apartment)))
      )
      OR (
        method = 'pickup'
        AND country IS NULL
        AND "postalCode" IS NULL
        AND city IS NULL
        AND street IS NULL
        AND house IS NULL
        AND apartment IS NULL
        AND "price" = 0
      )
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_deliveries_note_chk'
  ) THEN
    ALTER TABLE cartlify.order_deliveries
      DROP CONSTRAINT order_deliveries_note_chk;
  END IF;

  ALTER TABLE cartlify.order_deliveries
    ADD CONSTRAINT order_deliveries_note_chk
    CHECK (
      "note" IS NULL
      OR (char_length("note") >= 1 AND "note" = btrim("note"))
    );
END $$;

----------------------------------------
-- ORDER_SHIPMENTS: the carrier, the tracking number and the link as the admin writes them
----------------------------------------
-- carrier_chk: a carrier, when given, is trimmed and not empty.
-- tracking_chk: a tracking number and a link each need a carrier (the buyer sees whose tracking it
--   is); a link may come without a number. A link is https and has no spaces.
-- cost_non_negative: what the shop pays the carrier is 0 or more, or still empty.
-- rolled_back_chk: a send is rolled back at the time of the send or later.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_shipments_carrier_chk'
  ) THEN
    ALTER TABLE cartlify.order_shipments
      DROP CONSTRAINT order_shipments_carrier_chk;
  END IF;

  ALTER TABLE cartlify.order_shipments
    ADD CONSTRAINT order_shipments_carrier_chk
    CHECK (
      "carrier" IS NULL
      OR (char_length("carrier") >= 1 AND "carrier" = btrim("carrier"))
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_shipments_tracking_chk'
  ) THEN
    ALTER TABLE cartlify.order_shipments
      DROP CONSTRAINT order_shipments_tracking_chk;
  END IF;

  ALTER TABLE cartlify.order_shipments
    ADD CONSTRAINT order_shipments_tracking_chk
    CHECK (
      (
        "trackingNumber" IS NULL
        OR (
          carrier IS NOT NULL
          AND char_length("trackingNumber") >= 1
          AND "trackingNumber" = btrim("trackingNumber")
        )
      )
      AND (
        "trackingUrl" IS NULL
        OR (
          carrier IS NOT NULL
          AND "trackingUrl" ~ '^https://[^[:space:]]+$'
        )
      )
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_shipments_cost_non_negative'
  ) THEN
    ALTER TABLE cartlify.order_shipments
      DROP CONSTRAINT order_shipments_cost_non_negative;
  END IF;

  ALTER TABLE cartlify.order_shipments
    ADD CONSTRAINT order_shipments_cost_non_negative
    CHECK (
      cost IS NULL OR cost >= 0
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_shipments_rolled_back_chk'
  ) THEN
    ALTER TABLE cartlify.order_shipments
      DROP CONSTRAINT order_shipments_rolled_back_chk;
  END IF;

  ALTER TABLE cartlify.order_shipments
    ADD CONSTRAINT order_shipments_rolled_back_chk
    CHECK (
      "rolledBackAt" IS NULL OR "rolledBackAt" >= "shippedAt"
    );
END $$;

----------------------------------------
-- PRODUCTS: the weight and the sizes of a packed product
----------------------------------------
-- The weight is in grams, above 0 and up to 1 000 000 (a ton). A size is in millimetres, above
-- 0 and up to 10 000 (ten metres). The three sizes come together or not at all. A product may
-- have no weight and no sizes.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_shipping_data_chk'
  ) THEN
    ALTER TABLE cartlify.products
      DROP CONSTRAINT products_shipping_data_chk;
  END IF;

  ALTER TABLE cartlify.products
    ADD CONSTRAINT products_shipping_data_chk
    CHECK (
      ("weightGrams" IS NULL OR ("weightGrams" > 0 AND "weightGrams" <= 1000000))
      AND (
        ("lengthMm" IS NULL AND "widthMm" IS NULL AND "heightMm" IS NULL)
        OR (
          "lengthMm" IS NOT NULL AND "lengthMm" > 0 AND "lengthMm" <= 10000
          AND "widthMm" IS NOT NULL AND "widthMm" > 0 AND "widthMm" <= 10000
          AND "heightMm" IS NOT NULL AND "heightMm" > 0 AND "heightMm" <= 10000
        )
      )
    );
END $$;

----------------------------------------
-- USER_TOKENS: a token expires after it was created
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
-- USER_TOKENS: sessions
----------------------------------------
-- user_tokens_session_chk: a session token (REFRESH_TOKEN) has a session id, no other link has
-- one. It is NOT VALID: sessions opened before the column existed have none and get one at
-- their next renewal, so only new and changed rows are checked.
-- user_tokens_revoked_closed_chk: a session is revoked at the moment it is closed, so revokedAt
-- is empty or equal to usedAt.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_tokens_session_chk'
  ) THEN
    ALTER TABLE cartlify.user_tokens
      ADD CONSTRAINT user_tokens_session_chk
      CHECK ((type = 'REFRESH_TOKEN') = ("sessionId" IS NOT NULL)) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_tokens_revoked_closed_chk'
  ) THEN
    ALTER TABLE cartlify.user_tokens
      ADD CONSTRAINT user_tokens_revoked_closed_chk
      CHECK ("revokedAt" IS NULL OR ("usedAt" IS NOT NULL AND "revokedAt" = "usedAt"));
  END IF;
END $$;

----------------------------------------
-- PRODUCT_PRICE_CHANGE_LOGS: prices, the start of a sale
----------------------------------------
-- Both prices of a line are not negative.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_change_prices_non_negative'
  ) THEN
    ALTER TABLE cartlify.product_price_change_logs
      ADD CONSTRAINT price_change_prices_non_negative
      CHECK ("oldPrice" >= 0 AND "newPrice" >= 0);
  END IF;

  -- A line with an end (endsAt) is the start of a sale, so its new price is below the old one.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_change_sale_below_price'
  ) THEN
    ALTER TABLE cartlify.product_price_change_logs
      ADD CONSTRAINT price_change_sale_below_price
      CHECK ("endsAt" IS NULL OR "newPrice" < "oldPrice");
  END IF;
END $$;

----------------------------------------
-- REVIEWS: a rating or a comment
----------------------------------------
-- A review has a rating or a comment that is not blank; both empty is refused.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reviews_rating_or_comment_required'
  ) THEN
    ALTER TABLE cartlify.reviews
      DROP CONSTRAINT reviews_rating_or_comment_required;
  END IF;

  ALTER TABLE cartlify.reviews
    ADD CONSTRAINT reviews_rating_or_comment_required
    CHECK (
      "rating" IS NOT NULL
      OR ("comment" IS NOT NULL AND btrim("comment") <> '')
    );
END $$;

----------------------------------------
-- PRODUCTS: stock and reserved stock
----------------------------------------
-- The stock is not negative. The reserved stock is not negative and not above the stock.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_stock_non_negative'
  ) THEN
    ALTER TABLE cartlify.products
      DROP CONSTRAINT products_stock_non_negative;
  END IF;

  ALTER TABLE cartlify.products
    ADD CONSTRAINT products_stock_non_negative
    CHECK ("stock" >= 0);

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_reserved_stock_within_stock'
  ) THEN
    ALTER TABLE cartlify.products
      DROP CONSTRAINT products_reserved_stock_within_stock;
  END IF;

  ALTER TABLE cartlify.products
    ADD CONSTRAINT products_reserved_stock_within_stock
    CHECK ("reservedStock" >= 0 AND "reservedStock" <= "stock");
END $$;

----------------------------------------
-- PRODUCT_BATCHES and ORDER_BATCH_ALLOCATIONS: units, cost, number
----------------------------------------
-- product_batches_quantity_chk: a batch has units, and what it has left goes from all of them
--   down to none.
-- product_batches_unit_cost_chk: the cost of a unit is 0 or more.
-- product_batches_number_chk: the number the supplier gave, when there is one, is trimmed and
--   1-100 characters.
-- order_batch_allocations_quantity_chk: an allocation takes at least one unit.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_batches_quantity_chk'
  ) THEN
    ALTER TABLE cartlify.product_batches
      DROP CONSTRAINT product_batches_quantity_chk;
  END IF;

  ALTER TABLE cartlify.product_batches
    ADD CONSTRAINT product_batches_quantity_chk
    CHECK (quantity > 0 AND remaining >= 0 AND remaining <= quantity);

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_batches_unit_cost_chk'
  ) THEN
    ALTER TABLE cartlify.product_batches
      DROP CONSTRAINT product_batches_unit_cost_chk;
  END IF;

  ALTER TABLE cartlify.product_batches
    ADD CONSTRAINT product_batches_unit_cost_chk
    CHECK ("unitCost" >= 0);

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_batches_number_chk'
  ) THEN
    ALTER TABLE cartlify.product_batches
      DROP CONSTRAINT product_batches_number_chk;
  END IF;

  ALTER TABLE cartlify.product_batches
    ADD CONSTRAINT product_batches_number_chk
    CHECK (
      "supplierBatchNumber" IS NULL
      OR (
        "supplierBatchNumber" = btrim("supplierBatchNumber")
        AND char_length("supplierBatchNumber") BETWEEN 1 AND 100
      )
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_batch_allocations_quantity_chk'
  ) THEN
    ALTER TABLE cartlify.order_batch_allocations
      DROP CONSTRAINT order_batch_allocations_quantity_chk;
  END IF;

  ALTER TABLE cartlify.order_batch_allocations
    ADD CONSTRAINT order_batch_allocations_quantity_chk
    CHECK (quantity > 0);
END $$;

----------------------------------------
-- CHAT_MESSAGES: the sender and the content
----------------------------------------
-- A message of a user or of an admin names its sender (senderId); a message of the bot or of a
-- guest has none. The content is not blank.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_sender_consistency_chk'
  ) THEN
    ALTER TABLE cartlify.chat_messages
      DROP CONSTRAINT chat_messages_sender_consistency_chk;
  END IF;

  ALTER TABLE cartlify.chat_messages
    ADD CONSTRAINT chat_messages_sender_consistency_chk
    CHECK (
      (
        "senderType" IN ('user', 'admin')
        AND "senderId" IS NOT NULL
      )
      OR (
        "senderType" IN ('bot', 'guest')
        AND "senderId" IS NULL
      )
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_content_not_blank_chk'
  ) THEN
    ALTER TABLE cartlify.chat_messages
      DROP CONSTRAINT chat_messages_content_not_blank_chk;
  END IF;

  ALTER TABLE cartlify.chat_messages
    ADD CONSTRAINT chat_messages_content_not_blank_chk
    CHECK (length(btrim(content)) > 0);
END $$;

----------------------------------------
-- PRODUCT_IMAGES: one primary image per product
----------------------------------------
-- The cart, the orders and the lists show the primary image of a product. An image update
-- deletes the old images before it writes the new ones, so the index never sees two primaries.
-- Old rows are not cleaned: if a product already has two primary images, creating the index
-- fails until one of them is fixed by hand.
CREATE UNIQUE INDEX IF NOT EXISTS product_images_one_primary_idx ON cartlify.product_images ("productId")
WHERE
  "isPrimary";

----------------------------------------
-- PRODUCTS: one product of the catalog per article number
----------------------------------------
-- Two products of the catalog cannot share an article number; the case of the letters does
-- not count. A product taken out of the catalog frees its number. Deliveries and write-offs name
-- a product by this number.
CREATE UNIQUE INDEX IF NOT EXISTS products_sku_catalog_uidx ON cartlify.products (lower(sku))
WHERE
  sku IS NOT NULL
  AND "deletedAt" IS NULL;

----------------------------------------
-- CHAT_THREADS: one open thread per actor
----------------------------------------
-- A user and a guest each have at most one open thread.
CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_one_open_user_idx ON cartlify.chat_threads ("userId")
WHERE
  status = 'open'
  AND "userId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_one_open_guest_idx ON cartlify.chat_threads ("guestId")
WHERE
  status = 'open'
  AND "guestId" IS NOT NULL;

----------------------------------------
-- CHAT_THREADS: queues of the admins
----------------------------------------
-- The two queues of open admin threads. They are dropped and created again on every run, so a
-- changed definition takes effect.
-- waiting: the customer asked for an admin and has a message no admin has read; the oldest
--   request first.
-- active: no request is pending (an admin already took the thread): every open admin thread an
--   admin took, read or not, the newest message first.
DROP INDEX IF EXISTS cartlify.chat_threads_admin_waiting_queue_idx;

DROP INDEX IF EXISTS cartlify.chat_threads_admin_active_queue_idx;

CREATE INDEX chat_threads_admin_waiting_queue_idx ON cartlify.chat_threads ("adminRequestedAt" ASC, "lastMessageAt" DESC)
WHERE
  status = 'open'
  AND type = 'admin'
  AND "adminRequestedAt" IS NOT NULL
  AND "adminUnreadSince" IS NOT NULL;

CREATE INDEX chat_threads_admin_active_queue_idx ON cartlify.chat_threads ("lastMessageAt" DESC, id)
WHERE
  status = 'open'
  AND type = 'admin'
  AND "adminRequestedAt" IS NULL;

----------------------------------------
-- CHAT_THREADS: earlier closed admin threads of one customer
----------------------------------------
-- An admin who opens a thread sees the earlier closed admin threads of the same user or guest,
-- the newest first.
CREATE INDEX IF NOT EXISTS chat_threads_closed_admin_user_history_idx ON cartlify.chat_threads ("userId", "lastMessageAt" DESC)
WHERE
  status = 'closed'
  AND type = 'admin'
  AND "userId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_threads_closed_admin_guest_history_idx ON cartlify.chat_threads ("guestId", "lastMessageAt" DESC)
WHERE
  status = 'closed'
  AND type = 'admin'
  AND "guestId" IS NOT NULL;

----------------------------------------
-- CHAT_MESSAGES: history and unread messages
----------------------------------------
-- The messages of a thread in order are served by the index of the Prisma schema
-- (chat_messages_threadId_createdAt_idx).
-- chat_messages_unread_by_thread_sender_idx: the unread messages of a thread by sender; it holds
-- only unread rows.
-- chat_messages_thread_created_idx was the same index a second time, it is dropped (a temporary
-- line: remove it once dev and prod have run this script).
DROP INDEX IF EXISTS cartlify.chat_messages_thread_created_idx;

CREATE INDEX IF NOT EXISTS chat_messages_unread_by_thread_sender_idx ON cartlify.chat_messages ("threadId", "senderType")
WHERE
  "isRead" = false;

----------------------------------------
-- USERS: search by a part of the email
----------------------------------------
-- New and changed emails are stored in lower case (trg_users_before_write_email). The list of users for an
-- admin looks for a part of an address with ILIKE, and a trigram index serves it from 3
-- characters on.
CREATE INDEX IF NOT EXISTS users_email_trgm_idx ON cartlify.users USING gin (email cartlify.gin_trgm_ops);

----------------------------------------
-- ADMIN_ALERT_SETTINGS: the threshold of a kind
----------------------------------------
-- A threshold an admin set is a whole number from 1 (the bounds of each kind are the server's).
-- No threshold means the one the server gives.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_alert_settings_threshold_chk'
  ) THEN
    ALTER TABLE cartlify.admin_alert_settings
      DROP CONSTRAINT admin_alert_settings_threshold_chk;
  END IF;

  ALTER TABLE cartlify.admin_alert_settings
    ADD CONSTRAINT admin_alert_settings_threshold_chk
    CHECK (threshold IS NULL OR threshold >= 1);
END $$;

----------------------------------------
-- LEGAL_DOCUMENTS: the title, the text, the number and the sha256 of a version
----------------------------------------
-- The title is trimmed, 1-200 characters. The text is 1-200 000 characters. The number starts
-- at 1. The sha256 is 64 hex characters in lower case. The database sets the number and the
-- sha256 itself (legal_documents_before_insert, db/05).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'legal_documents_title_chk'
  ) THEN
    ALTER TABLE cartlify.legal_documents
      DROP CONSTRAINT legal_documents_title_chk;
  END IF;

  ALTER TABLE cartlify.legal_documents
    ADD CONSTRAINT legal_documents_title_chk
    CHECK (
      title = btrim(title)
      AND char_length(title) >= 1
      AND char_length(title) <= 200
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'legal_documents_content_chk'
  ) THEN
    ALTER TABLE cartlify.legal_documents
      DROP CONSTRAINT legal_documents_content_chk;
  END IF;

  ALTER TABLE cartlify.legal_documents
    ADD CONSTRAINT legal_documents_content_chk
    CHECK (char_length(content) >= 1 AND char_length(content) <= 200000);

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'legal_documents_version_chk'
  ) THEN
    ALTER TABLE cartlify.legal_documents
      DROP CONSTRAINT legal_documents_version_chk;
  END IF;

  ALTER TABLE cartlify.legal_documents
    ADD CONSTRAINT legal_documents_version_chk
    CHECK (version >= 1 AND sha256 ~ '^[0-9a-f]{64}$');
END $$;

----------------------------------------
-- JOURNALS: the event of a line is written domain.name
----------------------------------------
-- Lower case with one dot, for example product.update_batch or login.google. The same check is
-- on the four journals below. The events the app writes are listed in
-- src/config/journalEvents.ts.
DO $$
DECLARE
  v_journal record;
BEGIN
  FOR v_journal IN
    SELECT * FROM (
      VALUES
        ('admin_audit_log', 'admin_audit_log_event_chk'),
        ('product_price_change_logs', 'product_price_change_logs_event_chk'),
        ('login_logs', 'login_logs_event_chk'),
        ('legal_acceptances', 'legal_acceptances_event_chk')
    ) AS j (table_name, constraint_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = v_journal.constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE cartlify.%I ADD CONSTRAINT %I CHECK (event ~ %L)',
        v_journal.table_name,
        v_journal.constraint_name,
        '^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*$'
      );
    END IF;
  END LOOP;
END $$;
