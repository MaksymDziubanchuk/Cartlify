BEGIN;

-- On a live database a busy table makes the script wait for its lock, and every request of the
-- app waits behind the script. After 5 s the script stops and is run again (db-run-sql.yml).
SET LOCAL lock_timeout = '5s';

-- Everything below is created and owned by cartlify_owner, whoever runs the script.
SET LOCAL ROLE cartlify_owner;

------------------------------------------------------------
-- ADMIN STATS VIEW: the numbers of the admin dashboard (GET /api/admin/stats)
------------------------------------------------------------
-- The view gives one row. The period comes from the settings cartlify.stats_from and
-- cartlify.stats_to, which the server sets for its transaction; without them it is the last
-- 7 days up to now. A period includes its start and excludes its end.
-- The view is security_invoker: it reads with the rights and the row level security of the
-- caller, so the server sets the context of the admin before it reads the view.
-- The view is dropped and created again on every run, so the owner and the grant are set again
-- at the end.
DROP VIEW IF EXISTS cartlify.admin_stats_view;

CREATE VIEW cartlify.admin_stats_view
WITH
    (security_invoker = true) AS
WITH
    -- The period as instants: from_at and to_at are shown in the answer.
    period_bounds AS (
        SELECT
            COALESCE(
                NULLIF(current_setting('cartlify.stats_from', true), '')::timestamptz,
                now() - INTERVAL '7 days'
            ) AS from_at,
            COALESCE(
                NULLIF(current_setting('cartlify.stats_to', true), '')::timestamptz,
                now()
            ) AS to_at
    ),
    -- The same bounds as utc times without a zone (from_ts, to_ts), and the starts of the last 7
    -- and 30 days. The columns keep utc without a zone, so they are compared with these values,
    -- whatever the time zone of the session.
    params AS (
        SELECT
            pr.from_at,
            pr.to_at,
            pr.from_at AT TIME ZONE 'UTC' AS from_ts,
            pr.to_at AT TIME ZONE 'UTC' AS to_ts,
            (now() - INTERVAL '7 days') AT TIME ZONE 'UTC' AS last_7d_from,
            (now() - INTERVAL '30 days') AT TIME ZONE 'UTC' AS last_30d_from
        FROM
            period_bounds pr
    ),
    -- Buyers: the total, the new accounts in the period and in the last 7 and 30 days, and the
    -- accounts with a verified email (how many, and their share in percent; 0 without buyers).
    users_stats AS (
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (
                WHERE
                    u."createdAt" >= p.from_ts
                    AND u."createdAt" < p.to_ts
            )::int AS new_in_period,
            COUNT(*) FILTER (
                WHERE
                    u."createdAt" >= p.last_7d_from
            )::int AS new_7d,
            COUNT(*) FILTER (
                WHERE
                    u."createdAt" >= p.last_30d_from
            )::int AS new_30d,
            COUNT(*) FILTER (
                WHERE
                    u."isVerified" IS TRUE
            )::int AS verified_total,
            COALESCE(
                ROUND(
                    COUNT(*) FILTER (
                        WHERE
                            u."isVerified" IS TRUE
                    )::numeric * 100 / NULLIF(COUNT(*), 0),
                    2
                ),
                0
            )::numeric AS verified_rate
        FROM
            cartlify.users u
            CROSS JOIN params p
        -- Admin and root accounts are not counted, deleted accounts are.
        WHERE
            u.role NOT IN ('ADMIN'::cartlify."Role", 'ROOT'::cartlify."Role")
    ),
    -- Orders. The counts are for all time: every order (carts too), the confirmed ones and each
    -- status. The money is of the orders that were paid (paid, shipped, delivered), counted by
    -- the time of the payment (paidAt): for all time, in the period, in the last 7 and 30 days.
    -- revenue_* sums orders.total, which holds the price of the delivery; delivery_revenue_* is
    -- the part of it that buyers paid for delivery. An order has one delivery row at most, so the
    -- join does not repeat an order.
    orders_stats AS (
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (
                WHERE
                    o.confirmed IS TRUE
            )::int AS confirmed_total,
            COUNT(*) FILTER (
                WHERE
                    o.status = 'pending'::cartlify."OrderStatus"
                    AND o.confirmed IS FALSE
            )::int AS pending_carts_total,
            COUNT(*) FILTER (
                WHERE
                    o.status = 'pending'::cartlify."OrderStatus"
            )::int AS pending_count,
            COUNT(*) FILTER (
                WHERE
                    o.status = 'unconfirmed'::cartlify."OrderStatus"
            )::int AS unconfirmed_count,
            COUNT(*) FILTER (
                WHERE
                    o.status = 'waiting'::cartlify."OrderStatus"
            )::int AS waiting_count,
            COUNT(*) FILTER (
                WHERE
                    o.status = 'paid'::cartlify."OrderStatus"
            )::int AS paid_count,
            COUNT(*) FILTER (
                WHERE
                    o.status = 'shipped'::cartlify."OrderStatus"
            )::int AS shipped_count,
            COUNT(*) FILTER (
                WHERE
                    o.status = 'delivered'::cartlify."OrderStatus"
            )::int AS delivered_count,
            COUNT(*) FILTER (
                WHERE
                    o.status = 'cancelled'::cartlify."OrderStatus"
            )::int AS cancelled_count,
            COALESCE(
                SUM(o.total) FILTER (
                    WHERE
                        o.confirmed IS TRUE
                        AND o.status IN (
                            'paid'::cartlify."OrderStatus",
                            'shipped'::cartlify."OrderStatus",
                            'delivered'::cartlify."OrderStatus"
                        )
                ),
                0
            )::numeric AS revenue_total,
            COALESCE(
                SUM(o.total) FILTER (
                    WHERE
                        o.confirmed IS TRUE
                        AND o.status IN (
                            'paid'::cartlify."OrderStatus",
                            'shipped'::cartlify."OrderStatus",
                            'delivered'::cartlify."OrderStatus"
                        )
                        AND o."paidAt" >= p.from_ts
                        AND o."paidAt" < p.to_ts
                ),
                0
            )::numeric AS revenue_in_period,
            COALESCE(
                SUM(o.total) FILTER (
                    WHERE
                        o.confirmed IS TRUE
                        AND o.status IN (
                            'paid'::cartlify."OrderStatus",
                            'shipped'::cartlify."OrderStatus",
                            'delivered'::cartlify."OrderStatus"
                        )
                        AND o."paidAt" >= p.last_7d_from
                ),
                0
            )::numeric AS revenue_last_7d,
            COALESCE(
                SUM(o.total) FILTER (
                    WHERE
                        o.confirmed IS TRUE
                        AND o.status IN (
                            'paid'::cartlify."OrderStatus",
                            'shipped'::cartlify."OrderStatus",
                            'delivered'::cartlify."OrderStatus"
                        )
                        AND o."paidAt" >= p.last_30d_from
                ),
                0
            )::numeric AS revenue_last_30d,
            -- delivery_revenue_*: what buyers paid for delivery in the same orders, same times
            COALESCE(
                SUM(d.price) FILTER (
                    WHERE
                        o.confirmed IS TRUE
                        AND o.status IN (
                            'paid'::cartlify."OrderStatus",
                            'shipped'::cartlify."OrderStatus",
                            'delivered'::cartlify."OrderStatus"
                        )
                ),
                0
            )::numeric AS delivery_revenue_total,
            COALESCE(
                SUM(d.price) FILTER (
                    WHERE
                        o.confirmed IS TRUE
                        AND o.status IN (
                            'paid'::cartlify."OrderStatus",
                            'shipped'::cartlify."OrderStatus",
                            'delivered'::cartlify."OrderStatus"
                        )
                        AND o."paidAt" >= p.from_ts
                        AND o."paidAt" < p.to_ts
                ),
                0
            )::numeric AS delivery_revenue_in_period,
            COALESCE(
                SUM(d.price) FILTER (
                    WHERE
                        o.confirmed IS TRUE
                        AND o.status IN (
                            'paid'::cartlify."OrderStatus",
                            'shipped'::cartlify."OrderStatus",
                            'delivered'::cartlify."OrderStatus"
                        )
                        AND o."paidAt" >= p.last_7d_from
                ),
                0
            )::numeric AS delivery_revenue_last_7d,
            COALESCE(
                SUM(d.price) FILTER (
                    WHERE
                        o.confirmed IS TRUE
                        AND o.status IN (
                            'paid'::cartlify."OrderStatus",
                            'shipped'::cartlify."OrderStatus",
                            'delivered'::cartlify."OrderStatus"
                        )
                        AND o."paidAt" >= p.last_30d_from
                ),
                0
            )::numeric AS delivery_revenue_last_30d,
            -- The revenue of the period divided by the number of orders paid in it, 2 decimals,
            -- 0 when there are none.
            COALESCE(
                ROUND(
                    SUM(o.total) FILTER (
                        WHERE
                            o.confirmed IS TRUE
                            AND o.status IN (
                                'paid'::cartlify."OrderStatus",
                                'shipped'::cartlify."OrderStatus",
                                'delivered'::cartlify."OrderStatus"
                            )
                            AND o."paidAt" >= p.from_ts
                            AND o."paidAt" < p.to_ts
                    ) / NULLIF(
                        COUNT(*) FILTER (
                            WHERE
                                o.confirmed IS TRUE
                                AND o.status IN (
                                    'paid'::cartlify."OrderStatus",
                                    'shipped'::cartlify."OrderStatus",
                                    'delivered'::cartlify."OrderStatus"
                                )
                                AND o."paidAt" >= p.from_ts
                                AND o."paidAt" < p.to_ts
                        ),
                        0
                    ),
                    2
                ),
                0
            )::numeric AS average_order_value
        FROM
            cartlify.orders o
            LEFT JOIN cartlify.order_deliveries d ON d."orderId" = o.id
            CROSS JOIN params p
    ),
    -- Units sold: the quantity of the items of the orders paid in the period.
    items_sold_stats AS (
        SELECT
            COALESCE(SUM(oi.quantity), 0)::int AS items_sold
        FROM
            cartlify.order_items oi
            JOIN cartlify.orders o ON o.id = oi."orderId"
            CROSS JOIN params prm
        WHERE
            o.confirmed IS TRUE
            AND o.status IN (
                'paid'::cartlify."OrderStatus",
                'shipped'::cartlify."OrderStatus",
                'delivered'::cartlify."OrderStatus"
            )
            AND o."paidAt" >= prm.from_ts
            AND o."paidAt" < prm.to_ts
    ),
    -- Products: all, in the catalog (not deleted), deleted, and catalog products with no free
    -- unit in any live variant.
    products_stats AS (
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (
                WHERE
                    p."deletedAt" IS NULL
            )::int AS active_total,
            COUNT(*) FILTER (
                WHERE
                    p."deletedAt" IS NOT NULL
            )::int AS deleted_total,
            COUNT(*) FILTER (
                WHERE
                    p."deletedAt" IS NULL
                    -- no live variant has a free unit: free units are the stock minus reserved
                    -- minus the units of batches that are over (those are not for sale)
                    AND NOT EXISTS (
                        SELECT
                            1
                        FROM
                            cartlify.product_variants v
                        WHERE
                            v."productId" = p.id
                            AND v."deletedAt" IS NULL
                            AND (v.stock - v."reservedStock" - cartlify.variant_expired_units(v.id)) > 0
                    )
            )::int AS out_of_stock_total
        FROM
            cartlify.products p
    ),
    -- The 5 products with the highest revenue from their items in the period (a tie goes to
    -- more units sold, then to the lower id); the items of all the variants of a product count
    -- for it. Delivery is not part of it; deleted products are counted.
    top_products AS (
        SELECT
            p.id,
            p.name,
            COALESCE(SUM(oi."totalPrice"), 0)::numeric AS revenue,
            COALESCE(SUM(oi.quantity), 0)::int AS quantity_sold
        FROM
            cartlify.order_items oi
            JOIN cartlify.orders o ON o.id = oi."orderId"
            JOIN cartlify.products p ON p.id = oi."productId"
            CROSS JOIN params prm
        WHERE
            o.confirmed IS TRUE
            AND o.status IN (
                'paid'::cartlify."OrderStatus",
                'shipped'::cartlify."OrderStatus",
                'delivered'::cartlify."OrderStatus"
            )
            AND o."paidAt" >= prm.from_ts
            AND o."paidAt" < prm.to_ts
        GROUP BY
            p.id,
            p.name
        ORDER BY
            revenue DESC,
            quantity_sold DESC,
            p.id ASC
        LIMIT
            5
    ),
    -- The top as a JSON list in the same order, [] when there are no sales.
    top_products_json AS (
        SELECT
            COALESCE(
                jsonb_agg(
                    jsonb_build_object(
                        'id',
                        tp.id,
                        'name',
                        tp.name,
                        'revenue',
                        tp.revenue,
                        'quantitySold',
                        tp.quantity_sold
                    )
                    ORDER BY
                        tp.revenue DESC,
                        tp.quantity_sold DESC,
                        tp.id ASC
                ),
                '[]'::jsonb
            ) AS items
        FROM
            top_products tp
    ),
    -- The same by variant: the 5 variants with the highest revenue (a tie goes to more units sold,
    -- then to the lower id). A product sold in two variants is one row of the top of products and
    -- two rows here. The name is the name of the variant now, taken for the five that are left.
    top_variants AS (
        SELECT
            v.id,
            v."productId",
            p.name AS product_name,
            p."deletedAt" IS NOT NULL AS product_deleted,
            v."position",
            v.sku,
            v."deletedAt" IS NOT NULL AS variant_deleted,
            COALESCE(SUM(oi."totalPrice"), 0)::numeric AS revenue,
            COALESCE(SUM(oi.quantity), 0)::int AS quantity_sold
        FROM
            cartlify.order_items oi
            JOIN cartlify.orders o ON o.id = oi."orderId"
            JOIN cartlify.product_variants v ON v.id = oi."variantId"
            JOIN cartlify.products p ON p.id = v."productId"
            CROSS JOIN params prm
        WHERE
            o.confirmed IS TRUE
            AND o.status IN (
                'paid'::cartlify."OrderStatus",
                'shipped'::cartlify."OrderStatus",
                'delivered'::cartlify."OrderStatus"
            )
            AND o."paidAt" >= prm.from_ts
            AND o."paidAt" < prm.to_ts
        GROUP BY
            v.id,
            v."productId",
            p.name,
            p."deletedAt",
            v."position",
            v.sku,
            v."deletedAt"
        ORDER BY
            revenue DESC,
            quantity_sold DESC,
            v.id ASC
        LIMIT
            5
    ),
    -- The top of variants as a JSON list in the same order, [] when there are no sales.
    top_variants_json AS (
        SELECT
            COALESCE(
                jsonb_agg(
                    jsonb_build_object(
                        'product',
                        jsonb_build_object(
                            'id',
                            tv."productId",
                            'name',
                            tv.product_name,
                            'deleted',
                            tv.product_deleted
                        ),
                        'variant',
                        jsonb_build_object(
                            'id',
                            tv.id,
                            'position',
                            tv."position",
                            'name',
                            cartlify.variant_display_name(tv.id),
                            'sku',
                            tv.sku,
                            'deleted',
                            tv.variant_deleted
                        ),
                        'revenue',
                        tv.revenue,
                        'quantitySold',
                        tv.quantity_sold
                    )
                    ORDER BY
                        tv.revenue DESC,
                        tv.quantity_sold DESC,
                        tv.id ASC
                ),
                '[]'::jsonb
            ) AS items
        FROM
            top_variants tv
    ),
    -- The same for categories: a sale counts for the category its product has now, and only for
    -- that category, not for its parents.
    top_categories AS (
        SELECT
            c.id,
            c.name,
            COALESCE(SUM(oi."totalPrice"), 0)::numeric AS revenue,
            COALESCE(SUM(oi.quantity), 0)::int AS quantity_sold
        FROM
            cartlify.order_items oi
            JOIN cartlify.orders o ON o.id = oi."orderId"
            JOIN cartlify.products p ON p.id = oi."productId"
            JOIN cartlify.categories c ON c.id = p."categoryId"
            CROSS JOIN params prm
        WHERE
            o.confirmed IS TRUE
            AND o.status IN (
                'paid'::cartlify."OrderStatus",
                'shipped'::cartlify."OrderStatus",
                'delivered'::cartlify."OrderStatus"
            )
            AND o."paidAt" >= prm.from_ts
            AND o."paidAt" < prm.to_ts
        GROUP BY
            c.id,
            c.name
        ORDER BY
            revenue DESC,
            quantity_sold DESC,
            c.id ASC
        LIMIT
            5
    ),
    -- The top as a JSON list in the same order, [] when there are no sales.
    top_categories_json AS (
        SELECT
            COALESCE(
                jsonb_agg(
                    jsonb_build_object(
                        'id',
                        tc.id,
                        'name',
                        tc.name,
                        'revenue',
                        tc.revenue,
                        'quantitySold',
                        tc.quantity_sold
                    )
                    ORDER BY
                        tc.revenue DESC,
                        tc.quantity_sold DESC,
                        tc.id ASC
                ),
                '[]'::jsonb
            ) AS items
        FROM
            top_categories tc
    ),
    -- Reviews: the total, the rated ones and the negative ones (rating 2 or less) are for all
    -- time. The new ones and the average rating cover the reviews written in the period (the
    -- average is of the rated ones, 0 when there are none).
    reviews_stats AS (
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (
                WHERE
                    r.rating IS NOT NULL
            )::int AS rated_total,
            COUNT(*) FILTER (
                WHERE
                    r."createdAt" >= p.from_ts
                    AND r."createdAt" < p.to_ts
            )::int AS new_in_period,
            COALESCE(
                ROUND(
                    AVG(r.rating) FILTER (
                        WHERE
                            r.rating IS NOT NULL
                            AND r."createdAt" >= p.from_ts
                            AND r."createdAt" < p.to_ts
                    ),
                    2
                ),
                0
            )::numeric AS avg_rating,
            COUNT(*) FILTER (
                WHERE
                    r.rating IS NOT NULL
                    AND r.rating <= 2
            )::int AS negative_count
        FROM
            cartlify.reviews r
            CROSS JOIN params p
    )
-- The columns of the answer: period, users, orders, products and reviews are JSON objects whose
-- keys the server reads (admin.services.ts); createdAt is the time of the read. Each CTE joined
-- here gives one row, so the view gives one row.
SELECT
    jsonb_build_object('from', prm.from_at, 'to', prm.to_at) AS period,
    jsonb_build_object(
        'total',
        us.total,
        'newInPeriod',
        us.new_in_period,
        'new7d',
        us.new_7d,
        'new30d',
        us.new_30d,
        'verifiedTotal',
        us.verified_total,
        'verifiedRate',
        us.verified_rate
    ) AS users,
    jsonb_build_object(
        'total',
        os.total,
        'confirmedTotal',
        os.confirmed_total,
        'pendingCartsTotal',
        os.pending_carts_total,
        'byStatus',
        jsonb_build_object(
            'pending',
            os.pending_count,
            'unconfirmed',
            os.unconfirmed_count,
            'waiting',
            os.waiting_count,
            'paid',
            os.paid_count,
            'shipped',
            os.shipped_count,
            'delivered',
            os.delivered_count,
            'cancelled',
            os.cancelled_count
        ),
        'revenue',
        jsonb_build_object(
            'total',
            os.revenue_total,
            'inPeriod',
            os.revenue_in_period,
            'last7d',
            os.revenue_last_7d,
            'last30d',
            os.revenue_last_30d
        ),
        'deliveryRevenue',
        jsonb_build_object(
            'total',
            os.delivery_revenue_total,
            'inPeriod',
            os.delivery_revenue_in_period,
            'last7d',
            os.delivery_revenue_last_7d,
            'last30d',
            os.delivery_revenue_last_30d
        ),
        'averageOrderValue',
        os.average_order_value,
        'itemsSold',
        iss.items_sold
    ) AS orders,
    jsonb_build_object(
        'total',
        ps.total,
        'activeTotal',
        ps.active_total,
        'deletedTotal',
        ps.deleted_total,
        'outOfStockTotal',
        ps.out_of_stock_total,
        'topProductsByRevenue',
        tpj.items,
        'topVariantsByRevenue',
        tvj.items,
        'topCategoriesByRevenue',
        tcj.items
    ) AS products,
    jsonb_build_object(
        'total',
        rs.total,
        'ratedTotal',
        rs.rated_total,
        'newInPeriod',
        rs.new_in_period,
        'avgRating',
        rs.avg_rating,
        'negativeCount',
        rs.negative_count
    ) AS reviews,
    now() AS "createdAt"
FROM
    params prm
    CROSS JOIN users_stats us
    CROSS JOIN orders_stats os
    CROSS JOIN items_sold_stats iss
    CROSS JOIN products_stats ps
    CROSS JOIN top_products_json tpj
    CROSS JOIN top_variants_json tvj
    CROSS JOIN top_categories_json tcj
    CROSS JOIN reviews_stats rs;

ALTER VIEW cartlify.admin_stats_view OWNER TO cartlify_owner;

-- The app reads the view (with the context of an admin, see security_invoker above).
GRANT
SELECT
    ON cartlify.admin_stats_view TO cartlify_app;

------------------------------------------------------------
-- REQUIRED CHARACTERISTICS: which variants lack a value a category requires
------------------------------------------------------------
-- The rule lives only here. The admin list (GET /api/products?missingRequired=true) and the alert
-- variants_missing_required read variants_missing_required, so they count the same variants.
-- Both views are security_invoker: they read with the rights and the row level security of the
-- caller (an admin, the server sets the context first). They are dropped and created again on
-- every run, so the owner and the grants are set again at the end.
DROP VIEW IF EXISTS cartlify.variants_missing_required;

DROP VIEW IF EXISTS cartlify.category_required_attributes;

-- The characteristics a category requires: its own set and the sets of its parents up the tree
-- (the same walk as readCategorySetRows in the app, at most 50 levels). For one characteristic the
-- nearest category wins, so a child that does not require what its parent requires does not need
-- it, and neither do the categories below the child that say nothing about it.
CREATE VIEW cartlify.category_required_attributes
WITH
    (security_invoker = true) AS
WITH RECURSIVE
    up (category_id, ancestor_id, depth) AS (
        SELECT
            c.id,
            c.id,
            0
        FROM
            cartlify.categories c
        UNION ALL
        SELECT
            up.category_id,
            a."parentId",
            up.depth + 1
        FROM
            up
            JOIN cartlify.categories a ON a.id = up.ancestor_id
        WHERE
            a."parentId" IS NOT NULL
            AND up.depth < 50
    ),
    nearest AS (
        SELECT DISTINCT
            ON (up.category_id, ca."attributeId") up.category_id,
            ca."attributeId" AS attribute_id,
            ca.required
        FROM
            up
            JOIN cartlify.category_attributes ca ON ca."categoryId" = up.ancestor_id
        ORDER BY
            up.category_id,
            ca."attributeId",
            up.depth
    )
SELECT
    n.category_id,
    n.attribute_id
FROM
    nearest n
WHERE
    n.required;

-- A row for every live variant and every characteristic its category requires that it has no
-- value of. A variant taken out of sale is none of them (the variants of a product removed from the
-- catalog are taken out of sale with it).
CREATE VIEW cartlify.variants_missing_required
WITH
    (security_invoker = true) AS
SELECT
    v.id AS variant_id,
    v."productId" AS product_id,
    r.attribute_id
FROM
    cartlify.product_variants v
    JOIN cartlify.products p ON p.id = v."productId"
    JOIN cartlify.category_required_attributes r ON r.category_id = p."categoryId"
WHERE
    v."deletedAt" IS NULL
    AND NOT EXISTS (
        SELECT
            1
        FROM
            cartlify.variant_attribute_values vv
        WHERE
            vv."variantId" = v.id
            AND vv."attributeId" = r.attribute_id
    );

ALTER VIEW cartlify.category_required_attributes OWNER TO cartlify_owner;

ALTER VIEW cartlify.variants_missing_required OWNER TO cartlify_owner;

-- The app reads the views with the context of an admin (see security_invoker above).
GRANT
SELECT
    ON cartlify.category_required_attributes TO cartlify_app;

GRANT
SELECT
    ON cartlify.variants_missing_required TO cartlify_app;

COMMIT;