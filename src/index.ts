import type { PayloadRequest, CollectionAfterChangeHook, CollectionAfterDeleteHook, CollectionAfterLogoutHook, Config, Plugin, Where } from 'payload'

import { hatCollections } from './collections.js'
import { hatEndpoints, runSwitch, type SwitchInput, type SwitchResult } from './endpoints.js'
import { revokeSessions, wrapStrategies } from './sessions.js'
import { asPlugin, newToken, relId, serial } from './state.js'
import { LINKS, MEMBERS, REQUESTS, SESSIONS, type HatsOptions, type HatsUser, type ResolvedHatsOptions } from './types.js'

export { hatsStateOf } from './state.js'
export { applyHat, cleanupSessions, revokeSessions } from './sessions.js'
export { LINKS, MEMBERS, REQUESTS, SESSIONS } from './types.js'
export type { SwitchInput, SwitchResult }

/**
 * Switch the signed-in person's hat or account from a site's own route, without the picker. It runs the same code as
 * `POST /api/hats/switch`, in the same order (blocked, notLinked, showSwitch, the step-up checks, the session record,
 * the old session's revoke), and has no option that skips one. It acts only for `req.user`: with nobody signed in it
 * is refused (`signIn`, 401). It never throws for a refusal. An error from a site hook is a refusal too.
 *
 * On `{ ok: true }` the route must send `cookie` back as `Set-Cookie`. Call it only from a same-origin POST, never
 * from a GET: a GET can be started by a link on another site, and `SameSite=Lax` still sends the sign-in cookie on it.
 */
export const switchSession = (req: PayloadRequest, input: { account?: string | number | null; hat?: string; code?: string }): Promise<SwitchResult> => runSwitch(req, input)
export type { Hat, HatsEvent, HatsOptions, HatsState, HatsUser, StepUpContext } from './types.js'

/**
 * Hats for Payload. One person can link up to `maxLinked` accounts and switch between them, and an account that
 * holds several roles acts in one at a time (a "hat"). Switching into a sensitive hat asks for the site's second
 * factor. Every switched session is checked against its linked set on every request, and ends the moment the set,
 * the membership or the account's roles change.
 */
export const hats =
  (options: HatsOptions): Plugin =>
  (config: Config): Config => {
    const opts: ResolvedHatsOptions = {
      users: 'users',
      maxLinked: 4,
      confirmHours: 24,
      linkAnswerMs: 2000,
      showSwitch: undefined as never,
      adminSwitch: true,
      sendEmail: ({ payload, to, subject, text }) => payload.sendEmail({ to, subject, text }),
      ...options,
    }
    if (opts.maxLinked < 2) throw new Error('hats: maxLinked must be at least 2.')
    if (typeof opts.linkAnswerMs !== 'number' || !Number.isFinite(opts.linkAnswerMs) || opts.linkAnswerMs < 0 || opts.linkAnswerMs > 2_147_483_647) throw new Error('hats: linkAnswerMs must be a number of milliseconds, from 0 to 2147483647.')
    const users = (config.collections ?? []).find((c) => c.slug === opts.users)
    if (!users?.auth) throw new Error(`hats: no auth collection "${opts.users}".`)
    if (typeof users.auth === 'object' && users.auth.useSessions === false) throw new Error('hats: needs Payload sessions; remove auth.useSessions: false.')
    for (const slug of ['hat-links', MEMBERS, SESSIONS, REQUESTS])
      if ((config.collections ?? []).some((c) => c.slug === slug)) throw new Error(`hats: a collection "${slug}" already exists.`)

    const ids = (u: unknown) => new Set(opts.hatsOf(u as HatsUser).map((h) => h.id))
    // Losing a hat ends every session switched into the account: it comes back in through the switch, re-checked.
    const afterChange: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
      if (operation !== 'update' || !previousDoc) return doc
      const now = ids(doc)
      if ([...ids(previousDoc)].some((h) => !now.has(h))) await revokeSessions(req.payload, { and: [{ user: { equals: String(doc.id) } }, { via: { exists: true } }, { via: { not_equals: null } }] }, 'lost a role', req)
      return doc
    }
    // Once an account is deleted, nothing of the plugin's points at it. This runs in afterDelete, so only for a delete
    // that happened: one refused or failed before it (a site hook, access, one document of a bulk delete) changes
    // nothing here. It runs before the site's own afterDelete hooks, inside the delete's transaction where there is
    // one. On SQL databases the foreign keys have already set these columns to null, so null rows go too. Payload runs
    // a bulk delete's documents side by side; `serial` runs this one account at a time.
    const afterDelete: CollectionAfterDeleteHook = async ({ id, req }) => {
      const p = req.payload
      const me = relId(p, opts.users, id)
      const mineOrGone = (field: string): Where => ({ or: [{ [field]: { equals: me } }, { [field]: { exists: false } }] })
      await serial(req, () =>
        asPlugin(req, async () => {
          // One row at a time, so each leaving takes its set's members as they are at that moment.
          const rows = await p.find({ collection: MEMBERS as never, where: mineOrGone('user'), limit: 0, depth: 0, overrideAccess: true, pagination: false, req })
          for (const r of rows.docs) await p.delete({ collection: MEMBERS as never, where: { id: { equals: r.id } }, overrideAccess: true, req })
          await p.delete({ collection: REQUESTS as never, where: mineOrGone('requestedBy'), overrideAccess: true, req })
          // Requests to the account stay, emptied, until they expire: they still count toward the asker's limit, so
          // deleting an account frees nothing the asker could notice. At most one request holds the account.
          await p.update({ collection: REQUESTS as never, where: { or: [{ account: { equals: me } }, { holds: { equals: `account:${String(id)}` } }] }, data: { account: null, holds: `none:${newToken()}`, tokenHash: null } as never, overrideAccess: true, req })
          // Who started a set, added or approved an account: cleared, along with the set's label, which names them.
          await p.update({ collection: LINKS as never, where: mineOrGone('requestedBy'), data: { requestedBy: null, label: 'Started by a deleted account' } as never, overrideAccess: true, req })
          for (const field of ['addedBy', 'approvedBy'])
            await p.update({ collection: MEMBERS as never, where: { and: [{ [field]: { equals: me } }, { user: { exists: true } }] }, data: { [field]: null } as never, overrideAccess: true, req })
        }),
      )
      await revokeSessions(p, { or: [{ user: { equals: String(id) } }, { via: { equals: String(id) } }] }, 'account deleted', req)
    }
    const afterLogout: CollectionAfterLogoutHook = async ({ req }) => {
      const sid = (req.user as HatsUser | null)?._sid
      if (sid) await req.payload.update({ collection: SESSIONS as never, where: { sid: { equals: sid } }, data: { revokedAt: new Date().toISOString() } as never, overrideAccess: true, req })
    }

    const onInit = config.onInit
    return {
      ...config,
      collections: [
        ...(config.collections ?? []).map((c) =>
          c.slug === opts.users
            ? {
                ...c,
                hooks: {
                  ...c.hooks,
                  afterChange: [...(c.hooks?.afterChange ?? []), afterChange],
                                    afterDelete: [afterDelete, ...(c.hooks?.afterDelete ?? [])],
                  afterLogout: [...(c.hooks?.afterLogout ?? []), afterLogout],
                },
              }
            : c,
        ),
        ...hatCollections(opts),
      ],
      endpoints: [...(config.endpoints ?? []), ...hatEndpoints],
      admin:
        opts.adminSwitch === false
          ? config.admin
          : { ...config.admin, components: { ...config.admin?.components, actions: [...(config.admin?.components?.actions ?? []), '@extantape/payload-plugin-hats/client#HatSwitcher'] } },
      custom: { ...config.custom, hats: opts },
      onInit: async (payload) => {
        await onInit?.(payload)
        wrapStrategies(payload, opts)
      },
    }
  }
