import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, createLocalReq, getPayload, type Payload, type Plugin } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hats, LINKS, MEMBERS, REQUESTS, SESSIONS, type HatsEvent } from '../src/index.js'
import { asPlugin, newToken } from '../src/state.js'

/**
 * Deleting accounts, on every database setup a site can have: MongoDB with transactions, MongoDB without them, a
 * single delete with `disableTransaction`, bulk deletes, and SQLite (`HATS_DB=sqlite`, with
 * `npm install --no-save @payloadcms/db-sqlite`). Three things hold on each:
 *   - a delete that doesn't happen changes none of the plugin's rows;
 *   - a delete that happens leaves nothing pointing at a missing account or set;
 *   - a site's event handler that throws or hangs never blocks a delete or turns it into an error.
 * The accounts are made up. A later plugin refuses to delete `blockdel-` accounts, and the site's own afterDelete
 * fails for `afterfail-` ones.
 */
const SQLITE = process.env.HATS_DB === 'sqlite'
const MODES = SQLITE ? (['sqlite'] as const) : (['mongo', 'mongo-notx'] as const)
type Mode = 'sqlite' | 'mongo' | 'mongo-notx'
type Id = string | number
type Row = Record<string, unknown> & { id: Id }
const PW = 'correct-horse-battery'

let mongo: MongoMemoryReplSet | undefined
let sqliteDir: string | undefined
const instances: Payload[] = []

beforeAll(async () => {
  if (SQLITE) {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    sqliteDir = await mkdtemp(join(tmpdir(), 'hats-delete-'))
  } else mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
}, 120_000)

afterAll(async () => {
  for (const p of instances) await p.destroy()
  await mongo?.stop()
  if (sqliteDir) await (await import('node:fs/promises')).rm(sqliteDir, { recursive: true, force: true })
})

async function database(mode: Mode) {
  if (mode === 'sqlite') {
    const { join } = await import('node:path')
    const name = '@payloadcms/db-sqlite'
    const { sqliteAdapter } = (await import(name)) as { sqliteAdapter: (args: unknown) => never }
    return sqliteAdapter({ client: { url: `file:${join(sqliteDir!, 'hats.db')}` }, push: true })
  }
  return mongooseAdapter({ url: mongo!.getUri(`hats-${mode}`), ensureIndexes: true, ...(mode === 'mongo-notx' ? { transactionOptions: false as const } : {}) })
}

describe.each(MODES)('deleting accounts on %s', (mode) => {
  let payload: Payload
  let onEvent: ((e: HatsEvent) => unknown) | undefined
  const events: string[] = []

  beforeAll(async () => {
    const emailOf = async (p: Payload, id: Id) =>
      String(((await p.find({ collection: 'users', where: { id: { equals: id } }, depth: 0, overrideAccess: true })).docs[0] as { email?: string } | undefined)?.email ?? '')
    // Another plugin, after hats, with a beforeDelete of its own that refuses some deletes.
    const refuser: Plugin = (c) => ({
      ...c,
      collections: c.collections!.map((col) =>
        col.slug !== 'users'
          ? col
          : {
              ...col,
              hooks: {
                ...col.hooks,
                beforeDelete: [
                  ...(col.hooks?.beforeDelete ?? []),
                  async ({ id, req }) => {
                    if ((await emailOf(req.payload, id)).startsWith('blockdel-')) throw new Error('another plugin refuses this delete')
                  },
                ],
              },
            },
      ),
    })
    const config = await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: await database(mode),
      collections: [
        {
          slug: 'users',
          auth: true,
          // Only server code with overrideAccess deletes accounts here, so a signed-in delete is refused.
          access: { delete: () => false },
          fields: [],
          hooks: {
            afterDelete: [
              ({ doc }) => {
                if (String((doc as { email?: string }).email).startsWith('afterfail-')) throw new Error('the site’s afterDelete failed')
              },
            ],
          },
        },
      ],
      plugins: [
        hats({
          hatsOf: () => [{ id: 'member', label: 'Member' }],
          wear: (u) => u,
          canApproveLinks: () => true,
          sendEmail: async () => {},
          linkAnswerMs: 0,
          onEvent: (e) => {
            events.push(e.type)
            return onEvent?.(e) as never
          },
        }),
        refuser,
      ],
    })
    payload = await getPayload({ config, key: `hats-delete-${mode}` })
    instances.push(payload)
  }, 120_000)

  let n = 0
  const make = async (prefix = 'u') => {
    const u = (await payload.create({ collection: 'users', data: { email: `${prefix}-${mode}-${++n}@example.invalid`, password: PW } as never })) as unknown as { id: Id; email: string }
    return u
  }
  /**
   * A set of approved accounts, each with a live session, one switched into the next, a request each has open, and
   * an invitation from the first account to every other one.
   */
  async function setOf(...us: { id: Id }[]) {
    const approver = await make('approver')
    const req = await createLocalReq({}, payload)
    return asPlugin(req, async () => {
      const set = await payload.create({ collection: LINKS as never, data: { requestedBy: us[0]!.id, label: 'Started by a made-up account' } as never, overrideAccess: true, req })
      const later = new Date(Date.now() + 3_600_000).toISOString()
      for (const [i, u] of us.entries()) {
        await payload.create({ collection: MEMBERS as never, data: { link: set.id, user: u.id, status: 'approved', addedBy: us[0]!.id, approvedBy: approver.id } as never, overrideAccess: true, req })
        await payload.create({ collection: SESSIONS as never, data: { sid: `own-${newToken()}`, user: String(u.id), expiresAt: later } as never, overrideAccess: true, req })
        const next = us[(i + 1) % us.length]!
        await payload.create({ collection: SESSIONS as never, data: { sid: `via-${newToken()}`, user: String(next.id), via: String(u.id), link: String(set.id), hat: 'member', expiresAt: later } as never, overrideAccess: true, req })
        await payload.create({ collection: REQUESTS as never, data: { requestedBy: u.id, holds: `none:${newToken()}`, expiresAt: later } as never, overrideAccess: true, req })
        if (i > 0) await payload.create({ collection: REQUESTS as never, data: { requestedBy: us[0]!.id, account: u.id, holds: `account:${String(u.id)}`, tokenHash: 'made-up', expiresAt: later } as never, overrideAccess: true, req })
      }
      return set.id as Id
    })
  }

  const all = async (collection: string) => (await payload.find({ collection: collection as never, limit: 0, depth: 0, overrideAccess: true, pagination: false, sort: 'id' })).docs as unknown as Row[]
  const ref = (v: unknown) => (v == null ? null : String(typeof v === 'object' && 'id' in (v as object) ? (v as Row).id : v))
  /** Every row the plugin keeps, as plain values, so two moments can be compared exactly. */
  const snapshot = async () => {
    const strip = (rows: Row[]) => rows.map(({ updatedAt: _u, ...r }) => JSON.parse(JSON.stringify(r)))
    return { users: (await all('users')).map((u) => String(u.id)), members: strip(await all(MEMBERS)), links: strip(await all(LINKS)), requests: strip(await all(REQUESTS)), sessions: strip(await all(SESSIONS)) }
  }
  /** Nothing points at an account or set that isn't there, and no set is left with one account. */
  async function expectNothingDangling() {
    const users = new Set((await all('users')).map((u) => String(u.id)))
    const links = await all(LINKS)
    const linkIds = new Set(links.map((l) => String(l.id)))
    const members = await all(MEMBERS)
    const problems: string[] = []
    for (const m of members) {
      if (!users.has(String(ref(m.user)))) problems.push(`member ${m.id}: user ${ref(m.user)}`)
      if (!linkIds.has(String(ref(m.link)))) problems.push(`member ${m.id}: set ${ref(m.link)}`)
      for (const f of ['addedBy', 'approvedBy']) if (ref(m[f]) !== null && !users.has(ref(m[f])!)) problems.push(`member ${m.id}: ${f} ${ref(m[f])}`)
    }
    for (const l of links) {
      if (ref(l.requestedBy) !== null && !users.has(ref(l.requestedBy)!)) problems.push(`set ${l.id}: requestedBy ${ref(l.requestedBy)}`)
      if (members.filter((m) => ref(m.link) === String(l.id)).length < 2) problems.push(`set ${l.id}: fewer than two accounts`)
    }
    for (const r of await all(REQUESTS)) {
      if (!users.has(String(ref(r.requestedBy)))) problems.push(`request ${r.id}: requestedBy ${ref(r.requestedBy)}`)
      if (ref(r.account) !== null && !users.has(ref(r.account)!)) problems.push(`request ${r.id}: account ${ref(r.account)}`)
      const held = String(r.holds)
      if (held.startsWith('account:') && (held !== `account:${ref(r.account)}` || !users.has(held.slice(8)))) problems.push(`request ${r.id}: holds ${held}`)
    }
    for (const s of await all(SESSIONS))
      if (!s.revokedAt && (!users.has(String(s.user)) || (s.via != null && !users.has(String(s.via))))) problems.push(`live session ${s.id}: ${s.user} via ${s.via}`)
    expect(problems).toEqual([])
  }
  const exists = async (u: { id: Id }) => (await payload.count({ collection: 'users', where: { id: { equals: u.id } }, overrideAccess: true })).totalDocs === 1

  it('changes nothing when a later plugin refuses the delete', async () => {
    const a = await make(), b = await make('blockdel')
    await setOf(a, b)
    const before = await snapshot()
    await expect(payload.delete({ collection: 'users', id: b.id, overrideAccess: true })).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('changes nothing when a later plugin refuses a delete run with disableTransaction', async () => {
    const a = await make(), b = await make('blockdel')
    await setOf(a, b)
    const before = await snapshot()
    await expect(payload.delete({ collection: 'users', id: b.id, overrideAccess: true, disableTransaction: true })).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('changes nothing when access refuses the delete', async () => {
    const a = await make(), b = await make()
    await setOf(a, b)
    const before = await snapshot()
    await expect(payload.delete({ collection: 'users', id: b.id, user: { ...a, collection: 'users' } as never, overrideAccess: false })).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('in a bulk delete, leaves the refused account and its set as they were and cleans up after the rest', async () => {
    const a = await make(), b = await make('blockdel'), c = await make(), d = await make()
    await setOf(a, b)
    await setOf(c, d)
    const before = await snapshot()
    const res = await payload.delete({ collection: 'users', where: { email: { in: [b.email, c.email] } }, overrideAccess: true })
    expect(res.errors).toHaveLength(1)
    expect([await exists(b), await exists(c)]).toEqual([true, false])
    const after = await snapshot()
    const aboutB = (s: typeof before) => JSON.stringify([s.members, s.links, s.requests, s.sessions].map((rows) => rows.filter((r: Row) => JSON.stringify(r).includes(`"${String(b.id)}"`) || JSON.stringify(r).includes(`:${String(b.id)}"`))))
    expect(aboutB(after)).toEqual(aboutB(before))
    await expectNothingDangling()
  })

  it('bulk-deleting two of three accounts in one set removes their rows and the set left with one', async () => {
    const a = await make(), b = await make(), c = await make()
    const set = await setOf(a, b, c)
    const res = await payload.delete({ collection: 'users', where: { email: { in: [a.email, b.email] } }, overrideAccess: true })
    expect(res.errors).toEqual([])
    expect(await exists(c)).toBe(true)
    expect((await payload.count({ collection: MEMBERS as never, where: { link: { equals: set } }, overrideAccess: true })).totalDocs).toBe(0)
    expect((await payload.count({ collection: LINKS as never, where: { id: { equals: set } }, overrideAccess: true })).totalDocs).toBe(0)
    await expectNothingDangling()
  })

  it('bulk-deleting every account in a set leaves nothing behind', async () => {
    const a = await make(), b = await make(), c = await make()
    await setOf(a, b, c)
    const res = await payload.delete({ collection: 'users', where: { email: { in: [a.email, b.email, c.email] } }, overrideAccess: true })
    expect(res.errors).toEqual([])
    await expectNothingDangling()
  })

  it('deletes a child’s account without an error when the sessions-revoked handler throws', async () => {
    const parent = await make(), kid = await make('kid')
    await setOf(parent, kid)
    events.length = 0
    onEvent = (e) => {
      if (e.type === 'sessions-revoked') throw new Error('the site’s handler is down')
    }
    try {
      await payload.delete({ collection: 'users', id: kid.id, overrideAccess: true })
    } finally {
      onEvent = undefined
    }
    expect(events).toContain('sessions-revoked')
    expect(await exists(kid)).toBe(false)
    await expectNothingDangling()
  })

  it('deletes a child’s account when the sessions-revoked handler never finishes', async () => {
    const parent = await make(), kid = await make('kid')
    await setOf(parent, kid)
    onEvent = (e) => (e.type === 'sessions-revoked' ? new Promise(() => {}) : undefined)
    const t0 = Date.now()
    try {
      const res = await payload.delete({ collection: 'users', where: { id: { equals: kid.id } }, overrideAccess: true })
      expect(res.errors).toEqual([])
    } finally {
      onEvent = undefined
    }
    expect(Date.now() - t0).toBeLessThan(20_000)
    expect(await exists(kid)).toBe(false)
    await expectNothingDangling()
  })

  it('when the site’s own afterDelete fails, either the account and its rows stay or both go', async () => {
    const a = await make(), b = await make('afterfail')
    await setOf(a, b)
    const before = await snapshot()
    await expect(payload.delete({ collection: 'users', id: b.id, overrideAccess: true })).rejects.toThrow()
    if (await exists(b)) expect(await snapshot()).toEqual(before)
    else await expectNothingDangling()
    if (mode === 'mongo') expect(await exists(b)).toBe(true) // a transaction undoes the whole delete
  })

  it('a single delete of a linked account works and leaves nothing behind', async () => {
    const a = await make(), b = await make(), c = await make()
    await setOf(a, b, c)
    await payload.delete({ collection: 'users', id: b.id, overrideAccess: true })
    expect(await exists(b)).toBe(false)
    expect((await payload.count({ collection: MEMBERS as never, where: { user: { in: [a.id, c.id] } }, overrideAccess: true })).totalDocs).toBe(2)
    await expectNothingDangling()
  })
})
