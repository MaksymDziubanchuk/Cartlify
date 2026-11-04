# API

## API Surface

Current REST modules exposed by the application:

- `GET /health`
- `GET /ready`
- `GET /info`
- `GET /documentation`
- `GET /documentation/json`
- `api/auth/*`
- `api/users/*`
- `api/products/*`
- `api/categories/*`
- `api/favorites/*`
- `api/orders/*`
- `api/delivery/*`
- `api/reviews/*`
- `api/admin/*` (the directory of manufacturers and persons responsible in the EU is `api/admin/parties`, the directory of documents is `api/admin/documents`, the directory of characteristics is `api/admin/attribute-groups`, `api/admin/attributes` and `api/admin/attributes/:attributeId/options`; the journals are `api/admin/audit-log`, `api/admin/stock-log`, `api/admin/price-log`, `api/admin/login-log` and `api/admin/consent-log`, their events `api/admin/log-events`)
- `api/root/*`
- `api/chat/*`
- `api/legal/*`

Examples of implemented business endpoints:

- auth: register, login, refresh, logout, verify, password reset, OAuth callbacks, CSRF token
- users: admin list of users, get/update current user (an empty avatar removes it), get user by id, moderator removal of an avatar, root delete user
- products: list, the card with its variants (`{ product, variant, variants }`), reviews (the check of a comment, the removals of a moderator), create with its variants and its gallery, update, delete and restore, the variants of a product (read one, add, change, take out of sale, put back), the gallery (add pictures, take one out), the price and the sale of the variants (one, several of a product, many of any products, by a filter), the price history, a change of many products
- categories: list, create, update, delete
- documents (admin): upload a PDF, list, get, change the title and kind, delete the instructions and certificates that products name
- parties (admin): list, get, create, update, delete the manufacturers and the persons responsible in the EU that products name
- characteristics (admin): the groups of the card, the characteristics of a variant (text, number, yes/no, one value or several of a list) and the values of a list, each created, listed, changed, deleted and put in an order of its own, a value of a list put in the place of another in every variant that has it (`POST /api/admin/attributes/:attributeId/options/:optionId/replace`, `{ withOptionId }`); `GET` and `PUT /api/categories/:categoryId/attributes` read and write the characteristics a category asks for
- favorites: the list (`{ product, variant, addedAt }` rows), add and remove a variant (`POST|DELETE /api/favorites/:variantId`)
- orders: current cart, item mutations (also of an unconfirmed order), confirm, cancel of a payment, history, details, admin status update (the cancel of an order is a statement of return, see returns)
- reviews: vote on review
- admin: stats (the top of products and the top of variants), the accounting reports (by product, by variant, by category, by time), product popularity, admin chat queues, alerts
- root: manage admins, publish the terms, the contract and the privacy policy
- legal: the versions in force, a version by id, the consents of the user

## Products and variants

A product holds what its variants share; a variant is what a buyer chooses and buys (a size, a colour, a memory) and holds the price, the sale, the stock, the article number, the barcode, the weight and the sizes and the pictures it shows. Every answer that names a variant names it with its product. The model, the rules (pictures and who sees what, characteristics, the name and the duplicate rule, prices and sales, stock, lists and the filter) and the error codes by area are explained in [Products, variants and characteristics](variants.md); this section lists the routes.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/products` | everybody | the catalog list `{ items, limit, total, nextCursor? }`, a row is `{ product, variant, minPrice?, maxPrice?, stock }`. A query that asks nothing of a variant (a category, a search, `sort` by `popularity`, `createdAt`, `name`, `avgRating`, `sales`, `relevance`, `inStock`) lists PRODUCTS: one row per product, with its main variant (the first by its place with free units, else the first; a search by an article number shows the variant that has it), `minPrice` and `maxPrice` (the lowest and the highest price its variants sell at now, a sale counted) and `stock` (the free units of its variants). A query that asks something of a variant (`sort` by `price`, `discount`, `saleEndsAt`, `minPrice`, `maxPrice`, the filter `f` by characteristics, for an admin also `salePrice`, the sorts of the stock, `onSale`, `maxStock`, `withoutShippingData`) lists GROUPS of variants: the variants that fit the query, of ONE product, with the same value of every MAIN characteristic (a colour) are one row; a variant without a value of a main characteristic is a value of its own, a product with no main characteristic is one group. A group has its first variant by its place as `variant` (its picture, the card it opens), `minPrice` and `maxPrice` of its variants (equal for one price) and `stock` (their free units). A T-shirt with a main colour and a size that is not main has a row for each colour; a phone with a main memory and colour has a row for each pair. If variants must look different in a list, the characteristic that tells them apart must be main. A price sort puts a group where its lowest price stands going up and where its highest stands going down, and the price filter keeps only the variants that fit in the group. An admin sends `group=false` to get every variant on a row of its own (its `stock`, no range of prices); `group=false` of a buyer is `403 FILTER_FORBIDDEN`. The filter `f` is `<attributeId>:<value>`, one entry for a characteristic, repeated: `f=12:45,46&f=15:128..512&f=20:yes` (ids of the values of a list separated by commas, any of them fits; a number as a range with both ends included, `128..` from, `..512` up to, decimals `6.1..6.7`; `yes` or `no`); the values of one characteristic are OR, different characteristics AND, a variant without a value of one fits none of its values, a text cannot be filtered; a wrong entry is `400 FILTER_INVALID` with `details.reason`, `entry`, `index`. `total` counts the rows (groups) the filters find; the cursor keeps the row it ends at (the id of the first variant of a group, of the variant or of the product breaks the ties) and a cursor of one kind of rows (products, groups, single variants) is `400 CURSOR_INVALID` for the other. A buyer gets the short variant and only the variants that are for sale and show a picture (a product with none is in no list); admin and root get the full variant (the stock, the reserve, the units that are over, the cost of the latest delivery) and the variants without a picture, and without a flag only the plain products (not deleted, with no sale on any variant and no popularity override that is on). The filters of an admin that find the gaps of the catalog are flags too (a sale or an override do not filter next to them; the removed products come only with `deleted=true`): by a variant, `missingRequired=true` (the variant has no value of a characteristic its category requires, the parents' sets counted), `withoutWeight=true`, `withoutDimensions=true` (any of the three sizes), `withoutBarcode=true`, `withoutImages=true`, which make the rows variants (groups unless `group=false`); by a product, `hiddenFromBuyers=true` (the product is removed, or none of its variants is alive with a picture) or `false` (the products a buyer sees), `hasDeletedVariants=true`, which leave the rows products; and `manufacturerId`, `euResponsibleId`, `documentId` (the party or the document of the directory; `404 MANUFACTURER_NOT_FOUND`, `EU_RESPONSIBLE_NOT_FOUND`, `DOCUMENT_NOT_FOUND` with the id in `details`). They come with the other filters, `f`, the search, the sorts and the cursor. A buyer who sends one gets `403 FILTER_FORBIDDEN` with `details.filter` (a flag sent as `false` is no filter) |
| `GET /api/products/filters?categoryId=&branch=` | everybody | the filter of a category: the characteristics its variants are told apart by, from the variants a buyer sees in the category and everything below it (`branch=false`: the category alone). A characteristic is in `items` when it is in the filters (`inFilters`), is no text and has at least two different values among them (a variant without a value is no value). A choice has `values: [{ id, name, colorCode, position }]` that are there, in the order of the admin; a number `min` and `max`; yes/no `values: ['yes', 'no']`. Every item has `id`, `name`, `unit`, `type` and `group: { id, name }`, in the order of the card; no counts; the ids go into `f` of the list. `404 CATEGORY_NOT_FOUND` |
| `GET /api/products/suggestions?q=` | everybody | up to 8 names of the products a buyer sees (or, for an admin, of every product that is not deleted), the best match first |
| `GET /api/categories/tree` | everybody | the tree of the categories with `productCount` of each branch: the products that are not deleted and have a variant a buyer sees |
| `GET /api/products/:productId[?variantId=]` | everybody | the card `{ product, variant, variants }`: the variant asked for, or the main one (the first by its place with free units, else the first); `variants` are all to switch between in the short form, each with its `name` and the `values` that tell it from the others (see below), and the variant opened has `attributes`, every characteristic it has in the order of the card. A buyer gets the variants for sale that show a picture, admin and root all of them (with `visible`, `deletedAt`) and the `gallery` of the product with the variants that show each picture |
| `GET /api/products/:productId/variants/:variantId` | everybody | one variant in full (with its `attributes`), without the product |
| `POST /api/products` | admin, root | a form: the fields of the product, the picture files `images` (the gallery) and `variants`, the text of a JSON list `[{ price, sku?, barcode?, weightGrams?, lengthMm?, widthMm?, heightMm?, withoutShippingData?, attributes?: [{ attributeId, value }], images: [{ file, position }] }]`; `file` is the number of an uploaded file, `position` a place from 1 among the pictures of the variant. `201` is the card of an admin |
| `PATCH /api/products/:productId` | admin, root | the fields of the product itself: name, description, category, manufacturer, person responsible in the EU, warnings, documents, popularity override. `200` is the card of an admin |
| `PATCH /api/products/:productId/category` | admin, root | moves the product to another category (`{ categoryId }`). `200` is the card of an admin |
| `POST /api/products/:productId/variants` | admin, root | `{ variants: [{ price, sku?, barcode?, weightGrams?, lengthMm?, widthMm?, heightMm?, withoutShippingData?, attributes?, images: [{ imageId, position }] }] }`, 1 to 100, all or nothing. `201 { variants }` |
| `PATCH /api/products/:productId/variants/:variantId` | admin, root | any of `price` (with `sale` when the variant is on sale: `keep`, `remove` or a new sale `{ percent \| amount, endsAt }`), `sku`, `barcode`, `weightGrams`, `lengthMm`, `widthMm`, `heightMm`, `withoutShippingData`, `position` (the others move around it), `images` (written whole), `attributes: [{ attributeId, value }]` (the values that change; `value: null` takes one away). `200 { product, variant }` |
| `PATCH /api/products/:productId/variants` | admin, root | the same change for several variants of a product: `{ variantIds?, price?, sale?, weightGrams?, lengthMm?, widthMm?, heightMm?, withoutShippingData?, images?, attributes? }`; without `variantIds` every variant for sale. `images` is one list of pictures of the gallery, written whole to each variant (an empty list takes them all away; `400 VARIANT_IMAGE_NOT_FOUND` for a picture that is not in the gallery of the product). `sku`, `barcode` and `position` are one variant's and are not read. All or nothing, a refusal names every variant refused (`VARIANTS_INVALID`, `details.variants`). `200 { variants }` in full |
| `PATCH /api/products/variants/batch` | admin, root | many variants of any products, each with fields of its own, any field of the one-variant form (`price`, `sale`, `sku`, `barcode`, the weight and the sizes, `position`, `images`, `attributes`): `{ items: [{ variantId, ... }] }`, 1 to 100, all or nothing, the same refusal. The codes are checked as a whole: a code any other live variant holds now (one of the batch too), or two items ask for, is `409 PRODUCT_SKU_TAKEN` / `VARIANT_BARCODE_TAKEN` with `details.variants: [{ variantId, sku \| barcode }]`, so codes cannot be swapped in one request. The places move in the order of the items. `200 { items: [{ product, variant }] }` in the order of the items |
| `PATCH /api/products/:productId/sale` | admin, root | `{ variantIds?, sale }`: puts the variants (the ones named, or every one for sale) on sale until `sale.endsAt` by a percent or an amount off, each from its own price; `sale: null` takes the sales off. `200 { variants: [{ id, productId, name, price, salePrice, saleEndsAt, salePriorPrice, status }] }` with `status` `set`, `unchanged` or `removed`; `409` only when nothing changed |
| `POST /api/products/sales` | admin, root | many sales at once, all or nothing: `{ items: [{ variantId \| productId, sale }] }` (a product is all its variants for sale), or `{ categoryId, branch?, sale }`. The answer is the one of the sale route |
| `PATCH /api/products` | admin, root | a change of the prices of the variants that fit `scope` (`categoryId`, `productIds`, `variantIds`, `minPrice`, `maxPrice` of the usual price, `f` the characteristics as the filter of the list reads them, `inStock`, `deleted`) by a `percent` or an amount (`fixed`), with the word `sale` (`keep` or `remove`) for the sales that are on; `dryRun` lists the variants with their old and new price |
| `PATCH /api/products/batch` | admin, root | many products, each with fields of its own: name, description, category, manufacturer, person responsible in the EU, warnings, documents, popularity override; 1 to 100, all or nothing. `200 { products }` the cards of an admin |
| `GET /api/products/:productId/price-history[?variantId=]` | admin, root | the changes of the price of the variants of the product, the newest first, each with its `variant` (`id`, `position`, `name`, `sku`); `variantId` keeps one variant |
| `DELETE /api/products/:productId/variants/:variantId` | admin, root | takes the variant out of sale. `200 { id, deletedAt }` |
| `POST /api/products/:productId/variants/:variantId/restore` | admin, root | puts it back. `200 { product, variant }`; `409 VARIANT_DUPLICATE` when a live variant has the same values |
| `POST /api/products/:productId/images` | admin, root | a form of files `images`: more pictures for the gallery. `201 { images }` (the whole gallery). A product that is not there (`404`) and a gallery that is full (`400 PRODUCT_IMAGES_TOO_MANY`, `details.max` and `details.have`) are refused before a file is read or uploaded, and the files after the one the gallery has no room for are not uploaded. The count and the places are taken under the lock of the product, so two uploads at once keep the limit and take places of their own |
| `DELETE /api/products/:productId/images/:imageId` | admin, root | takes a picture out of the gallery. `200 { id, variantsWithoutImages }` |
| `DELETE /api/products/:productId`, `POST /api/products/:productId/restore` | admin, root | takes a product out of the catalog with its variants for sale, and brings them back with it |
| `POST /api/products/stock/deliveries` | admin, root | takes in a delivery, a batch of each item, all or nothing: `{ source, supplier?, document?, note?, unitCost?, expiresAt?, items: [{ variantId \| sku \| barcode, quantity, unitCost?, expiresAt?, supplierBatchNumber? }] }`, 1 to 100 items. An item names its variant by its id, its article number (any case) or its barcode, exactly one of the three; the same variant may stand in several items (a batch each). The `unitCost` and the `expiresAt` of the delivery stand in for an item that has none of its own (an item with `expiresAt: null` has no end); an item with no cost in either place is `400 BATCH_UNIT_COST_REQUIRED` with `details.items` (every such item: its `index` and how it names its variant). `201 { deliveryId, batches, variants }`: `deliveryId` is the id every stock log line of the delivery carries, and the admin log keeps one line (`STOCK_DELIVERY`) with it; a batch for each item in the order of the items, with `productId`, `variantId`, `product` (`id`, `name`) and `variant` (`id`, `position`, `name`, `sku`), and the stock of each variant after it once, by id (`variantId`, `productId`, `stock` the free units, `totalStock`, `reservedStock`, `expiredStock`) |
| `POST /api/products/stock/write-offs` | admin, root | writes off free units, all or nothing: `{ reason, note?, items: [{ variantId \| sku \| barcode, quantity, batchId? }] }`; a batch named gives its units first, the rest follows the order of a sale. A variant taken out of sale keeps its units until they are written off: it is named by its id (an article number or a barcode names the live variants only). `201 { writeOffId, items, variants }`: `writeOffId` is the id every stock log line of the write-off carries, and the admin log keeps one line (`STOCK_WRITE_OFF`) with it; each item with its `product` and `variant` and the batches it took (`batchId`, `quantity`, `unitCost`), then the stock of each variant after it |

Errors of these routes (each is described in Swagger next to the route):

- `400` `BATCH_UNIT_COST_REQUIRED`, `BATCH_UNIT_COST_INVALID`, `BATCH_EXPIRES_AT_INVALID`, `WRITE_OFF_NOTE_REQUIRED`, `VARIANTS_REQUIRED`, `VARIANTS_INVALID` (`details.variants` names every wrong variant by its `index` with its own `errorCode`; in a change of many variants by its `variantId`, under the status of the first variant refused: 400, 404 or 409), `VARIANTS_REPEATED`, `SALE_VARIANTS_REPEATED`, `PRODUCT_PRICE_INVALID`, `PRODUCT_SALE_REQUIRES_PRICE`, `PRODUCT_SALE_AMOUNT_TOO_HIGH`, `PRODUCT_SALE_TOO_SMALL`, `PRODUCT_SALE_ENDS_AT_INVALID`, `VARIANT_IMAGE_REQUIRED`, `GALLERY_IMAGE_UNUSED` (`details.files`), `VARIANT_IMAGES_INVALID` (the pictures of a variant in the form are no list), `VARIANT_IMAGES_TOO_MANY`, `VARIANT_IMAGES_REPEATED`, `VARIANT_IMAGE_POSITION_INVALID`, `VARIANT_IMAGE_NOT_FOUND`, `VARIANT_POSITION_INVALID`, `VARIANT_BARCODE_INVALID`, `PRODUCT_VARIANTS_TOO_MANY`, `PRODUCT_IMAGES_TOO_MANY`, `PRODUCT_IMAGES_NOT_ALLOWED`, `PRODUCT_STOCK_NOT_ALLOWED`, `NO_FIELDS_TO_UPDATE`, `VARIANT_ATTRIBUTES_INVALID`, `VARIANT_ATTRIBUTES_REPEATED` (`details.attributeIds`), `ATTRIBUTE_VALUE_INVALID` (`details.type`), `ATTRIBUTE_VALUE_TOO_PRECISE`, `ATTRIBUTE_VALUE_TOO_SMALL`, `ATTRIBUTE_VALUE_TOO_LARGE` (`details.bound`, `details.value`), `ATTRIBUTE_OPTION_NOT_FOUND` (`details.optionIds`), `ATTRIBUTE_VALUES_REPEATED`, `ATTRIBUTE_VALUES_TOO_MANY`, `ATTRIBUTE_REQUIRED` (`details.attributes`, `details.variants`)
- `404` `PRODUCT_NOT_FOUND`, `ATTRIBUTE_NOT_FOUND` (`details.attributeIds`), `VARIANT_NOT_FOUND` (in a delivery or a write-off `details` lists every `variantIds`, `skus` and `barcodes` that the catalog has no live variant for, a write-off by an id finds a variant taken out of sale too), `BATCH_NOT_FOUND` (the batch is not a batch of the variant of the item), `PRODUCT_IMAGE_NOT_FOUND`
- `409` `INSUFFICIENT_AVAILABLE_STOCK` (a write-off: `details.variants` names every variant short of free units, the lines of a variant counted together), `BATCH_INSUFFICIENT`, `PRODUCT_SKU_TAKEN`, `VARIANT_BARCODE_TAKEN`, `VARIANT_DUPLICATE` (`details.variants`, each with the variants it repeats in `sameAs`), `PRODUCT_DELETED`, `VARIANT_ALREADY_DELETED`, `VARIANT_NOT_DELETED`, `PRODUCT_SALE_DECISION_REQUIRED`, `PRODUCT_SALE_NOT_BELOW_PRICE`, `PRODUCT_SALE_ALREADY_SET`, `PRODUCT_SALE_ALREADY_REMOVED`

The values of the characteristics. A variant has a value of a characteristic of the directory by `attributes: [{ attributeId, value }]` in the routes that make and change variants (`POST /api/products`, `POST .../variants`, `PATCH .../variants/:variantId`, `PATCH .../variants`, `PATCH /api/products/variants/batch`). `value` fits the type of the characteristic: a text (trimmed, up to 500 signs), a number (the digits after the point and the bounds of the characteristic), `true`/`false`, the id of a value of its list, or an array of such ids for a set (no value twice, `ATTRIBUTE_MULTI_VALUES_MAX` at most). In a change `null` takes a value away and a characteristic that is not named stays; in a new variant it is no value (a characteristic with no value is simply not there). A request over several variants lists every variant with the same error at once (`VARIANTS_INVALID`). The characteristics the category of the product asks as required (its own and the parents') need a value whenever a variant is made or its values change (`ATTRIBUTE_REQUIRED`); a requirement added later breaks no old variant, a product moved to another category is not checked again. Two live variants of a product must differ in the values of at least one characteristic (`409 VARIANT_DUPLICATE`, a variant with no values repeats another with none, so a product with several variants needs characteristics that tell them apart); it is checked on make, add, change, restore and the replace of a value, under the lock of the product, so two requests at once cannot both pass. The name of a variant (`name`) is the name of the product, a dash and the labels of the characteristics that differ between the variants a buyer sees (the main ones first, then by the group and the place in the directory): "Phone X — 256 GB, black"; the same list is `values` of the short variant, `[{ attributeId, name, value }]`. The database writes it (`cartlify.variant_names`): the card, the lists, the carts and the copy an order keeps at the confirmation always agree, and a rename of a value or a characteristic changes the names at once (a confirmed order keeps its copy). The type of a characteristic that a variant has a value of cannot change (`409 ATTRIBUTE_TYPE_LOCKED`), nor can the characteristic (`409 ATTRIBUTE_IN_USE`) or a value of its list (`409 ATTRIBUTE_OPTION_IN_USE`) be deleted: the value is replaced first (`POST /api/admin/attributes/:attributeId/options/:optionId/replace`), all or nothing.

Requests that meet over one product wait for each other: a request that writes the variants or the gallery of a product locks the row of the product first, then the rows of its variants (by id), then the pictures it names (by id), then the characteristics and the values of lists it names (by id), and reads what it decides on after the lock. So two deletes (or two restores) of one variant at once give one `200` and one `409` (`VARIANT_ALREADY_DELETED`, `VARIANT_NOT_DELETED`), variants added while the product is deleted never stay for sale under it (`409 PRODUCT_DELETED`), and a picture taken out of the gallery while a variant is given it is `400 VARIANT_IMAGE_NOT_FOUND` for that request, never a `500`. The pictures of a variant in `PATCH .../variants/:variantId` and `POST .../variants` must be a list: `null`, a text, a number or an object is a wrong shape (`400 VALIDATION_ERROR`, `details` names `images`), and only an empty list takes the pictures away.

## Orders and the cart

A position of the cart and of an order is a variant: the black and the white of one product are two positions, one more white adds units to the position it has. Every position is `{ id, product, variant, quantity, unitPrice, totalPrice }`: `product` is `{ id, name, categoryId }`, `variant` the short variant of the catalog (`id`, `position`, `name`, `price`, the sale while it lasts, the free `stock`, its own main picture `image`) with `forSale`.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/orders/current` | user | the cart at the prices of now; the positions of variants a buyer does not see (taken out of sale, their product removed, no picture) are dropped for good |
| `POST /api/orders/current/items` | user | `{ variantId, quantity }`: the same variant again adds units to its position. `404 VARIANT_NOT_FOUND` (a variant that is not there or a buyer does not see), `409 OUT_OF_STOCK` (`details: { variantId, available, requested }`: the free units of the variant) |
| `PATCH /api/orders/current/items/:itemId`, `DELETE /api/orders/current/items/:itemId` | user | the same for the position `itemId`; the same routes work on an unconfirmed order under `/api/orders/:orderId/items` (`POST` takes `variantId` too) |
| `POST /api/orders/current/confirm` | user | reserves the units of each variant. `409 ORDER_ITEMS_UNAVAILABLE` (`details.items: [{ itemId, variantId, reason: deleted | out_of_stock, available, requested }]`: `deleted` is a variant not for sale any more), `409 ORDER_PRICES_CHANGED` (`details.items: [{ itemId, variantId, unitPrice, price }]`, `price` is the one now) |
| `GET /api/orders`, `GET /api/orders/:orderId` | user, admin, root | the history and one order; a confirmed order keeps the name and the price of the confirmation and keeps the position of a variant taken out of sale with `variant.forSale: false`; the filters `productId` (any variant of the product) and `variantId`; admin and root get `weight` (the weights of the variants times the units; `complete` is false when a variant has none) |
| `POST /api/payments/checkout/sessions` | user | the payment page of an order waiting for its payment: a line for each variant, named as the confirmation named it. `409 ORDER_ITEMS_UNAVAILABLE` for a variant taken out of sale since |

## API Documentation

Cartlify exposes Swagger/OpenAPI documentation for the REST API.

Local Swagger UI:

```bash
http://localhost:3000/documentation
```

Local OpenAPI JSON:

```bash
http://localhost:3000/documentation/json
```

Deployed Swagger UI:

```bash
https://cartlify.up.railway.app/documentation
```

Deployed OpenAPI JSON:

```bash
https://cartlify.up.railway.app/documentation/json
```

The current documentation includes:

- OpenAPI 3.0.3 specification
- grouped REST modules through Swagger tags
- reusable schemas for system and DTO responses
- cookie-based auth schemes for access token, refresh token, and guest id, and the `x-csrf-token` header scheme on every route that changes data
- health, readiness, and project information endpoints
- separate readiness responses for healthy and unavailable states
- for every route: a summary, a tag, a unique operation id, a description of what it does, a description of every parameter and of every status it answers; each error is described as "`CODE`: why" next to its status, and the refusals every route shares (`VALIDATION_ERROR`, `INSUFFICIENT_ROLE`, `CSRF_TOKEN_INVALID`, `RATE_LIMITED`, `RESOURCE_BUSY`...) are added to the routes by the OpenAPI plugin
- request and response examples

The document is held to the code by tests. In the integration tests every answer of the app is checked against it: a status, an error code or a field it does not describe fails the test (`tests/helpers/contract.ts`). `tests/integration/api/system/openapiComplete.test.ts` reads the whole document: every operation has a summary, a tag, a description and an operation id, every parameter and every answer has a description, every code the document names is a word of the source (or a setting of `.env.example`), every example passes the schema it sits next to, and the list of the kinds of alerts is the one the app has.

## Realtime Chat / AI Bot

Cartlify includes a WebSocket-based chat flow for guest, user, bot, and admin support scenarios.

Main chat flow:

1. A guest or authenticated user opens the current chat thread through the REST endpoint.
2. The client connects to the WebSocket endpoint.
3. The client joins a thread with a `thread:join` event.
4. Messages are sent with `message:send`.
5. New messages are broadcast as `message:new` events.
6. Read state is handled through `thread:read`.

Implemented chat behavior:

- guest bot chat
- authenticated user bot chat
- bot welcome message for new threads
- product-aware OpenAI chatbot responses
- automatic response language matching based on the latest customer message
- only customers with a confirmed email talk to an admin
- admin escalation: the bot asks to describe the issue, the description enters the admin queue
- admin queue model using `adminRequestedAt` and `adminUnreadSince`
- guest-to-user chat migration during authentication
- the bot knows the orders of a signed-in customer, with their statements of withdrawal and return: whether the customer may still withdraw, until when, for which units, and where the money is; it never files or promises a return (the customer uses the button "Withdraw from the contract here" in the order) and leaves an order whose transfer of money failed or was disputed to an admin
- the button "call an admin": when the bot cannot answer a user with a confirmed email (the model gives no answer, the limit of the shop or the limit of the customer is used up), `GET /api/chat/thread/current` has `adminCallAvailable: true` and the socket sends `thread:admin-call` (`{ threadId, available }`); `POST /api/chat/threads/{threadId}/call-admin` then gives the chat to the admins. The button comes back every time the bot is down and goes away when the bot answers again; the mark behind it lives 30 minutes in redis

The chat module is implemented, but admin workflow details are still being refined through manual testing.
