# payload-plugin-hats

Linked accounts and role hats for Payload. One person links their accounts and switches between them, and an account with several roles acts in one at a time. Switching up into a sensitive role asks for a second factor.

**Status:** early, 0.x. The server side passes 30 tests against a real Payload 3.92 and MongoDB, with made-up roles and a fake second factor. The redesigned switch (unreleased) has 34 unit tests for its order, gating, radio markup, code screen and focus targets, and was run in a browser at 390 and 1280 px wide on a local copy of a site with made-up accounts: keyboard open, arrows, Escape, the focus trap, Cancel back to the hat, a one-tap switch and the note after it. A real authenticator code wasn't tried with the new switch; the server refused the made-up code, as it should. It isn't in use on any site yet.

## What it does

- **Linked accounts.** Up to 4 accounts per person. Linking needs both emails confirmed and an approver who isn't in the set. Unlinking is self-serve and immediate.
- **Hats.** Wearing a hat narrows the user before `req.user` exists, so every access rule follows it: admin, REST, GraphQL and the Local API with `req`. If narrowing fails, the request is signed out, never given full roles.
- **Step-up.** Switching into a sensitive hat asks for that account's second factor, remembered for 3 hours per account (or per linked set, see below).
- **Step up on gain.** Pass `stepUpWhen` to decide for yourself when a switch asks for a code, in place of the `sensitive` flag. It gets the hat worn now (`from`) and the one it would become (`to`), each with the user as it would be worn, so a site can ask only when `to` holds a role or permission that `from` doesn't. Going down asks nothing, going up or sideways asks. Only an exact `false` skips the code. `true`, a throw or any other answer asks, so a broken check never lets a switch through.
- **One code for the whole set.** `stepUp.rememberPer: 'set'` remembers a good code for every account in the same linked set, for the same 3 hours, so one two-step covers the person. The default, `'account'`, is unchanged. An account in no set is remembered on its own either way. `stepUp.available` and `stepUp.verify` also get `signedIn` (the account that actually signed in) and `set` (the linked set's id, or `null`), so a site can check against one two-step for the person. `user` stays the account being switched into.
- **Revocation.** Unlinking, deleting a row, losing a role or deleting an account ends every session switched into or through it. Switched sessions also re-check their set on every request. An ended session's record is kept, marked revoked, so a session that Payload writes back by accident (two writes to an account's sessions at once) stays signed out. Old records are deleted once their Payload session is gone, at most 50 per switch.
- **Link limits.** Pass `limit` to rate-limit link requests, per person and per email address. It must answer exactly `true` to allow one. Any other answer, or a throw, refuses the request with `tooMany` (429) and nothing is sent.

Needs Payload sessions (`auth.useSessions`, on by default).

## On its own, and with others

**On its own:** it needs a users auth collection with Payload sessions, plus your `hatsOf` and `wear`, built from the roles you already have. Linking stays off until you set `canApproveLinks`, and switching into a sensitive hat is refused until you give it a `stepUp`.

**Only `true` counts.** `canApproveLinks`, `stepUp.available`, `stepUp.verify` and `limit` must answer exactly `true` (or a promise of it). Anything else is a no: `false`, `1`, `'yes'`, an object such as `{ valid: false }`, or an error thrown or rejected. A refused step-up answers 403 (`setUpTwoStep` or `wrongCode`), a refused approval 403 and a refused link request 429 (`tooMany`), never a 500. If your verifier returns a result object, pass its flag: `verify: async (a) => (await check(a)).valid === true`.

**Only `null` goes ahead.** `blocked(req)` answers a reason or `null`. A non-empty string refuses switching, linking and unlinking with 409 (`blocked`) and your reason. `null` or `undefined` goes ahead. Anything else, such as `''`, `false` or an object, and an error thrown or rejected, also refuses with 409 `blocked` and a general reason, never a 500.

**Works with:**
- **MFA:** MFA's `isOnFor` and `verify` make the `stepUp`. MFA's README has the two lines.
- **Masq:** your `blocked(req)` can refuse switching while masquerading, using Masq's `masqStateOf`. Masq's `canMasquerade` should refuse a switched session, using `hatsStateOf(user).via`.
- **Guardians:** Hats can be the switcher behind Guardians' required `actingFor`, so a guardian who switched into a kid's account is still seen as the guardian.
- **Audit Trail:** pass `onEvent` through Audit Trail's `fromPluginEvent`, and use `hatsStateOf(req)` in its `via`, so an entry says which account signed in and which hat was worn.

None of these are imported. The site connects them in its own config.

**Family:** It's part of the **Identity** family (a working draft): plugins designed to sit together for accounts and access.

## Use

```ts
import { hats } from '@extantape/payload-plugin-hats'

hats({
  hatsOf: (user) => [{ id: 'member', label: 'Member' }, { id: 'admin', label: 'Administrator', sensitive: true }],
  wear: (user, hat) => ({ ...user, roles: hat === 'admin' ? user.roles : ['member'] }),
  canApproveLinks: ({ user }) => user.roles.includes('admin'),
  stepUp: { available: (user) => hasAuthenticator(user), verify: ({ user, code }) => checkCode(user, code), rememberPer: 'set' }, // rememberPer is optional
  // optional: ask only when the new hat holds something the current one doesn't
  stepUpWhen: ({ from, to }) => holdsMoreThan(to.user, from.user),
  limit: ({ user, email }) => allowAttempt('hatsLink', `${user.id}:${email}`), // optional
})
```

`wear` must return a narrowed copy of the user, never the user itself: Hats refuses the request if it gets the same object back, if a hat adds one the account doesn't hold, or if an ordinary hat keeps a sensitive one.

Endpoints, under the API route:

- `GET /hats` lists the acting account, its hats and its linked accounts.
- `POST /hats/switch { account?, hat, code? }` switches hat or account.
- `POST /hats/link { email }` asks to link another account.
- `GET` and `POST /hats/confirm` handle the email confirmation.
- `POST /hats/unlink { account? }` takes an account out of the set.

Approvers approve in the admin, under Accounts → Linked accounts.

The switch goes in the admin header (turn it off with `adminSwitch: false`). For a site's own pages, `@extantape/payload-plugin-hats/client` has `HatSwitcher` for the header, `HatsSwitchedNote` for pages without a switch, and `LinkedAccounts` for the account page. They need no Payload UI package.

**The switch.** A pill, "Acting as Author" (24 characters at most, never the email), opens a panel titled Switch role: a popover 360 px wide under the trigger, or a bottom sheet below 640 px (85% of the screen at most, scrolling inside, with a scrim and room for the phone's safe area). It shows the hat worn now, then one group per account, the current account first. Each group is a fieldset with a radio per hat: safe hats first, then hats that ask for a code, tagged with a lock and Needs a code. The hat worn now is marked Current and does nothing. A safe hat switches in one tap (arrow keys move without switching; Space, Enter or a tap switches). A hat that asks for a code opens a code screen, Confirm it's you, with Switch and Cancel; Cancel puts focus back on that hat. When the hat worn is above the narrowest one, a Back to Member row stays at the bottom. Escape, the close button and the scrim close it and return focus to the trigger; focus stays inside while it's open.

After a switch the page reloads (or your `onSwitched` runs) and a note says "Now acting as Curator. Switch back to Member." for 5 seconds, longer while hovered or focused, with a dismiss button, in a status region. It's kept in sessionStorage across the reload, and focus moves to the new page's heading.

Site options on `HatSwitcher`, all optional:

- `accountTitle(account)`: each group's heading, for example its job ("Maintainer account"). Default: This account, Linked account. The email sits under it, small.
- `hatHelp`: a helper line under each hat, as `{ [hatId]: line }` or `(hat, account) => line`.
- `orderHats(hats)`: the order inside a group. Default: as `hatsOf` gives them, with hats that ask for a code last.
- `anotherWay`: text shown under Use another way on the code screen (recovery codes, say). Left out, the link isn't shown.
- `noteMs`: how long the note stays. Default 5000.

Colors and sizes come from `--hats-ink`, `--hats-paper`, `--hats-line`, `--hats-muted`, `--hats-hover`, `--hats-selected`, `--hats-error`, `--hats-focus` (an outline value), `--hats-row` and the rest in `src/client/styles.ts`. Unset, they follow the Payload admin's theme variables, so the switch matches the admin in light and dark, and then the surrounding text. There are no fixed colors.

Every word is replaceable for translation: pass `text` (see `defaultText`). Server answers carry a stable `reason` (for example `wrongCode`), and `text.reasons` gives your words for each; anything you leave out shows the English.

## Commands

```bash
npm test          # Vitest, in-memory MongoDB
npm run typecheck
npm run build
```

## License

MIT. See `LICENSE`.
