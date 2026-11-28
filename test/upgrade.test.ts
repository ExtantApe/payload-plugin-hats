import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, createLocalReq, getPayload, type Endpoint, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hats, LINKS, MEMBERS, REQUESTS, SESSIONS } from '../src/index.js'
import { asPlugin } from '../src/state.js'

/**
 * A MongoDB database left by 0.4.0, then this build started on it with `ensureIndexes: true`. 0.4.1 needs no host step
 * on MongoDB, so the plugin's 0.4.0 collections must keep exactly the indexes 0.4.0 built (an index of the same name
 * with other options makes MongoDB refuse to start), and the new `hat-requests` collection gets its own.
 *
 * `V040` is what 0.4.0 built, read from a database 0.4.0 started on with `ensureIndexes: true` (2026-11-27). The
 * collections and indexes here are made with the MongoDB driver alone, from that list, before this build starts; the
 * rows are then written the way 0.4.0 wrote them (account ids passed as text). The accounts are made up.
 */
type Index = { name: string; key: Record<string, number>; unique?: boolean; sparse?: boolean }
const stamps: Index[] = [
  { name: '_id_', key: { _id: 1 } },
  { name: 'createdAt_1', key: { createdAt: 1 } },
  { name: 'updatedAt_1', key: { updatedAt: 1 } },
]
const V040: Record<string, Index[]> = {
  [LINKS]: stamps,
  [MEMBERS]: [...stamps, { name: 'link_1', key: { link: 1 } }, { name: 'user_1', key: { user: 1 }, unique: true }, { name: 'tokenHash_1', key: { tokenHash: 1 } }],
  [SESSIONS]: [
    ...stamps,
    { name: 'sid_1', key: { sid: 1 }, unique: true },
    { name: 'user_1', key: { user: 1 } },
    { name: 'via_1', key: { via: 1 } },
    { name: 'link_1', key: { link: 1 } },
    { name: 'expiresAt_1', key: { expiresAt: 1 } },
    { name: 'revokedAt_1', key: { revokedAt: 1 } },
  ],
}

const SQLITE = process.env.HATS_DB === 'sqlite'
const PW = 'correct-horse-battery'
let mongo: MongoMemoryReplSet | undefined
let payload: Payload | undefined
let startError: unknown

const shape = (list: Record<string, unknown>[]) =>
  list
    .map((i) => ({ name: String(i.name), key: i.key as Record<string, number>, ...(i.unique ? { unique: true } : {}), ...(i.sparse ? { sparse: true } : {}), ...(i.partialFilterExpression ? { partial: i.partialFilterExpression } : {}), ...(i.expireAfterSeconds != null ? { ttl: i.expireAfterSeconds } : {}) }))
    .sort((a, b) => a.name.localeCompare(b.name))

describe.skipIf(SQLITE)('starting on a MongoDB database 0.4.0 left', () => {
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger', ip: '127.0.0.1' } })
    const url = mongo.getUri('hats-upgrade')
    const client = await MongoClient.connect(url)
    try {
      const db = client.db()
      for (const [name, list] of Object.entries(V040)) {
        await db.createCollection(name)
        for (const i of list) if (i.name !== '_id_') await db.collection(name).createIndex(i.key, { name: i.name, background: true, ...(i.unique ? { unique: true } : {}) })
      }
    } finally {
      await client.close()
    }
    try {
      const config = await buildConfig({
        secret: 'test-secret-not-for-production',
        telemetry: false,
        typescript: { autoGenerate: false },
        db: mongooseAdapter({ url, ensureIndexes: true }),
        collections: [{ slug: 'users', auth: true, fields: [] }],
        plugins: [hats({ hatsOf: () => [{ id: 'member', label: 'Member' }, { id: 'helper', label: 'Helper' }], wear: (u) => ({ ...u }), canApproveLinks: () => true, sendEmail: async () => {}, linkAnswerMs: 0 })],
      })
      payload = await getPayload({ config, key: 'hats-upgrade' })
    } catch (error) {
      startError = error
    }
  }, 180_000)

  afterAll(async () => {
    await payload?.destroy()
    await mongo?.stop()
  })

  it('starts, with every 0.4.0 index unchanged and the new collection indexed', async () => {
    expect(startError).toBeUndefined()
    const db = (payload!.db as unknown as { connection: { db: { collection: (n: string) => { indexes: () => Promise<Record<string, unknown>[]> } } } }).connection.db
    for (const [name, list] of Object.entries(V040)) expect([name, shape(await db.collection(name).indexes())]).toEqual([name, shape(list as never)])
    const requests = shape(await db.collection(REQUESTS).indexes())
    expect(requests.find((i) => i.name === 'holds_1')).toEqual({ name: 'holds_1', key: { holds: 1 }, unique: true })
    expect(requests.map((i) => i.name)).toEqual(expect.arrayContaining(['requestedBy_1', 'account_1', 'tokenHash_1', 'expiresAt_1']))
  })

  it('switches through, unlinks and deletes in a 0.4.0 set', async () => {
    expect(startError).toBeUndefined()
    const p = payload!
    const mk = async (email: string) => (await p.create({ collection: 'users', data: { email, password: PW } as never })) as unknown as { id: string; email: string }
    const a = await mk('upgrade-a@example.invalid'), b = await mk('upgrade-b@example.invalid'), c = await mk('upgrade-c@example.invalid')
    // Rows as 0.4.0 wrote them: through Payload, with account ids passed as text.
    const req = await createLocalReq({}, p)
    await asPlugin(req, async () => {
      const set = await p.create({ collection: LINKS as never, data: { requestedBy: String(a.id), label: 'Started by a made-up account' } as never, overrideAccess: true, req })
      for (const u of [a, b, c]) await p.create({ collection: MEMBERS as never, data: { link: set.id, user: String(u.id), status: 'approved', addedBy: String(a.id) } as never, overrideAccess: true, req })
    })
    const login = async (email: string) => (await p.login({ collection: 'users', data: { email, password: PW } })).token!
    const call = async (path: string, token: string, body: unknown) => {
      const user = (await p.auth({ headers: new Headers({ Authorization: `JWT ${token}` }) })).user
      const req = (await createLocalReq({ user: user as never }, p)) as PayloadRequest
      Object.assign(req, { headers: new Headers({ 'content-type': 'application/json' }), method: 'POST', url: `https://site.example/api${path}`, data: body, json: async () => body })
      const res = await (p.config.endpoints as Endpoint[]).find((e) => e.path === path && e.method === 'post')!.handler(req)
      const cookie = res.headers.getSetCookie().find((x) => x.startsWith('payload-token='))
      return { status: res.status, token: cookie ? cookie.split(';')[0]!.slice('payload-token='.length) : null }
    }
    const switched = await call('/hats/switch', await login(b.email), { account: String(a.id), hat: 'member' })
    expect(switched.status).toBe(200)
    expect(String((await p.auth({ headers: new Headers({ Authorization: `JWT ${switched.token}` }) })).user?.id)).toBe(String(a.id))
    expect((await call('/hats/unlink', await login(c.email), { account: String(c.id) })).status).toBe(200)
    await p.delete({ collection: 'users', id: b.id, overrideAccess: true })
    expect((await p.auth({ headers: new Headers({ Authorization: `JWT ${switched.token}` }) })).user).toBeNull()
    expect((await p.find({ collection: MEMBERS as never, overrideAccess: true, pagination: false, limit: 0 })).docs).toHaveLength(0)
    expect((await p.find({ collection: LINKS as never, overrideAccess: true, pagination: false, limit: 0 })).docs).toHaveLength(0)
  })
})
