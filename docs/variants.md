# Products, variants and characteristics

This page explains the model of the catalog to a developer who calls the API and to the shop admin who fills the catalog. Every statement here is true of the code; the routes, the fields and the error codes are in [API](api.md) and in Swagger (`/documentation`), the settings are in [configuration](configuration.md).

## Two rules for the shop admin

- **If variants must look different in a list, the characteristic that tells them apart must be main.** A list shows one row for the variants of a product that have the same value of every main characteristic. A T-shirt whose colour is main and whose size is not main has a row for each colour (the sizes are chosen on its card); a phone whose memory and colour are both main has a row for each pair. A characteristic that is not main never splits a row.
- **What a buyer chooses by must be a choice from a list.** Only a number, a yes/no and a choice of one value of a list can be main, and only a choice from a list shows a name, a colour swatch and a filter with the values that really exist. A colour typed as a text cannot be main, cannot be filtered and is spelled a little differently by every person who types it.

## Product and variant: what lives where

A **product** is what its variants share. A **variant** is what a buyer chooses and buys (a size, a colour, a memory). A product always has at least one variant.

| | Product | Variant |
| --- | --- | --- |
| Name, description | yes | the name is built by the server from the name of the product and the characteristics that tell the variants apart |
| Category | yes | by its product |
| Price, sale (`salePrice`, `saleEndsAt`, `salePriorPrice`) | no | yes |
| Stock (batches, free units, reserve) | no | yes |
| Article number (`sku`, up to 64 signs, one live variant of the catalog has it, letter case ignored), barcode (`barcode`, 8, 12, 13 or 14 digits with a good check digit, one live variant has it) | no | yes, both optional |
| Weight (`weightGrams`) and packed sizes (`lengthMm`, `widthMm`, `heightMm`) | no | yes |
| Pictures | the **gallery** of the product | the pictures of the gallery it shows, in an order of its own |
| Values of characteristics | no | yes |
| Place among the variants (`position`, from 1) | no | yes |
| Manufacturer, person responsible in the EU, warnings, documents (GPSR) | yes | no |
| Rating and reviews, popularity and views | yes | no |
| Taken out of sale (`deletedAt`) | yes | yes, apart from the product |

- A product holds `PRODUCT_VARIANTS_MAX` variants at most (200 unless set, 10000 at most); the ones taken out of sale count (`400 PRODUCT_VARIANTS_TOO_MANY`).
- A new product is made from one form (`POST /api/products`): its fields, the picture files of the gallery and `variants`, a JSON list of 1 to `PRODUCT_VARIANTS_MAX` variants, each with a price and the pictures it shows. Variants are added later in groups of 1 to 100 (`POST /api/products/:productId/variants`, all of them or none). The position of a variant is its place in the list; a new variant takes the next free place.
- The stock never comes with a product or a variant (`400 PRODUCT_STOCK_NOT_ALLOWED`): it comes with deliveries and goes with sales and write-offs (see Stock).
- Taking a variant out of sale (`DELETE .../variants/:variantId`) only marks it: it keeps its place, its batches and its history, and it lets its article number and its barcode go. `POST .../restore` puts it back (`409 PRODUCT_SKU_TAKEN` or `VARIANT_BARCODE_TAKEN` when its code was taken meanwhile, `409 VARIANT_DUPLICATE` when a live variant has the same values now). Taking a product out marks its variants that are for sale with the same time, and the restore of the product brings back just those; a variant of a product that is taken out comes back only with its product (`409 PRODUCT_DELETED`).
- A price is whole cents from 0 up to 99999999.99 (`400 PRODUCT_PRICE_INVALID`). The weight is whole grams up to a ton, a size whole millimetres up to 10 m, and the three sizes come together or not at all. A new variant needs the weight and the sizes unless the admin says `withoutShippingData: true` (the flag is not kept).
- Requests that write the variants or the gallery of one product wait for each other (the row of the product is locked first, then its variants, then the pictures). Two deletes of one variant at once give one `200` and one `409` (`VARIANT_ALREADY_DELETED`), variants added while the product is being taken out never stay for sale under it (`409 PRODUCT_DELETED`).

## The gallery, the pictures of a variant and who sees what

Pictures are files of a form (jpeg, png or webp by their bytes, up to `UPLOAD_MAX_BYTES`, 5 MB unless set), kept on Cloudinary in three sizes (`url200`, `url400`, `url800`). They belong to the **gallery of the product** (`PRODUCT_IMAGES_MAX`, 50 unless set); a variant **shows** some of them (`VARIANT_IMAGES_MAX`, 10 unless set) in an order of its own, and its first picture is its main picture.

- `POST /api/products` takes the files of the gallery; each variant names the files it shows by their numbers in the form with a place of its own. Every variant shows at least one picture (`400 VARIANT_IMAGE_REQUIRED`) and every file is shown by some variant (`400 GALLERY_IMAGE_UNUSED`).
- `POST /api/products/:productId/images` adds files to the gallery; no variant shows them until it is told to (`PATCH .../variants/:variantId` with `images: [{ imageId, position }]`, written whole; an empty list takes all its pictures away).
- `DELETE /api/products/:productId/images/:imageId` takes a picture out of the gallery; the variants that showed it lose it, and the answer names the variants left with no picture (`variantsWithoutImages`). The file is deleted from Cloudinary.
- The pictures of a request are checked before they are uploaded; a refused request leaves no file on Cloudinary.

**A variant without a picture is hidden.** What a buyer (a guest or a user) sees:

- a variant is visible when it is for sale (not taken out) and shows at least one picture;
- a product is visible when it is not taken out and has at least one visible variant;
- an invisible variant is `404 VARIANT_NOT_FOUND` on its card, an invisible product `404 PRODUCT_NOT_FOUND`; neither is in a list, the suggestions, the counts of the category tree, the answers of the bot or the favorites list;
- a cart refuses to add an invisible variant and drops the positions of the ones that became invisible; a confirmed order keeps them with `variant.forSale: false`.

Admin and root see everything: the hidden and the removed variants and products, the gallery with the variants that show each picture, and in a variant also the barcode, the whole stock, the reserve, the units of batches that are over, the cost of the latest delivery and the raw sale fields.

## Characteristics

The characteristics a variant is described by (a colour, a memory, a size) are kept in a **directory** that an admin fills (`/api/admin/attribute-groups`, `/api/admin/attributes`, `/api/admin/attributes/:attributeId/options`; every change goes to the admin log).

**Groups** are the sections of the card (Look, Memory, Battery). A group has a name (one in the directory, letter case ignored, up to 100 signs) and a place; characteristics in a group, and the groups among themselves, are put in an order with one request (`PUT .../order`). A group that has characteristics cannot be deleted (`409 ATTRIBUTE_GROUP_IN_USE`).

**Characteristics** belong to a group and have a name (one in the whole directory, letter case ignored, up to 100 signs), a place, a type and these settings:

| Type | A variant has | Settings |
| --- | --- | --- |
| `text` | a text, trimmed, up to 500 signs | cannot be main, cannot be filtered |
| `number` | a number | `unit` (a label such as `GB` or `mm`, up to 20 signs, nothing is converted), `decimals` (0 to 3, the digits after the point), `minValue` and `maxValue` |
| `boolean` | yes or no | can be main |
| `option` | one value of the list of the characteristic | can be main; values with a name and a colour swatch |
| `options` | several values of the list (a set, up to `ATTRIBUTE_MULTI_VALUES_MAX`, 50 unless set, no value twice) | cannot be main |

- **Main** (`isMain`): the characteristic splits the products of a list into rows by its value (see Lists). Only a number, a yes/no and a choice of one value can be main (`400 ATTRIBUTE_MAIN_NOT_ALLOWED`); the other characteristics are minor and show on the card only.
- **In filters** (`inFilters`, true unless said): the characteristic is in the panel of the filter of a category (see Lists). A text never is. The flag only chooses what the panel shows; the filter `f` of the list works for any characteristic that is not a text.
- **Values of a list** have a name (one in their characteristic, letter case ignored, up to 100 signs), an optional colour `#RRGGBB` and a place; a characteristic has `ATTRIBUTE_OPTIONS_MAX` values at most (500 unless set). A value is renamed or recoloured in one place and shows in every variant that has it.
- **The type** changes only while no variant has a value of the characteristic and no value of a list would be left without a list (`409 ATTRIBUTE_TYPE_LOCKED`, even between `option` and `options`). A characteristic that a variant has a value of, or that a category asks for, cannot be deleted (`409 ATTRIBUTE_IN_USE`, with the products); neither can a value of a list that a variant has (`409 ATTRIBUTE_OPTION_IN_USE`).
- **Replacing a value** (`POST /api/admin/attributes/:attributeId/options/:optionId/replace`, `{ withOptionId }`) puts another value in its place in every variant that has it, all or nothing, and then the old value can be deleted. The answer says how many variants changed (`updatedCount`, 0 is a normal `200`). It is refused when two variants of a product would become alike (`409 VARIANT_DUPLICATE`, listing them) or when both values are the same (`400 ATTRIBUTE_OPTION_REPLACE_SAME`).

**Required characteristics come from the category.** A category asks for a set of characteristics (`GET` and `PUT /api/categories/:categoryId/attributes`; the set is written whole, each item with `required`). A child category has the sets of its parents and adds its own; when a characteristic is named at several levels, the nearest category decides. The characteristics a category asks as required need a value whenever a variant of its products is made or its values change (`400 ATTRIBUTE_REQUIRED`, naming each variant and characteristic). A requirement added later breaks no old variant, a product moved to another category is not checked again, and the restore of a variant checks only the duplicate rule. The admin finds the variants that lack a required value with `GET /api/products?missingRequired=true` and with an alert.

**Values on variants.** A request that makes or changes variants carries `attributes: [{ attributeId, value }]` (`POST /api/products` inside the JSON `variants`, `POST .../variants`, `PATCH .../variants/:variantId`, `PATCH .../variants` and each item of `PATCH /api/products/variants/batch`). `value` is a text, a number, `true` or `false`, the id of a value of the list, or an array of such ids for a set. In a change `null` takes a value away and a characteristic that is not named stays; in a new variant it is simply no value; `attributes: []` changes nothing. The refusals name the characteristic and the bound or the value (`ATTRIBUTE_VALUE_INVALID`, `ATTRIBUTE_VALUE_TOO_SMALL`, `ATTRIBUTE_VALUE_TOO_LARGE`, `ATTRIBUTE_VALUE_TOO_PRECISE`, `ATTRIBUTE_OPTION_NOT_FOUND`, `ATTRIBUTE_VALUES_REPEATED`, `ATTRIBUTE_VALUES_TOO_MANY`, `VARIANT_ATTRIBUTES_INVALID`, `VARIANT_ATTRIBUTES_REPEATED`, `404 ATTRIBUTE_NOT_FOUND`); a request over several variants names every wrong one at once (`VARIANTS_INVALID`, `details.variants`). The bounds of a number are checked when a value is written; a bound changed later does not touch the values already there.

## The name of a variant and the duplicate rule

**The server builds the name of a variant**; a client never sends it. It is the name of the product, a dash and the labels of the characteristics that *differ* between the variants a buyer sees: "Phone X - 256 GB, black" (the dash is an em dash). A product with one variant, or whose variants differ in nothing, has the plain name of the product. The labels come main characteristics first, then by the place of the group and of the characteristic in the directory: a text as it is, a number without trailing zeros and with its unit, a choice by the name of its value (a set: the names joined with a comma), yes/no as `<characteristic>: yes` or `no` in the name and as `yes`/`no` in `values`. The same list is `values` of the short variant, `[{ attributeId, name, value }]`. The database writes both (`cartlify.variant_names`), so the card, the lists, the carts and the copy an order keeps at its confirmation always agree, and a rename of a value or of a characteristic changes the names at once. A confirmed order keeps the name it was bought under.

**The duplicate rule.** Two live variants of a product must differ in the values of at least one characteristic (`409 VARIANT_DUPLICATE`). A variant with no values repeats another with none, so a product with several variants needs characteristics that tell them apart. The rule is checked when a variant is made, added, changed or restored and when a value is replaced, under the lock of the product, so two requests at once cannot both pass; the variants taken out of sale do not count, and the restore of a whole product does not check it. A request over several variants lists every variant it would make alike, with the variants each repeats (`sameAs`).

## Prices and sales

The price and the sale belong to a variant. There are three request forms for a change of a variant, any field of it and not only the price and the sale, all or nothing, and a refusal of a form that covers several variants (`VARIANTS_INVALID`) names every variant refused with its own error under the status of the first one:

| Form | Route | Use |
| --- | --- | --- |
| One variant | `PATCH /api/products/:productId/variants/:variantId` | any field of the variant: the price and the sale, `sku`, `barcode`, the weight and the sizes, `position`, `images`, `attributes` |
| Several variants of one product, one change | `PATCH /api/products/:productId/variants` with `variantIds?` (every variant for sale without it) | the same price, sale, weight, sizes, values or pictures (`images`) for each; no `sku`, `barcode` or `position` (a code is unique, a place is one variant's: they are not read) |
| Many variants, each with its own change | `PATCH /api/products/variants/batch` with `items: [{ variantId, ... }]`, 1 to 100 | a spreadsheet-style edit: each item may carry any field of the one-variant form; the same variant twice is `400 VARIANTS_REPEATED` |

- **Pictures.** A variant shows pictures of the gallery of its product, chosen by `images: [{ imageId, position }]`, written whole (an empty list takes them all away and a buyer no longer sees the variant). In the form of several variants the list is one for every variant of the change, each variant gets exactly these pictures, and a variant that shows them already is not written; a picture that is not in the gallery of the product is `400 VARIANT_IMAGE_NOT_FOUND` (`details.imageIds`; no variant is named, the list is what is wrong). In the batch every item has the list of its own, checked against the gallery of its own product, and the refusal names the item (`VARIANTS_INVALID`, `errorCode: VARIANT_IMAGE_NOT_FOUND`). Each variant changed gets the change of its pictures in the line of the admin log (`{ field: 'images', old, new }`).
- **Codes in the batch.** An article number or a barcode that an item changes must be free among the live variants of the catalog, and the batch is checked as a whole: a code that any other live variant holds now, a variant of the same batch included (even one that gives it up in that batch), is taken, and so is a new code that two items ask for (an article number whatever the case of its letters). The codes are unique and checked on every write, so two variants cannot swap their codes in one request. `409 PRODUCT_SKU_TAKEN` or `409 VARIANT_BARCODE_TAKEN` names the items: `details.variants: [{ variantId, sku }]` (or `barcode`), in the order of the request, the article numbers first. A variant's own code in other letters is not taken. A variant that is out of sale holds no code and is not checked; the check comes when it is put back.
- **Places in the batch.** The items with a `position` are applied one after the other in the order of the items, after the other writes; the others move around the variant moved and a place past the last one is the last. The line of the admin log has the place the variant ends at (`{ field: 'position', old, new }`); a variant that ends where it was gets no line.

On top of those: `PATCH /api/products/:productId/sale` (`{ variantIds?, sale }`) puts the variants on sale or takes the sales off, `POST /api/products/sales` does it for many variants, for all the variants of products, or for a category with its branch, and `PATCH /api/products` is the bulk change of prices by a `scope` (category, products, variants, the price bounds, the filter `f`, free units, taken out or not) by a percent or an amount, with `dryRun` listing the variants with the old and the new price.

- **A sale** is a discount by a `percent` or an `amount` off the price of each variant until `endsAt` (a time in the future). While it lasts the variant sells at the sale price (the cart, the confirmation, the price sort and the price filters), and the answers show `salePrice`, `saleEndsAt` and `salePriorPrice` next to `price`; a sale past its end is left out. `salePriorPrice` is the lowest price of the 30 days before the sale (from the log of prices), the price a reduction is compared with. A discount that does not fit the price of a variant (an amount above it, or one that rounds to nothing or makes a free variant) refuses the whole request and names the variants (`400 PRODUCT_SALE_AMOUNT_TOO_HIGH`, `400 PRODUCT_SALE_TOO_SMALL`).
- **A new price of a variant that is on sale** says what happens to the sale in `sale`: `keep`, `remove` or a new sale (`409 PRODUCT_SALE_DECISION_REQUIRED` without it; `sale` without a price is `400 PRODUCT_SALE_REQUIRES_PRICE`). A sale stays below the price, so `keep` with a new price that is not above the sale price is `409 PRODUCT_SALE_NOT_BELOW_PRICE`. The bulk change of prices (`PATCH /api/products`) keeps or removes the sales of every variant alike.
- The sale routes answer the state of each variant (`set`, `unchanged`, `removed`); a request that leaves every variant as it was is `409` (`PRODUCT_SALE_ALREADY_SET`, `PRODUCT_SALE_ALREADY_REMOVED`) and changes nothing.
- Every change goes to the log of prices (a line for each variant, `GET /api/admin/price-log`, `GET /api/products/:productId/price-history[?variantId=]`) and to the admin log.

## Stock

The stock is the stock of a **variant**: what its batches have left. Only deliveries, sales, write-offs and cancels change it.

- **Batches.** A delivery (`POST /api/products/stock/deliveries`) takes in a batch of each item at its cost of a unit, an optional last good day (`expiresAt`) and the number the supplier gave it. An item names its variant by `variantId`, `sku` or `barcode` (exactly one of the three); the cost and the last good day of the whole delivery stand in for an item that has none of its own; an item with no cost in either place is `400 BATCH_UNIT_COST_REQUIRED`. `source` is a supplier, a surplus an inventory found, or goods a buyer brought back.
- **Write-offs** (`POST /api/products/stock/write-offs`) take free units from a batch named or from the batches in the order of a sale, with a reason (damaged, defective, expired, shortage, returned to the supplier, other with a note). A variant taken out of sale keeps its units until they are written off; it is named by its id.
- **Reserve.** Confirming an order reserves the units of each variant for `ORDER_RESERVATION_MINUTES` (15 unless set); the payment consumes them, an expired or cancelled reservation releases them. **Free units** are the stock less the reserve less the units of batches that are over: this is the `stock` a buyer sees and the number a cart is checked against (`409 OUT_OF_STOCK`, `409 ORDER_ITEMS_UNAVAILABLE` at the confirmation).
- **Sales and cancels.** A sale takes the batch that ends first, then the ones without an end, the oldest first, and keeps what it took from which batch (the cost of the goods sold). The cancel of a paid order puts the units back into the same batches.
- **Over** batches: a batch whose last good day is behind the day of the shop (`SHOP_TIME_ZONE`) is over; its units are free nowhere, and the admin sees them apart (`expiredStock`) to write them off.
- **The stock log** (`GET /api/admin/stock-log`, admin and root) has a line for every change of the stock of a variant, only added to, never changed: the event (`stock.delivery`, `stock.write_off`, `stock.sale`, `stock.cancel_return`), the change and the stock after it, the id of the operation (`deliveryId` of a delivery, `writeOffId` of a write-off, `orderId` of a sale and of a cancel), who did it (nobody for the sale at a payment) and the batches it was made of. Filters: `productId` (all its variants), `variantId`, `deliveryId`, `writeOffId`, `orderId`, a period, the events and the columns. The batches (`/api/admin/stock/batches`), the steps (`/api/admin/stock/movements`), the accounting reports and the statistics read it. The admin log keeps one line for a whole delivery or write-off, with the same id as the answer.

## Lists, filters and the panel

`GET /api/products` lists the catalog. A row is `{ product, variant, minPrice?, maxPrice?, stock }`. Whether a row is a product or a group of variants depends on the query:

- **Product mode.** A query that asks nothing of a variant (a category, a search, a sort by `popularity`, `createdAt`, `name`, `avgRating`, `sales`, `relevance` or `inStock`) lists products, one row each, with its main variant (the first by its place that has free units, else the first), `minPrice` and `maxPrice` (the lowest and the highest price its variants sell at now) and `stock` (the free units of all its variants).
- **Variant mode.** A query that asks something of a variant (a sort by `price`, `discount` or `saleEndsAt`, `minPrice`, `maxPrice`, the filter `f`, and for an admin the sorts and flags of the stock, `onSale`, `withoutShippingData`) lists **groups**: the variants that fit the query, of one product, with the same value of every main characteristic, are one row. A variant without a value of a main characteristic is a value of its own; a product with no main characteristic is one group. The row has the first variant of the group by its place as `variant`, `minPrice` and `maxPrice` of its variants (equal for one price: show the price, else "from - to") and `stock`. A price sort puts a group where its lowest price stands going up and where its highest stands going down, and the price filter keeps only the variants that fit in the group.
- **Single variants.** An admin who sends `group=false` gets every variant on a row of its own (the `stock` of the variant, no price range). For a buyer `group=false` is `403 FILTER_FORBIDDEN`; `group=true` is his normal view.
- `total` counts the rows (groups). The cursor keeps the row it ends at, and a cursor of one kind of rows (products, groups, single variants) is `400 CURSOR_INVALID` for another.
- A buyer gets the short variant (`id`, `position`, `name`, `values`, `price`, the sale while it lasts, `stock`, `image`) of the visible variants only. Admin and root get the full variant, the variants without a picture, and without any flag only the plain products (not removed, no sale on any variant, no popularity override that is on).

**The filter `f`** is `<attributeId>:<value>`, one entry for a characteristic, repeated for more:

```text
GET /api/products?categoryIds=4&f=12:45,46&f=15:128..512&f=20:yes
```

| Characteristic | Value | Reads as |
| --- | --- | --- |
| a choice (`option`, `options`) | ids of values, with commas | any of them fits (OR) |
| a number | `128..512` (both ends included), `128..` (from), `..512` (up to), `6.1..6.7` (decimals); one exact number is `128..128` | a range |
| yes/no | `yes` or `no` (letter case ignored) | the answer |

The values of one characteristic are OR, different characteristics are AND, a variant without a value of a characteristic fits none of its values, and a text cannot be filtered (`ATTRIBUTE_NOT_FILTERABLE`). The syntax is strict: ids without leading zeros, numbers like `-?\d+(\.\d+)?` of up to 30 signs, spaces around the parts ignored, at most 20 entries, 100 values in an entry and 1000 signs in an entry. A wrong entry is `400 FILTER_INVALID` with `details.reason` (`ENTRY_INVALID`, `VALUE_INVALID`, `RANGE_ORDER`, `ATTRIBUTE_REPEATED`, `TOO_MANY_ENTRIES`, `TOO_MANY_VALUES`, `ENTRY_TOO_LONG`, `ATTRIBUTE_NOT_FOUND`, `ATTRIBUTE_NOT_FILTERABLE`, `VALUE_FORM_MISMATCH`, `OPTION_NOT_FOUND`) and the `entry` and its `index`. The same filter is `scope.f` of the bulk change of prices.

**The panel** (`GET /api/products/filters?categoryId=&branch=`) tells the page what to draw for a category: the characteristics that are in the filters, are no text and have at least two different values among the variants a buyer sees in the category and everything below it (`branch=false`: the category alone). Each item has its `id`, `name`, `unit`, `type` and `group`, in the order of the card, and the values that are there (a choice: `[{ id, name, colorCode, position }]` in the order of the admin; a number: `min` and `max`; yes/no: `values: ['yes', 'no']`). There are no counts; the ids go into `f`. An unknown category is `404 CATEGORY_NOT_FOUND`.

## The card of a product

`GET /api/products/:productId[?variantId=]` is `{ product, variant, variants }`: the part every variant shares, the variant opened in full (with its `attributes`, every characteristic it has by the groups of the card, each with its `value` as the card writes it, the `raw` value and the colour of a swatch) and every variant to switch between in the short form, each with its `name` and the `values` that tell it from the others. Without `variantId` it opens the main variant. `GET /api/products/:productId/variants/:variantId` gives one variant on its own. A visit of a buyer to the card counts as a view of the product.

## The admin side

- **Filters of the admin list** (`GET /api/products`, admin and root; a buyer who sends one gets `403 FILTER_FORBIDDEN` with `details.filter`): the flags of the sale and of the stock, and the ones that find the gaps of the catalog. By a variant, which make the rows variants (groups unless `group=false`): `missingRequired`, `withoutWeight`, `withoutDimensions`, `withoutBarcode`, `withoutImages`, `withoutShippingData`. By a product, which leave the rows products: `hiddenFromBuyers` (the product is removed, or none of its variants is alive with a picture; `false` is the products a buyer sees), `hasDeletedVariants`, `manufacturerId`, `euResponsibleId`, `documentId` (an unknown id is `404`). They work together with the other filters, `f`, the search, the sorts and the cursor; the removed products come only with `deleted=true`.
- **Alerts** (`GET /api/admin/alerts`): `out_of_stock` and `low_stock` count variants (a variant taken out of sale is none), `products_without_shipping_data` the variants that lack the weight or the sizes, `variants_missing_required` the variants that lack a characteristic their category requires, `products_hidden_from_buyers` the products of the catalog none of whose variants a buyer sees (a product removed on purpose is not one), `expiring_batches` and `expired_batches` the batches (also of a variant taken out of sale). Each comes with its count and the request to the list that shows its cases.
- **Reports** (`/api/admin/reports/accounting/products`, `/variants`, `/categories`, `/timeline`, `format=csv` for the accountant): a row of the report by product is a product, the money of all its variants added up; a row of the report by variant is a variant with its product; its rows add up to the rows of the report by product. `productIds` and `variantIds` keep the variants of those products or those variants (both: the intersection). Categories and steps of time add up the variants.
- **Statistics** (`GET /api/admin/stats`): next to the top products (a product is the sum of its variants) and the top categories there is a top of variants, each `{ product, variant, revenue, quantitySold }`.
- **Journals**: the log of prices and the stock log have a line for each variant, with filters `productId` and `variantId`; the admin log has a line for every change of a variant (`variant.create`, `variant.update`, `variant.update_batch`, `variant.delete`, `variant.restore`), of the gallery (`product.gallery_add`, `product.gallery_remove`) and of the directory.

## Manufacturer, person responsible in the EU, warnings and documents (GPSR)

A product shows the safety and origin data an offer needs in the EU. They belong to the product, not to a variant, and show on its card.

- **Parties** (`/api/admin/parties`): the manufacturer and the person responsible in the EU are rows of a directory (`name` up to 200 signs, postal `address` up to 500, `email`, `country` as two capital letters). A change of a party shows in every product that names it; a party a product names cannot be deleted (`409 PARTY_IN_USE`), and a change of the country that would break the rule of a product is refused (`409 PARTY_COUNTRY_CHANGE_REFUSED`).
- **On a product**: a new product names its manufacturer by `manufacturerId` or brings the values of a new one in `manufacturer.*` (never both, `400 PARTY_CHOICE_AMBIGUOUS`); the manufacturer is required (`400 MANUFACTURER_REQUIRED`). A manufacturer outside the EU needs a person responsible in the EU (`euResponsibleId` or `euResponsible.*`, `400 PRODUCT_EU_RESPONSIBLE_REQUIRED`), and that person is in the EU (`400 EU_RESPONSIBLE_NOT_IN_EU`).
- **Warnings** (`warnings`): a text up to 2000 signs (`400 PRODUCT_WARNINGS_TOO_LONG`); empty takes them away.
- **Documents** (`/api/admin/documents`): instructions, certificates and declarations of conformity are PDF files kept in a directory (a title, a kind, checked by their bytes, up to `DOCUMENT_MAX_BYTES`, 20 MB unless set) on Cloudinary. A product names them by their ids in an order of its own (`documentIds`, up to `PRODUCT_DOCUMENTS_MAX`, 20 unless set) and the card shows them as `documents`; a document a product names cannot be deleted (`409 DOCUMENT_IN_USE`).

## Limits and settings

| Setting | Default | Bound | What it limits |
| --- | --- | --- | --- |
| `UPLOAD_MAX_BYTES` | 5000000 | 100000000 | the biggest picture file of a form |
| `PRODUCT_IMAGES_MAX` | 50 | 1000 | pictures in the gallery of a product |
| `PRODUCT_VARIANTS_MAX` | 200 | 10000 | variants of a product (the removed ones count) |
| `VARIANT_IMAGES_MAX` | 10 | 100 | pictures one variant shows |
| `DOCUMENT_MAX_BYTES` | 20000000 | 100000000 | the biggest PDF of a document |
| `PRODUCT_DOCUMENTS_MAX` | 20 | 100 | documents one product names |
| `ATTRIBUTE_OPTIONS_MAX` | 500 | 10000 | values of the list of one characteristic |
| `ATTRIBUTE_MULTI_VALUES_MAX` | 50 | 1000 | values of a set a variant has for one characteristic |

The start stops above a bound. The limits of the filter `f` (20 entries, 100 values in an entry, 1000 signs in an entry) and of a change of many variants (100) are constants of the code, not settings.

## Error codes by area

Each route lists its own codes in Swagger, next to its statuses; the shared ones (`VALIDATION_ERROR`, `INVALID_ID_PARAM`, `INSUFFICIENT_ROLE`, `CSRF_TOKEN_INVALID`, `RATE_LIMITED`, `RESOURCE_BUSY`, `INTERNAL_ERROR` and the others every route has) are described once for all. A test holds the document to the code: every code it names is a word of the source, and every example passes its own schema.

| Area | 400 | 404 | 409 |
| --- | --- | --- | --- |
| Variants of a product | `VARIANTS_REQUIRED`, `VARIANTS_INVALID`, `VARIANTS_REPEATED`, `VARIANT_INVALID`, `PRODUCT_PRICE_INVALID`, `PRODUCT_SKU_TOO_LONG`, `VARIANT_BARCODE_INVALID`, `VARIANT_POSITION_INVALID`, `PRODUCT_VARIANTS_TOO_MANY`, `PRODUCT_STOCK_NOT_ALLOWED`, `PRODUCT_WEIGHT_INVALID`, `PRODUCT_SIZES_INVALID`, `PRODUCT_SIZES_INCOMPLETE`, `PRODUCT_SHIPPING_DATA_REQUIRED`, `NO_FIELDS_TO_UPDATE` | `PRODUCT_NOT_FOUND`, `VARIANT_NOT_FOUND` | `PRODUCT_SKU_TAKEN`, `VARIANT_BARCODE_TAKEN`, `VARIANT_DUPLICATE`, `VARIANT_ALREADY_DELETED`, `VARIANT_NOT_DELETED`, `PRODUCT_DELETED`, `PRODUCT_NOT_DELETED` |
| Gallery and pictures | `VARIANT_IMAGE_REQUIRED`, `VARIANT_IMAGES_INVALID`, `VARIANT_IMAGES_TOO_MANY`, `VARIANT_IMAGES_REPEATED`, `VARIANT_IMAGE_POSITION_INVALID`, `VARIANT_IMAGE_NOT_FOUND`, `GALLERY_IMAGE_UNUSED`, `PRODUCT_IMAGES_TOO_MANY`, `PRODUCT_IMAGES_NOT_ALLOWED`, `PRODUCT_IMAGES_REQUIRED`, `MULTIPART_REQUIRED`, `IMAGE_INVALID`, `IMAGE_TYPE_NOT_ALLOWED` | `PRODUCT_IMAGE_NOT_FOUND` | |
| Prices and sales | `PRODUCT_SALE_REQUIRES_PRICE`, `PRODUCT_SALE_AMOUNT_TOO_HIGH`, `PRODUCT_SALE_TOO_SMALL`, `PRODUCT_SALE_ENDS_AT_INVALID`, `SALE_VARIANTS_REPEATED`, `BULK_PRICE_MODE_INVALID`, `BULK_PRICE_VALUE_INVALID`, `BULK_PRICE_PERCENT_TOO_LOW`, `BULK_PRICE_NEGATIVE_RESULT`, `BULK_PRICE_TOO_LARGE_RESULT` | `VARIANT_NOT_FOUND` | `PRODUCT_SALE_DECISION_REQUIRED`, `PRODUCT_SALE_NOT_BELOW_PRICE`, `PRODUCT_SALE_ALREADY_SET`, `PRODUCT_SALE_ALREADY_REMOVED` |
| Values of characteristics | `ATTRIBUTE_VALUE_INVALID`, `ATTRIBUTE_VALUE_TOO_SMALL`, `ATTRIBUTE_VALUE_TOO_LARGE`, `ATTRIBUTE_VALUE_TOO_PRECISE`, `ATTRIBUTE_OPTION_NOT_FOUND`, `ATTRIBUTE_VALUES_REPEATED`, `ATTRIBUTE_VALUES_TOO_MANY`, `VARIANT_ATTRIBUTES_INVALID`, `VARIANT_ATTRIBUTES_REPEATED`, `ATTRIBUTE_REQUIRED` | `ATTRIBUTE_NOT_FOUND` | `VARIANT_DUPLICATE` |
| Directory of characteristics | `ATTRIBUTE_GROUP_FIELDS_INVALID`, `ATTRIBUTE_FIELDS_INVALID`, `ATTRIBUTE_OPTION_FIELDS_INVALID`, `ATTRIBUTE_MAIN_NOT_ALLOWED`, `ATTRIBUTE_OPTIONS_NOT_ALLOWED`, `ATTRIBUTE_OPTIONS_TOO_MANY`, `ATTRIBUTE_OPTION_REPLACE_SAME`, `CATEGORY_ATTRIBUTES_REPEATED`, `ORDER_IDS_MISMATCH` | `ATTRIBUTE_GROUP_NOT_FOUND`, `ATTRIBUTE_NOT_FOUND`, `ATTRIBUTE_OPTION_NOT_FOUND`, `CATEGORY_NOT_FOUND` | `ATTRIBUTE_GROUP_NAME_TAKEN`, `ATTRIBUTE_NAME_TAKEN`, `ATTRIBUTE_OPTION_NAME_TAKEN`, `ATTRIBUTE_GROUP_IN_USE`, `ATTRIBUTE_IN_USE`, `ATTRIBUTE_OPTION_IN_USE`, `ATTRIBUTE_TYPE_LOCKED`, `VARIANT_DUPLICATE` |
| Lists, filter, panel | `FILTER_INVALID` (with `details.reason`), `CURSOR_INVALID`, `PRICE_RANGE_INVALID`, `CATEGORY_IDS_INVALID`, `SALES_PERIOD_INVALID`, `SORT_RELEVANCE_REQUIRES_SEARCH`, the `SORT_*_REQUIRES_*` codes | `CATEGORY_NOT_FOUND`, `MANUFACTURER_NOT_FOUND`, `EU_RESPONSIBLE_NOT_FOUND`, `DOCUMENT_NOT_FOUND` (403: `FILTER_FORBIDDEN`, `SORT_FORBIDDEN`, `DELETED_PRODUCTS_FORBIDDEN`) | |
| Stock | `BATCH_UNIT_COST_REQUIRED`, `BATCH_UNIT_COST_INVALID`, `BATCH_EXPIRES_AT_INVALID`, `WRITE_OFF_NOTE_REQUIRED` | `VARIANT_NOT_FOUND` (with `details` listing every id, article number and barcode missing), `BATCH_NOT_FOUND` | `INSUFFICIENT_AVAILABLE_STOCK`, `BATCH_INSUFFICIENT` |
| Cart, orders, favorites | | `VARIANT_NOT_FOUND` | `OUT_OF_STOCK`, `ORDER_ITEMS_UNAVAILABLE`, `ORDER_PRICES_CHANGED` |
| Parties, warnings, documents | `PARTY_FIELDS_REQUIRED`, `PARTY_FIELDS_INVALID`, `PARTY_ID_INVALID`, `PARTY_CHOICE_AMBIGUOUS`, `MANUFACTURER_REQUIRED`, `PRODUCT_EU_RESPONSIBLE_REQUIRED`, `EU_RESPONSIBLE_NOT_IN_EU`, `PRODUCT_WARNINGS_TOO_LONG`, `DOCUMENT_ID_INVALID`, `DOCUMENT_IDS_REPEATED`, `PRODUCT_DOCUMENTS_TOO_MANY`, `DOCUMENT_REQUIRED`, `DOCUMENT_MULTIPLE`, `DOCUMENT_INVALID`, `DOCUMENT_TYPE_NOT_ALLOWED`, `DOCUMENT_KIND_INVALID`, `DOCUMENT_TITLE_REQUIRED`, `DOCUMENT_TITLE_TOO_LONG` | `PARTY_NOT_FOUND`, `MANUFACTURER_NOT_FOUND`, `EU_RESPONSIBLE_NOT_FOUND`, `DOCUMENT_NOT_FOUND`, `DOCUMENTS_NOT_FOUND` | `PARTY_ALREADY_EXISTS`, `PARTY_IN_USE`, `PARTY_COUNTRY_CHANGE_REFUSED`, `DOCUMENT_IN_USE` |

## Where the code lives

| Part | Where |
| --- | --- |
| Routes of products and variants | `src/routes/api/products/` (`products.routes.ts`, `variant.controllers.ts`, the services and `services/helpers/variant*.ts`) |
| Directory of characteristics, sets of a category | `src/routes/api/attributes/` |
| Parties, documents | `src/routes/api/parties/`, `src/routes/api/documents/` |
| Names of variants, required values, stock log | `db/schema/05_fn_and_triggers.sql` (`variant_names`, `log_stock_change` and the stock functions), `db/schema/04_views.sql` (`category_required_attributes`, `variants_missing_required`) |
| Parsing of the filter `f` | `src/helpers/characteristicFilter.ts` |
