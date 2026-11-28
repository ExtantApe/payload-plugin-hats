# Hats for Payload: design note

"Link accounts and switch hats." The spec is the owner's brief (2026-11-09), made general for any Payload site. Reviewed and approved before building; the build's changes are in `decisions.md`.

## What it does

- **Linked accounts.** One person can link up to 4 accounts. Each keeps its own email and roles. Signing in to one signs you in to all of them, and edits are credited to the account you're acting as.
- **Hats.** One account that holds several roles can act in just one of them at a time: a "hat". Outside the hat you're wearing, the other roles' powers are absent, so those areas are read-only to you, or closed.
- **Switching up** into a hat the site marks as sensitive (for example admin or curator) asks for the site's second factor again, at most once every few hours.
- **Linking** needs both emails confirmed plus an administrator's approval. Unlinking is self-serve.

## What the site provides (options)

```ts
hats({
  users: 'users',                 // the auth collection
  // The hats an account can wear, from its own roles. Order = how they're listed.
  hatsOf: (user) => [{ id: 'member', label: 'Member' }, { id: 'admin', label: 'Administrator', sensitive: true }],
  // The user as seen while wearing a hat: return a copy with roles narrowed. Every access rule that reads roles
  // from req.user then follows the hat with no other change. Must never add a role the user doesn't have.
  wear: (user, hatId) => narrowRoles(user, hatId),
  // Who approves link requests (admin route + endpoint).
  canApproveLinks: ({ req }) => isMaintainer(req.user),
  // The site's second factor for switching up. Plugin asks for the code; the site checks it.
  stepUp: { verify: async (req, user, code) => verifyTwoStep(user, code), rememberFor: '3h', requiredFor: (hat) => Boolean(hat.sensitive) },
  // Who sees the switch at all (default: anyone in a linked set or with more than one hat).
  showSwitch: (user) => true,
  maxLinked: 4,
  sendEmail: async ({ to, subject, text }) => {},   // for link confirmations (the site's own mail)
})
```

## Data

Brought up to date with 0.5.0 on 2026-11-28.

The plugin adds four collections. No fields are added to users. Hats and step-up live in the session, so two browsers can wear different hats.

Below, a user who may approve is a signed-in account from the `users` collection for which `canApproveLinks` answers exactly `true`. Without that option, nobody may approve. With access checks on, no user can create rows in any of the four. Server code with `overrideAccess` can read all four and delete from all four.

- **`hat-links`**: one row for each linked set.
  - Fields: `label` (who started the set) and `requestedBy`.
  - Users: only a user who may approve can read it. No user can create, update or delete it. It is hidden in the admin.
  - Server code with `overrideAccess` can write it.
- **`hat-members`**: one row for each account in a set. `user` is unique, so an account has at most one row and is in at most one set.
  - Fields: `link` (the set), `user`, `status` (`requested`, `confirmed` or `approved`), `tokenHash` and `tokenExpires` (hidden, for a confirmation still waiting), `addedBy`, `confirmedAt`, `approvedBy` and `approvedAt`. `user` is required on every write. On SQL databases its column can be null.
  - Users: only a user who may approve can read, update or delete it.
  - Creates: the collection's own hook refuses a create from anything but the plugin, including from server code with `overrideAccess`. Rows are created only when the invited account confirms, and an approval changes the status of an existing row. The plugin creates the invited account's row as `confirmed` when that account confirms. An asker with no set also gets a row then, which stays `requested` until they confirm from their own email. An asker already in a set doesn't confirm again.
  - Updates: apart from the plugin's own writes, the hook lets an update through only from a user who may approve. This applies to server code too. That update can change nothing but the status, which must stay as it is or move from `confirmed` to `approved`. A move to `approved` needs a set the user doesn't belong to, as the acting account or the one they signed in with. The set must also have room under `maxLinked` (default 4). On approval the hook fills in `approvedBy` and `approvedAt`.
  - Deletes: a user who may approve and server code with `overrideAccess` can delete a row. An account in the set can also unlink through the plugin. Deleting a row unlinks the account and ends the switched sessions tied to it in that set. If one account or none is left, the set is removed. There is no `unlinked` status.
- **`hat-sessions`**: the hat and switch state for a Payload session.
  - Fields: `sid` (unique), `user`, `via` (the account that signed in), `link` (the set), `hat`, `steppedUp` (when a second factor was last given), `expiresAt` and `revokedAt`.
  - Users: no user can read, create, update or delete it. It is hidden in the admin.
  - Server code with `overrideAccess` can write it.
- **`hat-requests`**: open link requests.
  - Fields: `requestedBy`, `account` (set only for an invitation), `holds` (unique, so an account has one open invitation at a time), `tokenHash`, `expiresAt` and `link` (the asker's set when they asked). `requestedBy` is required on every write. On SQL databases its column can be null.
  - Users: no user can read, create, update or delete it. It is hidden in the admin.
  - Only the plugin can create or update a row. The collection's own hook refuses anyone else, including server code with `overrideAccess`. A key in `context` doesn't change that. Server code with `overrideAccess` can read and delete rows.

## Sessions

As built (2026-11-09; see `decisions.md`). The first draft used signed cookies for the hat; the build keeps it on the server instead.

- **State:** a hidden `hat-sessions` record per Payload session id: the hat worn, the account that actually signed in (`via`) and the set (`link`) for a switched session, and when each account's second factor was last given. No fields are added to users, and nothing in the browser decides the hat.
- **Narrowing:** in `onInit` the plugin wraps every Payload auth strategy. A signed-in user of the collection is narrowed with `wear()` before `req.user` exists, so the admin, REST, GraphQL and the Local API with `req` all follow the hat. If anything goes wrong there, the request is signed out, never given full roles.
  - A plain sign-in wears every role, as before. A stored hat the account no longer holds falls to the narrowest.
  - `wear()` is checked every time: it may not add a hat the account lacks, and an ordinary hat may not keep a sensitive one.
- **Switching:** `POST /api/hats/switch { account?, hat, code? }`.
  - Another account must be an approved member of the same set (read fresh).
  - A sensitive hat needs that account's second factor unless given in the last `rememberMinutes`.
  - For another account, a new Payload session is issued (`addSessionToUser`, `getFieldsToSign`, `jwtSign`) and the old one ends.
- **Revocation:** unlinking, deleting a row, losing a hat or deleting an account removes the Payload session itself, so the token stops working everywhere. A switched session also re-checks its set on every request.
- **Masquerade:** the site's `blocked(req)` refuses switching while masquerading. The site's `canMasquerade` should refuse a switched session (`hatsStateOf(user).via`).

## Credit and audit

- **Edits:** credited to the account acting, because it's `req.user`.
- **Audit:** `hatsStateOf(req)` gives `{ hat, via, link }`, where `via` is the account the person signed in with and `hat` is the one worn, and `onEvent` reports linking, approving, unlinking, switching and revoking. The site's audit log can record "Admin A, wearing Member, via B's sign-in".

## Interface

- An admin-bar menu (and a small React component for the site's own header): the linked accounts, then the current account's hats, with the current one ticked. A sensitive choice opens the code prompt inline. After switching, a short banner says who and which hat, with a link back. Keyboard and screen-reader friendly.
- An account page section for linking: enter an email, both confirm, then wait for approval; unlink.
- An admin view for approving requests.

## Tests

- **Linking:** both confirmations needed, plus approval; tokens are single-use and expire; at most one set per account and at most 4 members; unlinking is immediate.
- **Accounts:** a switch works only within an approved set (re-checked every time); it's refused while masquerading; credit goes to the target.
- **Hats:**
  - narrowing hides wider roles on the Local API, REST and GraphQL;
  - writes outside the hat are refused;
  - a forged or stale cookie gives the narrowest hat;
  - `wear` can never widen.
- **Step-up:** required for sensitive targets, remembered, then asked again; a wrong code is refused; an account without a second factor is refused.
- A Whitehat canary: an admin wearing Member must not read admin-only records.

## Wiring it into a site

The site supplies:
- `hatsOf` from its own role ladder, with its staff roles marked sensitive;
- `wear` to narrow those roles;
- `stepUp` from its existing two-step sign-in;
- `canApproveLinks` for its platform administrators.

Switching up asks for the second factor from day one, whether or not the site requires it at sign-in.

## Open questions

Answered 2026-11-09: a cap of 4, step-up remembered for 3 hours, and the switch only where some account in the set has more than one hat. See `decisions.md`.
