# Banking Backend

A Node.js / Express / MongoDB backend for a simple banking app: users, accounts, safe money transfers, and a superuser who can issue deposits.

The focus is **correctness and security of money movement**: double-entry ledger, atomic transfers, idempotency keys, overdraft-proof concurrency, multi-device sessions, and 2FA for admin actions.

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Scripts](#scripts)
- [Project structure](#project-structure)
- [How it works](#how-it-works)
- [API reference](#api-reference)
- [Security](#security)
- [Testing](#testing)
- [Known limitations](#known-limitations)

## Features

- **Auth:** signup/login with bcrypt, short-lived access tokens, rotating refresh tokens in HttpOnly cookies
- **Multi-device sessions:** up to 5 devices, list and revoke devices, log out everywhere
- **Accounts:** multiple accounts per user, balance, paginated statement, self-freeze
- **Transfers:** atomic, idempotent, overdraft-proof, with per-transfer and daily limits
- **Superuser tools:** deposits from a system account, freeze/unfreeze/close accounts, audit log, ledger reconciliation
- **2FA (TOTP):** required for superuser deposits and account-status changes
- **Append-only** ledger and audit log

## Tech stack

Node.js 20+ (ES modules), Express 4, Mongoose 8, MongoDB (**replica set required**), JWT, bcryptjs, helmet, express-rate-limit. Tests use Node's built-in test runner, supertest, and mongodb-memory-server.

## Quick start

### 1. Prerequisites

- Node.js 20 or newer
- A MongoDB **replica set**. Transactions do not work on a standalone server.
  - Easiest: a free MongoDB Atlas cluster (always a replica set).
  - Local: start `mongod --replSet rs0`, then in `mongosh` run:
    ```js
    rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:27017' }] })
    ```
    and use `mongodb://localhost:27017/banking?replicaSet=rs0` as `MONGO_URI`.

### 2. Install and configure

```bash
npm install
cp .env.example .env
```

Fill in `.env` (see [Environment variables](#environment-variables)). Generate secrets with:

```bash
openssl rand -base64 48   # run twice: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET
openssl rand -hex 32      # TOTP_ENCRYPTION_KEY
```

### 3. Run

```bash
npm run dev     # auto-restart on changes
npm start       # production
```

Check it is up: `GET http://localhost:3000/health` returns `{ "status": "ok" }`.

### 4. Create your first superuser

1. Sign up normally via `POST /api/auth/signup`.
2. Promote that user and create their system account:
   ```bash
   npm run create-superuser -- you@example.com
   ```
3. Log in again, then enable 2FA:
   - `POST /api/auth/2fa/setup` returns a `secret` and an `otpauthUrl`. Add it to an authenticator app (the URL can be shown as a QR code).
   - `POST /api/auth/2fa/enable` with `{ "totpCode": "123456" }` to confirm.

Now the superuser can issue deposits.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MONGO_URI` | yes | MongoDB connection string (replica set) |
| `JWT_ACCESS_SECRET` | yes | 32+ characters |
| `JWT_REFRESH_SECRET` | yes | 32+ characters, **different** from the access secret |
| `TOTP_ENCRYPTION_KEY` | yes | Exactly 64 hex characters. Encrypts 2FA secrets in the database. **Losing it makes all 2FA secrets unreadable.** |
| `CLIENT_ORIGIN` | no | Allowed frontend origin for CORS. Default `http://localhost:5173` |
| `PORT` | no | Default `3000` |
| `NODE_ENV` | no | `production` enables secure cookies |
| `MAX_TRANSFER_PAISE` | no | Max per transfer. Default `100000000` (Rs 10 lakh) |
| `MAX_DEPOSIT_PAISE` | no | Max per deposit. Default `1000000000` (Rs 1 crore) |
| `DAILY_TRANSFER_LIMIT_PAISE` | no | Max per account per 24h. Default `500000000` (Rs 50 lakh) |
| `REFRESH_GRACE_MS` | no | Grace window for a just-rotated refresh token. Default `10000` |

The server refuses to start if required variables are missing or malformed.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Start the server |
| `npm run dev` | Start with `--watch` |
| `npm test` | Run all tests (see [Testing](#testing)) |
| `npm run create-superuser -- <email> [currency]` | Promote a user to SUPERUSER and create their system account (default currency `INR`) |
| `npm run reset-2fa -- <email>` | Reset a user's 2FA and revoke their sessions (for a lost authenticator). Server access only. |

## Project structure

```
server.js                     Entry point: connect DB, start server, graceful shutdown
src/
  app.js                      Express app: security middleware, routes, error handler
  config/
    env.js                    Validates and exports environment config
    db.js                     MongoDB connection, replica-set check, index setup
  models/                     user, account, ledger, transaction, session, audit
  routes/                     auth, account, transaction, admin
  controllers/                transaction, deposit, admin
  services/
    transfer.service.js       Core money movement (transfers and deposits)
    account.service.js        Account status changes
    session.service.js        Token signing, session creation, refresh rotation
    audit.service.js          Audit log helpers
  middlewares/                auth, role, totp, rate limits, sanitize, origin check
  utils/                      totp, immutable schemas, http-error, request-meta
scripts/                      create-superuser, reset-2fa
tests/                        Integration and unit tests
```

## How it works

### Money and ledger

- **All amounts are integers in paise** (Rs 100 = `10000`). No floating point.
- **The ledger is the single source of truth.** Balance = sum of `CREDIT` entries minus sum of `DEBIT` entries for the account. There is no stored balance to drift out of sync.
- Every transfer writes exactly two ledger entries (one debit, one credit) inside one database transaction.
- Ledger and audit entries are **append-only**: Mongoose hooks block updates and deletes.

### Overdraft-proof concurrency

MongoDB transactions use snapshot isolation, so two simultaneous transfers could both read the same old balance and both succeed. To prevent this, every transfer first **writes to the source and destination account documents** (incrementing a per-account `lastSeq` counter). Concurrent transfers on the same account then conflict, and one is automatically retried against the fresh data. The same `seq` is stored on each ledger entry, giving a per-account ordering that a future balance-checkpoint feature can use.

### Idempotency

Every transfer needs an `idempotencyKey` (unique per user).

- Retrying with the same key and same parameters returns the original result (`200`, `replayed: true`) and never moves money twice, even if requests arrive in parallel.
- The same key with different parameters returns `422`.
- Check what happened to a request with `GET /api/transactions/status/:idempotencyKey`.

### Sessions and tokens

- **Access token:** JWT, 15 minutes, sent as `Authorization: Bearer <token>`.
- **Refresh token:** JWT, 3 days, stored as an HttpOnly, SameSite=Strict cookie scoped to `/api/auth`. Only its hash is stored in the database.
- Each login creates its own **session** (one per device). Maximum 5; the least recently used is dropped.
- Every authenticated request also checks the session still exists, so logout and revoke take effect **immediately**.
- Refresh tokens **rotate** on every use. If two refresh calls arrive in parallel (two tabs), the loser is still served inside a short grace window. Using an old token after the grace window is treated as theft: that session is revoked and an audit entry is written.

### Superuser and system accounts

- A **system account** is the source of newly issued money. Its balance goes negative (the total money issued). It can only be used through the deposit API, never through normal transfers.
- Superuser actions that change state (`deposits`, `account status`) require a fresh **2FA code** in the request body as `totpCode`. A code works once.

## API reference

Base URL: `http://localhost:3000`. All bodies are JSON. Protected routes need `Authorization: Bearer <accessToken>`.

### Health

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness check |

### Auth: `/api/auth`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/signup` | no | Body: `email`, `name`, `password`. Returns `accessToken` and sets refresh cookie |
| POST | `/login` | no | Body: `email`, `password`. Creates a new session |
| POST | `/refresh` | cookie | Rotates the refresh token, returns a new `accessToken` |
| POST | `/logout` | cookie | Ends this device's session |
| POST | `/logout-all` | yes | Ends every session |
| GET | `/sessions` | yes | Lists your devices (`current: true` marks this one) |
| DELETE | `/sessions/:id` | yes | Revokes one device |
| POST | `/2fa/setup` | superuser | Generates a TOTP secret (shown once) |
| POST | `/2fa/enable` | superuser | Body: `totpCode`. Activates 2FA |
| GET | `/me` | yes | Current user |

Password rules: 8 to 72 characters with an uppercase letter, a lowercase letter, a digit, and a special character.

### Accounts: `/api/accounts`

| Method | Path | Description |
|---|---|---|
| POST | `/` | Create an account. Optional body: `currency` (default `INR`). Max 10 per user |
| GET | `/` | List your accounts |
| GET | `/:id/balance` | Balance in paise |
| GET | `/:id/ledger?limit=20&before=<seq>` | Statement, newest first. Pass the response's `nextBefore` as `before` for the next page (limit 1 to 100) |
| POST | `/:id/freeze` | Freeze your own account. Only a superuser can unfreeze it |

### Transactions: `/api/transactions`

| Method | Path | Description |
|---|---|---|
| POST | `/` | Transfer money |
| GET | `/status/:idempotencyKey` | Status of a transfer you made |

**Transfer request:**

```json
{
  "fromAccount": "<your account id>",
  "toAccount": "<destination account id>",
  "amount": 5000,
  "idempotencyKey": "order-1234-attempt-1"
}
```

| Status | Meaning |
|---|---|
| 201 | Transfer completed |
| 200 | Same key already processed (`replayed: true`) |
| 400 | Validation error, insufficient balance, inactive account, currency mismatch |
| 403 | Not your source account, system account used, or daily limit exceeded |
| 404 | Account not found |
| 422 | Idempotency key reused with different parameters |
| 429 | Rate limited |
| 503 | Heavy contention, retry with the **same** `idempotencyKey` |

### Admin: `/api/admin` (superuser only)

| Method | Path | 2FA | Description |
|---|---|---|---|
| POST | `/deposits` | yes | Issue money from the system account to a user account |
| PATCH | `/accounts/:id/status` | yes | Set `status` to `ACTIVE`, `FROZEN`, or `CLOSED` |
| GET | `/audit?limit=50&before=<id>` | no | Audit log, newest first |
| GET | `/reconcile` | no | Integrity check: total credits equal total debits, and no normal account is negative |

**Deposit request:**

```json
{
  "toAccount": "<account id>",
  "amount": 100000,
  "idempotencyKey": "deposit-2026-10-23-001",
  "totpCode": "123456"
}
```

**Account status rules:** an owner can freeze their own active account; only a superuser can unfreeze or close; closing needs a zero balance; `CLOSED` is final; system accounts cannot be changed.

### Example (curl)

```bash
# Sign up and keep the access token
curl -s -X POST localhost:3000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","name":"Alice","password":"Passw0rd!x"}'

# Create an account
curl -s -X POST localhost:3000/api/accounts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'

# Transfer Rs 50 (5000 paise)
curl -s -X POST localhost:3000/api/transactions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"fromAccount":"<id>","toAccount":"<id>","amount":5000,"idempotencyKey":"demo-1"}'
```

## Security

- Passwords hashed with bcrypt; login timing is equalized for unknown emails
- Account lockout after 5 failed logins (15 minutes). A locked account answers like a wrong password, so emails cannot be enumerated
- JWT algorithm and issuer pinned; secrets validated at startup
- Refresh tokens hashed at rest, rotated, with reuse detection
- Sessions checked in the database on every request (instant revocation)
- Rate limits: 200 req/min per IP overall, 10 per 15 min per IP on signup/login, 30 per min per user on money routes, 10 per min per user on admin routes
- NoSQL operator injection and prototype pollution blocked (`$` and `.` keys rejected)
- `helmet`, strict CORS, `Cache-Control: no-store`, 10 KB body limit, Origin check on cookie endpoints
- 2FA (TOTP) for superuser actions; secrets encrypted with AES-256-GCM; codes are single-use
- Per-transfer, per-deposit, and daily limits
- Append-only ledger and audit log

**For production, also:**

- Run behind HTTPS and set `NODE_ENV=production`
- If behind a reverse proxy, uncomment `app.set('trust proxy', 1)` in `src/app.js` so rate limiting sees real client IPs
- Give the application's MongoDB user only the permissions it needs (ideally insert and find only on `ledgers` and `audits`). Mongoose hooks cannot stop raw database access.
- Keep `.env` out of git and back up `TOTP_ENCRYPTION_KEY` separately
- Run `npm audit` regularly

## Testing

```bash
npm test
```

Tests spin up an in-memory MongoDB replica set (the first run downloads a MongoDB binary, so it needs internet once).

| File | Covers |
|---|---|
| `tests/totp.test.js` | TOTP against RFC 6238 test vectors, base32, secret encryption |
| `tests/auth.test.js` | Parallel refresh, token reuse, multi-device, logout-all, lockout, injection, Origin check |
| `tests/money.test.js` | Parallel overdraft attempts, parallel same-key requests, ownership, deposits and 2FA replay, freeze rules, statement pagination, reconciliation, audit log |

Rate limiters are disabled when `NODE_ENV=test`.

## Known limitations

- No email verification, password reset, or password change flow yet (a password change should revoke all sessions)
- Locking accounts after failed logins lets an attacker lock a victim out for 15 minutes (limited by the IP rate limit)
- One superuser account holds the system account. There is no multi-admin approval flow.
- Single currency per transfer; there is no currency conversion
- Balance is computed from the ledger on each request. Fine for moderate volumes; add periodic balance checkpoints (using the stored `seq`) if accounts accumulate very large histories.
