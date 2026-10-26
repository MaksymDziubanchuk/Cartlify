# Cartlify

Backend-first e-commerce platform built as a production-oriented portfolio project.

Cartlify is not presented as a finished storefront. It is a realistic engineering project focused on how a commercial e-commerce backend is structured: authentication, RBAC, catalog management, order flow, PostgreSQL policies, background jobs, real-time support chat, AI-assisted customer support, maintainable module boundaries, and documented REST API behavior.

The repository currently contains a working REST API foundation, PostgreSQL hardening scripts, Redis-based order timeout processing, OAuth/media/email integrations, WebSocket-based chat, Swagger/OpenAPI documentation, and an OpenAI-powered assistant for product and support conversations. Some parts of the roadmap are already implemented, some are partially scaffolded, and some are planned for the next stages.

---

## Table of Contents

- [Project Goals](#project-goals)
- [Current Status](#current-status)
- [Technology Stack](#technology-stack)
- [Implemented Features](#implemented-features)
- [In Progress / Planned](#in-progress--planned)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [Local Setup](#local-setup)
- [Run Commands](#run-commands)
- [API Surface](#api-surface)
- [API Documentation](#api-documentation)
- [Realtime Chat / AI Bot](#realtime-chat--ai-bot)
- [Production Notes](#production-notes)
- [License](#license)

---

## Project Goals

Cartlify was built to demonstrate backend engineering decisions that are relevant in a real commercial project:

- modular Fastify architecture
- strict TypeScript boundaries between controllers, services, DTOs, and schemas
- PostgreSQL-first design with custom SQL layer, RLS, functions, views, and indexes
- role-based access control for `GUEST`, `USER`, `ADMIN`, and `ROOT`
- consistent order flow with background timeout handling
- real-time support chat with guest/user/admin flows
- AI-assisted product and support conversations with fallback behavior
- documented REST API surface through Swagger/OpenAPI
- API design that can later support SSR, GraphQL, and additional real-time features

---

## Current Status

**Repository maturity:** active development

What this repo already shows well:

- a non-trivial e-commerce domain model
- a real REST API structure with multiple modules
- authentication and authorization flows beyond basic login/logout
- PostgreSQL hardening beyond default Prisma usage
- background processing with Redis
- WebSocket-based chat flow
- OpenAI-powered chatbot integration
- guest-to-user chat continuity and admin escalation flow
- Swagger/OpenAPI documentation for the REST API

What is important to state honestly:

- the project is **not feature-complete yet**
- there is no storefront/UI layer in this repository yet; the current stage is the backend API
- WebSocket chat and OpenAI chatbot logic are implemented, but the admin-chat workflow is still being actively refined
- Swagger/OpenAPI is implemented and available, but route security metadata, operation ids, examples, and response descriptions are still being refined
- the test setup (Jest, Docker test database, launcher) is in place, but the test suite itself is only starting
- Dockerized deployment and broader observability are **planned**, not done in this snapshot

---

## Technology Stack

### Implemented in the current codebase

| Area                          | Technologies                                                                | Status      |
| ----------------------------- | --------------------------------------------------------------------------- | ----------- |
| Runtime                       | Node.js, TypeScript                                                         | Implemented |
| Web framework                 | Fastify                                                                     | Implemented |
| Database access               | PostgreSQL, Prisma                                                          | Implemented |
| DB hardening layer            | raw SQL scripts for roles, schema, RLS, views, functions, triggers, indexes | Implemented |
| Authentication                | JWT, HttpOnly cookies, refresh flow                                         | Implemented |
| Authorization                 | RBAC + PostgreSQL RLS context                                               | Implemented |
| API documentation             | Swagger / OpenAPI                                                           | Implemented |
| Realtime chat                 | WebSocket chat endpoint and event-based messaging                           | Implemented |
| AI assistant                  | OpenAI-powered chatbot service with product/support context                 | Implemented |
| Media                         | Cloudinary                                                                  | Implemented |
| Email                         | SendGrid                                                                    | Implemented |
| OAuth                         | Google, GitHub, LinkedIn                                                    | Implemented |
| Cache / background processing | Redis, order timeout worker                                                 | Implemented |
| Lint / formatting             | ESLint, Prettier                                                            | Implemented |
| CI utilities                  | GitHub Actions for DB migration / SQL execution                             | Implemented |

### Planned stack / next steps

| Area                     | Planned technologies                                  | Status      |
| ------------------------ | ----------------------------------------------------- | ----------- |
| Testing                  | Jest, PostgreSQL and Redis integration tests (Docker) | In progress |
| API docs refinement      | security metadata, operation ids, examples            | Planned     |
| Deployment               | Docker, AWS ECS/Fargate                               | Planned     |
| SSR delivery layer       | detachable Handlebars-based web module                | Planned     |
| Production observability | broader monitoring / metrics / reporting              | Planned     |

---

## Implemented Features

### Authentication and user flows

- user registration (the name is optional, up to 100 characters)
- the terms and the contract of the shop: root publishes each new version (`POST /api/root/legal-documents`, `GET` lists them, the latest first); a version is never changed or removed, the database numbers it within its kind and keeps the sha256 of its text. Anybody reads the versions in force (`GET /api/legal/documents/current`) and any version by its id. The terms and the contract together have to give the right to withdraw within 14 days, how to withdraw and return the goods, who pays for the return and the model withdrawal form: their texts are the copy of the contract the buyer gets. While versions are in force, the registration takes the consent to all of them (`acceptedDocumentIds`: `400 LEGAL_ACCEPTANCE_REQUIRED` names the kinds missing, an old version is `409 LEGAL_VERSION_OUTDATED`; both name the versions in force with their titles). A login by Google, GitHub or LinkedIn that makes a new account takes the consent the same way: the page sends `acceptedDocumentIds` with the start of the login, the signed state carries them to the callback, and without them no account is made (the page gets `?error=LEGAL_ACCEPTANCE_REQUIRED`). A customer who comes back after a new version came in force accepts it at the login: a login with a password answers `409 LEGAL_ACCEPTANCE_REQUIRED` with the versions in force and the page logs in again with them in `acceptedDocumentIds`, a login by a provider gets the same code on its callback page and starts again with them; an admin or root is asked nothing. The confirmation of an order still checks it for a session that stayed open (`GET /api/legal/acceptances/me` names what is missing, `POST /api/legal/acceptances`). Each consent keeps the address and the browser of its request, the consents are only added
- email verification flow
- resend verification email: a new link each time, earlier links stop working; the links are stored only as hashes
- login / logout: logout ends the session of this browser, `allDevices` ends every session of the user
- refresh token rotation: `POST /api/auth/refresh` answers 204 and sets both tokens as cookies, no token in the body
- a session ended on purpose (a logout, a reset or a change of the password, a role change by root, a closed session) is a plain `401 REFRESH_TOKEN_REVOKED` when its cookie comes back, the other sessions go on; a token already renewed coming back was copied and ends every session (`403 REFRESH_TOKEN_REUSE_DETECTED`)
- sessions: `GET /api/auth/sessions` lists the open sessions of the user (the browser that opened each, its last renewal, its deadline, the current one), `DELETE /api/auth/sessions/:sessionId` ends one; a session keeps its id across its renewals
- data export: `GET /api/users/me/export` gives the signed-in person everything the shop keeps of them as one JSON file (profile, orders, favorites, reviews and votes, chats, logins, sessions, the consents to the terms and the contract), once an hour; database functions of the system empty the network data of old logins and remove the data of idle guests and the chats of accounts deleted long ago, each with the days it keeps (run by the periodic tasks)
- password change: `POST /api/auth/password/change` with the current password ends the other sessions, keeps this one, closes the reset links and mails the owner; a new reset link closes the ones mailed before, a reset closes them all
- a role change by root ends the sessions of the person; an access token of the old role the database refuses answers `401 ACCESS_TOKEN_EXPIRED`, the page renews the session
- forgot password / reset password
- OAuth entry points and callbacks for Google, GitHub, and LinkedIn; a callback sends the browser back to the frontend page `WEB_ORIGIN/auth/callback`, with `?error=<errorCode>` when the login failed
- guest-to-user data migration during login/OAuth flows
- guest chat continuity: the cart, the favorites and the chats of the guest move to the account at a login (password or OAuth) and at the verification of the email in the browser of the guest, not at the registration; registering an address that was registered before and never verified sets the new password and mails a new link
- the list of users for an admin or root (`GET /api/users`), root accounts included: every field of an account and its last login (`lastLoginAt`), an empty one is null; filters that go together — a part of the email in any case (`_` and `%` are plain characters), roles and providers (several through commas), the email confirmation, the deleted accounts (only with `deleted=true`); the order is the sign-up or the last login (`sortBy`, `sortOrder`), equal values go by id, accounts that never logged in come last; pages by cursor with the total of the filters
- the profile of a user by id (`GET /api/users/:userId`) depends on who reads it, in the database function and in the API alike: a user gets the name, the avatar and the dates, no email; an admin or root gets the whole profile but the password, the provider id and the avatar file id, the open chat of the user with an admin, and the lists the `include` checkboxes name (`orders`, `reviews`, `favorites`, `votes`, `loginLogs`, `consents` — the versions of the terms and of the contract the user accepted and the ones each order was confirmed with, with the address and the browser, the text of each by `GET /api/legal/documents/:documentId`) of a period: the last 30 days unless `from`/`to` come, any dates, at most 60 days long (`400 PROFILE_PERIOD_TOO_LONG`, `400 PROFILE_PERIOD_INVALID`)
- avatars: every answer that names an account gives `avatarUrls` in four sizes and `avatarIsDefault`: the own picture of the account, or, without one, the first letter of the name (of the email when there is no name) on a color of the account, the way a Google account shows it; a deleted account is G on grey. Cloudinary draws the letter at the url on a plain picture, nothing is stored per account; the server puts that picture into the Cloudinary folder of its environment when it starts, so a new Cloudinary account needs no step by hand
- the picture of a Google, GitHub or LinkedIn account becomes the avatar of a new account: on the login that creates the account the server downloads it from the provider (https on the hosts of the provider only, no redirects, 256 px, jpeg, png or webp by its content, up to 5 MB) and keeps it at Cloudinary as the avatar; it waits at most 4 seconds, and whatever goes wrong the login goes on with the drawn letter. A later login, or a login that links an account we have, takes no picture, so a removed avatar never comes back
- avatar removal: the owner removes the own avatar with an empty `avatar` in `PATCH /api/users/me` (JSON or a form field); a moderator removes the avatar of another account with `DELETE /api/users/:userId/avatar` — an admin from a user account, root from any account, through the database function `cartlify.remove_user_avatar`. The file goes from Cloudinary after the change. A removal by a moderator goes to the admin journal and mails the person which removal it is; the answer and the profile an admin reads give `avatarRemovals` and `avatarRemovalsLimit` (`AVATAR_REMOVALS_LIMIT`, 5 unless set), and past the limit the admin takes the account to root, who alone deletes accounts
- user profile read/update endpoints: the update takes JSON or a multipart form with an avatar file (jpeg, png or webp by its content, whatever type the form names, up to 5 MB, a bigger one gets `413 PAYLOAD_TOO_LARGE`; it replaces the avatar only once the profile is written, a refused request changes nothing), the name and the locale are up to 100 characters, the phone is empty (removes it) or exactly `+380501234567`-style, a plus and 8 to 15 digits, in JSON and in a form alike; ids in the path are whole numbers from 1 to 2147483647
- account deletion: a user deletes their own account (`DELETE /api/users/me`: the password of a local account, or a login of the last 10 minutes for Google, GitHub and LinkedIn; orders waiting for payment, paid or shipped are shown first and deleted only on a confirmed second request), root deletes any user except themselves. The row stays, emptied of everything personal, named Guest and marked with `deletedAt`: its owner can no longer change it, other users get `404 USER_NOT_FOUND` for its profile, an admin still reads it; an order waiting for payment is cancelled with its stock returned and its payment page closed, a payment that still comes is refunded in full; paid and shipped orders are delivered; favorites, reviews and chat messages stay, open chats are closed. The person gets a mail with the orders still on their way and what happened to the cancelled ones; an account already deleted answers `404 USER_NOT_FOUND`, a deletion by root keeps a line in the admin log, and the admin list of root names a deleted admin with its `deletedAt`
- login logging

### Authorization and security

- role model: `GUEST`, `USER`, `ADMIN`, `ROOT`
- Fastify route guards
- database-level row-level security policies
- per-transaction actor context passed into PostgreSQL
- cookie-based auth flow with HttpOnly cookies; the frontend and the API share one site (`shop.example.com` and `api.shop.example.com`), so the cookies are first-party and keep `SameSite=Lax`
- CORS and the chat WebSocket handshake let in only `WEB_ORIGIN`; `/static` images may be shown on other origins
- CSRF protection (double submit): `GET /api/auth/csrf` gives a token and keeps its secret in an httpOnly cookie, every `POST`, `PUT`, `PATCH` and `DELETE` sends the token in the `x-csrf-token` header or gets `403 CSRF_TOKEN_INVALID`; the Stripe webhook is exempt, it signs its own calls. Swagger UI adds the token by itself; in Postman or curl take a token first and keep the cookies between requests
- centralized error normalization and request/response logging

### Catalog and product management

- category listing and admin CRUD; the tree goes from the top down: a move takes the whole branch of a category, `parentId: null` moves it to the top, and a category never goes inside its own branch (`409 CATEGORY_PARENT_CYCLE`, refused by the database too, also for two moves at the same time); a new parent category gets its children one PATCH each; deleting a category gives its direct children to its parent
- product listing with filtering, sorting and cursor pages, and the product details endpoint: a buyer (guest, user) gets what helps to buy (the price, the sale, the free units, the rating, the category; the list also the popularity) and sorts by date, price, popularity, rating, name or the sale (the products on sale first, then the rest by popularity); admin and root get the counters, the whole stock, the reserve and the popularity override too, sort by any field (the price by the usual one, the sale price in the list of the products on sale) and list the deleted products, the ones on sale, with a popularity override that is on or with no more free units than a number (`maxStock`) with their flags (an override goes with its end in the future, an end with an override) (without a flag only the plain products, with one every product of its condition). A visit of an admin is not counted as a view
- admin product CRUD; a new product has no stock and a product update never changes it (`400 PRODUCT_STOCK_NOT_ALLOWED`): the stock comes with deliveries and goes with sales and write-offs
- search that forgives a typo and another order of the words and finds a product by the name of its category and by its article number too, the best match first (`sort: relevance`, the default with a search); suggestions as one types (`GET /api/products/suggestions?q=`, up to 8 names)
- category branches: a category in the filter takes the products of the categories below it (`branch=false` only its own), the card names the way to its category from the top (`category.path`), and `GET /api/categories/tree` gives the whole tree with the products of each branch
- an article number (`sku`, optional, up to 64 signs): one product of the catalog has it at a time whatever the case of its letters (`409 PRODUCT_SKU_TAKEN`); a delivery and a write-off may name a product by it in place of its id
- a product taken out of the catalog comes back with `POST /api/products/:productId/restore` (admin/root, kept in the admin log); the admin finds the products taken out with `deleted=true`
- every sale names the lowest price of the 30 days before it (`salePriorPrice`, read from the log of prices), the price a reduction is compared with; `POST /api/products/sales` puts many products on sale at once, each with its own sale or one sale for a category and its branch, all or nothing
- the safety and origin data an offer shows in the EU (GPSR): the manufacturer with its addresses and country, a person responsible in the EU for a manufacturer outside it, the warnings; a new product needs them, the card gives them as `safety`
- stock in batches (admin/root): a delivery (`POST /api/products/stock/deliveries`) takes in a batch of each item at its cost of a unit in the money of the shop, with an optional last good day and the number the supplier gave it; `source` is a supplier, a surplus an inventory found or goods a buyer brought back. A write-off (`POST /api/products/stock/write-offs`) takes free units from the batch named or from the batches in the order of a sale, with a reason (damaged, defective, expired, a shortage an inventory found, returned to the supplier, other with a note); the units the waiting orders hold stay. A sale takes the batch that ends first, then the ones without an end, the oldest first, and keeps what it took from which batch: the cost of the goods it sold; a cancel of a paid order puts the units back into the same batches. A batch whose last good day is behind the day of the shop (`SHOP_TIME_ZONE`) is over: its units are no free units anywhere a buyer looks or buys (the catalog, the cart, the confirm, the reserve, the bot), a payment of units held for an order whose batch got over meanwhile is refused and the money goes back, and an admin sees them apart (`expiredStock`) to write them off. All of a request or nothing; every step is a database function that keeps a line in the admin log (`STOCK_DELIVERY`, `STOCK_WRITE_OFF`), and the database checks that the stock is what the batches have left
- product image upload flow: images come only as files of a form (creating a product takes only a form, an update takes JSON or a form), jpeg, png or webp by their content, up to 5 MB per file; an upload waits at a temporary id and takes the place of the product images only once the product is written, a refused request leaves no files and the images as they were; the files a product no longer has after an update are deleted
- a product without an image is no part of what a buyer or a guest browses (the catalog, the suggestions, the favorites, the counts of the category tree, the products the bot names); its card opens by its id with `images: []`, and a cart that holds it shows it with `images: null`. An admin lists it with `images: null`
- product category reassignment
- sales (`PATCH /api/products/:productId/sale`, admin/root): a discount by a percent of the price or an amount off it until an end in the future, `sale: null` takes it off (the same sale again, or nothing to take off, is `409` and changes nothing); while the sale lasts the product sells at the sale price (the cart, the confirmation and its smallest payment, the price sort and the price filters of the catalog), and the product answers show `salePrice` and `saleEndsAt` next to the usual `price`; a sale past its end is left out. A new price of a product on sale says what happens to the sale (`sale`: keep it, take it off, or a new one, each step with its log lines; the bulk price update keeps or removes the sales of every product alike), without it the change is `409 PRODUCT_SALE_DECISION_REQUIRED`. The log of prices keeps the start of a sale (by its percent or amount, negative, with the end) and a sale taken off; the admin log keeps every sale as `PRODUCT_SALE` (started, changed, taken off, ended by a price down to it) with the price, the sale before and after and the discount. A free product (a sale price of 0) is bought together with something that makes the smallest payment
- bulk price update endpoint for admin/root (the usual prices)
- a change of many products at once (`PATCH /api/products/batch`, admin/root): up to 100 products, each with fields of its own, the ones of `PATCH /api/products/:productId` without images, with the same checks, words on the sale and log lines; all of them or none, a refusal names every product refused the same way in `details.products`; two products can swap their article numbers
- an admin sees next to the price the cost of a unit in the latest delivery of a supplier (`lastUnitCost`, `null` without one; a surplus or goods a buyer brought back are no purchase) in the card, the list and the answers of the changes of a product
- product view/popularity-related fields in the data model

### Reviews and favorites

- product reviews, each with its author (`user: { id, name, avatarUrls, deleted }`); a deleted account stays the author, named Guest
- each review says whether its author bought the product (`verifiedPurchase`); the list sorts by the newest, the most helpful or the rating, and the mail of a delivered order asks to rate each product
- review deletion rules for user/admin/root
- a product removed from the catalog takes no new review (`404 PRODUCT_NOT_FOUND`)
- review voting endpoint: a vote is for the review of another user, the author gets `403 REVIEW_OWN_VOTE_FORBIDDEN`
- favorites for guest/user flows

### Orders

- current order/cart retrieval
- add/update/remove current order items
- the cart shows current prices and loses the items of products deleted from the catalog for good, on every read and change; an order waiting for its payment keeps them, its payment page names them (`409 ORDER_ITEMS_UNAVAILABLE`)
- confirm current order with the shipping data: the address and the recipient (first name, last name, phone) are required, a note is optional. Names are up to 100 characters with at least one letter and no digits, the phone is `+380501234567`-style like the profile phone. An order that lost its reservation keeps them for the next confirmation; a confirmed order keeps them as they were confirmed, the database refuses any change
- the confirmation needs the consent to the versions of the terms and of the contract in force (`409 LEGAL_ACCEPTANCE_REQUIRED` with the kinds missing and the versions in force with their ids and titles: the page shows a checkbox for each and opens its text by id) and keeps the versions it was confirmed with
- the confirmation names every item it cannot take (`409 ORDER_ITEMS_UNAVAILABLE` with `details.items`: deleted from the catalog or out of stock)
- the confirmation refuses a total no payment provider takes (below 0.50 with Stripe) before any stock is held (`400 ORDER_TOTAL_BELOW_MINIMUM` with `details: { minimum, currency }`)
- the owner cancels the payment of an order waiting for it (`POST /api/orders/:orderId/cancel-payment`): the payment page is closed first by the provider that opened it, then the reservation goes and the order becomes `unconfirmed` with its items and shipping data; a payment that came first answers `409 ORDER_ALREADY_PAID`
- an unconfirmed order (cancelled payment or expired reservation) is changed like the cart (`POST/PATCH/DELETE /api/orders/:orderId/items`), at current prices and without products deleted from the catalog, and confirmed again with only its id
- order history endpoint: newest first by default, the cart is not listed; paid orders keep the prices they were paid with, unconfirmed ones show current prices. `paidFrom`/`paidTo` keep the orders paid in a period (from its start, before its end, cancelled ones too; an end that is not after the start is `400 PAID_PERIOD_INVALID`), `sortBy=paidAt` lists the paid orders by the time of their payment; `updatedFrom`/`updatedTo` keep the orders changed last in a period (`400 UPDATED_PERIOD_INVALID` the same way)
- order by id endpoint
- every order answer (cart, confirmation, history, details, admin status update) gives the same fields: the shipping data, the note, while the order waits for the payment `reservationExpiresAt`, once it is paid `paidAt` (it stays) and once an admin cancelled it `cancelledAt`; the database sets both times, the payment id and the provider that took it stay internal
- admin/root order status update endpoint (shipped, delivered); each step mails the buyer (the items, the total, the address and the recipient) unless the account is deleted, a failed mail never undoes the status
- admin/root cancel of a paid or shipped order (`POST /api/orders/:orderId/cancel`): full refund by the payment provider that took the money, in the same transaction, the stock comes back, the buyer gets a mail unless the account is deleted, the audit log keeps it; the answer gives how to reach the buyer, also a deleted one. A delivered order is not cancelled
- the desk of the orders of an admin/root: the history filters by the buyer (`userId`), a few statuses (`statuses`), a product (`productId`) and a text (`q`: the number of an order, or a part of the email of the buyer, the name or the phone of the recipient); each row names its buyer, `format=csv` gives every order of the filters as a file for the courier; `POST /api/orders/status` moves many orders to shipped or delivered, each with its own answer. Each step goes to the admin log, and a double click mails once
- an order keeps the name each product had when it was confirmed (`item.name`): the history, the mails and the payment page show what was bought after a rename; an order not paid yet shows the price and the sale of each product now
- the payment page has a line for each item and the email of the buyer; the payment carries the name of the shop (`SHOP_NAME`), as the mails do
- Redis-based timeout worker for order reservation expiry handling
- the buyer gets an email when the order is paid, with the address and the recipient (sent when the payment event of the provider comes; a failed mail never fails it); the texts of the terms and of the contract the order was confirmed with are attached to it as `terms.txt` and `contract.txt`, the copy of the contract, and its last line says so

### Payments

Payments go through payment providers, none of them is the main one: the buyer names the provider to pay with. The server has Stripe for now; each provider keeps its own routes under `/api/payments/<provider>/`, the order records which provider took its money (`paymentProvider` with `paymentId`) and refunds go back through it.

- `POST /api/payments/checkout/sessions` with `orderId` and `provider` (required, `stripe` for now) opens the payment page of an order waiting for its payment; a repeated request for the same confirmation and provider gives the same page, a page of another provider opened before is closed first. The answer names the `provider` of the page
- a total below the minimum of the provider is refused with `400 ORDER_TOTAL_BELOW_MINIMUM` (0.50 with Stripe; the confirmation refuses a total no provider takes already), an item removed from the catalog with `409 ORDER_ITEMS_UNAVAILABLE` as in the confirmation; the provider out of reach answers `503 PAYMENT_PROVIDER_UNAVAILABLE` and opens nothing

Stripe:

- a Stripe page returns the buyer to `WEB_ORIGIN/checkout/success?session_id=<id>` or `WEB_ORIGIN/checkout/cancel?orderId=<id>` (page paths agreed with the frontend, placeholders for now)
- `GET /api/payments/stripe/checkout/sessions/:sessionId` tells the page the buyer comes back to how the payment stands; Stripe is asked directly, it knows about the payment before the webhook comes. An id that is not one of a Stripe checkout session is refused with `400 VALIDATION_ERROR` before Stripe, a session Stripe does not have or one not opened for an order answers `404 CHECKOUT_SESSION_NOT_FOUND`
- `POST /api/payments/stripe/webhook` (Stripe signature, no CSRF token, outside the request rate limit; the webhook endpoint of the Stripe account points here) records the payment, returns a payment the order cannot take in full and releases the reservation of a closed page after the grace window; the same payment delivered again changes nothing, also after the order was shipped, delivered or cancelled; a page of another tool in the same Stripe account is acknowledged with `skipped: NOT_AN_ORDER` and its money is left alone

### Chat and AI assistant

- current chat thread endpoint for guest/user sessions: two tabs that open it at once get the same chat; it gives the newest 50 messages, the ones before come page by page from `GET /api/chat/threads/:threadId/messages` with `nextCursor` (a customer reads their own chats, an admin the chats given to the admins)
- WebSocket connection endpoint for realtime messaging: the message of the customer reaches the chat as soon as it is written, the answer of the bot after it; one turn of the bot at a time in a chat, a message sent while the bot answers is refused with `CHAT_BOT_REPLYING` and not kept
- thread join/read/message events
- bot welcome message for newly created chat threads
- guest and authenticated-user chat flows
- OpenAI-powered chatbot responses
- product-aware bot answers based on product context
- automatic response language matching based on the latest customer message
- bot fallback behavior when AI response generation fails (an answer the model cut short is not asked again)
- the bot knows the last 5 orders of a signed-in customer, read with the rights of that customer
- the answers of the bot a guest and a user get in 24 hours are limited (`CHAT_BOT_GUEST_DAILY_TURNS`, `CHAT_BOT_USER_DAILY_TURNS`); past them the bot answers with a text of its own and the model is asked nothing
- admin escalation flow: before the model only an explicit request for a person and a question said a third time (more than three words) are found; whether anything else needs a person the model decides by meaning. A customer with a confirmed email is asked to describe the issue, the chat goes to the admins with the same step as that answer, and the description is what enters the admin queue (`admin:requested`)
- guest admin-support guard: only customers with a confirmed email talk to an admin, a guest or a customer without one is told so
- admin queue state model based on `adminRequestedAt` and `adminUnreadSince`
- message read-state handling for bot/user/admin chat scenarios

### Admin and root capabilities

- the admin log with filters (`GET /api/admin/audit-log`: the account and the role it wrote with, the thing, the actions, a field among the changes, a period, a csv): each line keeps the address and the browser of its request; the history of the price of a product (`GET /api/products/:productId/price-history`)
- alerts in place of mails (`GET /api/admin/alerts`), the overview of the work of an admin: paid orders to ship, shipped ones not delivered for some days, products with no or few free units, batches near or past their last good day, chats with a message no admin has read, late payments given back in some last days, a reservation worker that stopped; root also the actions of the admins. Each kind comes with its count and the request to the list of the app with its cases (`list`: the orders, the catalog of an admin, the batches, the chat queue, the admin log), the most urgent first; the page of an admin shows a few rows of each, sorts them as that list sorts and leads to the list or to a case. `?subscribed=true` gives only the kinds the admin follows, for the notifications the frontend shows at the interval the admin chose when a count changed
- the settings of the alerts, each admin and each root their own (`/api/admin/alerts/subscriptions`): follow a kind or not, set its threshold within its bounds (days, units, seconds, hours) or give it back to the one the server gives (`PUT`/`DELETE .../:kind/threshold`); single cases put aside (`/api/admin/alerts/dismissals`, kept in Redis) leave the count of their kind until taken back or over
- admin stats endpoint (`GET /api/admin/stats`, admin/root): the users (the accounts of buyers, admins and root left out), the orders by status, the money paid in a period and in the last 7 and 30 days, the units sold and the average order of the period, the top products and categories of the money paid in it, the reviews and their average rating of the period; the period is `[from, to)`, all time until now unless given
- accounting report (`GET /api/admin/reports/accounting`, admin/root): for a period (`from` taken in, `to` left out; all time until now without them) and the products asked for (`productIds`) or all: the sales of the orders paid in it with their cost at the batches they took and the margin, the paid orders cancelled in it, the net of both, the batches taken in by source, the units written off by reason at their costs, and what the batches have left now; `categoryId` keeps a category, with its whole branch unless `branch=false`
- the batches of the stock and its journal (`GET /api/admin/stock/batches`, `/movements`, admin/root): each batch with what it came in with, what is left of it at its cost, what the paid orders took and what was written off, its delivery (supplier, invoice, note, the admin) and whether it is over, filtered by product, delivery, source, units left, over or ending by a day and sorted by when it came in, its last good day, what is left, its cost or its value; the journal puts the deliveries, the write-offs, the units the paid orders took and the units their cancels put back in one list by time, filtered by product, batch, order, delivery, write-off, kind and period, with the batches and the change of the stock and of its value
- accounting by product, category and time (`GET /api/admin/reports/accounting/products`, `/categories`, `/timeline`, admin/root): the same money for each row, the margin of the sales and the write-offs apart; products sorted by revenue, margin, its percent, units, write-offs, purchases, stock or name with cursor pages and totals; categories with their whole branch or their own products only; the days, weeks from monday or months of the calendar of the shop (`SHOP_TIME_ZONE`, Europe/Madrid unless set), up to 400 steps. `format=csv` gives each as a file for the accountant
- manual product popularity endpoint
- admin chat queue endpoints: the chats no admin took (`waiting`), the ones an admin took with a message unread (`active`), both (`unread`, the longest waiting first)
- root-only admin management endpoints
- root publishes the versions of the terms and of the contract

### System endpoints

- `/health`
- `/ready`
- `/info`

### API documentation

- Swagger UI for REST API documentation
- OpenAPI 3.0.3 specification generation
- grouped route documentation by domain module
- reusable response schemas for system endpoints
- cookie-based security schemes for access token, refresh token, and guest id flows, plus the `x-csrf-token` header on every route that changes data
- Swagger UI calls the server it is served from and takes the CSRF token before such a request
- documented system readiness responses for healthy and unavailable states
- raw OpenAPI JSON endpoint for external inspection and tooling
- Swagger documentation is deployed together with the running API

Current API documentation refinement work:

- adding security metadata to all protected routes
- adding operation ids for cleaner generated API documentation
- improving summaries and descriptions for all domain modules
- replacing generic response descriptions with explicit response meanings
- adding request and response examples
- adding server entries for local and deployed environments

---

## In Progress / Planned

### In progress / partial

- admin chat queue behavior is implemented, but still being refined through manual testing
- demo data goes through the routes of the shop (`db/tools/demo_data.mjs`); the old CSV reseed of `db/data` stays local and does not load the current tables
- Swagger/OpenAPI documentation is implemented, but route metadata is still being refined

### Planned

- automated tests with Jest: unit tests and integration tests against a disposable PostgreSQL and Redis in Docker
- Swagger/OpenAPI refinement for protected routes, operation ids, examples, and response descriptions
- detachable SSR/web layer for showcase pages without coupling business logic to the UI
- Dockerized local/dev/prod workflow and a production deployment target on AWS ECS/Fargate
- broader admin analytics, observability, and reporting

---

## Project Structure

```text
Cartlify/
├── db/
│   ├── schema/                 # raw SQL run in order: roles, extensions, RLS, views, functions, indexes
│   ├── fixes/                  # one-time repair scripts
│   ├── data/                   # csv import; the reseed and clear scripts stay local, not in git
│   ├── seeds/                  # csv seed data
│   └── tools/                  # test database build, structure snapshot, anonymized copy of prod for dev, demo data
├── prisma/                     # Prisma schema and migrations
├── src/
│   ├── config/                 # env and service configs
│   ├── db/                     # Prisma context helpers, DB actor context
│   ├── helpers/                # shared helpers / normalizers
│   ├── middlewares/            # auth, RBAC, logging, error handling, id validation
│   ├── plugins/                # Fastify plugins, including Swagger/OpenAPI registration
│   ├── redis/                  # Redis client and keys
│   ├── routes/api/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── products/
│   │   ├── categories/
│   │   ├── favorites/
│   │   ├── orders/
│   │   ├── reviews/
│   │   ├── admin/
│   │   ├── root/
│   │   ├── chat/
│   │   └── legal/
│   ├── schemas/                # shared AJV schemas and DTO schemas
│   ├── services/               # cross-module services
│   │   └── email/templates/    # mails as .html and .txt files with {{marks}}: auth/, orders/, users/
│   ├── types/                  # DTOs and shared TypeScript types
│   ├── utils/                  # JWT, OAuth, Cloudinary, app errors
│   └── workers/                # background workers
├── tests/
│   ├── unit/                   # no database or network, mirrors src/ paths
│   ├── integration/            # api/<module>, db, flows, worker against the Docker test stack
│   ├── helpers/                # app startup for app.inject, test environment guard
│   ├── fixtures/               # static files used by tests
│   ├── setup/                  # per-project jest setup, keeps the local .env out of tests
│   ├── coverage/               # generated coverage report (gitignored)
│   └── run.mjs                 # test launcher behind npm test
├── docker-compose.test.yml     # disposable PostgreSQL and Redis for integration tests
├── .github/workflows/          # DB migration and SQL execution workflows
└── package.json
```

---

## Environment Variables

The repository contains `.env.example` with every variable read by `src/config/env.ts` and `prisma/schema.prisma`, plus `STRIPE_TEST_SECRET_KEY`, which only the tests read.

A practical local example:

```env
# development, test or production (development unless given); any other value stops the start
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
# frontend address: mail links, oauth redirects and the only site CORS and the chat websocket let in
# (in production for example https://shop.example.com; locally the frontend dev server)
WEB_ORIGIN=https://shop.example.com
# domain the site lives on, without https:// (required in production): a deleted account gets an address on it
SITE_DOMAIN=shop.example.com

# PostgreSQL
DATABASE_URL=postgresql://cartlify_app:your_password@localhost:5432/cartlify_dev
MIGRATION_DATABASE_URL=postgresql://cartlify_owner:your_password@localhost:5432/cartlify_dev
DEV_SHADOW_DATABASE_URL=postgresql://cartlify_owner:your_password@localhost:5432/cartlify_shadow

# Auth / cookies (lifetimes in seconds: a value that is not a positive whole number stops the start)
JWT_ACCESS_SECRET=replace_this_access_secret
JWT_ACCESS_TTL_SHORT=1200
JWT_ACCESS_TTL_LONG=3600
JWT_REFRESH_SECRET=replace_this_refresh_secret
JWT_REFRESH_TTL_SHORT=86400
JWT_REFRESH_TTL_LONG=2592000
GUEST_ID_TTL=157680000
RESET_TTL_MS=3600000
BCRYPT_ROUNDS=12
# the avatar removals by a moderator the rules allow an account (5 unless given)
AVATAR_REMOVALS_LIMIT=5
# the requests a minute one address may make (100 unless given)
RATE_LIMIT_MAX=100
# multiplies the limits of the login, the registration, the mails and the payment page (1 unless given)
REQUEST_LIMITS_SCALE=1
# the proxies in front of the server whose x-forwarded-for is trusted (1 unless given: railway puts one)
TRUST_PROXY_HOPS=1
# true logs the addresses of each request, to check how many proxies a new host puts in front
LOG_REQUEST_ADDRESSES=false
# the time zone of the days and months of the reports (Europe/Madrid unless given)
SHOP_TIME_ZONE=Europe/Madrid
# the name of the shop on a payment and in the mails (Cartlify unless given)
SHOP_NAME=Cartlify

# Redis
REDIS_URL=redis://localhost:6379
REDIS_ORDER_TIMEOUT_WORKER_MS=3000

# OpenAI / AI assistant
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
OPENAI_TIMEOUT_MS=12000
OPENAI_MAX_OUTPUT_TOKENS=450
# the answers of the chat bot a guest and a user get in 24 hours (30 and 100 unless given)
CHAT_BOT_GUEST_DAILY_TURNS=30
CHAT_BOT_USER_DAILY_TURNS=100

# Cloudinary (required: the app does not start without CLOUDINARY_URL or the three keys;
# the upload tests use them too, see Run Commands)
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
CLOUDINARY_URL=

# SendGrid (required only if you test email flows)
SENDGRID_API_KEY=
EMAIL_FROM=
EMAIL_FROM_NAME=
EMAIL_REPLY_TO=

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
GOOGLE_STATE_SECRET=

# GitHub OAuth
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_REDIRECT_URI=
GITHUB_STATE_SECRET=

# LinkedIn OAuth
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
LINKEDIN_REDIRECT_URI=
LINKEDIN_STATE_SECRET=

# Stripe (STRIPE_SECRET_KEY must be set and start with sk_, otherwise the app does not start)
STRIPE_SECRET_KEY=sk_test_replace_this_key
# the signing secret of the webhook endpoint: required in production, elsewhere the start warns
# that every stripe event is refused without it
STRIPE_WEBHOOK_SECRET=
# a three letter code of a currency with cents (eur unless given); jpy, kwd and the like stop the start
STRIPE_CURRENCY=eur

# tests only, the app never reads it: the secret key of a Stripe test sandbox (sk_test_)
# the payment tests pay and refund with; never a live key, the tests stop on any other
STRIPE_TEST_SECRET_KEY=
```

---

## Local Setup

### 1. Clone and install

```bash
git clone https://github.com/MaksymDziubanchuk/Cartlify.git
cd Cartlify
npm install
```

### 2. Create local environment file

```bash
cp .env.example .env
```

Then update `.env` using the example above.

### 3. Create PostgreSQL databases

You need:

- main database for development
- shadow database for Prisma dev migrations
- Redis instance for the order timeout worker

Example:

```bash
createdb cartlify_dev
createdb cartlify_shadow
```

### 4. Initialize DB roles and schema

The database is built in the same order as the test database (`db/tools/test_db_build.mjs`);
the order differs from the file numbers. Run the bootstrap script as a superuser before the
Prisma migrations, so the `cartlify` schema and the roles exist, then give the roles their
passwords (as the superuser too):

```bash
psql -v ON_ERROR_STOP=1 -f "db/schema/01_roles_and_schemas.sql" "$SUPERUSER_DATABASE_URL"
psql -v ON_ERROR_STOP=1 -c "ALTER ROLE cartlify_owner PASSWORD '<owner password>'; ALTER ROLE cartlify_app PASSWORD '<app password>'; ALTER ROLE cartlify_readonly PASSWORD '<readonly password>';" "$SUPERUSER_DATABASE_URL"
```

### 5. Generate Prisma client

```bash
npm run prisma:generate
```

### 6. Run Prisma migrations

The tables are created by the owner role, the way migrations run on the hosted databases:

```bash
DATABASE_URL="$OWNER_DATABASE_URL" npm run migrate:deploy
```

### 7. Apply PostgreSQL hardening layer

These scripts add extensions, RLS, functions, triggers, views, and additional indexes that go beyond basic Prisma migrations. Run them in this order: `02` needs the tables, the policies of `03` call functions from `05`, and the second run of `01` grants rights on everything created after its first run:

```bash
psql -v ON_ERROR_STOP=1 -f "db/schema/02_extensions.sql" "$SUPERUSER_DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/schema/05_fn_and_triggers.sql" "$OWNER_DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/schema/03_policies_and_rls.sql" "$OWNER_DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/schema/04_views.sql" "$OWNER_DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/schema/06_indexes_and_constraints.sql" "$OWNER_DATABASE_URL"
psql -v ON_ERROR_STOP=1 -f "db/schema/01_roles_and_schemas.sql" "$SUPERUSER_DATABASE_URL"
```

Compare the result with the reference of the structure (read only): `DATABASE_URL="$APP_DATABASE_URL" npm run db:snapshot:check:db`.

### 8. Start Redis

Example with a local Redis server:

```bash
redis-server
```

### 9. Start the app

```bash
npm run dev
```

If everything is configured correctly, check:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3000/info
```

Swagger UI is available at:

```bash
http://localhost:3000/documentation
```

Raw OpenAPI JSON is available at:

```bash
http://localhost:3000/documentation/json
```

---

## Run Commands

```bash
# development
npm run dev

# build: tsc, then tsc-alias puts relative paths in place of the @… aliases in dist
npm run build

# start the built app with node (dist/index.js); the mail templates, the logo and /static
# are read from src/ in the working directory, so src/ stays next to dist/
npm start

# generate prisma client
npm run prisma:generate

# create/apply prisma migration in development
npm run prisma:migrate

# apply existing prisma migrations (deployment style)
npm run migrate:deploy

# lint
npm run lint

# format
npm run format

# type check
npm run typecheck

# tests: pick test parts in a checkbox list (all parts without an interactive terminal);
# integration parts rebuild the Docker test database first and remove it after the run,
# Docker must be running;
# every answer of the app in the integration tests is held against the Swagger document: a status,
# an error code or a field it does not describe fails the test (tests/helpers/contract.ts)
npm test

# keep the test database running after the tests to look inside
npm test -- api:orders --keep-db

# tests by part name or group (all, unit, integration, api)
npm test -- unit api:orders

# rerun only the tests that failed last time
npm test -- --failed

# integration files run at the same time, one per core and at most 6; one by one:
npm test -- --workers=1
# a file that changes what the whole shop sees and cannot undo it (a version of the terms in
# force) is named *.shopwide.test.ts: it runs after the others and alone
# (tests/setup/sequencer.mjs, tests/setup/integration.shopState.ts)

# external services answer from mocks unless the run names them (the Services checkboxes,
# or service:<name>). Real SendGrid takes SENDGRID_API_TEST_KEY and EMAIL_FROM, EMAIL_FROM_NAME,
# EMAIL_REPLY_TO from .env (never SENDGRID_API_KEY); the tests send every mail in sandbox mode,
# SendGrid checks it and delivers nothing. GitHub Actions takes the secrets of the same names
npm test -- api:auth service:sendgrid

# real Cloudinary takes CLOUDINARY_* from .env: Cloudinary has no test mode, the upload tests
# upload into the test/ folder of the account and delete what they uploaded. GitHub Actions
# takes the CLOUDINARY_URL secret
npm test -- api:users api:products service:cloudinary

# Stripe answers from a mock of the test sandbox unless the run takes it for real: then the
# payment tests use Stripe in test mode with STRIPE_TEST_SECRET_KEY from .env (never
# STRIPE_SECRET_KEY). Either way they open payment pages, pay them with a test card and deliver
# the events to the webhook themselves, so the sandbox needs no webhook endpoint. Keep `stripe
# listen` off during a real run, it would forward their events to a dev server. The answers the
# mock gives are checked against the sandbox by tests/integration/api/payments/stripeAnswers.test.ts
# in both modes. GitHub Actions takes the STRIPE_TEST_SECRET_KEY secret
npm test -- api:payments api:orders service:stripe

# the bot tests answer as the model themselves; the tests of the model itself
# (api/chat/model.test.ts) ask OpenAI for real with OPENAI_API_TEST_KEY from .env (never
# OPENAI_API_KEY), a few cents a run, and check the form of the answer, not its words. GitHub
# Actions takes the OPENAI_API_TEST_KEY secret
npm test -- api:chat service:openai

# unit or integration tests only
npm run test:unit
npm run test:integration

# demo data through the routes of a running api: a tree of categories, 16 products with images,
# their stock by a delivery, sales, three buyers with carts, orders, reviews and favorites; what
# is there stays, a run adds only what is missing. The shop lets a buyer in only with a confirmed
# email: the first run registers the buyers, confirm the mails, the next run gives them their
# orders. DEMO_EMAIL_DOMAIN is the domain of their addresses (example.com reaches nobody)
DEMO_API_URL='<api url>' DEMO_ADMIN_EMAIL='<admin email>' DEMO_ADMIN_PASSWORD='<password>' \
  DEMO_USERS_PASSWORD='<password of the buyers>' node db/tools/demo_data.mjs

# a copy of prod for dev with made-up people, not a backup: prod is read into a throwaway
# postgres container, its buyers, orders, chats and logs are anonymized there, the dump goes to
# db/restore/ (git ignores it) and into dev with the owners and rights of the scripts. Both urls
# of a superuser, given on the command only; Docker must be running. --dump-only makes the dump
# only, --from <dump> restores dev from one; DEV_USERS_PASSWORD gives the buyers of the copy a
# password
PROD_URL='<prod superuser url>' DEV_URL='<dev superuser url>' node db/tools/dev_restore_from_prod.mjs
```

---

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
- `api/reviews/*`
- `api/admin/*`
- `api/root/*`
- `api/chat/*`
- `api/legal/*`

Examples of implemented business endpoints:

- auth: register, login, refresh, logout, verify, password reset, OAuth callbacks, CSRF token
- users: admin list of users, get/update current user (an empty avatar removes it), get user by id, moderator removal of an avatar, root delete user
- products: list, details, reviews, create/update/delete, upload images, sale, bulk price update, a change of many products
- categories: list, create, update, delete
- favorites: get/add/remove
- orders: current cart, item mutations (also of an unconfirmed order), confirm, cancel of a payment, history, details, admin status update, admin cancel with refund
- reviews: vote on review
- admin: stats, product popularity, admin chat queues
- root: manage admins, publish the terms and the contract
- legal: the versions in force, a version by id, the consents of the user

---

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
- cookie-based auth schemes for access token, refresh token, and guest id, and the `x-csrf-token` header scheme
- health, readiness, and project information endpoints
- separate readiness responses for healthy and unavailable states

The documentation is being improved further with:

- security metadata for all protected routes
- operation ids for all documented operations
- clearer summaries and descriptions for domain modules
- explicit response descriptions instead of generic default responses
- request and response examples
- local and deployed server entries in the OpenAPI spec

---

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

The chat module is implemented, but admin workflow details are still being refined through manual testing.

---

## Production Notes

This repository is still in active development and should not be treated as a fully production-ready deployment package yet.

Current production-oriented pieces already present:

- PostgreSQL RLS and custom SQL hardening scripts
- separate runtime and migration database credentials
- Redis-backed order timeout worker
- JWT cookie auth with refresh-token flow
- OAuth support
- structured backend module boundaries
- Swagger/OpenAPI documentation deployed with the running API

Planned production improvements:

- automated unit and integration tests
- Swagger/OpenAPI refinement with full protected-route security metadata and request/response examples
- Dockerized local/dev/prod workflow
- AWS ECS/Fargate deployment target
- broader monitoring, metrics, and operational reporting

---

## License

Copyright (c) 2025-2026 Maksym Dziubanchuk. All rights reserved.

The source code is public only to be viewed as part of the author's portfolio. It is not open source: using, copying, modifying, distributing or deploying it, in whole or in part, needs prior written permission from the author. See [LICENSE](LICENSE).
