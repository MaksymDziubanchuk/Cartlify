BEGIN;

------------------------------------------------------------
-- admin stats view
------------------------------------------------------------
DROP VIEW IF EXISTS cartlify.admin_stats_view;

CREATE VIEW cartlify.admin_stats_view
WITH
    (security_invoker = true) AS
WITH
    params AS (
        SELECT
            COALESCE(
                NULLIF(current_setting('cartlify.stats_from', true), '')::timestamptz,
                now() - INTERVAL '7 days'
            ) AS from_ts,
            COALESCE(
                NULLIF(current_setting('cartlify.stats_to', true), '')::timestamptz,
                now()
            ) AS to_ts,
            now() - INTERVAL '7 days' AS last_7d_from,
            now() - INTERVAL '30 days' AS last_30d_from
    ),
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
    ),
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
                        AND o."createdAt" >= p.from_ts
                        AND o."createdAt" < p.to_ts
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
                        AND o."createdAt" >= p.last_7d_from
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
                        AND o."createdAt" >= p.last_30d_from
                ),
                0
            )::numeric AS revenue_last_30d,
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
                    ) / NULLIF(
                        COUNT(*) FILTER (
                            WHERE
                                o.confirmed IS TRUE
                                AND o.status IN (
                                    'paid'::cartlify."OrderStatus",
                                    'shipped'::cartlify."OrderStatus",
                                    'delivered'::cartlify."OrderStatus"
                                )
                        ),
                        0
                    ),
                    2
                ),
                0
            )::numeric AS average_order_value
        FROM
            cartlify.orders o
            CROSS JOIN params p
    ),
    items_sold_stats AS (
        SELECT
            COALESCE(SUM(oi.quantity), 0)::int AS items_sold
        FROM
            cartlify.order_items oi
            JOIN cartlify.orders o ON o.id = oi."orderId"
        WHERE
            o.confirmed IS TRUE
            AND o.status IN (
                'paid'::cartlify."OrderStatus",
                'shipped'::cartlify."OrderStatus",
                'delivered'::cartlify."OrderStatus"
            )
    ),
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
                    AND (p.stock - p."reservedStock") <= 0
            )::int AS out_of_stock_total
        FROM
            cartlify.products p
    ),
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
            AND o."createdAt" >= prm.from_ts
            AND o."createdAt" < prm.to_ts
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
            AND o."createdAt" >= prm.from_ts
            AND o."createdAt" < prm.to_ts
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
SELECT
    jsonb_build_object('from', prm.from_ts, 'to', prm.to_ts) AS period,
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
    CROSS JOIN top_categories_json tcj
    CROSS JOIN reviews_stats rs;

ALTER VIEW cartlify.admin_stats_view OWNER TO cartlify_owner;

GRANT
SELECT
    ON cartlify.admin_stats_view TO cartlify_app;

COMMIT;