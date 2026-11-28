import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, createLocalReq, getPayload, type Endpoint, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hats, LINKS, MEMBERS, REQUESTS, type HatsUser } from '../src/index.js'
import { linkWorkSettled, relId } from '../src/state.js'

/**
 * Accounts with number ids, as SQL databases give them by default. A made-up users collection with a custom number id
 * on in-memory MongoDB stands in, so the suite needs no SQL adapter. MongoDB itself would accept a string id in a
 * relationship, so the checks here watch what the plugin hands Payload: every account id it writes into a
 * relationship must already be a number. (SQLite and Postgres refuse a string there; `HATS_DB=sqlite` runs the main
 * suite on SQLite.)
 */
let payload: Payload
let mongo: MongoMemoryReplSet
const PW = 'correct-horse-battery'
const mail: { to: string; text: string }[] = []
let next = 100
type U = HatsUser & { id: number; email: string }

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const config = await buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri('hats-numeric'), ensureIndexes: true }),
    collections: [{ slug: 'users', auth: true, fields: [{ name: 'id', type: 'number', required: true }] }],
    plugins: [
      hats({
        hatsOf: () => [{ id: 'member', label: 'Member' }],
        wear: (u) => u,
        canApproveLinks: () => false,
        sendEmail: async ({ to, text }) => void mail.push({ to, text }),
        linkAnswerMs: 0,
        confirmURL: ({ token }) => `https://site.example/api/hats/confirm?token=${token}`,
      }),
    ],
  })
  payload = await getPayload({ config })
}, 120_000)

/** Every account-id value the plugin passes to Payload in a create or update of its own collections. */
const written: { collection: string; field: string; value: unknown }[] = []
const ACCOUNT_FIELDS = ['user', 'requestedBy', 'account', 'addedBy', 'approvedBy']
beforeAll(() => {
  for (const op of ['create', 'update'] as const) {
    const real = payload[op].bind(payload) as (args: { collection: string; data?: Record<string, unknown> }) => Promise<unknown>
    ;(payload as unknown as Record<string, unknown>)[op] = (args: { collection: string; data?: Record<string, unknown> }) => {
      if (args.collection !== 'users')
        for (const field of ACCOUNT_FIELDS) if (args.data && field in args.data && args.data[field] != null) written.push({ collection: args.collection, field, value: args.data[field] })
      return real(args)
    }
  }
})

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

const make = (email: string) => payload.create({ collection: 'users', data: { id: ++next, email, password: PW } as never }) as unknown as Promise<U>
const endpoint = (path: string) => (payload.config.endpoints as Endpoint[]).find((e) => e.path === path && e.method === 'post')!
async function call(path: string, email: string | null, body: unknown) {
  let user: unknown
  if (email) {
    const token = (await payload.login({ collection: 'users', data: { email, password: PW } })).token!
    user = (await payload.auth({ headers: new Headers({ Authorization: `JWT ${token}` }) })).user
  }
  const req = (await createLocalReq({ user: user as never }, payload)) as PayloadRequest
  if (!user) req.user = null
  ;(req as { headers: Headers }).headers = new Headers({ 'content-type': 'application/json' })
  ;(req as { url: string }).url = `https://site.example/api${path}`
  req.data = body as never
  ;(req as unknown as { json: () => Promise<unknown> }).json = async () => body
  const res = await endpoint(path).handler(req)
  await linkWorkSettled()
  return res.status
}
const tokenTo = (email: string) => /token=([\w-]+)/.exec(mail.filter((m) => m.to === email).at(-1)?.text ?? '')?.[1] ?? ''

describe('accounts with number ids', () => {
  it('turns a numeric id into a number for a number-id collection, and leaves other ids as strings', () => {
    expect(relId(payload, 'users', '42')).toBe(42)
    expect(relId(payload, 'users', 42)).toBe(42)
    expect(relId(payload, 'users', null)).toBe(null)
    expect(relId(payload, LINKS, '6650f0c2a1b2c3d4e5f60718')).toBe('6650f0c2a1b2c3d4e5f60718')
  })

  it('writes a link request, both confirmations and the set with number ids, and counts the request against its asker', async () => {
    const asker = await make('asker@example.invalid')
    const target = await make('target@example.invalid')
    expect(await call('/hats/link', asker.email, { email: target.email })).toBe(202)
    const reqs = (await payload.find({ collection: REQUESTS as never, where: { requestedBy: { equals: asker.id } }, depth: 0, overrideAccess: true })).docs as unknown as { requestedBy: unknown; account: unknown }[]
    expect(reqs.map((r) => [r.requestedBy, r.account])).toEqual([[asker.id, target.id]])

    expect(await call('/hats/confirm', null, { token: tokenTo(target.email) })).toBe(200)
    expect(await call('/hats/confirm', null, { token: tokenTo(asker.email) })).toBe(200)
    const rows = (await payload.find({ collection: MEMBERS as never, depth: 0, overrideAccess: true, sort: 'user' })).docs as unknown as { user: unknown; status: string }[]
    expect(rows.map((r) => [r.user, r.status])).toEqual([
      [asker.id, 'confirmed'],
      [target.id, 'confirmed'],
    ])
    const sets = (await payload.find({ collection: LINKS as never, depth: 0, overrideAccess: true })).docs as unknown as { requestedBy: unknown }[]
    expect(sets.map((s) => s.requestedBy)).toEqual([asker.id])

    expect(written.length).toBeGreaterThanOrEqual(5)
    expect(written.filter((w) => typeof w.value !== 'number')).toEqual([])

    await payload.delete({ collection: 'users', id: asker.id, overrideAccess: true })
    expect((await payload.count({ collection: MEMBERS as never, where: { user: { equals: asker.id } }, overrideAccess: true })).totalDocs).toBe(0)
  })
})
