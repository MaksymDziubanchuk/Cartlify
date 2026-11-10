# Configuration

## Environment Variables

The repository contains `.env.example` with every variable read by `src/config/env.ts` and `prisma/schema.prisma`, plus `STRIPE_TEST_SECRET_KEY`, which only the tests read.

Some of what used to be an environment variable now lives in the `shop_settings` table instead, because root changes it without a deploy: delivery, the brand of a mail, the reservation and payment page minutes, the check of reviews, the limits a moderator's removals run into, the grace days of withdrawal, how many newsletter campaigns may go out in a window of days, the name the newsletters are sent under, the domains a newsletter text may name besides the shop's own, the logo, and which languages the shop answers in. See [shop settings](shop-settings.md) for the full list, the versions, and what a request does with a field root never filled in. What the variables of the newsletters and the captcha are for, and the setup outside the code (the SendGrid stream, the Event Webhook, Turnstile), is in [newsletters](newsletters.md).

A practical local example:

```env
# development, test or production (development unless given); any other value stops the start
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
# frontend address: mail links, oauth redirects and the only site CORS and the chat websocket let in
# (for example https://shop.example.com; locally the frontend dev server). Without it there is no
# frontend, in development as in production; only the tests fall back to http://localhost:3000
WEB_ORIGIN=https://shop.example.com
# address the API is reached on from outside (an https address in production, no path): the one-click unsubscribe of a newsletter mail (the header List-Unsubscribe) names it. Required in development and production, the start stops without it (only the tests may go without)
API_ORIGIN=https://api.shop.example.com
# domain the site lives on, without https:// (required in development and production, only the tests fall back to example.com): a deleted account gets an address on it
SITE_DOMAIN=shop.example.com
# the pages of the frontend on WEB_ORIGIN the server links to and sends the browser back to, a path from /;
# the page of an order or of a product names it by {id}
# the page a login with google, github or linkedin comes back to
WEB_PAGE_OAUTH_CALLBACK=/auth/callback
# the page the mail after a change of the password links to
WEB_PAGE_LOGIN=/web/login
# the page the link of an email verification opens, with #token= (after the #, which no server sees; the page posts it to POST /api/auth/verify; no # in the value)
WEB_PAGE_VERIFY_EMAIL=/web/login
# the page the link of a password reset opens, with #token= (after the #, which no server sees; the page posts it with the new password to POST /api/auth/password/reset; no # in the value)
WEB_PAGE_PASSWORD_RESET=/web/auth/reset
# the page the stripe payment page sends the buyer back to, with ?session_id=
WEB_PAGE_CHECKOUT_SUCCESS=/checkout/success
# the page the stripe payment page sends the buyer back to on cancel, with ?orderId=
WEB_PAGE_CHECKOUT_CANCEL=/checkout/cancel
# the page the mails of an order link to
WEB_PAGE_ORDER=/orders/{id}
# the page of the form of withdrawal the mails link to; the code of the order follows the # of the link
WEB_PAGE_WITHDRAWAL=/orders/{id}/withdrawal
# the page the mail of a delivered order asks to rate each product on
WEB_PAGE_PRODUCT_REVIEWS=/products/{id}#reviews
# the page of a product the cards of a newsletter mail link to ({id} once)
WEB_PAGE_PRODUCT=/products/{id}
# the page of a category the cards of a newsletter mail link to ({id} once)
WEB_PAGE_CATEGORY=/categories/{id}
# the page the button "Confirm the subscription" of the newsletter mail opens, with #token= (no # in the value)
WEB_PAGE_NEWSLETTER_CONFIRM=/newsletter/confirm
# the page the button "This is not me" of the same mail opens, with #token= (no # in the value)
WEB_PAGE_NEWSLETTER_DECLINE=/newsletter/decline
# the page "Manage the subscription" of the newsletter mails opens, with #token= (no # in the value); the unsubscribe button of a mail leads there too, with #unsubscribe=
WEB_PAGE_NEWSLETTER_MANAGE=/newsletter/manage

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
# the registrations of one email in 3 minutes; only a registration that succeeds counts
LIMIT_REGISTER_PER_EMAIL=1
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
# the translations of the texts of a campaign a manager of the newsletters asks for in an hour
LIMIT_NEWSLETTER_TRANSLATE_PER_USER=20
# the test mails of a campaign a manager of the newsletters sends in an hour, in all campaigns together
LIMIT_NEWSLETTER_TEST_PER_USER=30
# the requests from one address to the pages behind the links of the newsletter mails (confirm, "this is not me", the management of a subscription) in 10 minutes: a fixed window, it starts with the first request of the address and ends 10 minutes later, then the count starts over
LIMIT_NEWSLETTER_LINK_PER_ADDRESS=60
# the requests from one address to the unsubscribe button of the newsletter mails (the one-click POST of a mail client and the GET of its link, one count, apart from the one above) in 10 minutes, the same kind of fixed window, which the general limit above does not count; wide because a mailbox provider unsubscribes many readers from the few addresses of its servers
LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS=1000
# the calls of an admin by the button of a chat the bot could not answer, from a user in an hour
LIMIT_CHAT_CALL_ADMIN_PER_USER=10
# the statements of withdrawal a user makes from their account in an hour
LIMIT_WITHDRAWAL_PER_USER=10
# the requests of the public form of withdrawal from one address in an hour
LIMIT_WITHDRAWAL_FORM_PER_ADDRESS=20
# the requests of the public form of withdrawal for one order without its code, from every address, in an hour
LIMIT_WITHDRAWAL_FORM_PER_ORDER=5
# the requests of the public form of withdrawal with the same phone (or name) of a recipient without the code, from every address, in an hour
LIMIT_WITHDRAWAL_FORM_PER_DATA=5
# the wrong passwords of an account before its login pauses for a minute, doubling after
LOGIN_FAILURES_BEFORE_PAUSE=5
# the biggest file of a form in bytes and the most pictures in the gallery of a product; the most
# variants of a product and the most pictures of the gallery one variant shows; the biggest PDF of a
# document in bytes and the most documents of a product. The start stops above a bound (a zero too
# many would let one request write thousands of rows): 100000000 bytes for a file or a document,
# 1000 pictures in a gallery, 10000 variants of a product, 100 pictures of a variant, 100 documents
# of a product
UPLOAD_MAX_BYTES=5000000
PRODUCT_IMAGES_MAX=50
PRODUCT_VARIANTS_MAX=200
VARIANT_IMAGES_MAX=10
DOCUMENT_MAX_BYTES=20000000
PRODUCT_DOCUMENTS_MAX=20
# the values one characteristic of a choice has at most (10000 at most)
ATTRIBUTE_OPTIONS_MAX=500
# the values of a set (a characteristic that holds several values of its list) one variant has for
# one characteristic (1000 at most)
ATTRIBUTE_MULTI_VALUES_MAX=50
# the time zone of the days and months of the reports (Europe/Madrid unless given)
SHOP_TIME_ZONE=Europe/Madrid

# Redis
REDIS_URL=redis://localhost:6379
REDIS_ORDER_TIMEOUT_WORKER_MS=3000

# OpenAI / AI assistant and the check of the comments of reviews; the check asks the model for
# temperature 0, a model that does not take it (a reasoning one) lets every comment through
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
OPENAI_TIMEOUT_MS=12000
OPENAI_MAX_OUTPUT_TOKENS=450
# the answers of the chat bot a guest and a user get in 24 hours (30 and 100 unless given); a user
# with an unconfirmed email counts as a guest
CHAT_BOT_GUEST_DAILY_TURNS=30
CHAT_BOT_USER_DAILY_TURNS=100
# the turns of guests and unconfirmed users from one address in 24 hours (60 unless given); a new
# cookie or a new account does not reset them
CHAT_BOT_IP_DAILY_TURNS=60
# the turns of the whole shop that call the model in 24 hours (3000 unless given): the ceiling of the
# bill of the bot, past it the bot answers with its fallback text and asks the model nothing
CHAT_BOT_SHOP_DAILY_TURNS=3000

# Cloudinary (required: the app does not start without CLOUDINARY_URL or the three keys;
# the upload tests use them too, see Run Commands)
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
CLOUDINARY_URL=

# SendGrid (required only if you test email flows)
SENDGRID_API_KEY=
EMAIL_FROM=

# The newsletters and the captcha: all of these are required, the start stops without them in
# development and in production (the dev server is a copy of production); only the tests have values
# of their own. A value of spaces only is missing too. The newsletters go through a SendGrid stream of
# their own, apart from the mails of orders above: another API key, another Event Webhook, lists of
# complaints and bounces of their own (a separate account or subaccount; one account for both is for
# development only, and its lists overlap).
# The key of the SendGrid account of the newsletters, with the rights Mail Send and Suppressions
SENDGRID_NEWSLETTER_API_KEY=
# The Verification Key SendGrid shows for the Event Webhook of that account: the base64 of a DER
# public key of the curve P-256 (ECDSA). Any other key stops the start
SENDGRID_NEWSLETTER_WEBHOOK_KEY=
# The sender of the newsletters, a bare address of the authenticated domain (news@mail.example.com).
# The mails carry no Reply-To; point the replies of that address nowhere
NEWSLETTER_EMAIL_FROM=
# The secret of the HMAC of the blocklist of the subscription form: base64 or base64url of 32 bytes
# or more (for example `openssl rand -base64 48`). It must differ between the environments (dev and
# prod each have their own) and from NEWSLETTER_LINK_SECRET, and it is never changed after the
# launch: the blocked addresses would stop being found and the blocklist would stop blocking
NEWSLETTER_BLOCK_SECRET=
# The secret that signs the tokens of the links of every newsletter: the link "Manage the subscription"
# and the unsubscribe button (the header List-Unsubscribe), each with a mark of its own: base64 or
# base64url of 32 bytes or more. It must differ between the environments and from
# NEWSLETTER_BLOCK_SECRET, and it is never changed after the launch: the links in the mails already
# sent would stop working
NEWSLETTER_LINK_SECRET=
# The newsletters sent in one day, a whole number from 1. Set it under the plan of SendGrid, whose
# limit the mails of orders share (for example 1000 on prod, 100 on dev); what does not fit goes the
# next day
NEWSLETTER_DAILY_LIMIT=
# The minutes a newsletter mail the provider did not take (a busy provider, no answer in time, a
# refusal in a run of refusals that stopped the pass) waits before it is tried again, a whole number
# from 1 to 1440. It is also how long the pass that took the mail keeps it: a pass that died on a mail
# frees it after this time.
NEWSLETTER_RETRY_MINUTES=10
# How many times a newsletter mail is tried before it is given up and counted as rejected, a whole
# number from 1 to 20. A refusal of the provider that will not change (a bad request) gives a mail up
# as soon as the pass knows the fault is the mail's, whatever this is.
NEWSLETTER_MAX_ATTEMPTS=5
# The secret key of the Cloudflare Turnstile widget that checks the captcha on the registration, the
# password reset, the verification mail and the subscription form. The test secret of Cloudflare
# 1x0000000000000000000000000000000AA passes every check (for dev until the frontend has its widget)
TURNSTILE_SECRET_KEY=

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
# the signing secret of the webhook endpoint: required, the start stops without it in development
# and production (only the tests go without; every stripe event would be refused)
STRIPE_WEBHOOK_SECRET=
# signs the number of an order into the code of the links of withdrawal in the mails (32 characters
# at least): required, the start stops without it in development and production. Use another
# value on dev than on prod, so the codes of prod do not work there. Changing it stops all the
# links sent before
WITHDRAWAL_CODE_SECRET=
# a three letter code of a currency with cents (eur unless given); jpy, kwd and the like stop the start
STRIPE_CURRENCY=eur

# tests only, the app never reads it: the secret key of a Stripe test sandbox (sk_test_)
# the payment tests pay and refund with; never a live key, the tests stop on any other
STRIPE_TEST_SECRET_KEY=
```
