import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, createLocalReq, getPayload, type Endpoint, type Payload, type PayloadRequest, type Plugin } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hats, LINKS, MEMBERS, REQUESTS, SESSIONS } from '../src/index.js'
import { asPlugin, newToken } from '../src/state.js'

/**
 * A database that fails partway, ids that aren't accounts, and code that isn't the plugin's running inside the
 * plugin's own writes. On MongoDB with transactions, MongoDB without them (`transactionOptions: false`) and SQLite
 * (`HATS_DB=sqlite`, with `npm install --no-save @payloadcms/db-sqlite`). What holds on each:
 *   - a delete or unlink whose clean-up hits a database error fails, and is never reported as done;
 *   - with a MongoDB transaction that failure leaves the account and its rows as they were;
 *   - a switched session through an account that no longer exists is refused, however that came about;
 *   - the text "null" is no account: unlink answers `notInSet`, switch `notLinked`, never a 500;
 *   - another plugin's hook, the site's hook and a site field hook can't write `hat-requests` while the plugin works.
 * The accounts are made up. Failures are injected into the database adapter, once, at a named call.
 */
const SQLITE = process.env.HATS_DB === 'sqlite'
const MODES = SQLITE ? (['sqlite'] as const) : (['mongo', 'mongo-notx'] as const)
type Mode = 'sqlite' | 'mongo' | 'mongo-notx'
type Id = string | number
type User = { id: Id; email: string }
const PW = 'correct-horse-battery'

let mongo: MongoMemoryReplSet | undefined
let sqliteDir: string | undefined
const instances: Payload[] = []

beforeAll(async () => {
  if (SQLITE) {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    sqliteDir = await mkdtemp(join(tmpdir(), 'hats-failures-'))
  } else mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger', ip: '127.0.0.1' } })
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
  return mongooseAdapter({ url: mongo!.getUri(`hats-fail-${mode}`), ensureIndexes: true, ...(mode === 'mongo-notx' ? { transactionOptions: false as const } : {}) })
}

describe.each(MODES)('failures and foreign code on %s', (mode) => {
  let payload: Payload
  /** Set by a test: code that isn't the plugin's tries to write a link request, and records what happened. */
  const foreign = { on: false, tries: [] as string[] }
  async function tryWrite(where: string, req: PayloadRequest) {
    if (!foreign.on) return
    try {
      await req.payload.create({ collection: REQUESTS as never, data: { requestedBy: (req.user as User | null)?.id ?? null, holds: `none:${where}-${newToken()}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } as never, overrideAccess: true, req })
      foreign.tries.push(`${where}:written`)
    } catch {
      foreign.tries.push(`${where}:refused`)
    }
  }
  /** One injected failure at `target` (`method:collection`), armed straight away or once an `armAfter` call has run. */
  const inj = { target: '', armed: false, fired: false, armAfter: '' }

  beforeAll(async () => {
    // Another plugin, after hats, with an afterDelete of its own on the plugin's member rows.
    const other: Plugin = (c) => ({
      ...c,
      collections: c.collections!.map((col) =>
        col.slug !== MEMBERS ? col : { ...col, hooks: { ...col.hooks, afterDelete: [...(col.hooks?.afterDelete ?? []), async ({ req }) => tryWrite('other-plugin', req)] } },
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
          // The site's own hook and a field hook, both run while the plugin reads an account in its clean-up.
          hooks: { afterRead: [async ({ doc, req }) => (await tryWrite('site-hook', req), doc)] },
          fields: [{ name: 'nickname', type: 'text', hooks: { afterRead: [async ({ value, req }) => (await tryWrite('site-field', req), value)] } }],
        },
      ],
      plugins: [
        hats({
          hatsOf: () => [{ id: 'member', label: 'Member' }, { id: 'helper', label: 'Helper' }],
          wear: (u) => ({ ...u }),
          canApproveLinks: () => true,
          sendEmail: async () => {},
          linkAnswerMs: 0,
        }),
        other,
      ],
    })
    payload = await getPayload({ config, key: `hats-failures-${mode}` })
    instances.push(payload)
    const db = payload.db as unknown as Record<string, (args: { collection?: string }) => Promise<unknown>>
    for (const m of ['find', 'findOne', 'count', 'create', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany']) {
      const orig = db[m]!.bind(payload.db)
      db[m] = async (args) => {
        if (inj.armed && !inj.fired && `${m}:${args?.collection}` === inj.target) {
          inj.fired = true
          throw new Error('made-up database failure')
        }
        const result = await orig(args)
        if (inj.armAfter && !inj.armed && inj.armAfter.split('|').includes(`${m}:${args?.collection}`)) inj.armed = true
        return result
      }
    }
  }, 120_000)

  let n = 0
  const make = async () => (await payload.create({ collection: 'users', data: { email: `f-${mode}-${++n}@example.invalid`, password: PW } as never })) as unknown as User
  const login = async (u: User) => (await payload.login({ collection: 'users', data: { email: u.email, password: PW } })).token!
  const whoIs = async (token: string) => {
    try {
      return (await payload.auth({ headers: new Headers({ Authorization: `JWT ${token}` }) })).user?.id ?? null
    } catch {
      return null
    }
  }
  async function call(path: string, token: string, body: unknown) {
    const user = (await payload.auth({ headers: new Headers({ Authorization: `JWT ${token}` }) })).user
    const req = (await createLocalReq({ user: user as never }, payload)) as PayloadRequest
    Object.assign(req, { headers: new Headers({ 'content-type': 'application/json' }), method: 'POST', url: `https://site.example/api${path}`, data: body, json: async () => body })
    try {
      const res = await (payload.config.endpoints as Endpoint[]).find((e) => e.path === path && e.method === 'post')!.handler(req)
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('payload-token='))
      return { status: res.status, reason: null as string | null, token: cookie ? cookie.split(';')[0]!.slice('payload-token='.length) : null }
    } catch (e) {
      const err = e as { status?: number; data?: { reason?: string } }
      return { status: err.status ?? 500, reason: err.data?.reason ?? null, token: null }
    }
  }
  /** b signs in and switches into a: the session acts as a, through b. */
  const switchedIn = async (b: User, a: User) => {
    const r = await call('/hats/switch', await login(b), { account: a.id, hat: 'member' })
    expect(r.status).toBe(200)
    return r.token!
  }
  async function setOf(...us: User[]) {
    const req = await createLocalReq({}, payload)
    return asPlugin(req, async () => {
      const set = await payload.create({ collection: LINKS as never, data: { requestedBy: us[0]!.id, label: 'Started by a made-up account' } as never, overrideAccess: true, req })
      for (const u of us) await payload.create({ collection: MEMBERS as never, data: { link: set.id, user: u.id, status: 'approved', addedBy: us[0]!.id } as never, overrideAccess: true, req })
      return set.id as Id
    })
  }
  const exists = async (u: User) => (await payload.count({ collection: 'users', where: { id: { equals: u.id } }, overrideAccess: true })).totalDocs === 1
  const membersOf = async (link: Id) => (await payload.count({ collection: MEMBERS as never, where: { link: { equals: link } }, overrideAccess: true })).totalDocs
  const linkThere = async (link: Id) => (await payload.count({ collection: LINKS as never, where: { id: { equals: link } }, overrideAccess: true })).totalDocs === 1
  const disarm = () => Object.assign(inj, { target: '', armed: false, fired: false, armAfter: '' })

  for (const target of ['find:hat-members', 'deleteOne:hat-members', 'find:hat-sessions', 'find:hat-links', 'deleteOne:hat-links', 'updateOne:hat-sessions'])
    it(`an account delete that fails at ${target} during its clean-up throws, and nothing acts through it`, async () => {
      const a = await make(), b = await make()
      const link = await setOf(a, b)
      const token = await switchedIn(b, a)
      Object.assign(inj, { target, armed: false, fired: false, armAfter: 'deleteOne:users|deleteMany:users' })
      let threw = false
      try {
        await payload.delete({ collection: 'users', id: b.id, overrideAccess: true })
      } catch {
        threw = true
      } finally {
        const fired = inj.fired
        disarm()
        expect(fired).toBe(true)
      }
      expect(threw).toBe(true)
      if (mode === 'mongo') {
        // The transaction undid the whole delete.
        expect(await exists(b)).toBe(true)
        expect(await membersOf(link)).toBe(2)
        expect(await linkThere(link)).toBe(true)
      }
      if (!(await exists(b))) expect(await whoIs(token)).toBeNull()
      else expect(String(await whoIs(token))).toBe(String(a.id))
    })

  // The unlinked row goes first (deleteOne:hat-members); the set dissolving then removes the other row and the set.
  for (const target of ['deleteOne:hat-links', 'deleteOne:hat-members'])
    it(`an unlink that fails at ${target} while its set dissolves isn't reported as done`, async () => {
      const a = await make(), b = await make()
      const link = await setOf(a, b)
      const token = await login(a)
      Object.assign(inj, { target, armed: target === 'deleteOne:hat-links', fired: false, armAfter: target === 'deleteOne:hat-links' ? '' : 'deleteOne:hat-members' })
      const r = await call('/hats/unlink', token, { account: a.id })
      const fired = inj.fired
      disarm()
      expect(fired).toBe(true)
      expect(r.status).toBeGreaterThanOrEqual(500)
      if (mode === 'mongo') expect(await membersOf(link)).toBe(2)
    })

  it('an approver’s delete of a member row that fails while the set dissolves throws', async () => {
    const a = await make(), b = await make()
    const link = await setOf(a, b)
    const row = (await payload.find({ collection: MEMBERS as never, where: { user: { equals: b.id } }, overrideAccess: true, limit: 1 })).docs[0]!
    Object.assign(inj, { target: 'deleteOne:hat-links', armed: true, fired: false })
    let threw = false
    try {
      await payload.delete({ collection: MEMBERS as never, id: row.id, overrideAccess: true })
    } catch {
      threw = true
    }
    const fired = inj.fired
    disarm()
    expect(fired).toBe(true)
    expect(threw).toBe(true)
    if (mode === 'mongo') expect(await membersOf(link)).toBe(2)
  })

  it('refuses a switched session whose originating account is gone, and ends it', async () => {
    const a = await make(), b = await make()
    await setOf(a, b)
    const token = await switchedIn(b, a)
    // The account row goes with none of the plugin's clean-up, as a failed delete without a transaction can leave it.
    await payload.db.deleteOne({ collection: 'users', where: { id: { equals: b.id } } })
    expect(await whoIs(token)).toBeNull()
    const live = await payload.find({ collection: SESSIONS as never, where: { and: [{ via: { equals: String(b.id) } }, { revokedAt: { exists: false } }] }, overrideAccess: true })
    expect(live.docs).toHaveLength(0)
  })

  it('treats the text "null" as no account, on unlink and on switch', async () => {
    const a = await make(), b = await make()
    const link = await setOf(a, b)
    // A row whose account was cleared, in a's own set, as a database's foreign key can leave one.
    await payload.db.create({ collection: MEMBERS, data: { link, user: null, status: 'approved' } })
    const token = await login(a)
    for (const account of ['null', 'undefined']) {
      expect(await call('/hats/unlink', token, { account })).toMatchObject({ status: 404, reason: 'notInSet' })
      expect(await call('/hats/switch', token, { account, hat: 'member' })).toMatchObject({ status: 403, reason: 'notLinked' })
    }
    expect(await membersOf(link)).toBe(3)
    expect(await call('/hats/switch', token, { account: ` ${String(b.id)}`, hat: 'member' })).toMatchObject({ status: 403, reason: 'notLinked' })
  })

  it('lets no other plugin, site hook or site field hook write a link request during the plugin’s own work', async () => {
    const a = await make(), b = await make(), c = await make(), d = await make()
    await setOf(a, b)
    await setOf(c, d)
    await switchedIn(b, a)
    const tokenC = await login(c)
    const before = (await payload.count({ collection: REQUESTS as never, overrideAccess: true })).totalDocs
    foreign.on = true
    try {
      expect((await call('/hats/unlink', tokenC, { account: c.id })).status).toBe(200)
      await payload.delete({ collection: 'users', id: b.id, overrideAccess: true })
    } finally {
      foreign.on = false
    }
    const kinds = new Set(foreign.tries)
    expect(kinds).toContain('other-plugin:refused')
    expect(kinds).toContain('site-hook:refused')
    expect(kinds).toContain('site-field:refused')
    expect([...kinds].filter((k) => k.endsWith(':written'))).toEqual([])
    expect((await payload.count({ collection: REQUESTS as never, overrideAccess: true })).totalDocs).toBe(before)
    foreign.tries.length = 0
  })
})
