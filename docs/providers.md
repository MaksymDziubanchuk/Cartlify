# Providers of the outside services

Every outside service Cartlify works with sits behind an interface of its own kind. The rest of the app knows the interface, never the provider. A provider can be replaced, or joined by another one with the same function, without touching the orders, the returns, the newsletters, the catalog or the database.

## The kinds and their providers

| Kind     | Folder                   | What the app asks of it                                                                                                                                                              | Providers                                       | Chosen by                                                                                               |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Payments | `src/providers/payments` | a payment page for an order, its state, refunds, disputes and their evidence, its own events                                                                                         | Stripe                                          | the buyer picks one at the payment page (`provider`); every provider of the registry is offered         |
| Mail     | `src/providers/mail`     | a mail of a stream (the orders, the newsletters), taking an address off the list of complaints, the events of the mails of the newsletters                                           | SendGrid                                        | `MAIL_PROVIDER` (`sendgrid` unless set)                                                                 |
| Files    | `src/providers/files`    | pictures and the pdf files of documents: keep, move, delete, serve in the sizes of a page, the avatar of a letter                                                                    | Cloudinary                                      | `FILE_STORAGE_PROVIDER` (`cloudinary`)                                                                  |
| AI       | `src/providers/ai`       | a text to a request (the chat bot, the check of the reviews, the drafts of the translations), the scores of a moderation                                                             | OpenAI                                          | `AI_PROVIDER` (`openai`)                                                                                |
| Captcha  | `src/providers/captcha`  | whether the answer of the widget a visitor solved is good                                                                                                                            | Cloudflare Turnstile                            | `CAPTCHA_PROVIDER` (`turnstile`)                                                                        |
| Accounts | `src/providers/identity` | the login with an account at the provider: the start, the state, the person the provider vouches for, the address of their picture                                                   | Google, GitHub, LinkedIn                        | each has its own routes, `/api/auth/oauth/<name>` and `/api/auth/<name>/callback`; the person picks one |
| Delivery | `src/providers/delivery` | the carriers that take a parcel and their prices, the parcel with its label, its void, the commercial invoice of a parcel with the tax number of the shop, the events of the parcels | ShippyPro                                       | `DELIVERY_PROVIDER` (`shippypro`)                                                                       |
| Tax      | `src/providers/tax`      | the tax of a cart sent to a country by the rules root wrote, the threshold a country shares with others                                                                              | own (the rules of the records of the countries) | `TAX_PROVIDER` (`own`)                                                                                  |
| Receipts | `src/providers/receipts` | a fiscal receipt of a document registered at the tax authority, its state, the countries of a seller and the moment it serves                                                        | none, fiskaly (SIGN ES)                         | `RECEIPT_PROVIDER` (`none` unless set)                                                                  |

The settings of each provider keep its own names (`STRIPE_SECRET_KEY`, `SENDGRID_API_KEY`, `SHIPPYPRO_API_KEY`, `FISKALY_API_KEY`, `CLOUDINARY_URL`, `OPENAI_API_KEY`, `TURNSTILE_SECRET_KEY`, `GOOGLE_CLIENT_ID` and the like, see [configuration](configuration.md)). `src/config/env.ts` reads them; only the folder of the provider uses them.

## The shape of a kind

```text
src/providers/
├── provider.ts              # what every provider has (name, label) and the choice by a setting
├── callbackPaths.ts         # the paths the providers call the server on, outside the request rate limit
└── <kind>/
    ├── types.ts             # the interface of the kind in our words: its actions, its answers, its errors
    ├── names.ts             # the names of its providers, no client: the schemas and the settings read it
    ├── index.ts             # the registry the app asks, and what the kind does whatever the provider
    └── <provider>/          # one folder for each provider: its client, its settings, its webhook,
                             # the way its answers and its events become ours
```

- **Our words.** An answer of a provider is turned into the words of the kind before it leaves its folder: a refusal of a mail is `MAIL_PROVIDER_REFUSED` with whose fault it is (`refused`, `account`, `busy`), a provider that does not answer is `MAIL_PROVIDER_UNREACHABLE`, `PAYMENT_PROVIDER_UNAVAILABLE`, `DELIVERY_PROVIDER_UNAVAILABLE`, `RECEIPT_PROVIDER_UNAVAILABLE`, `IMAGE_STORAGE_UNAVAILABLE`, `CAPTCHA_UNAVAILABLE`, `OAUTH_PROVIDER_UNAVAILABLE`; an event of a mail is `bounced`, `dropped` or `complained`, a drop the provider made for an address it knew is `address_bounced` or `address_complained`. Nothing the provider said reaches an answer of the api; what it answered stays in the cause of the error, for the log. One exception: a carrier that refuses a parcel (`DELIVERY_PARCEL_REFUSED`) gives its reason to the admin in `details.message` (a street it does not know, a weight it does not take), for the admin to fix the order and try again.
- **Its own routes.** A provider that calls the server (the events of the payments, of the mails, of the parcels) has its route under its name: `/api/payments/stripe/webhook`, `/api/newsletters/sendgrid/webhook`, `/api/delivery/shippypro/webhook`. It checks its own signature on the exact bytes of the body, or a secret of its own in a header when the provider signs nothing (ShippyPro). The registry registers the routes and puts the paths outside the request rate limit.
- **The database names no provider.** A provider is a value of a type (`PaymentProvider`, `AuthProvider`) or a name of a registry, never a column: the transaction of the balance a dispute moved is `money_log.balanceTxId`, the id of a dispute at its provider `payment_disputes.providerDisputeId`, the statement of the system for a payment given back by hand at the provider has the reason `provider_refund`, the setting of the minutes of a payment page is `paymentPageMinutes`.
- **The bounds of a provider are its own.** What a provider takes or keeps is a property of it, the app reads the bounds of all of them: the smallest total of a payment, the minutes a payment page stays open, the longest answer of a captcha widget, the biggest body of a webhook.

## What keeps it so

- `tests/unit/providers/boundaries.test.ts` reads the code: the name of a provider (and of its client) appears only in its folder, in the registry and the names of its kind, and in `src/config/env.ts` (the names of its settings). A few words that mean something else are listed with the reason (`googlemail.com` is the mail domain of Gmail). A file of the app that names a provider fails it.
- `tests/integration/providers/<kind>.contract.test.ts` is the contract of a kind, written once: every provider of the registry goes through the same tests, made to answer by its entry in `tests/helpers/providers.ts` (its mock, or the real service when a run takes it, `npm test -- service:<name>`). The contract of the models runs against the mock only, a real one is paid for every request.

## How to add a provider

1. Make the folder `src/providers/<kind>/<name>/` with the provider: an object of the interface of the kind (`types.ts`), its client and its settings. Turn every answer and every event of the provider into the words of the kind there.
2. Add its name to `names.ts` and the provider to the list of `index.ts`, in the same order (the start stops otherwise).
3. Add its settings to `src/config/env.ts` and to `.env.example`. For a kind with one provider at a time, set the setting of the kind (`MAIL_PROVIDER` and the like) to its name.
4. A provider that calls the server: give it its route under its name and check its signature in its folder; the registry puts the path outside the request rate limit.
5. Give the tests its answers: a mock of its service next to the others in `tests/helpers`, and its entry in `tests/helpers/providers.ts`. The contract of the kind then runs for it as it is, and the boundary test holds its name to its folder.
6. A provider of payments or of accounts: add its value to the type of the database (`PaymentProvider`, `AuthProvider`) with a migration.
