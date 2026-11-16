# Why Cartlify

Cartlify is the backend of a shop for the European market, built so that its owner can trust it with real orders and real money, and so that a team can grow it without fear of breaking what works. What sets it apart, and where to see it for yourself:

## 🧩 Every outside service is a block of its own

Payments, delivery, mail, files, the language models, the captcha and the login with an account elsewhere each sit behind an interface of their kind. The rest of the app knows the interface, never the provider.

| Kind     | Provider of today                     |
| -------- | ------------------------------------- |
| Payments | Stripe                                |
| Delivery | ShippyPro (an aggregator of carriers) |
| Mail     | SendGrid                              |
| Files    | Cloudinary                            |
| Models   | OpenAI                                |
| Captcha  | Cloudflare Turnstile                  |
| Login    | Google, GitHub, LinkedIn              |

- **A new provider is a folder** and a line in a registry: nothing of the orders, the returns, the catalog or the database changes. Two providers of one kind can work side by side (a buyer picks the way to pay).
- **One contract a kind:** the same tests run every provider of a kind, so a new one is proven the way the first one was.
- **A test keeps the borders:** the name of a provider, its SDK and its formats live only in its folder.
- **Two modes of the tests:** by default every service answers from a mock that checks only our code and reaches nothing outside; a run can take any service for real (its test account or sandbox), and then asks it whatever costs nothing.

See [providers](providers.md).

## 💶 Money that adds up

- Every movement of money (a payment, a refund, a failure, a dispute, money given back by hand, a compensation, the cost of a parcel) is a line of one journal, only added to, written by the database in the same transaction as the change it belongs to.
- The reports, the alerts, the cards and the export read the money only from that journal, so they never disagree with each other.
- A refund is followed to its end, and a dispute at the bank is followed by the app itself: the order is held, the evidence is drafted, the end of the dispute is counted.

See [disputes](disputes.md) and [payments](payments.md).

## 🔐 Rules the API cannot step over

- Roles, row level security, functions and triggers live in SQL scripts; the API connects as a role that cannot step over them, and every request runs as its own actor (a guest, a buyer, an admin, root).
- What columns a role may change is guarded by a trigger of each table; the journals of the money and of the stock only take additions.
- The structure of the built database is compared with a committed snapshot on every run of the tests.

See [architecture](architecture.md).

## ⚖️ Made for the rules of the EU

- The withdrawal within the term of the EU by the account or a public form, with its statements, its parcels back and the money back.
- The product safety data an offer needs (GPSR), the lowest price of the 30 days before every sale, customs data for the parcels abroad.
- Versioned terms, contract and privacy policy with the consents to them; terms of keeping personal data, with the cleanups that keep them, and an export of the data of a person.

See [returns](returns.md) and [features](features.md).

## ✅ Tested like a product

- 17,000+ unit and integration tests on every push, the integration ones on a real PostgreSQL and Redis.
- Every path of every role (a guest, a buyer, an admin, root) is walked by a flow test, step by step, the way a person would go.
- Every answer of the integration tests is checked against the OpenAPI document, and a test checks that the document describes every route, code and example.

## 🛒 Ready for a storefront and for growth

- Every route, answer and error code is described in Swagger: a frontend is built against a documented API.
- Every mail speaks the language of its reader (English, Ukrainian, Spanish); a new language is a dictionary, not a change of the code.
- The data of the shop (its name, its zones, its methods of delivery, its sender) is changed by root without a deploy.
- The admins have journals filtered by every column, alerts with thresholds of their own, statistics and an accounting report.

What is done and what comes next — [status](status.md).
