# Pulse — Claude Code reference

**Platform conventions are injected separately** (or fetch them at
`https://social-vibecoding.usernodelabs.org/claude.md`). This file covers
only app-specific details. Platform rules win on any conflict.

---

## What Pulse is

Pulse is a Twitter/X-style microblogging app for the Usernode community. Users
post short messages ("pulses") of up to 280 characters, like and reply to
others, follow accounts, and browse feeds. Every new post is anchored on-chain
via a real wallet transaction — the blockchain is a tamper-evident receipt;
PostgreSQL is the primary read store.

---

## Tech stack

| Layer | Details |
|---|---|
| Server | Node.js / Express (`server.js`) |
| Database | PostgreSQL via `pg` `Pool`; schema applied idempotently on boot |
| Auth | JWT (`jsonwebtoken`); injected by the Usernode platform iframe |
| Frontend | Single file `public/index.html`; Tailwind CSS via CDN; vanilla JS inline in `<script>` |
| Wallet bridge | `window.usernode` from `https://social-vibecoding.usernodelabs.org/usernode-bridge/v1/bridge.js` |
| Entry point | `npm start` → `node server.js`, port from `$PORT` (default 3000) |

No build step. No bundler. No client-side framework.

---

## Database schema

Four tables, all `CREATE TABLE IF NOT EXISTS` in `start()`.

### `pulses`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `user_id` | INTEGER NOT NULL | From JWT |
| `username` | VARCHAR(255) NOT NULL | From JWT |
| `usernode_pubkey` | VARCHAR(255) | Wallet address (`ut1…`); nullable |
| `content` | TEXT NOT NULL | ≤ 280 chars, enforced server-side |
| `signature` | TEXT | Tx ID from `sendTransaction`; null for unsigned posts |
| `sign_message` | TEXT | Post content mirrored here for on-chain posts; null otherwise |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() |
| `deleted_at` | TIMESTAMPTZ | Soft-delete; null = live |

**Convention:** `pulses` is effectively append-only. Always soft-delete
(`UPDATE pulses SET deleted_at = NOW() WHERE …`); all queries filter
`WHERE deleted_at IS NULL`.

### `pulse_likes`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `pulse_id` | INTEGER | FK → `pulses(id)` ON DELETE CASCADE |
| `user_id` | INTEGER NOT NULL | |
| `username` | VARCHAR(255) NOT NULL | |
| `usernode_pubkey` | VARCHAR(255) | nullable |
| `signature` | TEXT | Reserved; currently null |
| `sign_message` | TEXT | Reserved; currently null |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() |
| UNIQUE | `(pulse_id, user_id)` | One like per user per post |

### `pulse_comments`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `pulse_id` | INTEGER | FK → `pulses(id)` ON DELETE CASCADE |
| `user_id` | INTEGER NOT NULL | |
| `username` | VARCHAR(255) NOT NULL | |
| `usernode_pubkey` | VARCHAR(255) | nullable |
| `content` | TEXT NOT NULL | ≤ 280 chars, enforced server-side |
| `signature` | TEXT | Reserved; currently null |
| `sign_message` | TEXT | Reserved; currently null |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() |

### `pulse_follows`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `follower_id` | INTEGER NOT NULL | |
| `follower_username` | VARCHAR(255) NOT NULL | |
| `following_id` | INTEGER NOT NULL | Resolved from target's latest pulse at follow time (0 if they have no pulses) |
| `following_username` | VARCHAR(255) NOT NULL | |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() |
| UNIQUE | `(follower_id, following_id)` | |

---

## API routes

Auth convention: the JWT arrives as `?token=` on the first iframe load, then
as `x-usernode-token` on all subsequent fetch calls. `req.user` is set by the
middleware when valid. `GET /health` and `GET /explorer-api/*` are public. All
other routes require auth for writes; `GET` routes on feeds/profiles accept
optional auth (used for `liked_by_me`).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | None | Health check — returns `{ status: 'ok' }` |
| GET | `/api/feed/trending` | Optional | Posts from last 48 h, ordered by `(like_count + comment_count * 2) DESC, created_at DESC`. Page size 20, `?offset=`. |
| GET | `/api/feed/live` | Optional | All posts, `created_at DESC`, no time window. Page size 20, `?offset=`. |
| GET | `/api/feed/following` | Required | Posts from accounts the user follows, `created_at DESC`. Page size 20, `?offset=`. |
| POST | `/api/pulses` | Required | Create post. Body: `{ content, signature, sign_message, pubkey }`. Returns `{ pulse }`. |
| GET | `/api/pulses/:id` | Optional | Single pulse with counts and `liked_by_me`. Returns `{ pulse }`. |
| DELETE | `/api/pulses/:id` | Required | Soft-delete. Owner only. |
| POST | `/api/pulses/:id/like` | Required | Like. Body: `{ pubkey }`. Idempotent. Returns `{ ok, like_count }`. |
| DELETE | `/api/pulses/:id/like` | Required | Unlike. Returns `{ ok, like_count }`. |
| GET | `/api/pulses/:id/comments` | Optional | All comments, `created_at ASC`. Returns `{ comments }`. |
| POST | `/api/pulses/:id/comments` | Required | Add comment. Body: `{ content, signature, sign_message, pubkey }`. Returns `{ comment }`. |
| GET | `/api/users/:username` | Optional | Profile stats: `pulse_count`, `follower_count`, `following_count`, `is_following`, `usernode_pubkey`. |
| GET | `/api/users/:username/pulses` | Optional | User's posts, `created_at DESC`. Page size 20, `?offset=`. Returns `{ pulses }`. |
| POST | `/api/users/:username/follow` | Required | Follow. Idempotent. |
| DELETE | `/api/users/:username/follow` | Required | Unfollow. |
| GET | `/api/suggestions` | Required | Up to 5 users not yet followed, ordered by username. Returns `{ suggestions }`. |
| GET | `/explorer-api/*` | None | Transparent proxy to blockchain explorer (for future tx verification). |

Feed pulse objects include: `id`, `user_id`, `username`, `usernode_pubkey`,
`content`, `signature`, `sign_message`, `created_at`, `like_count`,
`comment_count`, `liked_by_me`.

---

## Frontend architecture (`public/index.html`)

Single-file SPA. All JS is in one inline `<script>` block at the bottom of
the body. No modules, no imports.

### Global state

```js
const APP = {
  me: { id, username, usernode_pubkey },
  currentTab: 'trending'  // 'trending' | 'live' | 'following'
};
```

`APP.me` is populated during `boot()` by decoding the JWT client-side:
`atob(token.split('.')[1])` → `{ id, username, usernode_pubkey }`.

### Hash-based routing

`navigate(route)` sets `location.hash`. `handleRoute()` reads it and renders:

| Hash | View |
|---|---|
| `#feed` or empty | `renderFeed()` |
| `#search` | `renderSearch()` |
| `#profile/:username` | `renderProfile(username)` |
| `#pulse/:id` | `renderThreadView(id)` |

`window.addEventListener('hashchange', handleRoute)` drives all navigation.

### Key functions

| Function | What it does |
|---|---|
| `boot()` | Decodes JWT into `APP.me`, populates sidebar identity, calls `loadSuggestions()` and `handleRoute()` |
| `api(path, opts)` | `fetch` wrapper; injects `x-usernode-token` header; JSON-parses response |
| `renderFeed()` | Writes compose box + tab bar + empty `#feed-pulses` to `#main-content`, then calls `loadFeedPulses()` |
| `loadFeedPulses(offset)` | Picks the right feed endpoint from `APP.currentTab`, appends pulse cards; adds "Load more" button when 20 results returned |
| `switchTab(tab)` | Sets `APP.currentTab`, refreshes tab styling, calls `loadFeedPulses()` |
| `renderPulseCard(p, large)` | Returns HTML for a post card; shows chain icon (`ICON_CHAIN`) when `p.signature` is truthy |
| `anchorPost(content)` | **Dormant** — calls `usernode.sendTransaction(...)`, extracts tx ID, returns it or null. Currently not called from the posting flow (see On-chain anchoring). |
| `handleCompose(type)` | "Post" handler — posts/comments straight to the API unsigned (`signature: null, sign_message: null`), resets button |
| `handleLike(pulseId, currentlyLiked)` | Like/unlike toggle; updates icon and count in-place without re-rendering |
| `handleDelete(pulseId)` | Soft-deletes own post; removes card from DOM or navigates to feed |
| `renderThreadView(pulseId)` | Original post (large) + comments (ASC) + reply compose box; sets `window._threadPulseId` |
| `renderProfile(username)` | Profile header with stats + follow/unfollow button + user's posts |
| `handleFollow(username, currentlyFollowing)` | Follow/unfollow; updates button state optimistically |
| `loadSuggestions()` | Populates right sidebar "Who to follow" panel |
| `showToast(msg, isError)` | 3-second toast at top-right; red background on error |
| `esc(str)` | HTML-escapes all user-controlled strings — always use this before `innerHTML` |
| `updateNavActive(route)` | Marks the correct nav button active on both desktop sidebar and mobile bottom nav |

### Layout

- **Desktop (lg+):** three-column — 240px left sidebar (nav + identity), flex-1
  center column (`#main-content`), 288px right sidebar (suggestions).
- **Mobile:** fixed 56px top bar + fixed 64px bottom nav; center column spans
  full width with top/bottom padding to clear the bars.

---

## On-chain anchoring

> **Status: DISABLED in the posting flow (testnet).** Posts are currently
> stored **unsigned** — `handleCompose` sends `signature: null,
> sign_message: null`, exactly like comments and likes, with no wallet/bridge
> interaction and a plain **"Post"** button (no "Sign & Post"). The pieces
> below (`anchorPost`, the `signature` / `sign_message` columns, and the
> chain-icon rendering) are kept in place but **dormant** so signing can be
> re-enabled later by simply calling `anchorPost()` again from the post branch
> of `handleCompose`. The description below documents the dormant mechanism.

When enabled, new posts (not likes, not comments) are anchored via a wallet
self-transaction. The mechanism lives in `anchorPost(content)` in
`public/index.html`.

**Flow (when re-enabled):**

1. Check `typeof usernode !== 'undefined' && typeof usernode.sendTransaction === 'function'`.
   If false, show toast "Usernode bridge not available" and return null.
2. Call `usernode.sendTransaction(APP.me.usernode_pubkey, 1, content, { confirmTitle: 'Publish to Pulse', confirmSubtitle: content.slice(0, 80) })`.
   Destination = the user's own wallet (self-transaction). Amount = 1 token.
3. Extract the tx ID from the result by probing, in order:
   `tx_id`, `txid`, `txId`, `hash`, `tx_hash`, `txHash`, `id`,
   then the same set nested under `.tx`.
4. Return the tx ID string, or null on cancel / error.

**Storage:** tx ID → `pulses.signature`; post content → `pulses.sign_message`.

**Chain icon:** `renderPulseCard` shows `ICON_CHAIN` when `p.signature` is
truthy. Staging seed posts use `staging-sig-*` dummy values so the icon appears
in staging without a real wallet.

**Comments and likes:** proceed unsigned — `signature: null, sign_message: null`.
No wallet dialog is shown for these actions.

---

## Auth middleware

```js
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});
```

`PUBLIC_API_PATHS = new Set(['/health'])`. `PUBLIC_PREFIXES = ['/explorer-api/']`.
Static files (`GET` to non-`/api/` paths) pass through without auth. The `*`
catch-all sends the HTML shell when authenticated, and a styled 401 HTML page
when not.

---

## Staging seed data

`IS_STAGING = process.env.USERNODE_ENV === 'staging'`. The seed block in
`start()` runs after the schema migration, guarded by `IS_STAGING`. All inserts
are `ON CONFLICT … DO NOTHING` — safe to run on every boot.

**5 fake users** (IDs 99990001–99990005):

| ID | Username | Pubkey |
|---|---|---|
| 99990001 | staging-pulse-alice | ut1staging000alice |
| 99990002 | staging-pulse-bob | ut1staging000bob |
| 99990003 | staging-pulse-carol | ut1staging000carol |
| 99990004 | staging-pulse-dave | ut1staging000dave |
| 99990005 | staging-pulse-eve | ut1staging000eve |

**10 pulses** (IDs 900001–900010): 2 each from alice and bob, 2 from carol, 1
from dave, 3 from eve. Timestamps range from 1 h to 36 h ago. All have
`staging-sig-001` … `staging-sig-010` in `signature` so the chain icon renders.

**20 likes**: distributed so alice's and bob's posts score highest on Trending
(alice's post 900001 gets 4 likes, bob's 900003 gets 4 likes).

**5 comments**: on posts 900001, 900003, 900005, 900007, 900009.

**7 follow pairs**: alice↔bob (mutual), alice→carol, carol→alice, carol→bob,
carol→dave, dave→carol.

To add new seed data for a new feature: add rows in the existing `IS_STAGING`
block using IDs in the 9000xx / 9999xxxx namespace and usernames with the
`staging-pulse-` prefix.

---

## CI tests (`dapp.json`)

Five tests, all run against `GET /` (the root page requires a JWT; the test
runner injects one):

| Test name | Assertion |
|---|---|
| Feed renders | `#feed-tabs` selector present |
| Trending tab present | text "Trending" in page |
| Live Beats tab present | text "Live Beats" in page |
| Following tab present | text "Following" in page |
| Compose box present | `#compose-box` selector present |

When adding a new user-visible screen or selector, add a corresponding test
entry to `dapp.json` in the same commit.

---

## Key design decisions

- **No build step.** Tailwind from CDN; all JS inline. Keep it this way — no
  bundler, no TypeScript, no compile step.
- **Avoid adding npm dependencies.** The only deps are `express`, `pg`, and
  `jsonwebtoken`. Don't add more without a strong reason.
- **Soft deletes only.** `pulses.deleted_at` — never hard-delete a pulse; child
  rows (likes, comments) reference it by FK.
- **No users table.** Profiles are derived from `pulses`. `following_id` in
  `pulse_follows` is resolved from the target's latest pulse at follow time (0
  if they have none). Don't build a users table without discussing it first.
- **Follow resolution quirk.** `POST /api/users/:username/follow` looks up
  `user_id` from `pulses WHERE username = $1 LIMIT 1`. A user who has never
  posted gets `following_id = 0`. This is a known edge case.
- **`signature` / `sign_message` columns on all three write tables.** These
  were reserved for signing. **Currently null on all rows** (posts, likes, and
  comments) because on-chain anchoring is disabled in the posting flow on
  testnet. They remain so signing can be switched back on without a migration.
  Don't remove them.
- **Self-transaction amount is 1.** The post sends 1 token from the user to
  their own address. The user pays only the network fee. This hasn't been
  verified against Usernode's node for edge cases (e.g. minimum balance
  requirements).

---

## Deferred / out of scope

- **Search** — nav item and placeholder page exist; no search API or logic.
- **Like / comment on-chain anchoring** — deferred; too much UX friction per
  interaction with the current `sendTransaction` primitive.
- **Server-side tx ID verification** — the server stores the tx ID in
  `signature` but does not verify it on-chain. `/explorer-api/` proxy exists
  for this.
- **Users table** — no dedicated user registry; all profile data comes from
  `pulses`.
- **Reposts, media attachments, notifications, hashtags, DMs, content
  reporting** — all out of scope.
