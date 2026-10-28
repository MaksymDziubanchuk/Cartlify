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
- `api/admin/*`
- `api/root/*`
- `api/chat/*`
- `api/legal/*`

Examples of implemented business endpoints:

- auth: register, login, refresh, logout, verify, password reset, OAuth callbacks, CSRF token
- users: admin list of users, get/update current user (an empty avatar removes it), get user by id, moderator removal of an avatar, root delete user
- products: list, details, reviews (the check of a comment, the removals of a moderator), create/update/delete, upload images, sale, bulk price update, a change of many products
- categories: list, create, update, delete
- favorites: get/add/remove
- orders: current cart, item mutations (also of an unconfirmed order), confirm, cancel of a payment, history, details, admin status update, admin cancel with refund
- reviews: vote on review
- admin: stats, product popularity, admin chat queues
- root: manage admins, publish the terms and the contract
- legal: the versions in force, a version by id, the consents of the user

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
