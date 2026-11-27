# The second step of the login

An admin and root log in in two steps: the password (or an account at a provider: Google, GitHub,
LinkedIn), then a code of an authenticator app (Google Authenticator, 1Password and the like) or one
of their recovery codes. A customer logs in with the first step alone.

## What the person has

- **The app.** It shows six digits that change every 30 seconds (TOTP, RFC 6238). The server and
  the app share a secret the person scanned once from a QR code; the app works offline.
- **Ten recovery codes.** Shown once, when the app is set up or when the person asks for a new set.
  Each one lets a login in once in place of a code of the app. A used code is told apart from a
  wrong one.
- **Trusted browsers** (an admin only, root has none). A login can trust the browser for 30 days:
  the password alone lets the admin in on it. The admin sees the list and forgets any of them.

## The routes

| Route                                         | Who               | What                                                                          |
| --------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| `POST /api/auth/login`                        | guest             | `200` with the profile, or `202 { twoFactor: setup \| code, canTrustDevice }` |
| `GET /api/auth/<provider>/callback`           | guest             | redirect with `?twoFactor=setup\|code` for an admin or root                   |
| `POST /api/auth/two-factor/setup`             | guest with ticket | the secret of a new app: `otpauthUrl` for a QR code, `secret` to type in      |
| `POST /api/auth/two-factor/setup/confirm`     | guest with ticket | the first code opens the session and gives the ten recovery codes             |
| `POST /api/auth/two-factor/verify`            | guest with ticket | a code or a recovery code opens the session; `trustDevice` for an admin       |
| `GET /api/auth/two-factor`                    | admin, root       | when it was set up, the codes left, the trusted browsers                      |
| `DELETE /api/auth/two-factor/devices/:id`     | admin, root       | forget a trusted browser                                                      |
| `POST /api/auth/two-factor/recovery-codes`    | admin, root       | a code of the app gives a new set; the old one stops working                  |
| `POST /api/auth/two-factor/replace`           | admin, root       | a move to a new app: a code of the old app or a recovery code proves it       |
| `POST /api/auth/two-factor/replace/confirm`   | admin, root       | the first code of the new app makes it the one                                |
| `DELETE /api/root/admins/:adminId/two-factor` | root              | reset the second step of an admin                                             |

The first step puts a ticket in an httpOnly cookie (`twoFactorTicket`, 10 minutes). The ticket is
signed with a key of its own and holds no state of the server; it carries the new secret, encrypted,
while a setup or a move waits for its first code. Nothing happens on the password alone: the data of
the guest do not move to the account, the login journal gets no line, no session opens.

## The rules

- A code works once: the server keeps the last time step it took a code for. It takes the code of
  now and of one step before or after (a clock a little off, a person who types slowly).
- Five wrong codes in a row (of the app or recovery codes) pause the second step of the account for
  15 minutes, the right code too: `429 TWO_FACTOR_PAUSED` with `retry-after`. A used recovery code
  does not count.
- An admin or root without the second step gets no session: the login leads to the setup. A session
  from before the second step (the release of it, a reset by root) is not renewed: the refresh gives
  `401 REFRESH_TWO_FACTOR_REQUIRED` and the session ends.
- In the 10 minutes after a login with a recovery code, the session it opened moves to a new app
  with no other proof: a lost phone costs one recovery code, not two. Another session of the account
  (a stolen one) gives a proof.
- A new app forgets every trusted browser: the code is asked on each at its next login.
- Every way of ending all the sessions of an account (a logout of all devices, a change or a reset
  of the password, a role change, a stolen refresh token) forgets its trusted browsers too.
- The second step goes with the role: an account that stops being an admin or root loses it, and a
  new promotion sets it up again. A deleted account loses it too.

## The data

One table, `user_two_factor`, a row for each admin or root that set it up (`db/03`, `db/05`,
`db/06`): the secret encrypted with AES-256-GCM under `TWO_FACTOR_SECRET_KEY` (the version of the
key in front, `v1:`), the last step taken, the sha256 of the recovery codes not used and used, the
trusted browsers (the sha256 of the token of each, the name of the browser and the system, never the
whole User-Agent), and the count of wrong codes with the end of the pause. An account reads and
changes only its own row; root reads every row and removes the row of an admin.

The export of the data of a person has `twoFactor`: when it was set up and the trusted browsers (the
name and the dates), never the secret or the codes.

## The journals and the mails

The admin journal (`OTHER`, the entity is the account): `two_factor.enable`, `two_factor.replace`,
`two_factor.recovery_login`, `two_factor.recovery_renew`, `two_factor.device_forget`,
`two_factor.reset`. The login journal gets its line when the session opens, with the event of the
first step (`login.password`, `login.google`, ...).

The owner gets a mail when a recovery code lets a login in (with the codes left) and when root
resets the second step.

## A root without the phone and the codes

Root has no one above. The owner of the database removes the row by hand, under the superuser:

```sql
DELETE FROM cartlify.user_two_factor WHERE "userId" = <id of the root>;
```

The sessions of root end at their next refresh, and the next login sets the app up again.

## Before the launch

- `TWO_FACTOR_SECRET_KEY` on dev and on prod, another value on each ([Configuration](configuration.md)).
  Changing it makes every secret unreadable: each admin and root needs a reset then.
- The pages of the frontend: the setup with the QR code of `otpauthUrl` and the recovery codes, the
  code with the box "trust this browser" for an admin, the second step in the profile.
