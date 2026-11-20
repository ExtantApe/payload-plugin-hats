# Changelog

## Unreleased

- **A new hat switch.** A pill trigger ("Acting as Author"), a 360 px popover on wide screens and a bottom sheet under 640 px. It shows the hat worn now, then one fieldset per account (current account first) with a native radio per hat: safe hats first, then hats that ask for a code, tagged with a lock and Needs a code. Safe hats switch in one tap; the others open a code screen (Confirm it's you, Switch to <hat>, Cancel, and an optional Use another way). A Back to Member row stays at the bottom above the narrowest hat. Escape, close and the scrim return focus to the trigger, Cancel returns it to the hat, and focus stays in the panel while it's open.
- **A note after each switch.** "Now acting as <hat>. Switch back to <narrowest hat>." in a status region for 5 seconds (longer while hovered or focused), kept in sessionStorage across the reload, with focus moved to the new page's heading. `HatsSwitchedNote` shows it on pages without a switch.
- **Site options on `HatSwitcher`:** `accountTitle`, `hatHelp`, `orderHats`, `anotherWay` and `noteMs`, with defaults that need none of them. New exports: `HatsSwitchedNote`, `defaultOrder` and their types. New `text` keys for every new word; the old keys stay.
- **Theme variables only.** The switch reads `--hats-*` variables, then the Payload admin's theme variables, then the surrounding text. The fixed fallback colors for focus and errors are gone.

Tested: 34 new unit tests (order, which taps switch or ask, Back to Member, the 24-character trigger, fieldset and radio markup, Current and Needs a code tags, the code screen's aria-invalid and aria-describedby, focus targets, the note across a reload, no fixed colors). In a browser on a local site with made-up accounts at 390 and 1280 px: 30 checks, including keyboard open and Escape, arrows not switching, the focus trap, Cancel back to the hat, a one-tap switch, the note and its Switch back link, and Back to Member. Not tested: a real authenticator code through the new code screen, and screen readers.


## 0.2.0 (2026-11-16)

- **`stepUpWhen`.** Decides whether a switch needs a code, in place of the hat's `sensitive` flag. It gets `from` and `to` (user as worn, and hat), so a site can ask only when the new hat holds a role or permission the current one doesn't. Only an exact `false` skips the code; `true`, a throw or any other answer asks. The `GET /hats` menu's `needsCode` follows the same rule. Without it, nothing changes.
- **`stepUp.rememberPer: 'set'`.** One good code is remembered for every account in the same linked set, for `rememberMinutes` (default 180). Default `'account'` is unchanged. An account in no set is remembered on its own.
- **`stepUp.available` and `stepUp.verify` receive `signedIn` and `set`.** `signedIn` is the account that actually signed in, `set` is the linked set's id or `null`. `user` is still the target. `available` gets them as a second argument. The `switched` event's `steppedUp` still means a code was given in that request. New type export `StepUpContext`.

Tested: 34 tests (30 server, 4 client) against a real Payload and an in-memory MongoDB; the existing tests pass unchanged. New ones cover step down, up and sideways, `stepUpWhen` throwing, rejecting and answering `'yes'`, `1`, `{}` and `undefined`, the menu agreeing with the switch, one code across a linked set inside and after the 3-hour window, an account in no set, and what `available` and `verify` are told. Two mutation checks (set memory off, `stepUpWhen` accepting only `true`) each fail a test.
Not tested: the React components with the new options (they only read `needsCode`); a real authenticator.

## 0.1.5 (2026-11-11)

- **`limit` and `blocked` fail closed.** `limit` must answer exactly `true` to allow a link request; any other truthy answer is now refused with `tooMany` (429), as a throw already was. A `blocked` that throws, or answers anything but a reason or `null`, now refuses switching, linking and unlinking with 409 `blocked` and a general reason. Before, a throw escaped as a 500. Tested: 26 tests (22 server, 4 client), 5 mutation checks.

## 0.1.3 (2026-11-10)

- **A session with nothing left to wear is signed out.** If a site's `hatsOf` gives an account no hats at all (for example, because the site disabled it), a session the plugin keeps a record for, one switched in from another account or one wearing a hat, is now revoked and signed out. Before, with no hat to narrow to, it was handed the account with every role. A plain sign-in with no record is unchanged: refusing a disabled account at sign-in is the site's job.

Tested: 22 tests (18 server, 4 client). The new test, which disables an account with a direct write so no hook runs, fails without the change.

## 0.1.2 (2026-11-10)

Security fixes from a review of 0.1.1.

- **A revoked session stays signed out.** Payload writes an account's whole list of sessions at once, so a sign-in at the same moment as a revocation could write the revoked session back. Its record had already been deleted, so it then looked like a plain sign-in with every role. Records are now kept, marked `revokedAt`, and a session with one is signed out (and taken off the account again). This covers unlinking, an approver's delete, a lost role, a deleted account, signing out, and the session left behind when switching accounts.
- **Old session records are cleaned up**, at most 50 per switch: only those that expired over a day ago and whose Payload session is gone, so a session Payload kept alive keeps its hat. `cleanupSessions` is exported for a site's own job.
- **`wear()` must narrow.** A `wear()` that returns the user object unchanged is refused, so a site's mistake can't quietly leave every role on.
- **`limit` option** for link requests, called with the acting account and the email. A no, or a limit that fails, refuses with `tooMany` (429) and sends nothing.

Tested: 21 tests (17 server, 4 client). The new tests include a revoked session written back into the account (it stays signed out; this test fails without the fix), clean-up keeping a refreshed session's record, the `wear()` guard, and the limit refusing (and failing closed). Not yet tried on a site.

## 0.1.1 (2026-11-10)

- **`stepUp.available` may be async.** A site's two-step state is often a hidden field that isn't on the signed-in user, so the check can now look it up. A false answer still refuses ("Set up two-step sign-in on that account first."). Sites that pass a plain boolean function need no change.

Tested: 17 tests; the step-up tests now run through an async check.

## 0.1.0 (2026-11-10)

First release: linked accounts, role hats with narrowing before `req.user`, step-up for sensitive hats, and revocation.
