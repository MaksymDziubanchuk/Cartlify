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
-- PARTIES: the manufacturers and the persons responsible in the EU; the warnings of a product
----------------------------------------
-- A party has a name, a postal address, an email and a country, kept as the service trims them
-- (nothing empty, no space at an end), within the lengths the API gives; the country is two
-- capitals. One name, address and country is one row, letter case ignored: a second one would only
-- leave two entries for one party.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parties_values_chk') THEN
    ALTER TABLE cartlify.parties
      ADD CONSTRAINT parties_values_chk
      CHECK (
        name = btrim(name) AND name <> '' AND char_length(name) <= 200
        AND address = btrim(address) AND address <> '' AND char_length(address) <= 500
        AND email = btrim(email) AND char_length(email) <= 254
        AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
        AND country ~ '^[A-Z]{2}$'
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS parties_identity_uidx
  ON cartlify.parties (lower(name), lower(address), country);

-- The warnings of a product are text that is kept as it was trimmed, not empty, within 2000 signs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_warnings_chk') THEN
    ALTER TABLE cartlify.products
      ADD CONSTRAINT products_warnings_chk
      CHECK (
        warnings IS NULL
        OR (warnings = btrim(warnings) AND warnings <> '' AND char_length(warnings) <= 2000)
      );
  END IF;
END $$;

----------------------------------------
-- DOCUMENTS: the title, the file; the place of a document in a product
----------------------------------------
-- A document has a title kept as the service trims it (nothing empty, no space at an end, up to 200
-- signs), a file with its url, public id and a size above zero.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_values_chk') THEN
    ALTER TABLE cartlify.documents
      ADD CONSTRAINT documents_values_chk
      CHECK (
        title = btrim(title) AND title <> '' AND char_length(title) <= 200
        AND url <> '' AND "publicId" <> '' AND "sizeBytes" > 0
      );
  END IF;
END $$;

-- The documents of a product are numbered from 1, a number once (the unique key of the table).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_documents_position_chk') THEN
    ALTER TABLE cartlify.product_documents
      ADD CONSTRAINT product_documents_position_chk CHECK (position >= 1);
  END IF;
END $$;

----------------------------------------
-- CHARACTERISTICS: names, units, numbers, places
----------------------------------------
-- A group, a characteristic and a value have a name kept as the service trims it (nothing empty,
-- no space at an end, up to 100 signs), one name once in its scope, letter case ignored. A place is
-- 1 or more and once in its scope; the unique keys of the places are checked at the end of a
-- transaction (DEFERRABLE INITIALLY DEFERRED), so that a new order can be written row by row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attribute_groups_values_chk') THEN
    ALTER TABLE cartlify.attribute_groups
      ADD CONSTRAINT attribute_groups_values_chk
      CHECK (
        name = btrim(name) AND name <> '' AND char_length(name) <= 100
        AND position >= 1
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attribute_groups_position_key') THEN
    ALTER TABLE cartlify.attribute_groups
      ADD CONSTRAINT attribute_groups_position_key UNIQUE (position) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attributes_values_chk') THEN
    ALTER TABLE cartlify.attributes
      ADD CONSTRAINT attributes_values_chk
      CHECK (
        name = btrim(name) AND name <> '' AND char_length(name) <= 100
        AND (unit IS NULL OR (unit = btrim(unit) AND unit <> '' AND char_length(unit) <= 20))
        AND position >= 1
        -- the settings of a number: its digits after the point and its bounds, and only a number has them
        AND ((type = 'number') = (decimals IS NOT NULL))
        AND (decimals IS NULL OR decimals BETWEEN 0 AND 3)
        AND (type = 'number' OR ("minValue" IS NULL AND "maxValue" IS NULL))
        AND ("minValue" IS NULL OR "maxValue" IS NULL OR "minValue" <= "maxValue")
        -- a text and a set of values cannot split the rows of a list
        AND (NOT "isMain" OR type IN ('number', 'boolean', 'option'))
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attributes_group_position_key') THEN
    ALTER TABLE cartlify.attributes
      ADD CONSTRAINT attributes_group_position_key UNIQUE ("groupId", position) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attribute_options_values_chk') THEN
    ALTER TABLE cartlify.attribute_options
      ADD CONSTRAINT attribute_options_values_chk
      CHECK (
        name = btrim(name) AND name <> '' AND char_length(name) <= 100
        AND position >= 1
        AND ("colorCode" IS NULL OR "colorCode" ~ '^#[0-9A-Fa-f]{6}$')
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attribute_options_position_key') THEN
    ALTER TABLE cartlify.attribute_options
      ADD CONSTRAINT attribute_options_position_key UNIQUE ("attributeId", position) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS attribute_groups_name_uidx
  ON cartlify.attribute_groups (lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS attributes_name_uidx
  ON cartlify.attributes (lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS attribute_options_name_uidx
  ON cartlify.attribute_options ("attributeId", lower(name));

----------------------------------------
-- VALUES OF CHARACTERISTICS OF VARIANTS
----------------------------------------
-- A row holds one value in exactly one of the four columns (the type of the characteristic decides
-- which one: db/05), a text is trimmed, not empty and up to 500 signs. A variant has one row for a
-- characteristic, or one row for each value it has of a set: the unique index treats the empty
-- value of a list as a value (NULLS NOT DISTINCT), so a text, a number and yes/no are held once,
-- and a set holds each of its values once (a choice of one value is held by the trigger of db/05).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'variant_attribute_values_value_chk') THEN
    ALTER TABLE cartlify.variant_attribute_values
      ADD CONSTRAINT variant_attribute_values_value_chk
      CHECK (
        num_nonnulls("textValue", "numberValue", "boolValue", "optionId") = 1
        AND (
          "textValue" IS NULL
          OR ("textValue" = btrim("textValue") AND "textValue" <> '' AND char_length("textValue") <= 500)
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS variant_attribute_values_value_uidx
  ON cartlify.variant_attribute_values ("variantId", "attributeId", "optionId") NULLS NOT DISTINCT;

-- The filter of the catalog by characteristics (f) and its panel look for the variants that have a
-- value of a characteristic: a value of a list among some, a number in a range. The unique index
-- above answers "the values of one variant"; these two answer "the variants of one value": the
-- choices with the variant in the index (an index-only scan, the Prisma index on attributeId and
-- optionId has no variant), and the numbers by range (nothing indexed them: a range read every
-- value of the characteristic).
CREATE INDEX IF NOT EXISTS variant_attribute_values_choice_idx
  ON cartlify.variant_attribute_values ("attributeId", "optionId", "variantId")
  WHERE "optionId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS variant_attribute_values_number_idx
  ON cartlify.variant_attribute_values ("attributeId", "numberValue", "variantId")
  WHERE "numberValue" IS NOT NULL;

----------------------------------------
-- PRODUCTS: counters
----------------------------------------
-- The counters (views, popularity, reviewsCount) are not negative, the average rating is 0 to 5,
-- a popularity set by hand is not negative.
DO $$
BEGIN
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
-- PRODUCT_VARIANTS: price, sale, article number, barcode, place
----------------------------------------
-- The price is not negative.
-- A sale has a price and an end, or neither. The sale price is 0 (free) or more, and below
-- the price. A price lowered to the sale price or below ends the sale first
-- (product_variants_before_price_change, db/05), so this check does not stop that update.
-- The lowest price of the 30 days before a sale exists only while there is a sale. A sale may
-- have none.
-- An article number and a barcode are trimmed and not empty (the server turns an empty one into
-- none). A barcode is 8, 12, 13 or 14 digits; the check digit is the server's to check.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_price_non_negative'
  ) THEN
    ALTER TABLE cartlify.product_variants
      ADD CONSTRAINT product_variants_price_non_negative
      CHECK (price >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_sale_chk'
  ) THEN
    ALTER TABLE cartlify.product_variants
      ADD CONSTRAINT product_variants_sale_chk
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_sale_prior_price_chk'
  ) THEN
    ALTER TABLE cartlify.product_variants
      ADD CONSTRAINT product_variants_sale_prior_price_chk
      CHECK (
        "salePriorPrice" IS NULL
        OR ("salePrice" IS NOT NULL AND "salePriorPrice" >= 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_sku_chk'
  ) THEN
    ALTER TABLE cartlify.product_variants
      ADD CONSTRAINT product_variants_sku_chk
      CHECK (sku IS NULL OR (sku = btrim(sku) AND length(sku) > 0));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_barcode_chk'
  ) THEN
    ALTER TABLE cartlify.product_variants
      ADD CONSTRAINT product_variants_barcode_chk
      CHECK (barcode IS NULL OR barcode ~ '^([0-9]{8}|[0-9]{12,14})$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_position_chk'
  ) THEN
    ALTER TABLE cartlify.product_variants
      ADD CONSTRAINT product_variants_position_chk
      CHECK (position >= 1);
  END IF;
END $$;

-- Two live variants of the catalog cannot share an article number or a barcode; the case of the
-- letters does not count. A variant taken out of sale frees both. Deliveries and write-offs name a
-- variant by its article number or its barcode.
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_sku_catalog_uidx ON cartlify.product_variants (lower(sku))
WHERE
  sku IS NOT NULL
  AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_barcode_catalog_uidx ON cartlify.product_variants (barcode)
WHERE
  barcode IS NOT NULL
  AND "deletedAt" IS NULL;

-- The place of a variant among the variants of its product, and the place of a picture among the
-- pictures of a variant. A key is checked at the end of the transaction, so a reorder can write
-- the places one after another.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_position_key') THEN
    ALTER TABLE cartlify.product_variants
      ADD CONSTRAINT product_variants_position_key UNIQUE ("productId", position) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'variant_images_position_key') THEN
    ALTER TABLE cartlify.variant_images
      ADD CONSTRAINT variant_images_position_key UNIQUE ("variantId", position) DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'variant_images_position_chk') THEN
    ALTER TABLE cartlify.variant_images
      ADD CONSTRAINT variant_images_position_chk
      CHECK (position >= 1);
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
-- the cancel and only then: only a paid or shipped order is cancelled (refresh_return_state, by its
-- statements of return), and never before its payment time.
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
-- ORDERS: the time of the delivery and the term of the contract
----------------------------------------
-- deliveredAt is set by the database with the step to delivered and only then (orders_before_update,
-- db/05): an order has it exactly while it is delivered.
-- withdrawalDays and returnShippingPaidBy are what the contract in force said at the confirmation
-- (confirm_order): both or none, 14 days at least, and never on an order that is a cart.
-- An order delivered before deliveredAt existed has no such time and breaks the first check:
-- clear those rows before the script runs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_delivered_at_chk'
  ) THEN
    ALTER TABLE cartlify.orders
      DROP CONSTRAINT orders_delivered_at_chk;
  END IF;

  ALTER TABLE cartlify.orders
    ADD CONSTRAINT orders_delivered_at_chk
    CHECK (("deliveredAt" IS NOT NULL) = (status = 'delivered'));

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_withdrawal_terms_chk'
  ) THEN
    ALTER TABLE cartlify.orders
      DROP CONSTRAINT orders_withdrawal_terms_chk;
  END IF;

  ALTER TABLE cartlify.orders
    ADD CONSTRAINT orders_withdrawal_terms_chk
    CHECK (
      ("withdrawalDays" IS NULL) = ("returnShippingPaidBy" IS NULL)
      AND (
        "withdrawalDays" IS NULL
        OR (confirmed AND "withdrawalDays" >= 14 AND "withdrawalDays" <= 36500)
      )
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
-- RETURN_SHIPMENTS: the parcels the shop paid to carry goods back
----------------------------------------
-- carrier_chk, tracking_chk, cost_non_negative: the same rules as the sends to a buyer
-- (order_shipments): a carrier is not blank, a number needs a carrier and a link needs one, the
-- link is https, what the shop paid is 0 or more or still empty.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'return_shipments_carrier_chk'
  ) THEN
    ALTER TABLE cartlify.return_shipments
      DROP CONSTRAINT return_shipments_carrier_chk;
  END IF;

  ALTER TABLE cartlify.return_shipments
    ADD CONSTRAINT return_shipments_carrier_chk
    CHECK (
      "carrier" IS NULL
      OR (char_length("carrier") >= 1 AND "carrier" = btrim("carrier"))
    );

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'return_shipments_tracking_chk'
  ) THEN
    ALTER TABLE cartlify.return_shipments
      DROP CONSTRAINT return_shipments_tracking_chk;
  END IF;

  ALTER TABLE cartlify.return_shipments
    ADD CONSTRAINT return_shipments_tracking_chk
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
    SELECT 1 FROM pg_constraint WHERE conname = 'return_shipments_cost_non_negative'
  ) THEN
    ALTER TABLE cartlify.return_shipments
      DROP CONSTRAINT return_shipments_cost_non_negative;
  END IF;

  ALTER TABLE cartlify.return_shipments
    ADD CONSTRAINT return_shipments_cost_non_negative
    CHECK (
      cost IS NULL OR cost >= 0
    );
END $$;

----------------------------------------
-- PRODUCT_VARIANTS: the weight and the sizes of a packed variant
----------------------------------------
-- The weight is in grams, above 0 and up to 1 000 000 (a ton). A size is in millimetres, above
-- 0 and up to 10 000 (ten metres). The three sizes come together or not at all. A variant may
-- have no weight and no sizes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_shipping_data_chk'
  ) THEN
    ALTER TABLE cartlify.product_variants
      ADD CONSTRAINT product_variants_shipping_data_chk
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
  END IF;
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
-- PRODUCT_VARIANTS: stock and reserved stock
----------------------------------------
-- The stock is not negative. The reserved stock is not negative and not above the stock.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_stock_non_negative'
  ) THEN
    ALTER TABLE cartlify.product_variants
      ADD CONSTRAINT product_variants_stock_non_negative
      CHECK ("stock" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_reserved_stock_within_stock'
  ) THEN
    ALTER TABLE cartlify.product_variants
      ADD CONSTRAINT product_variants_reserved_stock_within_stock
      CHECK ("reservedStock" >= 0 AND "reservedStock" <= "stock");
  END IF;
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
-- LEGAL_DOCUMENTS: the fields of each kind
----------------------------------------
-- The contract has the days a buyer has to withdraw after the delivery (14 to 36500), the address
-- the goods go back to (trimmed, 1-500 characters) and who pays the carrier for it. The privacy
-- policy has the eight terms of keeping personal data, each 1 to 36500 days (six for the logins,
-- the guests, the chats, the statements of return and the recipients of the orders; two for the
-- newsletters: the proof of the consent of an ended subscription and the rows of the recipients of
-- a campaign). The terms have none of them, and no kind has the fields of another. Each test
-- starts with IS NOT NULL: a check that reads NULL passes.
-- A version published before these columns existed has none of them and breaks the check: clear
-- those rows (and the consents to them) before the script runs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'legal_documents_kind_fields_chk'
  ) THEN
    ALTER TABLE cartlify.legal_documents
      DROP CONSTRAINT legal_documents_kind_fields_chk;
  END IF;

  ALTER TABLE cartlify.legal_documents
    ADD CONSTRAINT legal_documents_kind_fields_chk
    CHECK (
      CASE kind
        WHEN 'contract' THEN
          "withdrawalDays" IS NOT NULL
          AND "withdrawalDays" >= 14 AND "withdrawalDays" <= 36500
          AND "returnAddress" IS NOT NULL
          AND "returnAddress" = btrim("returnAddress")
          AND char_length("returnAddress") >= 1 AND char_length("returnAddress") <= 500
          AND "returnShippingPaidBy" IS NOT NULL
          AND "retentionLoginAddressesDays" IS NULL
          AND "retentionGuestDataDays" IS NULL
          AND "retentionDeletedChatsDays" IS NULL
          AND "retentionReturnAddressesDays" IS NULL
          AND "retentionReturnPersonalDays" IS NULL
          AND "retentionRecipientDays" IS NULL
          AND "retentionNewsletterConsentDays" IS NULL
          AND "retentionNewsletterRecipientsDays" IS NULL
        WHEN 'privacy' THEN
          "retentionLoginAddressesDays" IS NOT NULL
          AND "retentionLoginAddressesDays" >= 1 AND "retentionLoginAddressesDays" <= 36500
          AND "retentionGuestDataDays" IS NOT NULL
          AND "retentionGuestDataDays" >= 1 AND "retentionGuestDataDays" <= 36500
          AND "retentionDeletedChatsDays" IS NOT NULL
          AND "retentionDeletedChatsDays" >= 1 AND "retentionDeletedChatsDays" <= 36500
          AND "retentionReturnAddressesDays" IS NOT NULL
          AND "retentionReturnAddressesDays" >= 1 AND "retentionReturnAddressesDays" <= 36500
          AND "retentionReturnPersonalDays" IS NOT NULL
          AND "retentionReturnPersonalDays" >= 1 AND "retentionReturnPersonalDays" <= 36500
          AND "retentionRecipientDays" IS NOT NULL
          AND "retentionRecipientDays" >= 1 AND "retentionRecipientDays" <= 36500
          AND "retentionNewsletterConsentDays" IS NOT NULL
          AND "retentionNewsletterConsentDays" >= 1 AND "retentionNewsletterConsentDays" <= 36500
          AND "retentionNewsletterRecipientsDays" IS NOT NULL
          AND "retentionNewsletterRecipientsDays" >= 1 AND "retentionNewsletterRecipientsDays" <= 36500
          AND "withdrawalDays" IS NULL
          AND "returnAddress" IS NULL
          AND "returnShippingPaidBy" IS NULL
        ELSE
          "withdrawalDays" IS NULL
          AND "returnAddress" IS NULL
          AND "returnShippingPaidBy" IS NULL
          AND "retentionLoginAddressesDays" IS NULL
          AND "retentionGuestDataDays" IS NULL
          AND "retentionDeletedChatsDays" IS NULL
          AND "retentionReturnAddressesDays" IS NULL
          AND "retentionReturnPersonalDays" IS NULL
          AND "retentionRecipientDays" IS NULL
          AND "retentionNewsletterConsentDays" IS NULL
          AND "retentionNewsletterRecipientsDays" IS NULL
      END
    );
END $$;

----------------------------------------
-- RETURNS AND RETURN_ITEMS: the statement and the pairs of the goods with the money
----------------------------------------
-- returns_text_chk: the name and the email of the statement are trimmed, the name has 1-200
--   characters, the email 3-320 and an at sign.
-- returns_stated_at_chk: a statement is not made before the moment it states (never of the future).
-- returns_source_chk: an admin statement has its admin and its reason, any other has a reason of
--   none; only an admin makes one outside the withdrawal; a statement of an account names the
--   account, one of a form names none.
-- returns_extends_chk: a statement does not extend itself.
-- returns_proof_chk: the proof is confirmed together with who confirmed it.
-- return_items_quantity_chk, return_items_amount_chk: whole units above 0, money not below 0.
-- return_items_goods_chk: the day and the author of a result come with it (not with expected), the
--   reason of a refusal to accept comes with not_accepted and with nothing else.
-- return_items_pair_chk: the pairs of the goods with the money. The goods that came back (to_stock,
--   written_off, lost) never have their money refused; the goods that were not accepted or did not
--   arrive have none of it refunded or on its way; refunded or pending money is for goods that wait,
--   came back or were lost; refused money is for goods not accepted or not arrived.
-- return_items_money_chk: the money of a row and the fields of its transfer agree. A pending row has
--   the key of its transfer; a refunded row has the time and either the key (sent through the
--   provider) or the method, the note and the root who recorded it (sent outside the app), not both;
--   a row not refunded or refused has no transfer at all; a failure and its words stay on a row not
--   refunded; the code of a closing stays on a refused row whose goods did not arrive; a refused row
--   carries no delivery and no deduction of the way back; no number is below 0.
-- returns_shipping_reimbursed_chk: the money of the way back root gave back outside the app comes
--   whole (the sum above 0, the day, the way, the note, who) or not at all.
-- returns_accepted_chk: only a statement of the form without the code is accepted, together with
--   who accepted it.
-- returns_manual_under_review_uidx: one statement of the form without the code waits for the check
--   of an admin per order (create_return refuses another first, RETURN_MANUAL_UNDER_REVIEW).
-- return_shipments_tracking_uidx: a number of a parcel once per statement, whatever the spaces and
--   the case (record_return_shipment refuses it first, RETURN_SHIPMENT_EXISTS).
-- returns_proof_given_chk: the buyer gives the proof of the parcel as a whole: the time with the
--   carrier and the number, both trimmed and not empty, and a link only with them, https and with
--   no spaces.
-- returns_close_chk: root closes with a code and a note together.
-- order_batch_allocations_returned_chk: never more units back than the order took from the batch.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'returns_text_chk') THEN
    ALTER TABLE cartlify.returns DROP CONSTRAINT returns_text_chk;
  END IF;

  ALTER TABLE cartlify.returns
    ADD CONSTRAINT returns_text_chk
    CHECK (
      "contactName" = btrim("contactName")
      AND char_length("contactName") >= 1 AND char_length("contactName") <= 200
      AND "contactEmail" = btrim("contactEmail")
      AND char_length("contactEmail") >= 3 AND char_length("contactEmail") <= 320
      AND position('@' IN "contactEmail") > 1
    );

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'returns_stated_at_chk') THEN
    ALTER TABLE cartlify.returns DROP CONSTRAINT returns_stated_at_chk;
  END IF;

  ALTER TABLE cartlify.returns
    ADD CONSTRAINT returns_stated_at_chk
    CHECK ("statedAt" <= "createdAt");

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'returns_source_chk') THEN
    ALTER TABLE cartlify.returns DROP CONSTRAINT returns_source_chk;
  END IF;

  ALTER TABLE cartlify.returns
    ADD CONSTRAINT returns_source_chk
    CHECK (
      (source = 'admin') = (reason IS NOT NULL)
      AND (source = 'admin' OR basis = 'withdrawal')
      AND (source IN ('admin', 'account')) = ("createdById" IS NOT NULL)
    );

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'returns_extends_chk') THEN
    ALTER TABLE cartlify.returns DROP CONSTRAINT returns_extends_chk;
  END IF;

  ALTER TABLE cartlify.returns
    ADD CONSTRAINT returns_extends_chk
    CHECK ("extendsId" IS NULL OR "extendsId" <> id);

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'returns_proof_chk') THEN
    ALTER TABLE cartlify.returns DROP CONSTRAINT returns_proof_chk;
  END IF;

  ALTER TABLE cartlify.returns
    ADD CONSTRAINT returns_proof_chk
    CHECK (("proofConfirmedAt" IS NULL) = ("proofConfirmedById" IS NULL));

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_items_quantity_chk') THEN
    ALTER TABLE cartlify.return_items DROP CONSTRAINT return_items_quantity_chk;
  END IF;

  ALTER TABLE cartlify.return_items
    ADD CONSTRAINT return_items_quantity_chk
    CHECK (quantity > 0 AND amount >= 0);

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_items_goods_chk') THEN
    ALTER TABLE cartlify.return_items DROP CONSTRAINT return_items_goods_chk;
  END IF;

  ALTER TABLE cartlify.return_items
    ADD CONSTRAINT return_items_goods_chk
    CHECK (
      (goods = 'expected') = ("goodsSetAt" IS NULL)
      AND ("goodsSetAt" IS NULL) = ("goodsSetById" IS NULL)
      AND (goods = 'not_accepted') = ("notAcceptedReason" IS NOT NULL)
    );

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_items_pair_chk') THEN
    ALTER TABLE cartlify.return_items DROP CONSTRAINT return_items_pair_chk;
  END IF;

  ALTER TABLE cartlify.return_items
    ADD CONSTRAINT return_items_pair_chk
    CHECK (
      CASE goods
        WHEN 'expected' THEN money IN ('not_refunded', 'pending', 'refunded')
        WHEN 'to_stock' THEN money IN ('not_refunded', 'pending', 'refunded')
        WHEN 'written_off' THEN money IN ('not_refunded', 'pending', 'refunded')
        WHEN 'lost' THEN money IN ('not_refunded', 'pending', 'refunded')
        -- goods paid ahead that never came keep their money back
        WHEN 'not_arrived' THEN money IN ('not_refunded', 'refused', 'refunded')
        ELSE money IN ('not_refunded', 'refused')
      END
      AND (money <> 'refused' OR goods IN ('not_accepted', 'not_arrived'))
    );

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_items_money_chk') THEN
    ALTER TABLE cartlify.return_items DROP CONSTRAINT return_items_money_chk;
  END IF;

  ALTER TABLE cartlify.return_items
    ADD CONSTRAINT return_items_money_chk
    CHECK (
      "deliveryShare" >= 0
      AND "shippingDeduction" >= 0
      AND (money <> 'pending' OR "refundKey" IS NOT NULL)
      AND (
        money <> 'refunded'
        OR ("refundedAt" IS NOT NULL AND ("refundKey" IS NULL) = ("outsideMethod" IS NOT NULL))
      )
      AND (
        money NOT IN ('not_refunded', 'refused')
        OR ("refundKey" IS NULL AND "refundedAt" IS NULL AND "refundId" IS NULL AND "outsideMethod" IS NULL)
      )
      AND ("outsideMethod" IS NULL) = ("outsideNote" IS NULL)
      -- money sent outside the app names root; a chargeback the webhook records names nobody
      AND ("outsideById" IS NULL OR "outsideMethod" IS NOT NULL)
      AND ("outsideById" IS NOT NULL OR "outsideMethod" IS NULL OR "outsideMethod" = 'chargeback')
      AND ("refundFailure" IS NULL OR money = 'not_refunded')
      AND ("refundFailureText" IS NULL OR "refundFailure" IS NOT NULL)
      AND ("refusedCode" IS NULL OR (money = 'refused' AND goods = 'not_arrived'))
      AND (money <> 'refused' OR "deliveryShare" = 0)
      AND (money <> 'refused' OR "shippingDeduction" = 0)
    );

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'returns_proof_given_chk') THEN
    ALTER TABLE cartlify.returns DROP CONSTRAINT returns_proof_given_chk;
  END IF;

  ALTER TABLE cartlify.returns
    ADD CONSTRAINT returns_proof_given_chk
    CHECK (
      ("proofProvidedAt" IS NULL) = ("proofCarrier" IS NULL)
      AND ("proofProvidedAt" IS NULL) = ("proofTrackingNumber" IS NULL)
      AND (
        "proofCarrier" IS NULL
        OR (char_length("proofCarrier") >= 1 AND "proofCarrier" = btrim("proofCarrier"))
      )
      AND (
        "proofTrackingNumber" IS NULL
        OR (char_length("proofTrackingNumber") >= 1 AND "proofTrackingNumber" = btrim("proofTrackingNumber"))
      )
      AND (
        "proofTrackingUrl" IS NULL
        OR ("proofProvidedAt" IS NOT NULL AND "proofTrackingUrl" ~ '^https://[^[:space:]]+$')
      )
    );

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'returns_close_chk') THEN
    ALTER TABLE cartlify.returns DROP CONSTRAINT returns_close_chk;
  END IF;

  ALTER TABLE cartlify.returns
    ADD CONSTRAINT returns_close_chk
    CHECK (("closeCode" IS NULL) = ("closeNote" IS NULL));

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'returns_shipping_reimbursed_chk') THEN
    ALTER TABLE cartlify.returns DROP CONSTRAINT returns_shipping_reimbursed_chk;
  END IF;

  ALTER TABLE cartlify.returns
    ADD CONSTRAINT returns_shipping_reimbursed_chk
    CHECK (
      ("shippingReimbursed" IS NULL) = ("shippingReimbursedAt" IS NULL)
      AND ("shippingReimbursed" IS NULL) = ("shippingReimbursedMethod" IS NULL)
      AND ("shippingReimbursed" IS NULL) = ("shippingReimbursedNote" IS NULL)
      AND ("shippingReimbursed" IS NULL) = ("shippingReimbursedById" IS NULL)
      AND ("shippingReimbursed" IS NULL OR "shippingReimbursed" > 0)
    );

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'returns_accepted_chk') THEN
    ALTER TABLE cartlify.returns DROP CONSTRAINT returns_accepted_chk;
  END IF;

  ALTER TABLE cartlify.returns
    ADD CONSTRAINT returns_accepted_chk
    CHECK (
      ("acceptedAt" IS NULL) = ("acceptedById" IS NULL)
      AND ("acceptedAt" IS NULL OR source = 'form_manual')
    );

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_batch_allocations_returned_chk') THEN
    ALTER TABLE cartlify.order_batch_allocations DROP CONSTRAINT order_batch_allocations_returned_chk;
  END IF;

  ALTER TABLE cartlify.order_batch_allocations
    ADD CONSTRAINT order_batch_allocations_returned_chk
    CHECK (returned >= 0 AND returned <= quantity);

  -- the lines of a statement of return name the row and the order; no other line does
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_log_return_item_chk') THEN
    ALTER TABLE cartlify.stock_log DROP CONSTRAINT stock_log_return_item_chk;
  END IF;

  ALTER TABLE cartlify.stock_log
    ADD CONSTRAINT stock_log_return_item_chk
    CHECK (
      (event IN ('stock.return', 'stock.return_write_off')) = ("returnItemId" IS NOT NULL)
      AND ("returnItemId" IS NULL OR "orderId" IS NOT NULL)
    );
END $$;

CREATE INDEX IF NOT EXISTS stock_log_return_item_idx
  ON cartlify.stock_log ("returnItemId", id)
  WHERE "returnItemId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS returns_manual_under_review_uidx
  ON cartlify.returns ("orderId")
  WHERE source = 'form_manual' AND "closedAt" IS NULL AND "acceptedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS return_shipments_tracking_uidx
  ON cartlify.return_shipments ("returnId", upper(regexp_replace("trackingNumber", '\s', '', 'g')))
  WHERE "trackingNumber" IS NOT NULL;

-- the transfers that wait for the provider: the worker asks about them
CREATE INDEX IF NOT EXISTS return_items_pending_idx
  ON cartlify.return_items ("updatedAt")
  WHERE money = 'pending';

----------------------------------------
-- JOURNALS: the event of a line is written domain.name
----------------------------------------
-- Lower case with one dot, for example product.update_batch or login.google. The same check is
-- on the five journals below. The events the app writes are listed in
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
        ('legal_acceptances', 'legal_acceptances_event_chk'),
        ('stock_log', 'stock_log_event_chk')
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

----------------------------------------
-- STOCK_LOG: the actor, the change, the operation, the changes, the indexes of the operations
----------------------------------------
-- stock_log_actor_chk: a line has an actor and a role together, or none of them (the system).
-- stock_log_change_chk: a line is a change (not 0) and the stock after it is not below 0.
-- stock_log_operation_chk: a line belongs to one operation at most: a delivery, a write-off or an
--   order.
-- stock_log_meta_chk: the changes are a list of {field, old, new}.
-- The three operations are found by their id in the lines of one delivery, write-off or order;
-- most lines have none of them, so the indexes hold the lines that have the id.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_log_actor_chk') THEN
    ALTER TABLE cartlify.stock_log
      ADD CONSTRAINT stock_log_actor_chk
      CHECK (("actorId" IS NULL) = ("actorRole" IS NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_log_change_chk') THEN
    ALTER TABLE cartlify.stock_log
      ADD CONSTRAINT stock_log_change_chk
      CHECK ("quantityChange" <> 0 AND "stockAfter" >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_log_operation_chk') THEN
    ALTER TABLE cartlify.stock_log
      ADD CONSTRAINT stock_log_operation_chk
      CHECK (num_nonnulls("deliveryId", "writeOffId", "orderId") <= 1);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_log_meta_chk') THEN
    ALTER TABLE cartlify.stock_log
      ADD CONSTRAINT stock_log_meta_chk
      CHECK (meta IS NULL OR jsonb_typeof(meta) = 'array');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stock_log_delivery_idx
  ON cartlify.stock_log ("deliveryId", id)
  WHERE "deliveryId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS stock_log_write_off_idx
  ON cartlify.stock_log ("writeOffId", id)
  WHERE "writeOffId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS stock_log_order_idx
  ON cartlify.stock_log ("orderId", id)
  WHERE "orderId" IS NOT NULL;

----------------------------------------
-- USERS: the form of a language code
----------------------------------------
-- A language is two lower-case letters (en, uk, es, ...); the ones the app answers in are decided
-- by the dictionaries that exist (src/locales), not by this form check.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_locale_chk') THEN
    ALTER TABLE cartlify.users
      ADD CONSTRAINT users_locale_chk
      CHECK (locale IS NULL OR locale ~ '^[a-z]{2}$');
  END IF;
END $$;

----------------------------------------
-- SHOP_SETTINGS: a row is one setting (docs/shop-settings.md)
----------------------------------------
-- The key is one the server knows and the value of the shape that key takes
-- (shop_setting_value_valid, db/05); the rules between settings are the server's.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shop_settings_value_chk') THEN
    ALTER TABLE cartlify.shop_settings
      ADD CONSTRAINT shop_settings_value_chk
      CHECK (cartlify.shop_setting_value_valid (key, value));
  END IF;
END $$;

-- The current value of a setting is the latest row of its key (the start of the server and every
-- write read it); the history goes newest first, of every key or of one.
CREATE INDEX IF NOT EXISTS shop_settings_key_id_idx ON cartlify.shop_settings (key, id DESC);

----------------------------------------
-- USERS: the right to run the newsletters
----------------------------------------
-- Only an admin has it (root needs none): it goes off with the role (trg_users_clear_newsletter_manager,
-- db/05), and the check keeps a buyer from having it whoever sets it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_newsletter_manager_chk') THEN
    ALTER TABLE cartlify.users
      ADD CONSTRAINT users_newsletter_manager_chk
      CHECK (NOT "canManageNewsletters" OR role = 'ADMIN');
  END IF;
END $$;

----------------------------------------
-- NEWSLETTER_SUBSCRIPTIONS: the address, the language, the source, the state
----------------------------------------
-- newsletter_subscriptions_email_chk: an address as the server writes it (lower case, no spaces
--   around it, one at sign, up to 254 characters); the format of an address is the API's to judge.
-- newsletter_subscriptions_locale_chk: a language is two lower-case letters or none ("no language",
--   the language of the shop is used).
-- newsletter_subscriptions_source_chk: a subscription of an account names its account and has no
--   HMAC; a subscription of the form has no account, and the HMAC of its address (the key of the
--   blocklist) while it lives. One that ended or was stopped may have none: an admin who erased the
--   address (cartlify.newsletter_admin_erase_address) empties it, and the guard of db/05 lets
--   nothing else do so.
-- newsletter_subscriptions_ended_user_chk: the account whose deletion ended a subscription of the form
--   (endedUserId) is named only on a subscription of the form that ended.
-- newsletter_subscriptions_status_chk: what a state holds. A waiting one has the sha256 of the token
--   of its link and the deadline, and is not confirmed or ended; one in force or paused has no link
--   and no end; a stopped one has the time of the end and the reason bounced; an ended one has the
--   time and a reason other than the bounce. Each positive test starts with IS NOT NULL: a check that
--   reads NULL passes.
-- newsletter_subscriptions_tokens_chk: the hash of the link of management and the hash of the link of
--   the unsubscribe are sha256 in hex and two different ones (the token of the button of a mail client
--   opens nothing but the unsubscribe), the salt they are made from is a string of 16 to 128
--   characters.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_subscriptions_email_chk') THEN
    ALTER TABLE cartlify.newsletter_subscriptions
      ADD CONSTRAINT newsletter_subscriptions_email_chk
      CHECK (
        email = lower(btrim(email))
        AND char_length(email) >= 3 AND char_length(email) <= 254
        AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_subscriptions_locale_chk') THEN
    ALTER TABLE cartlify.newsletter_subscriptions
      ADD CONSTRAINT newsletter_subscriptions_locale_chk
      CHECK (locale IS NULL OR locale ~ '^[a-z]{2}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_subscriptions_source_chk') THEN
    ALTER TABLE cartlify.newsletter_subscriptions
      ADD CONSTRAINT newsletter_subscriptions_source_chk
      CHECK (
        CASE source
          WHEN 'account' THEN
            "userId" IS NOT NULL
            AND "emailHmac" IS NULL
          WHEN 'form' THEN
            "userId" IS NULL
            AND (
              ("emailHmac" IS NOT NULL AND "emailHmac" ~ '^[0-9a-f]{64}$')
              OR ("emailHmac" IS NULL AND status IN ('ended', 'stopped_bounce'))
            )
        END
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_subscriptions_status_chk') THEN
    ALTER TABLE cartlify.newsletter_subscriptions
      ADD CONSTRAINT newsletter_subscriptions_status_chk
      CHECK (
        CASE status
          WHEN 'pending' THEN
            "confirmHash" IS NOT NULL
            AND "confirmHash" ~ '^[0-9a-f]{64}$'
            AND "confirmExpiresAt" IS NOT NULL
            AND "confirmedAt" IS NULL
            AND "endedAt" IS NULL
            AND "endReason" IS NULL
          WHEN 'active' THEN
            "confirmHash" IS NULL
            AND "confirmExpiresAt" IS NULL
            AND "endedAt" IS NULL
            AND "endReason" IS NULL
          WHEN 'paused_complaint' THEN
            "confirmHash" IS NULL
            AND "confirmExpiresAt" IS NULL
            AND "endedAt" IS NULL
            AND "endReason" IS NULL
          WHEN 'stopped_bounce' THEN
            "confirmHash" IS NULL
            AND "confirmExpiresAt" IS NULL
            AND "endedAt" IS NOT NULL
            AND "endReason" IS NOT NULL
            AND "endReason" = 'bounced'
          WHEN 'ended' THEN
            "confirmHash" IS NULL
            AND "confirmExpiresAt" IS NULL
            AND "endedAt" IS NOT NULL
            AND "endReason" IS NOT NULL
            AND "endReason" <> 'bounced'
        END
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_subscriptions_tokens_chk') THEN
    ALTER TABLE cartlify.newsletter_subscriptions
      ADD CONSTRAINT newsletter_subscriptions_tokens_chk
      CHECK (
        "manageHash" ~ '^[0-9a-f]{64}$'
        AND "unsubscribeHash" ~ '^[0-9a-f]{64}$'
        AND "unsubscribeHash" <> "manageHash"
        AND char_length("manageSalt") >= 16 AND char_length("manageSalt") <= 128
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_subscriptions_ended_user_chk') THEN
    ALTER TABLE cartlify.newsletter_subscriptions
      ADD CONSTRAINT newsletter_subscriptions_ended_user_chk
      CHECK ("endedUserId" IS NULL OR (source = 'form' AND status = 'ended'));
  END IF;
END $$;

-- An address has at most one subscription that waits, is in force or is paused: the form and the
-- account share the place, and a second request finds the first. Ended and stopped subscriptions
-- stay beside it as the proof of the consent. The address is compared as written (lower case, by
-- the check above).
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_subscriptions_live_email_uidx
  ON cartlify.newsletter_subscriptions (email)
  WHERE status IN ('pending', 'active', 'paused_complaint');

-- The link of a request that waits (the confirmation, "this was not me") finds the request by the
-- hash of its token. A token belongs to one request: the lookup never has two rows to choose from
-- (the steps read it into one row), and a second request given the same hash is refused. A request
-- that is not waiting has no hash (newsletter_subscriptions_status_chk).
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_subscriptions_pending_confirm_uidx
  ON cartlify.newsletter_subscriptions ("confirmHash")
  WHERE status = 'pending';

-- The blocking of an address finds the requests of the address by its HMAC (a subscription of the
-- form keeps it, one of an account does not). The HMAC is no key: every row an address ever had
-- carries the same one.
CREATE INDEX IF NOT EXISTS newsletter_subscriptions_email_hmac_idx
  ON cartlify.newsletter_subscriptions ("emailHmac")
  WHERE "emailHmac" IS NOT NULL;

-- The export of an account reads an address among the rows of every state; the index of the live
-- addresses above holds only the live ones.
CREATE INDEX IF NOT EXISTS newsletter_subscriptions_email_idx
  ON cartlify.newsletter_subscriptions (email);

-- The list of subscribers for the people who run the newsletters looks for a part of an address with
-- ILIKE '%part%', in the rows of every state; a trigram index serves it from 3 characters on (as
-- users_email_trgm_idx does for the users). Addresses are kept in lower case.
CREATE INDEX IF NOT EXISTS newsletter_subscriptions_email_trgm_idx
  ON cartlify.newsletter_subscriptions USING gin (email cartlify.gin_trgm_ops);

-- the cleanup of the requests that were not confirmed in time
CREATE INDEX IF NOT EXISTS newsletter_subscriptions_pending_expiry_idx
  ON cartlify.newsletter_subscriptions ("confirmExpiresAt")
  WHERE status = 'pending';

-- the cleanup of the ended subscriptions whose term of keeping has passed
CREATE INDEX IF NOT EXISTS newsletter_subscriptions_ended_idx
  ON cartlify.newsletter_subscriptions ("endedAt")
  WHERE status IN ('ended', 'stopped_bounce');

----------------------------------------
-- NEWSLETTER_SUBSCRIPTION_EVENTS: the language, the version of the policy; the campaign
----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_subscription_events_locale_chk') THEN
    ALTER TABLE cartlify.newsletter_subscription_events
      ADD CONSTRAINT newsletter_subscription_events_locale_chk
      CHECK (locale IS NULL OR locale ~ '^[a-z]{2}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_subscription_events_privacy_chk') THEN
    ALTER TABLE cartlify.newsletter_subscription_events
      ADD CONSTRAINT newsletter_subscription_events_privacy_chk
      CHECK ("privacyVersion" IS NULL OR "privacyVersion" >= 1);
  END IF;
END $$;

-- the lines that name a campaign: the unsubscribes from its mails, and the check of the key when a
-- draft is deleted
CREATE INDEX IF NOT EXISTS newsletter_subscription_events_campaign_idx
  ON cartlify.newsletter_subscription_events ("campaignId", id)
  WHERE "campaignId" IS NOT NULL;

----------------------------------------
-- NEWSLETTER_CAMPAIGNS: the name, the text, the totals, the state
----------------------------------------
-- newsletter_campaigns_name_chk: a name the admins see, as the service trims it, up to 200
--   characters.
-- newsletter_campaigns_content_chk: the text is an object (a language to its subject, preview and
--   blocks; the schema of the route judges the rest), the data of the products is an object or a
--   list.
-- newsletter_campaigns_totals_chk: the totals are not negative.
-- newsletter_campaigns_cancel_reason_chk: the reason of a cancellation (the limit of the campaigns,
--   when the system cancelled it) belongs to a cancelled campaign only; one an admin cancelled has none.
-- newsletter_campaigns_status_chk: what a state holds. A draft and a scheduled campaign have not
--   started: no start, no end, no data of products, no total; a scheduled one has its time. A
--   sending one has its start; a finished one the start and the time it finished; a stopped one the
--   start and the time it was stopped; a cancelled one has its time and never started.
-- The lists of campaigns (newest first, and the ones that wait for their time) are served by the
-- indexes of the Prisma model (newsletter_campaigns_createdAt_id_idx,
-- newsletter_campaigns_status_scheduledAt_idx).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_campaigns_name_chk') THEN
    ALTER TABLE cartlify.newsletter_campaigns
      ADD CONSTRAINT newsletter_campaigns_name_chk
      CHECK (name = btrim(name) AND name <> '' AND char_length(name) <= 200);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_campaigns_content_chk') THEN
    ALTER TABLE cartlify.newsletter_campaigns
      ADD CONSTRAINT newsletter_campaigns_content_chk
      CHECK (
        jsonb_typeof(content) = 'object'
        AND ("productsSnapshot" IS NULL OR jsonb_typeof("productsSnapshot") IN ('object', 'array'))
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_campaigns_totals_chk') THEN
    ALTER TABLE cartlify.newsletter_campaigns
      ADD CONSTRAINT newsletter_campaigns_totals_chk
      CHECK (
        "plannedCount" >= 0 AND "sentCount" >= 0 AND "rejectedCount" >= 0
        AND "undeliveredCount" >= 0 AND "complaintCount" >= 0 AND "unsubscribedCount" >= 0
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_campaigns_cancel_reason_chk') THEN
    ALTER TABLE cartlify.newsletter_campaigns
      ADD CONSTRAINT newsletter_campaigns_cancel_reason_chk
      CHECK ("cancelReason" IS NULL OR status = 'cancelled');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_campaigns_status_chk') THEN
    ALTER TABLE cartlify.newsletter_campaigns
      ADD CONSTRAINT newsletter_campaigns_status_chk
      CHECK (
        CASE status
          WHEN 'draft' THEN
            "startedAt" IS NULL AND "finishedAt" IS NULL AND "stoppedAt" IS NULL
            AND "cancelledAt" IS NULL AND "productsSnapshot" IS NULL
            AND "plannedCount" = 0 AND "sentCount" = 0 AND "rejectedCount" = 0
            AND "undeliveredCount" = 0 AND "complaintCount" = 0 AND "unsubscribedCount" = 0
          WHEN 'scheduled' THEN
            "scheduledAt" IS NOT NULL
            AND "startedAt" IS NULL AND "finishedAt" IS NULL AND "stoppedAt" IS NULL
            AND "cancelledAt" IS NULL AND "productsSnapshot" IS NULL
            AND "plannedCount" = 0 AND "sentCount" = 0 AND "rejectedCount" = 0
            AND "undeliveredCount" = 0 AND "complaintCount" = 0 AND "unsubscribedCount" = 0
          WHEN 'sending' THEN
            "startedAt" IS NOT NULL
            AND "finishedAt" IS NULL AND "stoppedAt" IS NULL AND "cancelledAt" IS NULL
          WHEN 'finished' THEN
            "startedAt" IS NOT NULL AND "finishedAt" IS NOT NULL
            AND "stoppedAt" IS NULL AND "cancelledAt" IS NULL
          WHEN 'stopped' THEN
            "startedAt" IS NOT NULL AND "stoppedAt" IS NOT NULL
            AND "finishedAt" IS NULL AND "cancelledAt" IS NULL
          WHEN 'cancelled' THEN
            "cancelledAt" IS NOT NULL
            AND "startedAt" IS NULL AND "finishedAt" IS NULL AND "stoppedAt" IS NULL
        END
      );
  END IF;
END $$;

----------------------------------------
-- NEWSLETTER_RECIPIENTS: the language, the tries, the state
----------------------------------------
-- newsletter_recipients_status_chk: a mail that waits has not been sent and has no id; one that was
--   sent, and later bounced, dropped or complained about, has the time it was sent; one the provider
--   rejected has neither; one the sending left out (skipped: the person unsubscribed meanwhile, or
--   there was nothing to send) never went out and has neither.
-- newsletter_recipients_queue_idx: the mails that wait, in the order they are taken (the tries used,
--   then the id); the sending (newsletter_claim_recipients) reads only these, however many mails of
--   finished campaigns the table holds, and stops at the first rows that fit.
-- newsletter_recipients_sent_at_idx: the mails sent in a day (the daily limit of the newsletters
--   counts them).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_recipients_locale_chk') THEN
    ALTER TABLE cartlify.newsletter_recipients
      ADD CONSTRAINT newsletter_recipients_locale_chk
      CHECK (locale ~ '^[a-z]{2}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_recipients_attempts_chk') THEN
    ALTER TABLE cartlify.newsletter_recipients
      ADD CONSTRAINT newsletter_recipients_attempts_chk
      CHECK (attempts >= 0 AND ("providerMessageId" IS NULL OR "providerMessageId" <> ''));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_recipients_status_chk') THEN
    ALTER TABLE cartlify.newsletter_recipients
      ADD CONSTRAINT newsletter_recipients_status_chk
      CHECK (
        CASE
          WHEN status = 'queued' THEN "sentAt" IS NULL AND "providerMessageId" IS NULL
          WHEN status IN ('sent', 'bounced', 'dropped', 'complained') THEN "sentAt" IS NOT NULL
          WHEN status = 'skipped' THEN "sentAt" IS NULL AND "providerMessageId" IS NULL
          ELSE true
        END
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS newsletter_recipients_queue_idx
  ON cartlify.newsletter_recipients (attempts, id)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS newsletter_recipients_sent_at_idx
  ON cartlify.newsletter_recipients ("sentAt")
  WHERE "sentAt" IS NOT NULL;

----------------------------------------
-- NEWSLETTER_FORM_BLOCKLIST: the HMAC, who blocked, the reason
----------------------------------------
-- newsletter_form_blocklist_hmac_chk: the HMAC of an address is a sha256 in hex.
-- newsletter_form_blocklist_actor_chk: an entry is made by an admin (named) or by the person
--   (byPerson), exactly one of the two.
-- newsletter_form_blocklist_reason_chk: a reason is trimmed and not empty, up to 200 characters.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_form_blocklist_hmac_chk') THEN
    ALTER TABLE cartlify.newsletter_form_blocklist
      ADD CONSTRAINT newsletter_form_blocklist_hmac_chk
      CHECK ("emailHmac" ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_form_blocklist_actor_chk') THEN
    ALTER TABLE cartlify.newsletter_form_blocklist
      ADD CONSTRAINT newsletter_form_blocklist_actor_chk
      CHECK (("blockedById" IS NOT NULL) <> "byPerson");
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_form_blocklist_reason_chk') THEN
    ALTER TABLE cartlify.newsletter_form_blocklist
      ADD CONSTRAINT newsletter_form_blocklist_reason_chk
      CHECK (reason IS NULL OR (reason = btrim(reason) AND reason <> ''));
  END IF;
END $$;
