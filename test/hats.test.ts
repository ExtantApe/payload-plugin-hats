import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, createLocalReq, createPayloadRequest, getPayload, type SanitizedConfig, type Endpoint, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyHat, cleanupSessions, hats, hatsStateOf, MEMBERS, REQUESTS, SESSIONS, switchSession, type Hat, type HatsEvent, type HatsUser } from '../src/index.js'
import { asPlugin, hashToken, isDissolving, isInternal, linkWorkSettled, unmarked, withMark, DISSOLVING } from '../src/state.js'
import type { ResolvedHatsOptions } from '../src/types.js'

/**
 * A made-up site: a role ladder member < author < curator < admin (curator and admin sensitive), notes only admins
 * may read, a "maintainer" flag for approving links, and a fake second factor (the code is stored on the account).
 */
const LADDER = ['member', 'author', 'curator', 'admin'] as const
type Level = (typeof LADDER)[number]
type U = HatsUser & { level: Level; maintainer?: boolean; code?: string | null; disabled?: boolean }
const hatsOf = (u: HatsUser): Hat[] => {
  if ((u as U).disabled) return [] // as a site does for a disabled account
  const level = LADDER.indexOf((u as U).level ?? 'member')
  return LADDER.slice(0, level + 1).map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1), sensitive: id === 'curator' || id === 'admin' }))
}
const wear = (u: HatsUser, hat: string) => ({ ...u, level: hat as Level, maintainer: hat === 'admin' ? (u as U).maintainer : false }) as HatsUser

let payload: Payload
let config: SanitizedConfig
let mongo: MongoMemoryReplSet
const PW = 'correct-horse-battery'
const mail: { to: string; text: string }[] = []
const events: HatsEvent[] = []
let masquerading = false
/**
 * MongoDB in memory by default. `HATS_DB=sqlite` runs the same suite on SQLite, for a check by hand with
 * `npm install --no-save @payloadcms/db-sqlite` (it isn't a dependency); its file lives in a temp folder this suite
 * makes and removes. Tests that count MongoDB's own write calls are skipped there.
 */
const SQLITE = process.env.HATS_DB === 'sqlite'
let sqliteDir: string | undefined
async function database() {
  if (!SQLITE) {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
    return mongooseAdapter({ url: mongo.getUri('hats'), ensureIndexes: true })
  }
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  sqliteDir = await mkdtemp(join(tmpdir(), 'hats-sqlite-'))
  const name = '@payloadcms/db-sqlite'
  const { sqliteAdapter } = (await import(name)) as { sqliteAdapter: (args: unknown) => never }
  return sqliteAdapter({ client: { url: `file:${join(sqliteDir, 'hats.db')}` }, push: true })
}
/** Stand-in answers for the site's own checks, so a test can make them say something other than true or false. */
const answers: { approve?: () => unknown; available?: () => unknown; verify?: () => unknown; limit?: () => unknown; blocked?: () => unknown; event?: (e: HatsEvent) => unknown; confirmURL?: (args: { req: PayloadRequest; token: string }) => string } = {}
/** Truthy answers that aren't `true`, and a thrown error: every one must be a no. */
const NOT_TRUE: [string, () => unknown][] = [
  ['1', () => 1],
  ["'yes'", () => 'yes'],
  ['{ valid: false }', () => ({ valid: false })],
  ['a resolved object', async () => ({})],
  ['a thrown error', () => {
    throw new Error('check store down')
  }],
  ['a rejected promise', async () => {
    throw new Error('check store down')
  }],
]

/** Writes as the plugin itself, as only the plugin's own code can: the mark is private to its modules. */
const plugin = async <T,>(fn: (req: PayloadRequest) => Promise<T>) => {
  const req = await createLocalReq({}, payload)
  return asPlugin(req, () => fn(req))
}
/** Off only in tests that time the answer itself or hold a send open on purpose. */
let settleLinks = true
const tokenFrom = (text: string) => /token=([\w-]+)/.exec(text)?.[1] ?? ''
const endpoint = (path: string, method: string) => (payload.config.endpoints as Endpoint[]).find((e) => e.path === path && e.method === method)!
/** The signed-in user for a token, exactly as REST, GraphQL and the admin see it (Payload's auth strategies). */
const whoIs = async (token: string) => (await payload.auth({ headers: new Headers({ Authorization: `JWT ${token}` }) })).user as U | null

async function call(path: string, token: string | null, body: unknown = {}, method = 'post') {
  const user = token ? await whoIs(token) : null
  const req = (await createLocalReq({ user: (user ?? undefined) as never }, payload)) as PayloadRequest
  if (!user) req.user = null
  ;(req as { headers: Headers }).headers = new Headers({ 'content-type': 'application/json' })
  ;(req as { method: string }).method = 'POST'
  ;(req as { url: string }).url = `https://site.example/api${path}`
  req.data = body as never
  ;(req as unknown as { json: () => Promise<unknown> }).json = async () => body
  try {
    const res = await endpoint(path, method).handler(req)
    // A link request answers after linkAnswerMs and may still be working; wait for it, so what it mails is there.
    if (path === '/hats/link' && settleLinks) await linkWorkSettled()
    const text = await res.text()
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('payload-token='))
    return { status: res.status, body: text.startsWith('{') ? JSON.parse(text) : text, token: cookie ? cookie.split(';')[0]!.slice('payload-token='.length) : null }
  } catch (error) {
    return { status: (error as { status?: number }).status ?? 500, body: { message: (error as Error).message, data: (error as { data?: unknown }).data } as Record<string, any>, token: null }
  }
}

const login = async (email: string) => (await payload.login({ collection: 'users', data: { email, password: PW } })).token!
const make = (email: string, level: Level, extra: Partial<U> = {}) =>
  payload.create({ collection: 'users', data: { email, password: PW, level, ...extra } as never }) as unknown as Promise<U>
const canReadSecrets = async (user: U | null) => {
  try {
    await payload.find({ collection: 'secrets', user: user as never, overrideAccess: false })
    return true
  } catch {
    return false
  }
}

/** Confirms every token mailed so far, and the ones those confirmations mail, once each. */
async function confirmAll() {
  const used = new Set<string>()
  for (;;) {
    const fresh = mail.map((m) => tokenFrom(m.text)).filter((t) => t && !used.has(t))
    if (!fresh.length) return
    for (const t of fresh) {
      used.add(t)
      expect((await call('/hats/confirm', null, { token: t })).status).toBe(200)
    }
  }
}

/** Links accounts the way people do: request, the other account confirms, then the asker, then a maintainer outside the set approves. */
async function link(from: U, to: U, approver: U) {
  mail.length = 0
  const res = await call('/hats/link', await login(from.email!), { email: to.email })
  expect(res.status).toBe(202)
  await confirmAll()
  const { docs } = await payload.find({ collection: MEMBERS as never, where: { status: { equals: 'confirmed' } }, depth: 0, overrideAccess: true })
  for (const d of docs) await payload.update({ collection: MEMBERS as never, id: d.id, data: { status: 'approved' } as never, user: approver as never, overrideAccess: false })
}

beforeAll(async () => {
  config = await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: await database(),
      collections: [
        {
          slug: 'users',
          auth: true,
          access: { update: () => true },
          fields: [
            { name: 'level', type: 'select', options: [...LADDER], defaultValue: 'member', saveToJWT: true },
            { name: 'maintainer', type: 'checkbox' },
            { name: 'code', type: 'text' },
            { name: 'disabled', type: 'checkbox' },
            { name: 'minorUntil', type: 'date' }, // as an age check might store it; the plugin never reads it
            { name: '_verified', type: 'checkbox', admin: { hidden: true } }, // what Payload adds when auth.verify is on; the test turns that on by hand
          ],
        },
        { slug: 'secrets', access: { read: ({ req }) => (req.user as U | null)?.level === 'admin' }, fields: [{ name: 'text', type: 'text' }] },
      ],
      plugins: [
        hats({
          hatsOf,
          wear,
          canApproveLinks: ({ user }) => (answers.approve ? (answers.approve() as boolean) : Boolean((user as U).maintainer)),
          stepUp: {
            available: async (u) => (answers.available ? (answers.available() as boolean) : Boolean((u as U).code)),
            verify: ({ user, code }) => (answers.verify ? (answers.verify() as boolean) : code === (user as U).code),
          },
          blocked: () => (answers.blocked ? (answers.blocked() as string | null) : masquerading ? 'Stop masquerading first.' : null),
          limit: ({ email }) => {
            if (answers.limit) return answers.limit() as boolean
            if (email.startsWith('broken-')) throw new Error('limit store down')
            return !email.startsWith('limited-')
          },
          sendEmail: async ({ to, text }) => void mail.push({ to, text }),
          linkAnswerMs: 100,
          // The plugin's own default, unless a test asks otherwise.
          confirmURL: (args) => (answers.confirmURL ? answers.confirmURL(args) : `https://site.example/api/hats/confirm?token=${args.token}`),
          onEvent: (e) => {
            events.push(e)
            if (answers.event) return answers.event(e) as void
          },
        }),
      ],
    })
  payload = await getPayload({ config })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
  if (sqliteDir) await (await import('node:fs/promises')).rm(sqliteDir, { recursive: true, force: true }) // only the folder this suite made
})

let n = 0
const email = (name: string) => `${name}-${++n}@example.invalid`
beforeEach(() => {
  masquerading = false
  delete answers.approve
  delete answers.available
  delete answers.verify
  delete answers.limit
  delete answers.blocked
  delete answers.event
  delete answers.confirmURL
  mail.length = 0
})

describe('hats on one account', () => {
  it('starts in every role, narrows to a hat, and the hat holds for every reader of req.user', async () => {
    const admin = await make(email('admin'), 'admin', { code: '123456' })
    const token = await login(admin.email!)
    expect((await whoIs(token))!.level).toBe('admin')
    expect(await canReadSecrets(await whoIs(token))).toBe(true)

    const menu = await call('/hats', token, undefined, 'get')
    expect(menu.body.hats.map((h: Hat) => h.id)).toEqual(['member', 'author', 'curator', 'admin'])
    expect(menu.body.hat).toBe('admin')
    expect(menu.body.showSwitch).toBe(true)

    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(200)
    const narrowed = await whoIs(token)
    expect(narrowed!.level).toBe('member')
    expect(hatsStateOf(narrowed)).toMatchObject({ hat: 'member', via: null })
    // The canary: an administrator wearing Member reads nothing only administrators may read.
    expect(await canReadSecrets(narrowed)).toBe(false)
    // The state never ends up in a response.
    expect(JSON.stringify(narrowed)).not.toContain('_hats')
  })

  it('narrows the user REST and GraphQL requests are built with', async () => {
    const admin = await make(email('admin'), 'admin', { code: '5' })
    const token = await login(admin.email!)
    await call('/hats/switch', token, { hat: 'member' })
    for (const path of ['/api/secrets', '/api/graphql']) {
      const req = await createPayloadRequest({ config, request: new Request(`https://site.example${path}`, { headers: { cookie: `payload-token=${token}` } }) })
      expect((req.user as U).level).toBe('member')
      await expect(payload.find({ collection: 'secrets', req, overrideAccess: false })).rejects.toThrow()
    }
  })

  it('asks for the second factor to switch up, refuses a wrong code, remembers a good one, then asks again', async () => {
    const admin = await make(email('admin'), 'admin', { code: '654321' })
    const token = await login(admin.email!)
    await call('/hats/switch', token, { hat: 'author' })
    // Narrowing never needs a code.
    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(200)
    const ask = await call('/hats/switch', token, { hat: 'admin' })
    expect(ask.status).toBe(401)
    expect(ask.body.needsCode).toBe(true)
    const wrong = await call('/hats/switch', token, { hat: 'admin', code: '000000' })
    expect(wrong.status).toBe(403)
    expect(wrong.body.reason ?? wrong.body.data?.reason).toBe('wrongCode')
    expect((await whoIs(token))!.level).toBe('member')
    expect((await call('/hats/switch', token, { hat: 'admin', code: '654321' })).status).toBe(200)
    expect((await whoIs(token))!.level).toBe('admin')

    await call('/hats/switch', token, { hat: 'member' })
    expect((await call('/hats/switch', token, { hat: 'curator' })).status).toBe(200) // remembered

    const sid = hatsStateOf(await whoIs(token))!.sid
    const { docs } = await payload.find({ collection: SESSIONS as never, where: { sid: { equals: sid } }, overrideAccess: true })
    const old = new Date(Date.now() - 181 * 60_000).toISOString()
    await payload.update({ collection: SESSIONS as never, id: docs[0]!.id, data: { steppedUp: { [String(admin.id)]: old } } as never, overrideAccess: true })
    await call('/hats/switch', token, { hat: 'member' })
    expect((await call('/hats/switch', token, { hat: 'admin' })).status).toBe(401) // three hours on: asked again
  })

  it('refuses a sensitive hat on an account with no second factor, and any hat the account doesn’t hold', async () => {
    const curator = await make(email('curator'), 'curator')
    const token = await login(curator.email!)
    await call('/hats/switch', token, { hat: 'member' })
    const res = await call('/hats/switch', token, { hat: 'curator' })
    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/two-step/)
    expect((await call('/hats/switch', token, { hat: 'admin' })).status).toBe(400)
  })

  it('falls to the narrowest hat when the worn one is gone, and never lets wear() widen', async () => {
    const u = await make(email('curator'), 'curator', { code: '111111' })
    const token = await login(u.email!)
    await call('/hats/switch', token, { hat: 'author' })
    await payload.update({ collection: 'users', id: u.id, data: { level: 'member' } as never, overrideAccess: true })
    await payload.update({ collection: 'users', id: u.id, data: { level: 'curator' } as never, overrideAccess: true })
    expect((await whoIs(token))!.level).toBe('author')
    // A stored hat the account no longer holds (e.g. written before a role change): narrowest, not widest.
    const sid = hatsStateOf(await whoIs(token))!.sid
    const { docs } = await payload.find({ collection: SESSIONS as never, where: { sid: { equals: sid } }, overrideAccess: true })
    await payload.update({ collection: SESSIONS as never, id: docs[0]!.id, data: { hat: 'pope' } as never, overrideAccess: true })
    expect((await whoIs(token))!.level).toBe('member')

    await payload.update({ collection: SESSIONS as never, id: docs[0]!.id, data: { hat: 'member' } as never, overrideAccess: true })
    const raw = { ...(await payload.findByID({ collection: 'users', id: u.id, overrideAccess: true })), collection: 'users', _sid: sid } as unknown as HatsUser
    const opts = payload.config.custom!.hats
    await expect(applyHat(payload, { ...opts, wear: (x: HatsUser) => ({ ...x, level: 'admin' }) as HatsUser }, raw)).rejects.toThrow(/doesn't hold/)
    await expect(applyHat(payload, { ...opts, wear: (x: HatsUser) => x }, raw)).rejects.toThrow(/sensitive/)
  })

  it('hides the switch from an account with nothing to switch to, and refuses it while masquerading', async () => {
    const member = await make(email('member'), 'member')
    const token = await login(member.email!)
    expect((await call('/hats', token, undefined, 'get')).body.showSwitch).toBe(false)
    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(403)

    const admin = await make(email('admin'), 'admin', { code: '1' })
    masquerading = true
    expect((await call('/hats/switch', await login(admin.email!), { hat: 'member' })).status).toBe(409)
  })
})

describe('an account left with no hats', () => {
  it('signs out its sessions that wear a hat or came from another account, instead of giving them every role', async () => {
    // Its own session, wearing a narrower hat.
    const own = await make(email('nohat'), 'author')
    const token = await login(own.email!)
    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(200)
    // Disabled without any hook running (a direct write), so only the per-request check stands in the way.
    await payload.db.updateOne({ collection: 'users', id: own.id, data: { disabled: true }, returning: false })
    expect(await whoIs(token)).toBeNull()

    // A session switched into it from a linked account.
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const a = await make(email('a'), 'author')
    const b = await make(email('b'), 'admin', { code: '424242' })
    await link(a, b, approver)
    const res = await call('/hats/switch', await login(a.email!), { account: b.id, hat: 'member' })
    expect(await whoIs(res.token!)).toBeTruthy()
    await payload.db.updateOne({ collection: 'users', id: b.id, data: { disabled: true }, returning: false })
    expect(await whoIs(res.token!)).toBeNull()

    // A plain sign-in with no hats is the site's business (it refuses disabled accounts at sign-in): unchanged.
    const plain = await make(email('plain'), 'member')
    const plainToken = await login(plain.email!)
    await payload.db.updateOne({ collection: 'users', id: plain.id, data: { disabled: true }, returning: false })
    expect((await whoIs(plainToken))?.id).toBe(plain.id)
  })
})

describe('wear() that doesn’t narrow', () => {
  it('refuses a wear() that hands back the same user', async () => {
    // An author wearing Member: no sensitive hat involved, so only this guard can catch it.
    const u = await make(email('w'), 'author')
    const token = await login(u.email!)
    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(200)
    const sid = hatsStateOf(await whoIs(token))!.sid
    const raw = (await payload.findByID({ collection: 'users', id: u.id, depth: 0, overrideAccess: true })) as unknown as HatsUser
    const opts = { ...(payload.config.custom!.hats as ResolvedHatsOptions), wear: (x: HatsUser) => x }
    await expect(applyHat(payload, opts, { ...raw, collection: 'users', _sid: sid } as HatsUser)).rejects.toThrow(/unchanged/)
  })
})

describe('linking', () => {
  it('needs both emails confirmed and an approver outside the set; tokens work once', async () => {
    const maint = await make(email('maint'), 'admin', { maintainer: true, code: '9' })
    const other = await make(email('maint2'), 'admin', { maintainer: true, code: '8' })
    const b = await make(email('b'), 'member')
    const res = await call('/hats/link', await login(maint.email!), { email: b.email })
    expect(res.status).toBe(202)
    // The asker gets a note with no token; only the other account gets a link to confirm.
    expect(mail.map((m) => m.to).sort()).toEqual([maint.email, b.email].sort())
    expect(tokenFrom(mail.find((m) => m.to === maint.email)!.text)).toBe('')
    const tb = tokenFrom(mail.find((m) => m.to === b.email)!.text)
    expect(tb).not.toBe('')
    const rowOf = async (u: U) => (await payload.find({ collection: MEMBERS as never, where: { user: { equals: u.id } }, overrideAccess: true })).docs[0]
    // Nothing is in a set until the other account confirms.
    expect(await rowOf(maint)).toBeUndefined()
    expect(await rowOf(b)).toBeUndefined()

    // A mail scanner opening the link confirms nothing.
    expect((await call('/hats/confirm', null, undefined, 'get')).status).toBe(200)
    expect(await rowOf(b)).toBeUndefined()
    mail.length = 0
    expect((await call('/hats/confirm', null, { token: tb })).status).toBe(200)
    expect((await call('/hats/confirm', null, { token: tb })).status).toBe(400) // once only
    expect((await rowOf(b))!.status).toBe('confirmed')
    expect((await rowOf(maint))!.status).toBe('requested')
    // Then the asker confirms from their own email.
    expect(mail.map((m) => m.to)).toEqual([maint.email])
    const ta = tokenFrom(mail[0]!.text)
    // Not before it's confirmed.
    await expect(payload.update({ collection: MEMBERS as never, id: (await rowOf(maint))!.id, data: { status: 'approved' } as never, user: other as never, overrideAccess: false })).rejects.toThrow(/confirmed/)
    expect((await call('/hats/confirm', null, { token: ta })).status).toBe(200)
    expect((await call('/hats/confirm', null, { token: ta })).status).toBe(400) // once only
    expect((await rowOf(maint))!.status).toBe('confirmed')
    const row = async () => (await rowOf(b))!

    // The approver is in the set: refused, so the owner's own links need someone else.
    await expect(payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { status: 'approved' } as never, user: maint as never, overrideAccess: false })).rejects.toThrow(/belong to/)
    // Nobody else can rewrite the row, or approve without the approver role.
    await expect(payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { user: other.id } as never, user: other as never, overrideAccess: false })).rejects.toThrow()
    await expect(payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { status: 'approved' } as never, user: b as never, overrideAccess: false })).rejects.toThrow()
    await payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { status: 'approved' } as never, user: other as never, overrideAccess: false })
    expect((await row()).status).toBe('approved')
    expect((await row()).approvedBy).toBeTruthy()
  })

  it('refuses an expired link and gives nothing away about other accounts', async () => {
    const a = await make(email('a'), 'author')
    const taken = await make(email('taken'), 'member')
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    await link(taken, await make(email('x'), 'member'), approver)
    mail.length = 0

    const token = await login(a.email!)
    const answers = [await call('/hats/link', token, { email: 'nobody@example.invalid' }), await call('/hats/link', token, { email: taken.email }), await call('/hats/link', token, { email: a.email })]
    for (const r of answers) expect([r.status, r.body.message]).toEqual([202, answers[0]!.body.message])
    // Only the asker's own note, the same each time, with no token.
    expect(mail.map((m) => m.to)).toEqual([a.email, a.email, a.email])
    expect(new Set(mail.map((m) => m.text)).size).toBe(1)
    expect(tokenFrom(mail[0]!.text)).toBe('')

    const fresh = await make(email('fresh'), 'member')
    await call('/hats/link', token, { email: fresh.email })
    // The requester's own menu shows nothing until the other account confirms.
    expect((await call('/hats', token, undefined, 'get')).body.set).toEqual([])
    const t = tokenFrom(mail.find((m) => m.to === fresh.email)!.text)
    const req = (await payload.find({ collection: REQUESTS as never, where: { account: { equals: fresh.id } }, overrideAccess: true })).docs[0]!
    await plugin((r) => payload.update({ collection: REQUESTS as never, id: req.id, data: { expiresAt: new Date(Date.now() - 1000).toISOString() } as never, overrideAccess: true , req: r })) // as time passing would
    expect((await call('/hats/confirm', null, { token: t })).status).toBe(400)
    expect((await payload.find({ collection: MEMBERS as never, where: { user: { in: [a.id, fresh.id] } }, overrideAccess: true })).totalDocs).toBe(0)
  })

  it('refuses link requests the site’s limit refuses, and when the limit itself fails, sending nothing', async () => {
    const a = await make(email('lim'), 'member')
    const target = await make(`limited-${email('t')}`, 'member')
    const broken = await make(`broken-${email('t')}`, 'member')
    for (const to of [target, broken]) {
      const res = await call('/hats/link', await login(a.email!), { email: to.email })
      expect(res.status).toBe(429)
      expect(res.body.data?.reason).toBe('tooMany')
    }
    expect(mail).toHaveLength(0)
    expect((await payload.find({ collection: MEMBERS as never, where: { user: { in: [a.id, target.id, broken.id] } }, overrideAccess: true })).totalDocs).toBe(0)
  })

  it('holds at most four accounts, and one set per account', async () => {
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const [a, b, c, d, e] = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((x) => make(email(x), 'author')))
    await link(a!, b!, approver)
    await link(a!, c!, approver)
    await link(a!, d!, approver)
    const res = await call('/hats/link', await login(a!.email!), { email: e!.email })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/at most 4/)
    const set = await payload.find({ collection: MEMBERS as never, where: { user: { in: [a!.id, b!.id, c!.id, d!.id] } }, overrideAccess: true })
    expect(new Set(set.docs.map((m) => String((m as unknown as { link: unknown }).link))).size).toBe(1)
    expect(set.docs.every((m) => (m as unknown as { status: string }).status === 'approved')).toBe(true)
  })
})

describe('switching accounts', () => {
  async function linkedPair() {
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const a = await make(email('a'), 'author')
    const b = await make(email('b'), 'admin', { code: '424242' })
    await link(a, b, approver)
    return { a, b, approver }
  }

  it('switches within an approved set, credits the account switched to, and asks for that account’s code', async () => {
    const { a, b } = await linkedPair()
    const token = await login(a.email!)
    expect((await call('/hats', token, undefined, 'get')).body.linked.map((l: { label: string }) => l.label)).toEqual([b.email])
    // Into b's narrowest hat: no code needed.
    const res = await call('/hats/switch', token, { account: b.id, hat: 'member' })
    expect(res.status).toBe(200)
    expect(res.token).toBeTruthy()
    const asB = await whoIs(res.token!)
    expect(asB!.id).toBe(b.id)
    expect(asB!.level).toBe('member')
    expect(hatsStateOf(asB)).toMatchObject({ via: String(a.id), hat: 'member' })
    expect(await whoIs(token)).toBeNull() // the session it came from has ended
    // b's admin hat: b's own second factor.
    expect((await call('/hats/switch', res.token, { hat: 'admin' })).status).toBe(401)
    expect((await call('/hats/switch', res.token, { hat: 'admin', code: '424242' })).status).toBe(200)
    expect(await canReadSecrets(await whoIs(res.token!))).toBe(true)
    // Back to a: a plain session of a's own again.
    const back = await call('/hats/switch', res.token, { account: a.id, hat: 'author' })
    expect(hatsStateOf(await whoIs(back.token!))).toMatchObject({ via: null })
  })

  it('refuses accounts outside the set, including before approval', async () => {
    const { a } = await linkedPair()
    const stranger = await make(email('s'), 'admin')
    expect((await call('/hats/switch', await login(a.email!), { account: stranger.id, hat: 'member' })).status).toBe(403)
    const c = await make(email('c'), 'member')
    mail.length = 0
    await call('/hats/link', await login(a.email!), { email: c.email })
    await confirmAll()
    expect((await call('/hats/switch', await login(a.email!), { account: c.id, hat: 'member' })).status).toBe(403)
  })

  it('ends switched sessions the moment the link goes: self-serve unlink, an approver’s delete, a lost role', async () => {
    const into = async () => {
      const p = await linkedPair()
      const res = await call('/hats/switch', await login(p.a.email!), { account: p.b.id, hat: 'member' })
      expect(await whoIs(res.token!)).toBeTruthy()
      return { ...p, token: res.token! }
    }
    // Unlink, self-serve, from b's own sign-in.
    let s = await into()
    const own = await login(s.b.email!)
    expect((await call('/hats/unlink', own, {})).status).toBe(200)
    expect(await whoIs(s.token)).toBeNull()
    expect(await whoIs(own)).toBeTruthy() // b's own sign-in stays
    expect((await payload.find({ collection: MEMBERS as never, where: { user: { equals: s.a.id } }, overrideAccess: true })).totalDocs).toBe(0) // a set of one is gone

    // An approver deletes the row.
    s = await into()
    const row = (await payload.find({ collection: MEMBERS as never, where: { user: { equals: s.b.id } }, overrideAccess: true })).docs[0]!
    await payload.delete({ collection: MEMBERS as never, id: row.id, user: s.approver as never, overrideAccess: false })
    expect(await whoIs(s.token)).toBeNull()

    // b loses a role.
    s = await into()
    await payload.update({ collection: 'users', id: s.b.id, data: { level: 'curator' } as never, overrideAccess: true })
    expect(await whoIs(s.token)).toBeNull()

    // Even if the session record survived somehow, the set is re-checked on every request.
    s = await into()
    const sid = hatsStateOf(await whoIs(s.token))!.sid
    await payload.db.deleteMany({ collection: MEMBERS, where: { user: { equals: s.b.id } } })
    expect(await whoIs(s.token)).toBeNull()
    const rows = (await payload.find({ collection: SESSIONS as never, where: { sid: { equals: sid } }, overrideAccess: true })).docs as { revokedAt?: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.revokedAt).toBeTruthy() // kept as a tombstone, not deleted
  })

  it('keeps a revoked session signed out even when Payload puts it back', async () => {
    const { a, b } = await linkedPair()
    const res = await call('/hats/switch', await login(a.email!), { account: b.id, hat: 'member' })
    const sid = hatsStateOf(await whoIs(res.token!))!.sid
    const sessionsOf = async () => ((await payload.findByID({ collection: 'users', id: b.id, depth: 0, overrideAccess: true, showHiddenFields: true })) as unknown as { sessions: { id: string }[] }).sessions
    const before = await sessionsOf()
    expect(before.some((x) => x.id === sid)).toBe(true)
    // b loses a role: switched sessions end, while the link itself stays.
    await payload.update({ collection: 'users', id: b.id, data: { level: 'curator' } as never, overrideAccess: true })
    expect(await whoIs(res.token!)).toBeNull()
    // A sign-in elsewhere that read b's sessions before the revocation writes them all back.
    await payload.db.updateOne({ collection: 'users', id: b.id, data: { sessions: before }, returning: false })
    expect((await sessionsOf()).some((x) => x.id === sid)).toBe(true)
    // Still signed out: never a plain sign-in with b's every role. And the session is taken off again.
    expect(await whoIs(res.token!)).toBeNull()
    expect((await sessionsOf()).some((x) => x.id === sid)).toBe(false)
  })

  it('cleans up session records only once their Payload session is gone', async () => {
    const { a, b } = await linkedPair()
    const res = await call('/hats/switch', await login(a.email!), { account: b.id, hat: 'member' })
    const sid = hatsStateOf(await whoIs(res.token!))!.sid
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
    // A live switched session whose record says it expired (Payload refreshed it): kept.
    await payload.update({ collection: SESSIONS as never, where: { sid: { equals: sid } }, data: { expiresAt: old } as never, overrideAccess: true })
    // A long-gone one: removed.
    await payload.create({ collection: SESSIONS as never, data: { sid: `gone-${n}`, user: String(b.id), revokedAt: old, expiresAt: old } as never, overrideAccess: true })
    await cleanupSessions(payload)
    const left = async (s: string) => (await payload.find({ collection: SESSIONS as never, where: { sid: { equals: s } }, overrideAccess: true })).totalDocs
    expect(await left(sid)).toBe(1)
    expect(await left(`gone-${n}`)).toBe(0)
    const asB = await whoIs(res.token!)
    expect(asB!.level).toBe('member') // still narrowed
  })

  it('records who did what for the audit log', async () => {
    events.length = 0
    const { a, b } = await linkedPair()
    await call('/hats/switch', await login(a.email!), { account: b.id, hat: 'member' })
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['link-requested', 'link-confirmed', 'link-approved', 'switched']))
    expect(events.find((e) => e.type === 'switched')).toMatchObject({ from: String(a.id), to: String(b.id), via: String(a.id), hat: 'member', steppedUp: false })
  })
})

describe('only an exact true from the site’s checks', () => {
  it('refuses a step-up when available or verify answers anything but true, a throw included, and never 500s', async () => {
    const admin = await make(email('admin'), 'admin', { code: '246810' })
    const token = await login(admin.email!)
    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(200)

    for (const [what, answer] of NOT_TRUE) {
      answers.available = answer
      const res = await call('/hats/switch', token, { hat: 'admin', code: '246810' })
      expect(res.status, `available: ${what}`).toBe(403)
      expect(res.body.data?.reason, `available: ${what}`).toBe('setUpTwoStep')
    }
    delete answers.available

    for (const [what, answer] of NOT_TRUE) {
      answers.verify = answer
      const res = await call('/hats/switch', token, { hat: 'admin', code: '246810' })
      expect(res.status, `verify: ${what}`).toBe(403)
      expect(res.body.data?.reason, `verify: ${what}`).toBe('wrongCode')
      expect((await whoIs(token))!.level, `verify: ${what}`).toBe('member')
    }
    const sid = hatsStateOf(await whoIs(token))!.sid
    const { docs } = await payload.find({ collection: SESSIONS as never, where: { sid: { equals: sid } }, overrideAccess: true })
    expect(docs[0]?.steppedUp?.[String(admin.id)]).toBeUndefined() // nothing remembered from a refused code

    answers.available = () => true
    answers.verify = () => true
    expect((await call('/hats/switch', token, { hat: 'admin', code: '246810' })).status).toBe(200)
    expect((await whoIs(token))!.level).toBe('admin')
  })

  it('refuses link approval, and reading the sets, unless canApproveLinks answers exactly true', async () => {
    const maint = await make(email('maint'), 'admin', { maintainer: true })
    const a = await make(email('a'), 'member')
    const b = await make(email('b'), 'member')
    expect((await call('/hats/link', await login(a.email!), { email: b.email })).status).toBe(202)
    await confirmAll()
    const row = async () => (await payload.find({ collection: MEMBERS as never, where: { user: { equals: b.id } }, overrideAccess: true })).docs[0]!

    for (const [what, answer] of NOT_TRUE) {
      answers.approve = answer
      const approve = payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { status: 'approved' } as never, user: maint as never, overrideAccess: false })
      await expect(approve, `approve: ${what}`).rejects.toMatchObject({ status: 403 })
      await expect(payload.find({ collection: MEMBERS as never, user: maint as never, overrideAccess: false }), `read: ${what}`).rejects.toMatchObject({ status: 403 })
      expect((await row()).status, what).toBe('confirmed')
    }

    answers.approve = () => true
    expect((await payload.find({ collection: MEMBERS as never, where: { user: { equals: b.id } }, user: maint as never, overrideAccess: false })).docs).toHaveLength(1)
    await payload.update({ collection: MEMBERS as never, id: (await row()).id, data: { status: 'approved' } as never, user: maint as never, overrideAccess: false })
    expect((await row()).status).toBe('approved')
  })

  it('refuses a link request unless the site’s limit answers exactly true, a throw included, and never 500s', async () => {
    const a = await make(email('lim'), 'member')
    const b = await make(email('lim'), 'member')
    const token = await login(a.email!)
    for (const [what, answer] of NOT_TRUE) {
      answers.limit = answer
      const res = await call('/hats/link', token, { email: b.email })
      expect(res.status, `limit: ${what}`).toBe(429)
      expect(res.body.data?.reason, `limit: ${what}`).toBe('tooMany')
    }
    expect(mail).toHaveLength(0)
    expect((await payload.find({ collection: MEMBERS as never, where: { user: { in: [a.id, b.id] } }, overrideAccess: true })).totalDocs).toBe(0)

    answers.limit = () => true
    expect((await call('/hats/link', token, { email: b.email })).status).toBe(202)
    expect(mail).toHaveLength(2)
  })

  it('refuses switching, linking and unlinking unless blocked answers null, a throw included, and never 500s', async () => {
    const admin = await make(email('admin'), 'admin', { code: '1' })
    const other = await make(email('other'), 'member')
    const token = await login(admin.email!)
    const NOT_NULL: [string, () => unknown][] = [
      ["''", () => ''],
      ['false', () => false],
      ...NOT_TRUE,
    ]
    for (const [what, answer] of NOT_NULL) {
      answers.blocked = answer
      for (const [path, body] of [['/hats/switch', { hat: 'member' }], ['/hats/link', { email: other.email }], ['/hats/unlink', {}]] as const) {
        const res = await call(path, token, body)
        expect(res.status, `${path}, blocked: ${what}`).toBe(409)
        expect(res.body.data?.reason, `${path}, blocked: ${what}`).toBe('blocked')
        // A string is the site's own reason ('yes' included); anything else gets the general one.
        expect(res.body.message, `${path}, blocked: ${what}`).toBe(what === "'yes'" ? 'yes' : 'Switching isn’t available right now. Try again later.')
      }
    }
    expect((await whoIs(token))!.level).toBe('admin')
    expect(mail).toHaveLength(0)

    answers.blocked = () => 'Stop masquerading first.'
    expect((await call('/hats/switch', token, { hat: 'member' })).body.message).toBe('Stop masquerading first.')
    answers.blocked = () => undefined
    expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(200)
    answers.blocked = () => null
    expect((await call('/hats/switch', token, { hat: 'author' })).status).toBe(200)
    expect((await whoIs(token))!.level).toBe('author')
  })
})

describe('stepUpWhen and remembering per set', () => {
  /** Permissions that don't nest, so a hat can sit beside another: curator and author each hold something the other lacks. */
  const PERMS: Record<string, string[]> = { member: ['read'], author: ['read', 'write'], curator: ['read', 'curate'], admin: ['read', 'write', 'curate', 'admin'] }
  const gains = ({ from, to }: { from: { hat: string | null }; to: { hat: string } }) => PERMS[to.hat]!.some((p) => !PERMS[from.hat ?? 'admin']!.includes(p))
  const live = () => payload.config.custom!.hats as ResolvedHatsOptions & { stepUpWhen?: unknown }
  async function using(patch: Record<string, unknown>, fn: () => Promise<void>) {
    const opts = live() as unknown as Record<string, any>
    const before = { stepUpWhen: opts.stepUpWhen, stepUp: opts.stepUp }
    if ('stepUpWhen' in patch) opts.stepUpWhen = patch.stepUpWhen
    if ('rememberPer' in patch) opts.stepUp = { ...opts.stepUp, rememberPer: patch.rememberPer }
    try {
      await fn()
    } finally {
      opts.stepUpWhen = before.stepUpWhen
      opts.stepUp = before.stepUp
    }
  }
  const menuAsks = async (token: string) => Object.fromEntries((await call('/hats', token, undefined, 'get')).body.hats.map((h: Hat & { needsCode: boolean }) => [h.id, h.needsCode]))

  it('asks nothing for a step down, and for a step up or sideways, with the menu saying the same', async () => {
    await using({ stepUpWhen: gains }, async () => {
      const admin = await make(email('admin'), 'admin', { code: '111111' })
      const token = await login(admin.email!)
      // Plain sign-in wears everything: every move is down.
      expect(Object.values(await menuAsks(token)).filter(Boolean)).toEqual([])
      expect((await call('/hats/switch', token, { hat: 'curator' })).status).toBe(200)
      // Sideways: author is not sensitive, but it holds write, which curator lacks.
      expect((await menuAsks(token)).author).toBe(true)
      expect((await menuAsks(token)).member).toBe(false)
      expect((await call('/hats/switch', token, { hat: 'author' })).status).toBe(401)
      expect((await whoIs(token))!.level).toBe('curator')
      expect((await call('/hats/switch', token, { hat: 'member' })).status).toBe(200) // down
      expect((await menuAsks(token)).author).toBe(true)
      const up = await call('/hats/switch', token, { hat: 'author' }) // up
      expect(up.status).toBe(401)
      expect(up.body.needsCode).toBe(true)
      expect((await call('/hats/switch', token, { hat: 'author', code: '111111' })).status).toBe(200)
      expect((await menuAsks(token)).admin).toBe(false) // a code was just given: remembered
    })
  })

  it('hands stepUpWhen the user as worn now and as it would be worn', async () => {
    const seen: { from: unknown; to: unknown }[] = []
    await using({ stepUpWhen: ({ from, to }: any) => (seen.push({ from: { level: from.user.level, hat: from.hat }, to: { level: to.user.level, hat: to.hat } }), false) }, async () => {
      const admin = await make(email('admin'), 'admin')
      const token = await login(admin.email!)
      await call('/hats/switch', token, { hat: 'author' })
      await call('/hats/switch', token, { hat: 'curator' })
    })
    expect(seen).toEqual([
      { from: { level: 'admin', hat: 'admin' }, to: { level: 'author', hat: 'author' } },
      { from: { level: 'author', hat: 'author' }, to: { level: 'curator', hat: 'curator' } },
    ])
  })

  it('asks for a code when stepUpWhen throws, rejects, or answers anything but false', async () => {
    const answersToTry: [string, () => unknown][] = [...NOT_TRUE, ['true', () => true], ['undefined', () => undefined]]
    for (const [what, answer] of answersToTry) {
      await using({ stepUpWhen: answer }, async () => {
        const admin = await make(email('admin'), 'admin', { code: '222222' })
        const token = await login(admin.email!)
        const res = await call('/hats/switch', token, { hat: 'member' }) // a plain step down
        expect(res.status, what).toBe(401)
        expect(res.body.needsCode, what).toBe(true)
        expect((await menuAsks(token)).member, what).toBe(true)
        expect((await whoIs(token))!.level, what).toBe('admin')
        expect((await call('/hats/switch', token, { hat: 'member', code: '222222' })).status, what).toBe(200)
      })
    }
    // Only an exact false lets it through.
    await using({ stepUpWhen: () => false }, async () => {
      const admin = await make(email('admin'), 'admin')
      expect((await call('/hats/switch', await login(admin.email!), { hat: 'member' })).status).toBe(200)
    })
  })

  it('still refuses when stepUpWhen asks and the site has no second factor on that account', async () => {
    await using({ stepUpWhen: () => true }, async () => {
      const author = await make(email('author'), 'author')
      const token = await login(author.email!)
      const res = await call('/hats/switch', token, { hat: 'member' })
      expect(res.status).toBe(403)
      expect(res.body.data?.reason).toBe('setUpTwoStep')
    })
  })

  async function pair() {
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const a = await make(email('a'), 'admin', { code: '333333' })
    const b = await make(email('b'), 'admin', { code: '444444' })
    await link(a, b, approver)
    const [mine] = (await payload.find({ collection: MEMBERS as never, where: { user: { equals: a.id } }, overrideAccess: true })).docs as unknown as { link: unknown }[]
    const setId = String(typeof mine!.link === 'object' ? (mine!.link as { id: unknown }).id : mine!.link)
    return { a, b, setId }
  }
  const ageMemory = async (token: string, key: string) => {
    const { docs } = await payload.find({ collection: SESSIONS as never, where: { sid: { equals: hatsStateOf(await whoIs(token))!.sid } }, overrideAccess: true })
    const old = new Date(Date.now() - 181 * 60_000).toISOString()
    await payload.update({ collection: SESSIONS as never, id: docs[0]!.id, data: { steppedUp: { [key]: old } } as never, overrideAccess: true })
  }

  it('by default a code covers its own account only', async () => {
    const { a, b } = await pair()
    const token = await login(a.email!)
    await call('/hats/switch', token, { hat: 'member' })
    expect((await call('/hats/switch', token, { hat: 'admin', code: '333333' })).status).toBe(200)
    expect((await call('/hats/switch', token, { account: b.id, hat: 'admin' })).status).toBe(401)
  })

  it('with rememberPer set, one code covers every linked account for three hours, then asks again', async () => {
    const { a, b, setId } = await pair()
    await using({ rememberPer: 'set' }, async () => {
      const token = await login(a.email!)
      await call('/hats/switch', token, { hat: 'member' })
      expect((await call('/hats/switch', token, { hat: 'admin', code: '333333' })).status).toBe(200)
      // Into b, whose own code was never given.
      const into = await call('/hats/switch', token, { account: b.id, hat: 'admin' })
      expect(into.status).toBe(200)
      expect((await whoIs(into.token!))!.id).toBe(b.id)
      // And back to a's admin hat from b's session.
      const t = into.token!
      await call('/hats/switch', t, { hat: 'member' })
      const menu = await call('/hats', t, undefined, 'get')
      expect(menu.body.hats.find((h: Hat & { needsCode: boolean }) => h.id === 'admin').needsCode).toBe(false)
      expect(menu.body.linked[0].hats.find((h: Hat & { needsCode: boolean }) => h.id === 'admin').needsCode).toBe(false)
      expect((await call('/hats/switch', t, { account: a.id, hat: 'admin' })).status).toBe(200)

      // Three hours on: asked again, and a good code (this time b's) is remembered for the set again.
      const t2 = await login(b.email!)
      await call('/hats/switch', t2, { hat: 'member' })
      await ageMemory(t2, `set:${setId}`)
      const again = await call('/hats/switch', t2, { hat: 'admin' })
      expect(again.status).toBe(401)
      expect((await call('/hats/switch', t2, { hat: 'admin', code: '444444' })).status).toBe(200)
    })
  })

  it('an account in no set is remembered on its own, and verify and available are told who signed in and which set', async () => {
    const { a, b, setId } = await pair()
    const lone = await make(email('lone'), 'admin', { code: '555555' })
    const told: { fn: string; user: unknown; signedIn: unknown; set: unknown }[] = []
    const opts = live() as unknown as { stepUp: { available: (...a: any[]) => unknown; verify: (...a: any[]) => unknown; rememberPer?: string } }
    const before = { ...opts.stepUp }
    opts.stepUp = {
      ...before,
      rememberPer: 'set',
      available: (u: HatsUser, ctx: any) => (told.push({ fn: 'available', user: u.id, signedIn: ctx.signedIn.id, set: ctx.set }), before.available(u, ctx)),
      verify: (args: any) => (told.push({ fn: 'verify', user: args.user.id, signedIn: args.signedIn.id, set: args.set }), before.verify(args)),
    }
    try {
      const lt = await login(lone.email!)
      await call('/hats/switch', lt, { hat: 'member' })
      expect((await call('/hats/switch', lt, { hat: 'admin', code: '555555' })).status).toBe(200)
      const { docs } = await payload.find({ collection: SESSIONS as never, where: { sid: { equals: hatsStateOf(await whoIs(lt))!.sid } }, overrideAccess: true })
      expect(Object.keys((docs[0] as unknown as { steppedUp: object }).steppedUp)).toEqual([String(lone.id)])
      expect(told.at(-1)).toEqual({ fn: 'verify', user: lone.id, signedIn: lone.id, set: null })

      // The person is a; the target is b: the target stays `user`.
      told.length = 0
      const at = await login(a.email!)
      await call('/hats/switch', at, { hat: 'member' })
      const into = await call('/hats/switch', at, { account: b.id, hat: 'admin', code: '444444' })
      expect(into.status).toBe(200)
      expect(told.at(-1)).toEqual({ fn: 'verify', user: b.id, signedIn: a.id, set: setId })
      expect(told[0]).toEqual({ fn: 'available', user: b.id, signedIn: a.id, set: setId })
      // From b's session the person is still a.
      told.length = 0
      await call('/hats/switch', into.token!, { hat: 'member' })
      await ageMemory(into.token!, `set:${setId}`)
      await call('/hats/switch', into.token!, { hat: 'admin', code: '444444' })
      expect(told.at(-1)).toMatchObject({ fn: 'verify', user: b.id, signedIn: a.id, set: setId })
    } finally {
      opts.stepUp = before
    }
  })

  it('reports steppedUp on the event only when a code was given in that request', async () => {
    events.length = 0
    const { a } = await pair()
    const token = await login(a.email!)
    await call('/hats/switch', token, { hat: 'member' })
    await call('/hats/switch', token, { hat: 'admin', code: '333333' })
    await call('/hats/switch', token, { hat: 'member' })
    await call('/hats/switch', token, { hat: 'admin' }) // remembered
    const sw = events.filter((e) => e.type === 'switched') as Extract<HatsEvent, { type: 'switched' }>[]
    expect(sw.map((e) => e.steppedUp)).toEqual([false, true, false, false])
  })
})

describe('switchSession and the endpoint share one switch', () => {
  const LIVE = () => payload.config.custom!.hats as Record<string, any>
  /** A request as a site's own route would hold it: the signed-in user from Payload's auth, nothing else. */
  async function reqFor(token: string | null, body: unknown = {}) {
    const user = token ? await whoIs(token) : null
    const req = (await createLocalReq({ user: (user ?? undefined) as never }, payload)) as PayloadRequest
    if (!user) req.user = null
    ;(req as { headers: Headers }).headers = new Headers({ 'content-type': 'application/json' })
    ;(req as { url: string }).url = 'https://site.example/api/hats/switch'
    ;(req as { method: string }).method = 'POST'
    req.data = body as never
    return req
  }
  const viaEndpoint = async (token: string | null, body: Record<string, unknown>) => {
    const req = await reqFor(token, body)
    try {
      const res = await endpoint('/hats/switch', 'post').handler(req)
      const json = JSON.parse(await res.text())
      return { ok: res.status === 200, status: res.status, reason: json.reason as string | undefined, cookie: res.headers.getSetCookie().find((c) => c.startsWith('payload-token=')) ?? null }
    } catch (e) {
      return { ok: false, status: (e as { status: number }).status, reason: (e as { data?: { reason?: string } }).data?.reason, cookie: null }
    }
  }
  const viaFunction = async (token: string | null, body: Record<string, unknown>) => {
    const r = await switchSession(await reqFor(token), body as never)
    return r.ok ? { ok: true, status: 200, reason: undefined, cookie: r.cookie, result: r } : { ok: false, status: r.status, reason: r.reason, cookie: null, result: r }
  }
  /** Cookie attributes with the value and expiry taken out, since both differ on every call. */
  const attrs = (c: string | null) => c?.split(';').map((p) => p.trim()).filter((p) => !p.toLowerCase().startsWith('expires=')).map((p, i) => (i === 0 ? 'payload-token' : p)).join('; ')
  const tokenOf = (cookie: string | null) => cookie!.split(';')[0]!.slice('payload-token='.length)
  const both = async (mk: () => Promise<string | null>, body: Record<string, unknown>) => ({ e: await viaEndpoint(await mk(), body), f: await viaFunction(await mk(), body) })
  async function pair2() {
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const a = await make(email('a'), 'admin', { code: '333333' })
    const b = await make(email('b'), 'curator', { code: '444444' })
    await link(a, b, approver)
    return { a, b }
  }

  describe('refuses a switch that did not come from the site\'s own POST', () => {
    const cases: [string, { method?: string; headers?: Record<string, string> }, string][] = [
      ['a GET', { method: 'GET' }, 'notPost'],
      ['a missing method', { method: '' }, 'notPost'],
      ['a foreign Origin', { headers: { origin: 'https://evil.example' } }, 'crossSite'],
      ['a cross-site Sec-Fetch-Site', { headers: { 'sec-fetch-site': 'cross-site' } }, 'crossSite'],
      ['a same-site (sibling) Sec-Fetch-Site', { headers: { 'sec-fetch-site': 'same-site' } }, 'crossSite'],
      ['a GET with a foreign Origin and cross-site Sec-Fetch-Site', { method: 'GET', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }, 'notPost'],
    ]
    for (const [name, mod, reason] of cases)
      it(`${name}`, async () => {
        const admin = await make(email('admin'), 'admin')
        const token = await login(admin.email!)
        const req = await reqFor(token)
        ;(req as { method: string }).method = mod.method ?? 'POST'
        for (const [k, v] of Object.entries(mod.headers ?? {})) req.headers.set(k, v)
        const r = await switchSession(req, { hat: 'member' })
        expect(r).toMatchObject({ ok: false, reason })
        expect((await whoIs(token))!.level).toBe('admin') // nothing switched
      })
    it('lets the site\'s own origin and a same-origin Sec-Fetch-Site through', async () => {
      const admin = await make(email('admin'), 'admin')
      const req = await reqFor(await login(admin.email!))
      req.headers.set('origin', 'https://site.example')
      req.headers.set('sec-fetch-site', 'same-origin')
      expect(await switchSession(req, { hat: 'member' })).toMatchObject({ ok: true })
    })
  })

  it('refuses an account that is locked, and lets it in once the lock has passed', async () => {
    const { a, b } = await pair2()
    await payload.update({ collection: 'users', id: b.id, data: { lockUntil: new Date(Date.now() + 600_000).toISOString() } as never, overrideAccess: true, showHiddenFields: true } as never)
    const locked = await both(() => login(a.email!), { account: b.id, hat: 'curator', code: '444444' })
    for (const r of [locked.e, locked.f]) expect([r.ok, r.status, r.reason]).toEqual([false, 403, 'locked'])
    await payload.update({ collection: 'users', id: b.id, data: { lockUntil: new Date(Date.now() - 1000).toISOString() } as never, overrideAccess: true, showHiddenFields: true } as never)
    expect((await viaFunction(await login(a.email!), { account: b.id, hat: 'curator', code: '444444' })).ok).toBe(true)
  })

  it('refuses when the headers are a plain object with a foreign Origin, and when there are no headers at all', async () => {
    const admin = await make(email('admin'), 'admin')
    const token = await login(admin.email!)
    const bad = await reqFor(token)
    ;(bad as { headers: unknown }).headers = { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }
    expect(await switchSession(bad, { hat: 'member' })).toMatchObject({ ok: false, reason: 'crossSite' })
    const none = await reqFor(token)
    ;(none as { headers: unknown }).headers = undefined
    expect(await switchSession(none, { hat: 'member' })).toMatchObject({ ok: false, reason: 'crossSite' })
    expect((await whoIs(token))!.level).toBe('admin')
    const fine = await reqFor(token)
    ;(fine as { headers: unknown }).headers = { origin: 'https://site.example' }
    expect(await switchSession(fine, { hat: 'member' })).toMatchObject({ ok: true })
  })

  it('treats headers that are not a Headers instance or a plain object as cross-site', async () => {
    const admin = await make(email('admin'), 'admin')
    const token = await login(admin.email!)
    const odd: unknown[] = [[['origin', 'https://site.example']], new Map([['origin', 'https://site.example']]), { get: () => undefined }, 'origin: x', 5]
    for (const headers of odd) {
      const req = await reqFor(token)
      ;(req as { headers: unknown }).headers = headers
      // the Map and the array are refused outright; a class instance with a get() is not trusted either
      expect(await switchSession(req, { hat: 'member' })).toMatchObject({ ok: false, reason: 'crossSite' })
    }
    expect((await whoIs(token))!.level).toBe('admin')
  })

  it('refuses an unverified account when the collection verifies emails, and lets it in once verified', async () => {
    const { a, b } = await pair2()
    const auth = payload.collections.users!.config.auth as { verify: unknown }
    const saved = auth.verify
    try {
      auth.verify = true
      await payload.update({ collection: 'users', id: a.id, data: { _verified: true } as never, overrideAccess: true, showHiddenFields: true } as never)
      await payload.update({ collection: 'users', id: b.id, data: { _verified: false } as never, overrideAccess: true, showHiddenFields: true } as never)
      const r = await both(() => login(a.email!), { account: b.id, hat: 'curator', code: '444444' })
      for (const x of [r.e, r.f]) expect([x.ok, x.status, x.reason]).toEqual([false, 403, 'unverified'])
      await payload.update({ collection: 'users', id: b.id, data: { _verified: true } as never, overrideAccess: true, showHiddenFields: true } as never)
      expect((await viaFunction(await login(a.email!), { account: b.id, hat: 'curator', code: '444444' })).ok).toBe(true)
    } finally {
      auth.verify = saved
    }
  })

  it('refuses a request whose user is from another collection even with a valid session state', async () => {
    const admin = await make(email('admin'), 'admin')
    const token = await login(admin.email!)
    const req = await reqFor(token)
    expect(hatsStateOf(req.user as never)).toBeTruthy() // the state is there, so only the collection check can refuse
    ;(req.user as { collection: string }).collection = 'staff'
    expect(await switchSession(req, { hat: 'member' })).toMatchObject({ ok: false, status: 401, reason: 'signIn' })
    expect((await whoIs(token))!.level).toBe('admin')
  })

  it('is refused with no one signed in, and by an account that is not from the hats collection', async () => {
    const e = await viaEndpoint(null, { hat: 'member' })
    const f = await viaFunction(null, { hat: 'member' })
    expect([e.ok, e.status, e.reason]).toEqual([false, 401, 'signIn'])
    expect([f.ok, f.status, f.reason]).toEqual([false, 401, 'signIn'])
    // A user that exists but not as a browser sign-in (no session state) is refused the same way.
    const u = await make(email('admin'), 'admin')
    const req = await reqFor(null)
    req.user = { ...u, collection: 'users' } as never
    const r = await switchSession(req, { hat: 'member' })
    expect(r).toMatchObject({ ok: false, status: 400, reason: 'signIn' })
  })

  it('never throws for a refusal, and acts only for req.user (the input names no other person)', async () => {
    const admin = await make(email('admin'), 'admin')
    const other = await make(email('other'), 'admin')
    const token = await login(admin.email!)
    const r = await switchSession(await reqFor(token), { hat: 'member', user: other.id, as: other.id } as never)
    expect(r).toMatchObject({ ok: true, account: String(admin.id), hat: 'member', cookie: null })
    expect((await whoIs(token))!.level).toBe('member')
    const otherToken = await login(other.email!)
    expect((await whoIs(otherToken))!.level).toBe('admin') // untouched
  })

  it('gives every refusal the same status and reason as the endpoint, and passes once the guard is lifted', async () => {
    const { a, b } = await pair2()
    const outsider = await make(email('out'), 'admin', { code: '999999' })
    const member = await make(email('mem'), 'member')
    const opts = LIVE()
    const t = async (u: U) => login(u.email!)
    const stepDown = async (u: U) => {
      const tk = await login(u.email!)
      await call('/hats/switch', tk, { hat: 'member' })
      return tk
    }
    type Case = { name: string; mk: () => Promise<string | null>; body: () => Record<string, unknown>; expectStatus: number; expectReason: string; lift: () => () => void; liftedBody?: () => Record<string, unknown> }
    const cases: Case[] = [
      { name: 'blocked', mk: () => t(a), body: () => ({ hat: 'member' }), expectStatus: 409, expectReason: 'blocked', lift: () => ((answers.blocked = () => 'Stop masquerading first.'), () => void (answers.blocked = undefined)) },
      { name: 'notLinked', mk: () => t(a), body: () => ({ account: outsider.id, hat: 'admin' }), expectStatus: 403, expectReason: 'notLinked', lift: () => () => {} },
      { name: 'notAvailable', mk: () => t(member), body: () => ({ hat: 'member' }), expectStatus: 403, expectReason: 'notAvailable', lift: () => () => {} },
      { name: 'chooseHat', mk: () => t(a), body: () => ({ hat: 'nonsense' }), expectStatus: 400, expectReason: 'chooseHat', lift: () => () => {} },
      { name: 'needsCode', mk: () => stepDown(a), body: () => ({ hat: 'admin' }), expectStatus: 401, expectReason: 'needsCode', lift: () => () => {}, liftedBody: () => ({ hat: 'admin', code: '333333' }) },
      { name: 'wrongCode', mk: () => stepDown(a), body: () => ({ hat: 'admin', code: '000000' }), expectStatus: 403, expectReason: 'wrongCode', lift: () => () => {}, liftedBody: () => ({ hat: 'admin', code: '333333' }) },
      { name: 'setUpTwoStep', mk: () => stepDown(a), body: () => ({ hat: 'admin', code: '333333' }), expectStatus: 403, expectReason: 'setUpTwoStep', lift: () => ((answers.available = () => false), () => void (answers.available = undefined)), liftedBody: () => ({ hat: 'admin', code: '333333' }) },
      { name: 'noSecondFactor', mk: () => stepDown(a), body: () => ({ hat: 'admin', code: '333333' }), expectStatus: 403, expectReason: 'noSecondFactor', lift: () => { const s = opts.stepUp; opts.stepUp = undefined; return () => void (opts.stepUp = s) } },
    ]
    for (const c of cases) {
      const restore = c.lift()
      try {
        const { e, f } = await both(c.mk, c.body())
        expect([e.ok, e.status, e.reason], `${c.name} endpoint`).toEqual([false, c.expectStatus, c.expectReason])
        expect([f.ok, f.status, f.reason], `${c.name} function`).toEqual([false, c.expectStatus, c.expectReason])
        expect((f.result as { message?: string }).message, c.name).toBeTruthy()
      } finally {
        restore()
      }
      // The other way: with the guard lifted (or the right input) the same call goes through, on both.
      if (c.name === 'notLinked') expect((await viaFunction(await t(a), { account: b.id, hat: 'curator', code: '444444' })).ok).toBe(true)
      else if (c.name === 'notAvailable') expect((await viaFunction(await t(a), { hat: 'member' })).ok).toBe(true)
      else if (c.name === 'chooseHat') expect((await viaFunction(await t(a), { hat: 'author' })).ok).toBe(true)
      else if (c.name === 'noSecondFactor') expect((await viaFunction(await stepDown(a), { hat: 'admin', code: '333333' })).ok).toBe(true)
      else {
        const body = c.liftedBody?.() ?? c.body()
        const { e, f } = await both(c.mk, body)
        expect([c.name, e.ok, f.ok]).toEqual([c.name, true, true])
      }
    }
  })

  it('an unavailable switch (showSwitch false) and a showSwitch that throws are both refusals, and nothing changes', async () => {
    const admin = await make(email('admin'), 'admin')
    const opts = LIVE()
    const before = opts.showSwitch
    try {
      for (const [name, fn] of [['false', () => false], ['throws', () => { throw new Error('site store down') }]] as [string, () => boolean][]) {
        opts.showSwitch = fn
        const token = await login(admin.email!)
        const e = await viaEndpoint(token, { hat: 'member' })
        const f = await viaFunction(token, { hat: 'member' })
        expect(e.ok, name).toBe(false)
        expect(f.ok, name).toBe(false)
        expect(f.status, name).toBe(name === 'false' ? 403 : 500)
        expect((await whoIs(token))!.level, name).toBe('admin')
      }
    } finally {
      opts.showSwitch = before
    }
    expect((await viaFunction(await login(admin.email!), { hat: 'member' })).ok).toBe(true)
  })

  it('refuses when the site hooks throw (verify, available, blocked, stepUpWhen), and never passes', async () => {
    const a = await make(email('a'), 'admin', { code: '333333' })
    const down = async () => {
      const tk = await login(a.email!)
      await call('/hats/switch', tk, { hat: 'member' })
      return tk
    }
    const boom = () => { throw new Error('check store down') }
    for (const [name, key, reason, status] of [['verify', 'verify', 'wrongCode', 403], ['available', 'available', 'setUpTwoStep', 403], ['blocked', 'blocked', 'blocked', 409]] as const) {
      const tk = await down()
      ;(answers as Record<string, unknown>)[key] = boom
      try {
        const r = await viaFunction(tk, { hat: 'admin', code: '333333' })
        expect([name, r.ok, r.status, r.reason]).toEqual([name, false, status, reason])
        expect((await whoIs(tk))!.level, name).toBe('member')
      } finally {
        ;(answers as Record<string, unknown>)[key] = undefined
      }
    }
    const opts = LIVE()
    const tk = await down()
    opts.stepUpWhen = boom
    try {
      const r = await viaFunction(tk, { hat: 'admin' })
      expect(r).toMatchObject({ ok: false, status: 401, reason: 'needsCode' })
    } finally {
      opts.stepUpWhen = undefined
    }
    // The same call with working hooks goes through.
    expect((await viaFunction(await down(), { hat: 'admin', code: '333333' })).ok).toBe(true)
  })

  it('turns an unexpected error inside the switch into a refusal (a throwing hatsOf), never a throw or a pass', async () => {
    const admin = await make(email('admin'), 'admin')
    const token = await login(admin.email!)
    const opts = LIVE()
    const before = opts.hatsOf
    let calls = 0
    opts.hatsOf = (u: HatsUser) => (++calls > 1 ? (() => { throw new Error('role store down') })() : before(u))
    try {
      const r = await switchSession(await reqFor(token), { hat: 'member' })
      expect(r).toMatchObject({ ok: false, status: 500, reason: 'failed' })
    } finally {
      opts.hatsOf = before
    }
    expect((await whoIs(token))!.level).toBe('admin')
    expect((await switchSession(await reqFor(token), { hat: 'member' })).ok).toBe(true)
  })

  it('has no option that skips a check: extra input is ignored', async () => {
    const a = await make(email('a'), 'admin', { code: '333333' })
    const tk = await login(a.email!)
    await call('/hats/switch', tk, { hat: 'member' })
    const r = await switchSession(await reqFor(tk), { hat: 'admin', skipStepUp: true, force: true, trusted: true, code: undefined } as never)
    expect(r).toMatchObject({ ok: false, reason: 'needsCode' })
    answers.blocked = () => 'Stop masquerading first.'
    try {
      expect(await switchSession(await reqFor(tk), { hat: 'author', skipBlocked: true } as never)).toMatchObject({ ok: false, reason: 'blocked' })
    } finally {
      answers.blocked = undefined
    }
    expect((await whoIs(tk))!.level).toBe('member')
  })

  it('gives the same answer, the same cookie attributes and the same session effects as the endpoint', async () => {
    const { a, b } = await pair2()
    const mk = async () => login(a.email!)
    const e = await viaEndpoint(await mk(), { account: b.id, hat: 'curator', code: '444444' })
    const f = await viaFunction(await mk(), { account: b.id, hat: 'curator', code: '444444' })
    expect([e.ok, e.status]).toEqual([true, 200])
    expect(f.ok).toBe(true)
    expect(e.cookie).toBeTruthy()
    expect(attrs(f.cookie)).toBe(attrs(e.cookie))
    expect(attrs(f.cookie)).toMatch(/HttpOnly/)
    expect(attrs(f.cookie)).toMatch(/Path=\//)
    expect(attrs(f.cookie)).toMatch(/SameSite=Lax/)
    // The new session works and is b's, with the person recorded as a; the old session is gone.
    const who = await whoIs(tokenOf(f.cookie))
    expect(who!.id).toBe(b.id)
    expect(hatsStateOf(who)!.via).toBe(String(a.id))
    expect(who!.level).toBe('curator')
    // The same hat on the same account: same answer, no cookie, from both.
    const tkE = await login(a.email!)
    const tkF = await login(a.email!)
    const e2 = await viaEndpoint(tkE, { hat: 'author' })
    const f2 = await viaFunction(tkF, { hat: 'author' })
    expect([e2.ok, e2.cookie]).toEqual([true, null])
    expect([f2.ok, f2.cookie]).toEqual([true, null])
    expect((await whoIs(tkF))!.level).toBe('author')
    // The old session of the cross-account switch no longer signs in.
    const old = await login(a.email!)
    const moved = await viaFunction(old, { account: b.id, hat: 'curator', code: '444444' })
    expect(moved.ok).toBe(true)
    expect(await whoIs(old)).toBeNull()
  })

  it('records the same events as the endpoint, with via, and returns typed account and hat', async () => {
    events.length = 0
    const { a, b } = await pair2()
    const f = await viaFunction(await login(a.email!), { account: b.id, hat: 'curator', code: '444444' })
    expect(f.result).toMatchObject({ ok: true, account: String(b.id), hat: 'curator' })
    const sw = events.filter((e) => e.type === 'switched') as Extract<HatsEvent, { type: 'switched' }>[]
    expect(sw.at(-1)).toMatchObject({ from: String(a.id), to: String(b.id), hat: 'curator', via: String(a.id), steppedUp: true })
  })
})

describe('a gain-based stepUpWhen across a person\'s set', () => {
  const PERMS: Record<string, string[]> = { member: ['read'], author: ['read', 'write'], curator: ['read', 'curate'], admin: ['read', 'write', 'curate', 'admin'] }
  const gains = ({ from, to }: { from: { hat: string | null }; to: { hat: string } }) => PERMS[to.hat]!.some((p) => !PERMS[from.hat ?? 'admin']!.includes(p))
  const LIVE = () => payload.config.custom!.hats as Record<string, any>
  async function setup(extra: { rememberMinutes?: number } = {}) {
    const opts = LIVE()
    const saved = { stepUp: opts.stepUp, stepUpWhen: opts.stepUpWhen }
    opts.stepUpWhen = gains
    opts.stepUp = { ...opts.stepUp, rememberPer: 'set', ...extra }
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const staff = await make(email('staff'), 'member', { code: '616161' })
    const admin = await make(email('adm'), 'admin', { code: '626262' })
    await link(staff, admin, approver)
    const [m] = (await payload.find({ collection: MEMBERS as never, where: { user: { equals: staff.id } }, overrideAccess: true })).docs as unknown as { link: unknown }[]
    const setId = String(typeof m!.link === 'object' ? (m!.link as { id: unknown }).id : m!.link)
    return { staff, admin, setId, restore: () => void Object.assign(opts, saved) }
  }
  const age = async (token: string, key: string, minutes: number) => {
    const { docs } = await payload.find({ collection: SESSIONS as never, where: { sid: { equals: hatsStateOf(await whoIs(token))!.sid } }, overrideAccess: true })
    await payload.update({ collection: SESSIONS as never, id: docs[0]!.id, data: { steppedUp: { [key]: new Date(Date.now() - minutes * 60_000).toISOString() } } as never, overrideAccess: true })
  }
  const sw = async (token: string, input: Record<string, unknown>) => {
    const user = await whoIs(token)
    const req = (await createLocalReq({ user: user as never }, payload)) as PayloadRequest
    ;(req as { method: string }).method = 'POST'
    return switchSession(req, input as never)
  }

  it('asks once for the set, remembers it for 180 minutes by default, then asks again; going back down never asks', async () => {
    const { staff, admin, setId, restore } = await setup()
    try {
      const t = await login(staff.email!) // signed in as the member account
      const up = await sw(t, { account: admin.id, hat: 'admin' })
      expect(up).toMatchObject({ ok: false, reason: 'needsCode', status: 401 })
      const into = await sw(t, { account: admin.id, hat: 'admin', code: '626262' })
      expect(into.ok).toBe(true)
      const t2 = (into as { cookie: string }).cookie.split(';')[0]!.slice('payload-token='.length)
      expect(hatsStateOf(await whoIs(t2))!.via).toBe(String(staff.id))

      // Down to the signed-in account: no code, and the person's own session record is kept (via).
      const back = await sw(t2, { account: staff.id, hat: 'member' })
      expect(back.ok).toBe(true)
      const t3 = (back as { cookie: string }).cookie.split(';')[0]!.slice('payload-token='.length)
      expect(hatsStateOf(await whoIs(t3))).toMatchObject({ via: null })
      expect((await whoIs(t3))!.id).toBe(staff.id)
      // Back up inside the window: the remembered code covers the set, so no code is asked for.
      const again = await sw(t3, { account: admin.id, hat: 'admin' })
      expect(again.ok).toBe(true)
      const t4 = (again as { cookie: string }).cookie.split(';')[0]!.slice('payload-token='.length)
      // Down a hat on the same account asks nothing either.
      expect((await sw(t4, { hat: 'member' })).ok).toBe(true)
      // 179 minutes old: still remembered. 181: asked again.
      await age(t4, `set:${setId}`, 179)
      expect((await sw(t4, { hat: 'admin' })).ok).toBe(true)
      await sw(t4, { hat: 'member' })
      await age(t4, `set:${setId}`, 181)
      expect(await sw(t4, { hat: 'admin' })).toMatchObject({ ok: false, reason: 'needsCode' })
      expect((await sw(t4, { hat: 'admin', code: '626262' })).ok).toBe(true)
    } finally {
      restore()
    }
  })

  it('follows rememberMinutes, and without rememberPer: set each account asks for itself', async () => {
    const short = await setup({ rememberMinutes: 30 })
    try {
      const t = await login(short.admin.email!)
      await sw(t, { hat: 'member' })
      expect((await sw(t, { hat: 'admin', code: '626262' })).ok).toBe(true)
      await sw(t, { hat: 'member' })
      await age(t, `set:${short.setId}`, 29)
      expect((await sw(t, { hat: 'admin' })).ok).toBe(true)
      await sw(t, { hat: 'member' })
      await age(t, `set:${short.setId}`, 31)
      expect(await sw(t, { hat: 'admin' })).toMatchObject({ ok: false, reason: 'needsCode' })
    } finally {
      short.restore()
    }
    const per = await setup()
    try {
      LIVE().stepUp.rememberPer = 'account'
      const t = await login(per.staff.email!)
      expect((await sw(t, { account: per.admin.id, hat: 'admin', code: '626262' })).ok).toBe(true)
      const t2 = await login(per.admin.email!)
      await sw(t2, { hat: 'member' })
      // A code given on another session for the admin account is not remembered here (memory is per session).
      expect(await sw(t2, { hat: 'admin' })).toMatchObject({ ok: false, reason: 'needsCode' })
    } finally {
      per.restore()
    }
  })

  it('stops going back down the moment the link is gone or blocked() says no', async () => {
    const { staff, admin, restore } = await setup()
    try {
      const t = await login(staff.email!)
      const into = await sw(t, { account: admin.id, hat: 'admin', code: '626262' })
      const t2 = (into as { cookie: string }).cookie.split(';')[0]!.slice('payload-token='.length)
      answers.blocked = () => 'Stop masquerading first.'
      try {
        expect(await sw(t2, { account: staff.id, hat: 'member' })).toMatchObject({ ok: false, reason: 'blocked' })
      } finally {
        answers.blocked = undefined
      }
      await call('/hats/unlink', t2, { account: String(admin.id) })
      expect(await whoIs(t2)).toBeNull() // switched sessions end with the unlink; sign in again
    } finally {
      restore()
    }
  })
})

describe('a link request answers the same way whatever the address', () => {
  const OPTS = () => payload.config.custom!.hats as ResolvedHatsOptions
  const WRITES = ['create', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'upsert'] as const

  /** Counts database writes per kind and collection while `fn` runs. */
  async function countWrites<T>(fn: () => Promise<T>) {
    const db = payload.db as unknown as Record<string, (args: { collection: string }) => Promise<unknown>>
    const saved = WRITES.map((k) => [k, db[k]!] as const)
    const counts: Record<string, number> = {}
    for (const [k, original] of saved)
      db[k] = function (this: unknown, args: { collection: string }) {
        counts[`${k} ${args.collection}`] = (counts[`${k} ${args.collection}`] ?? 0) + 1
        return original.call(this, args)
      }
    try {
      return { result: await fn(), counts }
    } finally {
      for (const [k, original] of saved) db[k] = original
    }
  }

  /** What the asker could read, with their own id and address masked, so branches compare directly. */
  async function readable(asker: U, token: string) {
    const mask = (v: unknown) => JSON.stringify(v).replaceAll(String(asker.id), 'ASKER-ID').replaceAll(String(asker.email), 'ASKER')
    const local = async (collection: string) => {
      try {
        const r = await payload.find({ collection: collection as never, user: asker as never, overrideAccess: false, depth: 0 })
        return `rows ${r.totalDocs}`
      } catch (error) {
        return `refused ${(error as { status?: number }).status}`
      }
    }
    return {
      menu: mask((await call('/hats', token, undefined, 'get')).body),
      members: await local(MEMBERS),
      links: await local('hat-links'),
      requests: await local(REQUESTS),
    }
  }

  /** The kinds of address a person might type: every one must look the same from the asker's side. */
  const BRANCHES: Record<string, (asker: U) => Promise<string>> = {
    missing: async () => email('nobody'),
    existing: async () => (await make(email('t'), 'member')).email!,
    locked: async () => {
      const t = await make(email('t'), 'member')
      await payload.db.updateOne({ collection: 'users', id: t.id, data: { lockUntil: new Date(Date.now() + 3_600_000).toISOString(), loginAttempts: 9 }, returning: false })
      return t.email!
    },
    unverified: async () => {
      const t = await make(email('t'), 'member')
      await payload.db.updateOne({ collection: 'users', id: t.id, data: { _verified: false }, returning: false })
      return t.email!
    },
    linked: async () => {
      const t = await make(email('t'), 'member')
      await link(t, await make(email('x'), 'member'), await make(email('maint'), 'admin', { maintainer: true }))
      return t.email!
    },
    pending: async () => {
      const t = await make(email('t'), 'member')
      await call('/hats/link', await login((await make(email('other'), 'member')).email!), { email: t.email })
      return t.email!
    },
    minor: async () => (await make(email('t'), 'member', { minorUntil: new Date(Date.now() + 5 * 365 * 86_400_000).toISOString() } as Partial<U>)).email!,
    self: async (asker) => asker.email!,
  }

  /** Everything the asker can observe about one request, and a second one to the same address. */
  async function observe(kind: string) {
    const asker = await make(email('asker'), 'member')
    const target = await BRANCHES[kind]!(asker)
    const token = await login(asker.email!)
    const out: unknown[] = []
    for (const round of [1, 2]) {
      mail.length = 0
      const { result, counts } = await countWrites(() => call('/hats/link', token, { email: target }))
      const own = mail.filter((m) => m.to === asker.email).map((m) => m.text.replaceAll(String(asker.email), 'ASKER'))
      const pending = (await payload.count({ collection: REQUESTS as never, where: { requestedBy: { equals: asker.id } }, overrideAccess: true })).totalDocs
      out.push({ round, status: result.status, body: result.body, own, writes: counts, pending, read: await readable(asker, token) })
    }
    return out
  }

  it.skipIf(SQLITE)('gives the same answer, asker email, readable records, database writes and pending count for every kind of address', async () => {
    await observe('existing') // warm-up: clears expired rows and loads every code path once
    const seen: Record<string, unknown> = {}
    for (const kind of Object.keys(BRANCHES)) seen[kind] = await observe(kind)
    for (const kind of Object.keys(BRANCHES)) expect(seen[kind], kind).toEqual(seen.missing)
    // And what they all look like: a 202, one note to the asker, one request record each time, nothing readable.
    expect(seen.missing).toMatchObject([
      { status: 202, own: [expect.any(String)], writes: { [`create ${REQUESTS}`]: 1, [`updateOne ${REQUESTS}`]: 1 }, pending: 1, read: { members: 'refused 403', links: 'refused 403', requests: 'refused 403' } },
      { status: 202, pending: 2 },
    ])
  })

  it('reaches the same pending limit after the same number of requests, whatever the address', async () => {
    const reach = async (kind: string) => {
      const asker = await make(email('asker'), 'member')
      const target = await BRANCHES[kind]!(asker)
      const token = await login(asker.email!)
      const statuses: number[] = []
      for (let i = 0; i <= OPTS().maxLinked * 2; i++) statuses.push((await call('/hats/link', token, { email: target })).status)
      return statuses
    }
    const missing = await reach('missing')
    expect(missing.at(-1)).toBe(429)
    expect(missing.filter((s) => s === 202)).toHaveLength(OPTS().maxLinked * 2)
    expect(await reach('existing')).toEqual(missing)
  })

  it('answers no sooner than linkAnswerMs, and doesn’t wait for a slow, hanging or failing invitation', async () => {
    const opts = OPTS()
    const saved = { send: opts.sendEmail, ms: opts.linkAnswerMs }
    let release: () => void = () => {}
    try {
      opts.linkAnswerMs = 250 // read on every request, so a site can change it
      for (const mode of ['ok', 'slow', 'hang', 'fail'] as const) {
        const asker = await make(email('asker'), 'member')
        const target = await make(email('t'), 'member')
        settleLinks = false
        let inviteDone = false
        opts.sendEmail = async ({ to, text }) => {
          if (to === target.email && mode !== 'ok') {
            if (mode === 'fail') throw new Error('mail server down')
            await new Promise<void>((resolve) => {
              release = resolve
              if (mode === 'slow') setTimeout(resolve, 1500)
            })
            inviteDone = true
          }
          mail.push({ to, text })
        }
        const token = await login(asker.email!)
        const timed = async (to: string) => {
          mail.length = 0
          const start = performance.now()
          const res = await call('/hats/link', token, { email: to })
          return { res, ms: performance.now() - start, own: mail.filter((m) => m.to === asker.email).length }
        }
        const real = await timed(target.email!)
        expect(real.ms, mode).toBeGreaterThanOrEqual(245)
        expect(inviteDone, `${mode}: answered before the invitation finished`).toBe(false)
        const fake = await timed(email('nobody'))
        expect(fake.ms, mode).toBeGreaterThanOrEqual(245)
        expect([real.res.status, real.res.body, real.own], mode).toEqual([fake.res.status, fake.res.body, fake.own])
        if (mode === 'fail') {
          // An invitation that never went out leaves a request whose token can never be used.
          const r = (await payload.find({ collection: REQUESTS as never, where: { requestedBy: { equals: asker.id } }, overrideAccess: true, showHiddenFields: true, sort: 'createdAt' })).docs[0] as unknown as { account?: unknown; tokenHash?: unknown }
          expect([r.account ?? null, r.tokenHash ?? null]).toEqual([null, null])
        }
        release()
      }
    } finally {
      release()
      settleLinks = true
      await linkWorkSettled()
      opts.sendEmail = saved.send
      opts.linkAnswerMs = saved.ms
    }
  })

  it('measures the answer time for a missing and an existing address (reported, not asserted)', async () => {
    const opts = OPTS()
    const saved = opts.linkAnswerMs
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
    const run = async (kind: 'missing' | 'existing') => {
      const times: number[] = []
      for (let i = 0; i < 9; i++) {
        const asker = await make(email('asker'), 'member')
        const to = await BRANCHES[kind]!(asker)
        const token = await login(asker.email!)
        const start = performance.now()
        await call('/hats/link', token, { email: to })
        times.push(performance.now() - start)
      }
      return median(times)
    }
    settleLinks = false
    try {
      const report: Record<string, string> = {}
      for (const ms of [saved, 0]) {
        opts.linkAnswerMs = ms
        await run('existing') // warm-up
        report[`linkAnswerMs ${ms}`] = `missing ${(await run('missing')).toFixed(1)} ms, existing ${(await run('existing')).toFixed(1)} ms`
      }
      console.log('hats link answer medians:', JSON.stringify(report))
    } finally {
      settleLinks = true
      await linkWorkSettled()
      opts.linkAnswerMs = saved
    }
  })
})

describe('confirming a link request fails closed', () => {
  const requestFrom = async (asker: U, target: U) => {
    mail.length = 0
    expect((await call('/hats/link', await login(asker.email!), { email: target.email })).status).toBe(202)
    return tokenFrom(mail.find((m) => m.to === target.email)!.text)
  }
  const rowsOf = async (...us: U[]) => (await payload.find({ collection: MEMBERS as never, where: { user: { in: us.map((u) => u.id) } }, overrideAccess: true })).totalDocs

  it('refuses a request token for an address that got no invitation, or one already in a set', async () => {
    const asker = await make(email('a'), 'member')
    const token = 'made-up-token-for-a-request-with-no-account'
    await plugin((r) => payload.create({ collection: REQUESTS as never, data: { requestedBy: asker.id, account: null, holds: 'none:made-up', tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } as never, overrideAccess: true , req: r }))
    expect((await call('/hats/confirm', null, { token })).status).toBe(400)

    const target = await make(email('t'), 'member')
    const t = await requestFrom(asker, target)
    // Meanwhile the target joins someone else's set.
    await link(target, await make(email('x'), 'member'), await make(email('maint'), 'admin', { maintainer: true }))
    expect((await call('/hats/confirm', null, { token: t })).status).toBe(400)
    expect(await rowsOf(asker)).toBe(0)
  })

  it('refuses a confirmation that would take the set past maxLinked', async () => {
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const [a, b, c, d, e] = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((x) => make(email(x), 'member')))
    await link(a!, b!, approver)
    await link(a!, c!, approver)
    const td = await requestFrom(a!, d!)
    const te = await requestFrom(a!, e!)
    expect((await call('/hats/confirm', null, { token: td })).status).toBe(200)
    expect((await call('/hats/confirm', null, { token: te })).status).toBe(400)
    expect(await rowsOf(e!)).toBe(0)
  })

  it('refuses approving past maxLinked, however the rows got there', async () => {
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const people = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((x) => make(email(x), 'member')))
      const set = await plugin((r) => payload.create({ collection: 'hat-links' as never, data: { label: 'made up' } as never, overrideAccess: true, req: r }))
    const rows = []
    for (const [i, p] of people.entries())
      rows.push(await plugin((r) => payload.create({ collection: MEMBERS as never, data: { link: set.id, user: p.id, status: i < 4 ? 'approved' : 'confirmed' } as never, overrideAccess: true, req: r })))
    await expect(payload.update({ collection: MEMBERS as never, id: rows[4]!.id, data: { status: 'approved' } as never, user: approver as never, overrideAccess: false })).rejects.toThrow(/at most 4/)
  })

  it('hides an asker who hasn’t confirmed from the invited account, and refuses unlinking them', async () => {
    const asker = await make(email('a'), 'member')
    const invited = await make(email('b'), 'member')
    expect((await call('/hats/confirm', null, { token: await requestFrom(asker, invited) })).status).toBe(200)
    const token = await login(invited.email!)
    expect((await call('/hats', token, undefined, 'get')).body.set.map((m: { label: string }) => m.label)).toEqual([invited.email])
    const res = await call('/hats/unlink', token, { account: String(asker.id) })
    expect([res.status, res.body.data?.reason]).toEqual([404, 'notInSet'])
    expect(await rowsOf(asker)).toBe(1)
  })

  it('removes link requests when either account is deleted', async () => {
    const asker = await make(email('a'), 'member')
    const target = await make(email('t'), 'member')
    const other = await make(email('o'), 'member')
    await requestFrom(asker, target)
    await requestFrom(other, asker)
    const left = async () => (await payload.count({ collection: REQUESTS as never, where: { or: [{ requestedBy: { equals: asker.id } }, { account: { equals: asker.id } }] }, overrideAccess: true })).totalDocs
    expect(await left()).toBe(2)
    await payload.delete({ collection: 'users', id: asker.id, overrideAccess: true })
    expect(await left()).toBe(0)
  })
})

describe('upgrading from 0.4.0 with linking on', () => {
  /** Records exactly as 0.4.0 wrote them: a set, and a member row per account with that status (and a token while requested). */
  async function old(people: U[], status: 'requested' | 'confirmed' | 'approved', expires = Date.now() + 3_600_000) {
    const set = await plugin((r) => payload.create({ collection: 'hat-links' as never, data: { requestedBy: people[0]!.id, label: `Started by ${people[0]!.email}` } as never, overrideAccess: true, req: r }))
    const tokens: string[] = []
    for (const p of people) {
      const token = `old-token-${p.id}`
      tokens.push(token)
      const pending = status === 'requested' ? { tokenHash: hashToken(token), tokenExpires: new Date(expires).toISOString() } : {}
      await plugin((r) => payload.create({ collection: MEMBERS as never, data: { link: set.id, user: p.id, status, addedBy: people[0]!.id, ...pending } as never, overrideAccess: true, req: r }))
    }
    return { set: String(set.id), tokens }
  }
  const statuses = async (set: string) =>
    ((await payload.find({ collection: MEMBERS as never, where: { link: { equals: set } }, depth: 0, overrideAccess: true, sort: 'createdAt' })).docs as unknown as { status: string }[]).map((d) => d.status)

  it('keeps an approved set working: list, switch and unlink', async () => {
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((x) => make(email(x), 'author')))
    await old([a!, b!, c!], 'approved')
    const token = await login(a!.email!)
    expect((await call('/hats', token, undefined, 'get')).body.linked.map((l: { label: string }) => l.label).sort()).toEqual([b!.email, c!.email].sort())
    const res = await call('/hats/switch', token, { account: b!.id, hat: 'member' })
    expect(res.status).toBe(200)
    expect(hatsStateOf(await whoIs(res.token!))).toMatchObject({ via: String(a!.id) })
    const gone = await call('/hats/unlink', res.token, { account: String(c!.id) })
    expect(gone.status).toBe(200)
    expect((await call('/hats', await login(a!.email!), undefined, 'get')).body.linked.map((l: { label: string }) => l.label)).toEqual([b!.email])
  })

  it('completes a pending request: both old tokens still confirm, and approval waits for both', async () => {
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const [a, b] = await Promise.all(['a', 'b'].map((x) => make(email(x), 'author')))
    const { set, tokens } = await old([a!, b!], 'requested')
    expect((await call('/hats/confirm', null, { token: tokens[1] })).status).toBe(200)
    const rows = (await payload.find({ collection: MEMBERS as never, where: { link: { equals: set } }, depth: 0, overrideAccess: true })).docs as unknown as { id: string; user: unknown }[]
    const theirs = rows.find((r) => String(r.user) === String(b!.id))!
    const mine = rows.find((r) => String(r.user) === String(a!.id))!
    // Approving now is refused for the row still waiting on its own email.
    await expect(payload.update({ collection: MEMBERS as never, id: mine.id, data: { status: 'approved' } as never, user: approver as never, overrideAccess: false })).rejects.toThrow(/Only a confirmed account/)
    expect((await call('/hats/switch', await login(a!.email!), { account: b!.id, hat: 'member' })).status).toBe(403)
    expect((await call('/hats/confirm', null, { token: tokens[0] })).status).toBe(200)
    expect((await call('/hats/confirm', null, { token: tokens[0] })).status).toBe(400) // still single use
    for (const r of [mine, theirs]) await payload.update({ collection: MEMBERS as never, id: r.id, data: { status: 'approved' } as never, user: approver as never, overrideAccess: false })
    expect(await statuses(set)).toEqual(['approved', 'approved'])
    expect((await call('/hats/switch', await login(a!.email!), { account: b!.id, hat: 'member' })).status).toBe(200)
  })

  it('answers an expired old token with a way to ask again, and asking again works', async () => {
    const [a, b] = await Promise.all(['a', 'b'].map((x) => make(email(x), 'member')))
    const { tokens } = await old([a!, b!], 'requested', Date.now() - 60_000)
    const res = await call('/hats/confirm', null, { token: tokens[1] })
    expect(res.status).toBe(400)
    expect(res.body).toMatch(/Ask again from your account page/)
    mail.length = 0
    expect((await call('/hats/link', await login(a!.email!), { email: b!.email })).status).toBe(202)
    expect(mail.find((m) => m.to === b!.email)).toBeTruthy() // the old rows no longer hold b up
    await confirmAll()
    const set = (await payload.find({ collection: MEMBERS as never, where: { user: { equals: b!.id } }, depth: 0, overrideAccess: true })).docs as unknown as { status: string }[]
    expect(set.map((d) => d.status)).toEqual(['confirmed'])
  })

  it('lets an asker with an old pending set ask for another account, which still needs every confirmation', async () => {
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((x) => make(email(x), 'member')))
    const { set } = await old([a!, b!], 'requested')
    mail.length = 0
    expect((await call('/hats/link', await login(a!.email!), { email: c!.email })).status).toBe(202)
    await confirmAll()
    const rows = (await payload.find({ collection: MEMBERS as never, where: { link: { equals: set } }, depth: 0, overrideAccess: true })).docs as unknown as { id: string; user: unknown; status: string }[]
    expect(rows.find((r) => String(r.user) === String(c!.id))?.status).toBe('confirmed')
    for (const who of [a!, b!]) {
      const r = rows.find((x) => String(x.user) === String(who.id))!
      expect(r.status).toBe('requested')
      await expect(payload.update({ collection: MEMBERS as never, id: r.id, data: { status: 'approved' } as never, user: approver as never, overrideAccess: false })).rejects.toThrow(/Only a confirmed account/)
    }
  })

  it('gives a handler written for 0.4.0 a real set id and strings on every link event', async () => {
    events.length = 0
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((x) => make(email(x), 'member')))
    const linkTo = async (to: U) => {
      mail.length = 0
      expect((await call('/hats/link', await login(a!.email!), { email: to.email })).status).toBe(202)
      await confirmAll()
      const { docs } = await payload.find({ collection: MEMBERS as never, where: { and: [{ user: { in: [a!.id, to.id] } }, { status: { equals: 'confirmed' } }] }, depth: 0, overrideAccess: true })
      for (const d of docs) await payload.update({ collection: MEMBERS as never, id: d.id, data: { status: 'approved' } as never, user: approver as never, overrideAccess: false })
    }
    await linkTo(b!) // a new set: the event waits until the set is made
    await linkTo(c!) // an existing set: the event comes with the request
    const old040 = (e: HatsEvent) => {
      // What a 0.4.0 handler might do: string work on every field it was promised, and look the set up.
      if (e.type === 'link-requested' || e.type === 'link-confirmed' || e.type === 'link-approved') return `${e.type}:${e.link.trim()}:${e.account.toUpperCase()}`
      return e.type
    }
    const linkEvents = events.filter((e) => e.type.startsWith('link-'))
    expect(linkEvents.filter((e) => e.type === 'link-requested')).toHaveLength(2)
    for (const e of linkEvents) {
      expect(() => old040(e)).not.toThrow()
      const set = await payload.findByID({ collection: 'hat-links' as never, id: (e as { link: string }).link, overrideAccess: true, disableErrors: true })
      expect(set).toBeTruthy()
    }
    const first = events.findIndex((e) => e.type === 'link-requested')
    expect(events[first + 1]?.type).toBe('link-confirmed')
    expect(events[first]).toMatchObject({ by: String(a!.id), account: String(b!.id) })
  })
})

describe('link requests after review', () => {
  const ask = async (asker: U, address: string) => {
    mail.length = 0
    const res = await call('/hats/link', await login(asker.email!), { email: address })
    return { status: res.status, body: res.body, mail: mail.map((m) => ({ to: m.to === asker.email ? 'asker' : 'other', text: m.text })) }
  }
  const requestsTo = async (u: U) => (await payload.count({ collection: REQUESTS as never, where: { account: { equals: u.id } }, overrideAccess: true })).totalDocs

  it('sends an account one open invitation at a time, from every asker, and the askers can’t tell', async () => {
    const target = await make(email('t'), 'member')
    const [a, b] = await Promise.all(['a', 'b'].map((x) => make(email(x), 'member')))
    const first = await ask(a!, target.email!)
    expect(first.mail.filter((m) => m.to === 'other')).toHaveLength(1)
    const again = await ask(a!, target.email!)
    const other = await ask(b!, target.email!)
    const missing = await ask(b!, email('nobody'))
    for (const r of [again, other]) {
      expect(r.mail.filter((m) => m.to === 'other')).toHaveLength(0)
      expect([r.status, r.body]).toEqual([missing.status, missing.body])
      expect(r.mail.map((m) => m.to)).toEqual(missing.mail.map((m) => m.to))
    }
    expect(await requestsTo(target)).toBe(1)
    // Every request is still written and counted against its asker.
    expect((await payload.count({ collection: REQUESTS as never, where: { requestedBy: { equals: a!.id } }, overrideAccess: true })).totalDocs).toBe(2)
  })

  it('refuses link request writes from server code, even with overrideAccess, and writes nothing', async () => {
    const asker = await make(email('a'), 'member')
    const target = await make(email('t'), 'member')
    const data = { requestedBy: asker.id, account: target.id, tokenHash: hashToken('made-up'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    await expect(payload.create({ collection: REQUESTS as never, data: data as never, overrideAccess: true })).rejects.toThrow(/Only the hats plugin/)
    expect(await requestsTo(target)).toBe(0)
    await ask(asker, email('nobody'))
    const row = (await payload.find({ collection: REQUESTS as never, where: { requestedBy: { equals: asker.id } }, overrideAccess: true })).docs[0] as unknown as { id: string; account: unknown; tokenHash: string }
    await expect(payload.update({ collection: REQUESTS as never, id: row.id, data: { account: target.id, tokenHash: hashToken('made-up') } as never, overrideAccess: true })).rejects.toThrow(/Only the hats plugin/)
    const bulk = await payload.update({ collection: REQUESTS as never, where: { requestedBy: { equals: asker.id } }, data: { account: target.id, tokenHash: hashToken('made-up') } as never, overrideAccess: true })
    expect(bulk.docs).toHaveLength(0)
    expect(bulk.errors.length).toBeGreaterThan(0)
    const after = (await payload.findByID({ collection: REQUESTS as never, id: row.id, overrideAccess: true })) as unknown as { account: unknown; tokenHash: string }
    expect([after.account ?? null, after.tokenHash]).toEqual([row.account ?? null, row.tokenHash])
    expect((await call('/hats/confirm', null, { token: 'made-up' })).status).toBe(400)
  })

  it('keeps counting requests to an account that is deleted, and empties them', async () => {
    const asker = await make(email('a'), 'member')
    const target = await make(email('t'), 'member')
    for (let i = 0; i < 8; i++) expect((await ask(asker, target.email!)).status).toBe(202)
    expect((await ask(asker, target.email!)).status).toBe(429)
    await payload.delete({ collection: 'users', id: target.id, overrideAccess: true })
    expect((await ask(asker, target.email!)).status).toBe(429)
    const rows = (await payload.find({ collection: REQUESTS as never, where: { requestedBy: { equals: asker.id } }, overrideAccess: true, showHiddenFields: true })).docs as unknown as { account: unknown; tokenHash: unknown }[]
    expect(rows).toHaveLength(8)
    expect(rows.every((r) => r.account == null)).toBe(true)
    expect(rows.filter((r) => r.tokenHash == null)).toHaveLength(1) // the one invitation, emptied; the rest never had an account
  })

  it('answers the second of two simultaneous confirmations with the expired-link page', async () => {
    const asker = await make(email('a'), 'member')
    const target = await make(email('t'), 'member')
    const sent = await ask(asker, target.email!)
    const token = tokenFrom(sent.mail.find((m) => m.to === 'other')!.text)
    const both = await Promise.all([call('/hats/confirm', null, { token }), call('/hats/confirm', null, { token })])
    expect(both.map((r) => r.status).sort()).toEqual([200, 400])
    expect((await payload.count({ collection: MEMBERS as never, where: { user: { in: [asker.id, target.id] } }, overrideAccess: true })).totalDocs).toBe(2)
  })

  it('refuses to start with a linkAnswerMs a timer can’t hold', () => {
    const base = { hatsOf, wear, sendEmail: async () => {} }
    expect(() => hats({ ...base, linkAnswerMs: 2 ** 31 })({ collections: [] } as never)).toThrow(/linkAnswerMs/)
    expect(() => hats({ ...base, linkAnswerMs: 2 ** 31 - 1 })({ collections: [] } as never)).toThrow(/no auth collection/)
  })

  it('refuses a confirmation once the asker has joined another set, and allows a set the asker started since', async () => {
    const [a, b, x, y] = await Promise.all(['a', 'b', 'x', 'y'].map((n) => make(email(n), 'member')))
    const tb = tokenFrom((await ask(a!, b!.email!)).mail.find((m) => m.to === 'other')!.text)
    // a joins x's approved set.
    const set = await plugin((r) => payload.create({ collection: 'hat-links' as never, data: { requestedBy: x!.id, label: 'made up' } as never, overrideAccess: true, req: r }))
    for (const p of [x!, a!]) await plugin((r) => payload.create({ collection: MEMBERS as never, data: { link: set.id, user: p.id, status: 'approved' } as never, overrideAccess: true, req: r }))
    expect((await call('/hats/confirm', null, { token: tb })).status).toBe(400)
    expect((await payload.count({ collection: MEMBERS as never, where: { user: { equals: b!.id } }, overrideAccess: true })).totalDocs).toBe(0)

    // Two requests from no set: the first confirmation starts the asker's set, the second joins it.
    const c = await make(email('c'), 'member')
    const d = await make(email('d'), 'member')
    const tc = tokenFrom((await ask(y!, c.email!)).mail.find((m) => m.to === 'other')!.text)
    const td = tokenFrom((await ask(y!, d.email!)).mail.find((m) => m.to === 'other')!.text)
    expect((await call('/hats/confirm', null, { token: tc })).status).toBe(200)
    expect((await call('/hats/confirm', null, { token: td })).status).toBe(200)
    const rows = (await payload.find({ collection: MEMBERS as never, where: { user: { in: [y!.id, c.id, d.id] } }, depth: 0, overrideAccess: true })).docs as unknown as { link: unknown }[]
    expect(new Set(rows.map((r) => String(r.link))).size).toBe(1)
  })

  it('holds one open invitation per account with many askers at once, round after round, and the askers can’t tell', async () => {
    const askers = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((x) => make(email(x), 'member')))
    const tokens = await Promise.all(askers.map((a) => login(a.email!)))
    // Rows that hold nothing: requests to addresses with no account, from every asker.
    for (const [i] of askers.entries()) await call('/hats/link', tokens[i]!, { email: email('nobody') })
    mail.length = 0
    const nobody = await call('/hats/link', tokens[0]!, { email: email('nobody') })
    const reference = { status: nobody.status, body: nobody.body, mail: mail.filter((m) => m.to === askers[0]!.email).length }
    for (let round = 0; round < 5; round++) {
      const target = await make(email('t'), 'member')
      mail.length = 0
      const started = Date.now()
      const replies = await Promise.all(tokens.map((t) => call('/hats/link', t, { email: target.email })))
      expect(Date.now() - started).toBeGreaterThanOrEqual(100)
      for (const r of replies) expect([r.status, r.body]).toEqual([reference.status, reference.body])
      expect(mail.filter((m) => m.to === target.email)).toHaveLength(1)
      for (const a of askers) expect(mail.filter((m) => m.to === a.email)).toHaveLength(reference.mail)
      expect(await requestsTo(target)).toBe(1)
      // Every request is still written, one per asker.
      const rows = (await payload.find({ collection: REQUESTS as never, where: { requestedBy: { in: askers.map((a) => a.id) } }, overrideAccess: true, pagination: false })).docs as unknown as { holds: string }[]
      expect(rows).toHaveLength(askers.length * (round + 2) + 1)
      expect(rows.filter((r) => r.holds === `account:${String(target.id)}`)).toHaveLength(1)
    }
  })

  it('confirms a link even when the site’s onEvent handler throws, logs it without details, and still sends link-confirmed', async () => {
    const logged: unknown[] = []
    const error = payload.logger.error.bind(payload.logger)
    payload.logger.error = ((...args: unknown[]) => void logged.push(args)) as never
    try {
      for (const failing of ['link-requested', 'link-confirmed'] as const) {
        const [a, b] = await Promise.all(['a', 'b'].map((x) => make(email(x), 'member')))
        answers.event = (e) => {
          if (e.type === failing) throw new Error(`made-up failure about ${b!.email}`)
        }
        events.length = 0
        const token = tokenFrom((await ask(a!, b!.email!)).mail.find((m) => m.to === 'other')!.text)
        expect((await call('/hats/confirm', null, { token })).status).toBe(200)
        expect((await payload.count({ collection: MEMBERS as never, where: { user: { in: [a!.id, b!.id] } }, overrideAccess: true })).totalDocs).toBe(2)
        expect(events.map((e) => e.type)).toEqual(['link-requested', 'link-confirmed'])

        // Asking from a set fires link-requested at ask time; a throw there changes nothing the asker sees.
        const c = await make(email('c'), 'member')
        const sent = await ask(a!, c.email!)
        expect(sent.status).toBe(202)
        expect(sent.mail.filter((m) => m.to === 'other')).toHaveLength(1)
      }
      expect(logged.length).toBeGreaterThanOrEqual(3)
      expect(JSON.stringify(logged)).not.toMatch(/made-up failure|@example\.invalid/)
    } finally {
      payload.logger.error = error
    }
  })

  it('confirms and still sends link-confirmed when a handler’s error has a name that throws or isn’t a plain word, and logs only a short safe name', async () => {
    const logged: unknown[] = []
    const error = payload.logger.error.bind(payload.logger)
    payload.logger.error = ((...args: unknown[]) => void logged.push(args)) as never
    try {
      const odd: (() => unknown)[] = [
        () => Object.defineProperty(new Error('made-up'), 'name', { get: () => { throw new Error('made-up getter failure') } }),
        () => Object.assign(new Error('made-up'), { name: 'Bad name with spaces and an address someone@example.invalid' }),
        () => Object.assign(new Error('made-up'), { name: 'X'.repeat(80) }),
        () => 'a thrown string about someone@example.invalid',
      ]
      for (const thrown of odd) {
        const [a, b] = await Promise.all(['a', 'b'].map((x) => make(email(x), 'member')))
        answers.event = (e) => {
          if (e.type === 'link-requested') throw thrown()
        }
        events.length = 0
        const token = tokenFrom((await ask(a!, b!.email!)).mail.find((m) => m.to === 'other')!.text)
        expect((await call('/hats/confirm', null, { token })).status).toBe(200)
        expect(events.map((e) => e.type)).toEqual(['link-requested', 'link-confirmed'])
      }
      const names = logged.map((l) => /\(([^)]*)\)$/.exec(String((l as [{ msg: string }])[0].msg))?.[1])
      expect(names).toEqual(['Error', 'Error', 'Error', 'string'])
      expect(JSON.stringify(logged)).not.toMatch(/made-up|@example\.invalid|XXXX/)
    } finally {
      payload.logger.error = error
    }
  })

  it('answers the confirm page within about two seconds when the site’s handlers never finish', async () => {
    const warned: unknown[] = []
    const warn = payload.logger.warn.bind(payload.logger)
    payload.logger.warn = ((...args: unknown[]) => void warned.push(args)) as never
    try {
      const [a, b] = await Promise.all(['a', 'b'].map((x) => make(email(x), 'member')))
      const token = tokenFrom((await ask(a!, b!.email!)).mail.find((m) => m.to === 'other')!.text)
      answers.event = (e) => (e.type === 'link-confirmed' ? new Promise(() => {}) : undefined)
      const started = Date.now()
      const res = await call('/hats/confirm', null, { token })
      const took = Date.now() - started
      expect(res.status).toBe(200)
      expect(took).toBeLessThan(3500)
      expect(took).toBeGreaterThanOrEqual(1900)
      expect((await payload.count({ collection: MEMBERS as never, where: { user: { in: [a!.id, b!.id] } }, overrideAccess: true })).totalDocs).toBe(2)
      expect(JSON.stringify(warned)).toMatch(/still running/)
    } finally {
      payload.logger.warn = warn
    }
  }, 15_000)

  it('runs the site’s confirmURL and onEvent callbacks without the plugin’s mark on the request', async () => {
    const seen: [string, boolean][] = []
    answers.confirmURL = ({ req, token }) => {
      seen.push(['confirmURL', isInternal(req)])
      return `https://site.example/api/hats/confirm?token=${token}`
    }
    answers.event = (e) => {
      if ('req' in e) seen.push([e.type, isInternal(e.req)])
    }
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((x) => make(email(x), 'member')))
    const token = tokenFrom((await ask(a!, b!.email!)).mail.find((m) => m.to === 'other')!.text)
    expect((await call('/hats/confirm', null, { token })).status).toBe(200) // mails the asker a link of its own
    expect((await ask(a!, c!.email!)).status).toBe(202) // from a set: link-requested fires at ask time
    expect(seen.map(([k]) => k)).toEqual(['confirmURL', 'confirmURL', 'link-requested', 'confirmURL', 'link-requested'])
    expect(seen.every(([, marked]) => marked === false)).toBe(true)
  })

  it('ignores a string marker in context: server code can’t pass as the plugin', async () => {
    const asker = await make(email('a'), 'member')
    const target = await make(email('t'), 'member')
    const data = { requestedBy: asker.id, account: target.id, holds: `account:${String(target.id)}`, tokenHash: hashToken('made-up'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    for (const context of [{ hatsInternal: true }, { hatsInternal: true, hatsDissolving: true }])
      await expect(payload.create({ collection: REQUESTS as never, data: data as never, overrideAccess: true, context })).rejects.toThrow(/Only the hats plugin/)
    expect(await requestsTo(target)).toBe(0)
  })
})

describe('the plugin’s marks and the site’s callbacks', () => {
  it('leaves no mark behind when the site’s callback runs the plugin’s own code inside it', async () => {
    const req = await createLocalReq({}, payload)
    const inside: boolean[] = []
    await asPlugin(req, () =>
      unmarked(req, async () => {
        inside.push(isInternal(req))
        await asPlugin(req, async () => void inside.push(isInternal(req)))
        inside.push(isInternal(req))
      }),
    )
    expect(inside).toEqual([false, true, false])
    expect(isInternal(req)).toBe(false)
    await withMark(req, DISSOLVING, () => unmarked(req, () => withMark(req, DISSOLVING, async () => 1)))
    expect(isDissolving(req)).toBe(false)
  })

  it('keeps a mark off a site callback still running after the plugin moves on, and off the plugin after it', async () => {
    const req = await createLocalReq({}, payload)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const late: boolean[] = []
    let callback!: Promise<void>
    await asPlugin(req, async () => {
      callback = unmarked(req, async () => {
        await held
        late.push(isInternal(req))
      })
    })
    await asPlugin(req, async () => {
      release()
      await callback
    })
    expect(late).toEqual([false])
    expect(isInternal(req)).toBe(false)
  })
})

describe('unlinking takes only an exact account id', () => {
  /** Links two new accounts, approving only their own rows (earlier tests may leave other confirmed rows behind). */
  async function pair() {
    const approver = await make(email('maint'), 'admin', { maintainer: true })
    const a = await make(email('a'), 'member')
    const b = await make(email('b'), 'member')
    mail.length = 0
    expect((await call('/hats/link', await login(a.email!), { email: b.email })).status).toBe(202)
    await confirmAll()
    const { docs } = await payload.find({ collection: MEMBERS as never, where: { user: { in: [a.id, b.id] } }, depth: 0, overrideAccess: true })
    for (const d of docs) await payload.update({ collection: MEMBERS as never, id: d.id, data: { status: 'approved' } as never, user: approver as never, overrideAccess: false })
    return { a, b }
  }

  it('refuses any other spelling of the id with notInSet and no database text, and unlinks with the exact one', async () => {
    const { a, b } = await pair()
    const token = await login(a.email!)
    const id = String(b.id)
    const unlinked: HatsEvent[] = []
    answers.event = (e) => void (e.type === 'unlinked' && unlinked.push(e))
    for (const odd of [`0${id}`, `${id}abc`, ` ${id}`, `${id} `, `${id}e0`, `${id}.0`, { id: b.id }, [b.id], '', '99999999999999999999999', true]) {
      const res = await call('/hats/unlink', token, { account: odd })
      expect([JSON.stringify(odd), res.status, res.body?.data?.reason ?? res.body?.reason]).toEqual([JSON.stringify(odd), 404, 'notInSet'])
      expect(JSON.stringify(res.body)).not.toMatch(/sql|select|where|syntax|cast/i)
    }
    expect(unlinked).toEqual([])
    expect((await payload.count({ collection: MEMBERS as never, where: { user: { equals: b.id } }, overrideAccess: true })).totalDocs).toBe(1)
    expect((await call('/hats/unlink', token, { account: b.id })).status).toBe(200)
    expect(unlinked.map((e) => (e as { account: string }).account)).toEqual([id])
  })

  it('still unlinks, with no error, when the site’s unlinked handler throws', async () => {
    const { a, b } = await pair()
    answers.event = (e) => {
      if (e.type === 'unlinked') throw new Error('the site’s handler is down')
    }
    expect((await call('/hats/unlink', await login(a.email!), { account: String(b.id) })).status).toBe(200)
    expect((await payload.count({ collection: MEMBERS as never, where: { user: { in: [a.id, b.id] } }, overrideAccess: true })).totalDocs).toBe(0)
  })
})
