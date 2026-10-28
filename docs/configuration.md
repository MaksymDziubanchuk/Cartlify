# Configuration

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
# the pages of the frontend on WEB_ORIGIN the server links to and sends the browser back to, a path from /;
# the page of an order or of a product names it by {id}
# the page a login with google, github or linkedin comes back to
WEB_PAGE_OAUTH_CALLBACK=/auth/callback
# the page the mail after a change of the password links to
WEB_PAGE_LOGIN=/web/login
# the page the link of an email verification opens, with ?token=
WEB_PAGE_VERIFY_EMAIL=/web/login
# the page the link of a password reset opens, with ?token=
WEB_PAGE_PASSWORD_RESET=/web/auth/reset
# the page the stripe payment page sends the buyer back to, with ?session_id=
WEB_PAGE_CHECKOUT_SUCCESS=/checkout/success
# the page the stripe payment page sends the buyer back to on cancel, with ?orderId=
WEB_PAGE_CHECKOUT_CANCEL=/checkout/cancel
# the page the mails of an order link to
WEB_PAGE_ORDER=/orders/{id}
# the page the mail of a delivered order asks to rate each product on
WEB_PAGE_PRODUCT_REVIEWS=/products/{id}#reviews

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
# the life of the link of an email verification in ms (a day unless given)
VERIFY_TTL_MS=86400000
BCRYPT_ROUNDS=12
# the avatar removals by a moderator the rules allow an account (5 unless given)
AVATAR_REMOVALS_LIMIT=5
# the removals of the reviews of an author by a moderator the rules allow (5 unless given)
REVIEW_REMOVALS_LIMIT=5
# the requests a minute one address may make (100 unless given)
RATE_LIMIT_MAX=100
# multiplies every limit of a route (1 unless given)
REQUEST_LIMITS_SCALE=1
# the proxies in front of the server whose x-forwarded-for is trusted (1 unless given: railway puts one)
TRUST_PROXY_HOPS=1
# true logs the addresses of each request, to check how many proxies a new host puts in front
LOG_REQUEST_ADDRESSES=false
# the most requests of each limit of a route, the windows stay in the code
# the logins from one address in 10 minutes
LIMIT_LOGIN_PER_ADDRESS=30
# the logins of one email in 10 minutes
LIMIT_LOGIN_PER_EMAIL=10
# the registrations from one address in an hour
LIMIT_REGISTER_PER_ADDRESS=10
# the mails of a reset or a verification from one address in 15 minutes
LIMIT_MAIL_PER_ADDRESS=10
# the mails of a reset or a verification to one address in 3 minutes
LIMIT_MAIL_PER_EMAIL=1
# the payment pages of a user in a minute
LIMIT_CHECKOUT_PER_USER=10
# the changes of the password of a user in 15 minutes
LIMIT_PASSWORD_CHANGE_PER_USER=10
# the exports of the data of a user in an hour
LIMIT_EXPORT_PER_USER=1
# the reviews of a user in an hour
LIMIT_REVIEW_PER_USER=30
# the wrong passwords of an account before its login pauses for a minute, doubling after
LOGIN_FAILURES_BEFORE_PAUSE=5
# the biggest file of a form in bytes and the most pictures of a product
UPLOAD_MAX_BYTES=5000000
PRODUCT_IMAGES_MAX=10
# the minutes a confirmed order holds its units and the minutes stripe keeps its payment page open
# after them (at least 30); both together at most 1440, the 24 hours stripe takes
ORDER_RESERVATION_MINUTES=15
STRIPE_PAGE_AFTER_RESERVATION_MINUTES=30
# the time zone of the days and months of the reports (Europe/Madrid unless given)
SHOP_TIME_ZONE=Europe/Madrid
# the name of the shop on a payment, in the mails, in the chat bot and in the documentation (Cartlify unless given)
SHOP_NAME=Cartlify
# the logo of every mail, a png or jpeg file from the folder of the server
SHOP_LOGO_PATH=src/static/images/logo3.png

# how the shop gets an order to its buyer: a list of manual (the shop sends it itself with a carrier
# it works with outside the app) and pickup (the buyer collects it at the shop)
DELIVERY_METHODS=manual,pickup
# what a buyer pays for the manual delivery, to the cent (nothing unless given)
DELIVERY_FLAT_PRICE=4.99
# from this sum of the items on the manual delivery is free, the sum itself included
DELIVERY_FREE_FROM=50
# the countries the manual delivery goes to, codes through commas, from AT, BE, BG, HR, CY, CZ, DK, EE,
# FI, FR, DE, GR, HU, IE, IT, LV, LT, LU, MT, NL, PL, PT, RO, SK, SI, ES, SE, GB, CH, NO, IS, LI, UA;
# required while the manual delivery is on, in every environment: without it the server does not start
DELIVERY_COUNTRIES=UA,PL,DE
# where and when a buyer collects an order, required while the pickup is on
PICKUP_ADDRESS=Main street 1, Kyiv
PICKUP_HOURS=Mon-Fri 10:00-18:00

# Redis
REDIS_URL=redis://localhost:6379
REDIS_ORDER_TIMEOUT_WORKER_MS=3000

# OpenAI / AI assistant and the check of the comments of reviews; the check asks the model for
# temperature 0, a model that does not take it (a reasoning one) lets every comment through
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
OPENAI_TIMEOUT_MS=12000
OPENAI_MAX_OUTPUT_TOKENS=450
# the answers of the chat bot a guest and a user get in 24 hours (30 and 100 unless given)
CHAT_BOT_GUEST_DAILY_TURNS=30
CHAT_BOT_USER_DAILY_TURNS=100
# the model and the moderation of openai check the comments of reviews; false publishes them unchecked
REVIEW_CHECK_ENABLED=true

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
