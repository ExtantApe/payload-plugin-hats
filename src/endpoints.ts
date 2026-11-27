import { addDataAndFileToRequest, APIError, getFieldsToSign, jwtSign, type Endpoint, type PayloadRequest } from 'payload'
import { addSessionToUser, generateCookie } from 'payload/shared'

import { blockedBy, exactlyTrue } from './access.js'
import { cleanupSessions, revokeSessions, revokeSid, sessionBySid, sharedLink, tombstone, wornHat } from './sessions.js'
import { memoryKey, needsStepUp, remembered } from './stepup.js'
import { asPlugin, hashToken, hatsOptions, hatsStateOf, idOf, newToken } from './state.js'
import { LINKS, MEMBERS, REQUESTS, SESSIONS, type Hat, type HatsUser, type ResolvedHatsOptions } from './types.js'

const json = (body: unknown, status = 200, cookies: string[] = []) => {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  for (const c of cookies) headers.append('Set-Cookie', c)
  return new Response(JSON.stringify(body), { status, headers })
}
/** A refusal with a stable `reason`, so a site can show its own words for it (the English message is the fallback). */
const refuse = (message: string, status = 403, reason?: string): never => {
  throw new APIError(message, status, reason ? { reason } : undefined, true)
}

/** The acting account, its full record (all roles, not the hat), and the session's hat state. */
async function actor(req: PayloadRequest) {
  const opts = hatsOptions(req.payload)
  const user = req.user as HatsUser | null
  if (!user || user.collection !== opts.users) refuse('Sign in first.', 401, 'signIn')
  const state = hatsStateOf(user)
  if (!state) refuse('Switching needs a browser sign-in.', 400, 'signIn')
  const full = await loadUser(req, String(user!.id))
  if (!full) refuse('Sign in first.', 401, 'signIn')
  return { opts, user: user!, full: full!, state: state!, person: state!.via ?? String(user!.id) }
}

const loadUser = async (req: PayloadRequest, id: string) =>
  (await req.payload.findByID({ collection: hatsOptions(req.payload).users as never, id, depth: 0, overrideAccess: true, showHiddenFields: true, disableErrors: true, req })) as HatsUser | null

const labelOf = (u: HatsUser) => String(u.email ?? u.id)

async function members(req: PayloadRequest, link: string) {
  const { docs } = await req.payload.find({ collection: MEMBERS as never, where: { link: { equals: link } }, limit: 0, depth: 0, overrideAccess: true, pagination: false, req })
  return docs as unknown as { id: string; user: unknown; status: string }[]
}
async function membershipOf(req: PayloadRequest, userId: string) {
  const { docs } = await req.payload.find({ collection: MEMBERS as never, where: { user: { equals: userId } }, limit: 1, depth: 0, overrideAccess: true, pagination: false, req })
  return (docs[0] as unknown as { id: string; link: unknown; status: string } | undefined) ?? null
}

/** The other approved accounts in the acting account's set, with their hats. */
async function linkedAccounts(req: PayloadRequest, userId: string) {
  const mine = await membershipOf(req, userId)
  if (mine?.status !== 'approved') return { link: null, linked: [] as { user: HatsUser; hats: Hat[] }[] }
  const link = idOf(mine.link)
  const linked: { user: HatsUser; hats: Hat[] }[] = []
  for (const m of await members(req, link)) {
    if (m.status !== 'approved' || idOf(m.user) === userId) continue
    const u = await loadUser(req, idOf(m.user))
    if (u) linked.push({ user: u, hats: hatsOptions(req.payload).hatsOf(u) })
  }
  return { link, linked }
}

const defaultShow: NonNullable<ResolvedHatsOptions['showSwitch']> = ({ hats, linked }) => hats.length > 1 || linked.some((l) => l.hats.length > 1)

async function blockedReason(req: PayloadRequest, opts: ResolvedHatsOptions) {
  if (!opts.blocked) return
  const why = await blockedBy(() => opts.blocked!(req))
  if (why !== null) refuse(why, 409, 'blocked')
}

/** GET /api/hats: the switch menu for the acting account. */
const me: Endpoint = {
  path: '/hats',
  method: 'get',
  handler: async (req) => {
    if (!req.user) return json({ signedIn: false })
    const { opts, full, state, person } = await actor(req)
    const hats = opts.hatsOf(full)
    const { link, linked } = await linkedAccounts(req, String(full.id))
    const worn = wornHat(hats, state.hat ? { hat: state.hat, via: state.via } : null) ?? hats.at(-1) ?? null
    const s = await sessionBySid(req.payload, state.sid, req)
    const mine = await membershipOf(req, String(full.id))
    const from = { user: req.user as HatsUser, hat: worn?.id ?? null }
    const setId = mine?.status === 'approved' ? idOf(mine.link) : null
    const asks = async (target: HatsUser, targetHats: Hat[], h: Hat, sameAccount: boolean) =>
      !(sameAccount && h.id === worn?.id) && (await needsStepUp(opts, { req, from, target, hats: targetHats, hat: h })) && !remembered(opts, s?.steppedUp, String(target.id), setId)
    // The set as this account may see it: an account nobody has confirmed yet stays hidden, so a request never
    // reveals whether an email has an account here.
    const set: { id: string | number; label: string; status: string; you: boolean }[] = []
    if (mine)
      for (const m of await members(req, idOf(mine.link))) {
        const you = idOf(m.user) === String(full.id)
        if (!you && m.status === 'requested') continue
        const u = you ? full : await loadUser(req, idOf(m.user))
        if (u) set.push({ id: u.id, label: labelOf(u), status: m.status, you })
      }
    return json({
      signedIn: true,
      account: { id: full.id, label: labelOf(full) },
      signedInAs: person,
      hat: worn?.id ?? null,
      hats: await Promise.all(hats.map(async (h) => ({ ...h, needsCode: await asks(full, hats, h, true) }))),
      linked: await Promise.all(
        linked.map(async (l) => ({
          id: l.user.id,
          label: labelOf(l.user),
          hats: await Promise.all(l.hats.map(async (h) => ({ ...h, needsCode: await asks(l.user, l.hats, h, false) }))),
        })),
      ),
      link,
      set,
      canLink: Boolean(opts.canApproveLinks),
      showSwitch: (opts.showSwitch ?? defaultShow)({ user: full, hats, linked }),
      maxLinked: opts.maxLinked,
    })
  },
}

/** What a switch came to. A refusal carries the endpoint's `reason` (`needsCode` included) and its English message. */
export type SwitchResult =
  | { ok: true; account: string; hat: string; /** The Set-Cookie value for the new session, or null when the hat changed on the same account. */ cookie: string | null }
  | { ok: false; status: number; reason: string; message: string }

/** The input of a switch: the same three fields the endpoint reads from its body. */
export type SwitchInput = { account?: unknown; hat?: unknown; code?: unknown }

/**
 * The one switch, shared by POST /api/hats/switch and `switchSession`, so the two can't drift. It acts only for
 * `req.user` and has no option that skips a check. Any failure, an error from a host hook included, is a refusal.
 */
export async function runSwitch(req: PayloadRequest, input: SwitchInput | null | undefined): Promise<SwitchResult> {
  try {
    return await switchCore(req, input ?? {})
  } catch (error) {
    if (error instanceof APIError) {
      const reason = (error.data as { reason?: unknown } | undefined)?.reason
      return { ok: false, status: error.status, reason: typeof reason === 'string' ? reason : 'failed', message: error.message }
    }
    req.payload?.logger?.warn({ err: error }, 'Hats: switch refused after an unexpected error')
    return { ok: false, status: 500, reason: 'failed', message: 'Switching didn’t work. Try again.' }
  }
}

/** The origins this site answers as: the one the request arrived on, and the configured server URL. */
function ownOrigins(req: PayloadRequest): string[] {
  const out: string[] = []
  for (const u of [req.url, req.payload?.config?.serverURL]) {
    try {
      if (u) out.push(new URL(u).origin)
    } catch {
      /* an unreadable address adds no origin, so a mismatch is refused */
    }
  }
  return out
}

/** Reads a header from a Headers instance or a plain object (any key case). Null for anything else, which is refused as cross-site. */
function headerReader(h: unknown): ((name: string) => string | null) | null {
  if (h instanceof Headers) return (name) => h.get(name)
  const proto = h && typeof h === 'object' ? Object.getPrototypeOf(h) : undefined
  if (proto !== Object.prototype && proto !== null) return null
  const entries = Object.entries(h as Record<string, unknown>)
  // Header values are strings (or lists of them, as Node gives them); a function or anything else means this isn't headers.
  const plain = (v: unknown) => v == null || typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))
  if (!entries.every(([, v]) => plain(v))) return null
  return (name) => {
    const hit = entries.find(([k]) => k.toLowerCase() === name)
    if (!hit) return null
    const v = hit[1]
    return Array.isArray(v) ? v.join(', ') : v == null ? null : String(v)
  }
}

/** A switch only comes from the site's own POST: any other method, a foreign Origin or a Sec-Fetch-Site other than same-origin is refused. */
function refuseCrossSite(req: PayloadRequest) {
  if (String(req.method ?? '').toUpperCase() !== 'POST') refuse('Switching needs a POST from this site.', 405, 'notPost')
  const header = headerReader(req.headers)
  if (!header) return refuse('Switching must come from this site.', 403, 'crossSite') // no headers to check, so no way to tell: refused
  const origin = header('origin')
  if (origin != null && !ownOrigins(req).includes(origin)) refuse('Switching must come from this site.', 403, 'crossSite')
  const fetchSite = header('sec-fetch-site')
  if (fetchSite != null && fetchSite !== 'same-origin') refuse('Switching must come from this site.', 403, 'crossSite')
}

async function switchCore(req: PayloadRequest, body: SwitchInput): Promise<SwitchResult> {
  refuseCrossSite(req)
  const { opts, full, state, person } = await actor(req)
  await blockedReason(req, opts)
  const current = String(full.id)
  const to = body.account == null || body.account === '' ? current : String(body.account)

  let link: string | null = null
  if (to !== current) {
    link = await sharedLink(req.payload, current, to, req)
    if (!link) refuse('That account isn’t linked to this one.', 403, 'notLinked')
  }
  const target = to === current ? full : await loadUser(req, to)
  if (!target) refuse('That account isn’t linked to this one.', 403, 'notLinked')
  // Direct login refuses a locked account, so a switch into one is refused too.
  const lockUntil = to === current ? null : (target as { lockUntil?: unknown }).lockUntil
  if (lockUntil != null && new Date(lockUntil as string).getTime() > Date.now()) refuse('That account is locked. Try again later.', 403, 'locked')
  // Direct login refuses an unverified account when the collection verifies emails, so a switch does too.
  const usersAuth = req.payload.collections[opts.users as never]!.config.auth
  if (to !== current && usersAuth.verify && (target as { _verified?: unknown })._verified === false) refuse('That account’s email isn’t confirmed yet.', 403, 'unverified')
  const { linked } = await linkedAccounts(req, current)
  if (!(opts.showSwitch ?? defaultShow)({ user: full, hats: opts.hatsOf(full), linked })) refuse('Switching isn’t available for this account.', 403, 'notAvailable')

  const hats = opts.hatsOf(target!)
  const hat = typeof body.hat === 'string' ? hats.find((h) => h.id === body.hat) : to === current ? undefined : hats[0]
  if (!hat) refuse('Choose one of that account’s hats.', 400, 'chooseHat')

  const s = await sessionBySid(req.payload, state.sid, req)
  const nowWearing = to === current ? (wornHat(hats, s) ?? hats.at(-1))!.id : null
  const steppedUp = { ...(s?.steppedUp ?? {}) }
  let gaveCode = false
  const setId = (await membershipOf(req, to).then((m) => (m?.status === 'approved' ? idOf(m.link) : null))) ?? null
  const from = { user: req.user as HatsUser, hat: wornHat(opts.hatsOf(full), s)?.id ?? opts.hatsOf(full).at(-1)?.id ?? null }
  if (hat!.id !== nowWearing && (await needsStepUp(opts, { req, from, target: target!, hats, hat: hat! })) && !remembered(opts, steppedUp, to, setId)) {
    if (!opts.stepUp) refuse('This site has no second factor for switching up.', 403, 'noSecondFactor')
    // Only an exact `true` passes either check; a truthy answer such as `{ valid: false }`, or a thrown error, is a no.
    const stepUp = opts.stepUp!
    const ctx = { signedIn: (person === current ? full : await loadUser(req, person)) ?? full, set: setId }
    if (!(await exactlyTrue(() => stepUp.available(target!, ctx)))) refuse('Set up two-step sign-in on that account first.', 403, 'setUpTwoStep')
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!code) return { ok: false, status: 401, reason: 'needsCode', message: 'Enter a code from that account’s authenticator app.' }
    if (!(await exactlyTrue(() => stepUp.verify({ req, user: target!, code, ...ctx })))) refuse('That code didn’t work. Try a new one.', 403, 'wrongCode')
    steppedUp[memoryKey(opts, to, setId)] = new Date().toISOString()
    gaveCode = true
  }

  const users = req.payload.collections[opts.users as never]!.config
  if (to === current) {
    await asPlugin(req, async () => {
      if (s) await req.payload.update({ collection: SESSIONS as never, id: s.id, data: { hat: hat!.id, steppedUp } as never, overrideAccess: true, req })
      else await req.payload.create({ collection: SESSIONS as never, data: { sid: state.sid, user: current, hat: hat!.id, steppedUp, expiresAt: expiry(users.auth.tokenExpiration) } as never, overrideAccess: true, req })
    })
    await opts.onEvent?.({ type: 'switched', req, from: current, to, hat: hat!.id, via: person, steppedUp: gaveCode })
    return { ok: true, account: to, hat: hat!.id, cookie: null }
  }

  // Another account: a fresh Payload session for it, then this one ends.
  const own = person === to
  const { sid } = await addSessionToUser({ collectionConfig: users, payload: req.payload, req, user: target as never })
  if (!sid) refuse('Switching accounts needs Payload sessions (auth.useSessions).', 500, 'noSessions')
  await asPlugin(req, () =>
    req.payload.create({
      collection: SESSIONS as never,
      data: { sid, user: to, via: own ? null : person, link: own ? null : link, hat: hat!.id, steppedUp, expiresAt: expiry(users.auth.tokenExpiration) } as never,
      overrideAccess: true,
      req,
    }),
  )
  await revokeSid(req.payload, current, state.sid, req)
  if (s) await tombstone(req.payload, s.id, req)
  else
    await asPlugin(req, () =>
      req.payload.create({ collection: SESSIONS as never, data: { sid: state.sid, user: current, revokedAt: new Date().toISOString(), expiresAt: expiry(users.auth.tokenExpiration) } as never, overrideAccess: true, req }),
    )
  await cleanupSessions(req.payload, req).catch((err) => req.payload.logger.warn({ err }, 'Hats: session clean-up skipped'))
  const { token } = await jwtSign({
    fieldsToSign: getFieldsToSign({ collectionConfig: users, email: String(target!.email ?? ''), sid, user: target as never }),
    secret: req.payload.secret,
    tokenExpiration: users.auth.tokenExpiration,
  })
  const cookie = generateCookie<string>({
    name: `${req.payload.config.cookiePrefix}-token`,
    value: token,
    path: '/',
    httpOnly: true,
    secure: users.auth.cookies.secure,
    sameSite: typeof users.auth.cookies.sameSite === 'string' ? users.auth.cookies.sameSite : 'Lax',
    domain: users.auth.cookies.domain ?? undefined,
    expires: new Date(Date.now() + users.auth.tokenExpiration * 1000),
    returnCookieAsObject: false,
  })
  await opts.onEvent?.({ type: 'switched', req, from: current, to, hat: hat!.id, via: person, steppedUp: gaveCode })
  return { ok: true, account: to, hat: hat!.id, cookie }
}

/**
 * POST /api/hats/switch { account?, hat, code? }: wear another hat, on this account or another approved account in
 * the same set. A sensitive hat needs that account's second factor unless it was given here recently.
 */
const switchHat: Endpoint = {
  path: '/hats/switch',
  method: 'post',
  handler: async (req) => {
    await addDataAndFileToRequest(req)
    const result = await runSwitch(req, (req.data ?? {}) as SwitchInput)
    if (result.ok) return json({ ok: true, account: result.account, hat: result.hat, reload: true }, 200, result.cookie ? [result.cookie] : [])
    if (result.reason === 'needsCode') return json({ ok: false, needsCode: true, reason: 'needsCode', message: result.message }, 401)
    return refuse(result.message, result.status, result.reason)
  },
}

const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()

const SENT =
  'If that address belongs to an account that can be linked, we’ve emailed it a link to confirm. Once it’s confirmed, we’ll email you to confirm from your side, and then an administrator reviews the link.'

const confirmLink = (req: PayloadRequest, opts: ResolvedHatsOptions, token: string) =>
  opts.confirmURL ? opts.confirmURL({ req, token }) : `${new URL(req.url ?? 'http://localhost').origin}${req.payload.config.routes.api}/hats/confirm?token=${token}`

/** Open link requests one account may have at once. Counted the same whatever the addresses were. */
const pendingCap = (opts: ResolvedHatsOptions) => opts.maxLinked * 2

/**
 * POST /api/hats/link { email }: ask to link the acting account with another. The person asking learns nothing
 * about the address: the answer, the time it takes, their own email, the records they can read and the records
 * written for them are the same whether or not it has an account, whatever state that account is in. Only the
 * other account hears about it, and nothing changes on the asker's side until that account confirms.
 */
const requestLink: Endpoint = {
  path: '/hats/link',
  method: 'post',
  handler: async (req) => {
    await addDataAndFileToRequest(req)
    const { opts, full } = await actor(req)
    await blockedReason(req, opts)
    if (!opts.canApproveLinks) refuse('Linking accounts isn’t turned on here.', 403, 'linkingOff')
    const email = String((req.data as { email?: unknown } | undefined)?.email ?? '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) refuse('Enter the other account’s email address.', 400, 'enterEmail')
    // Refused unless the site's limit answers exactly true (a throw, false or any other answer is a no): nothing is recorded or sent.
    if (opts.limit && !(await exactlyTrue(() => opts.limit!({ req, user: full, email })))) refuse('Too many link requests. Try again later.', 429, 'tooMany')
    const me = String(full.id)
    const now = new Date()

    // Everything up to here depends only on the asker and what they typed. From here on the answer waits for the
    // same fixed time whatever happens, so how long the work takes says nothing about the address.
    const answer = new Promise<void>((resolve) => setTimeout(resolve, opts.linkAnswerMs))

    await asPlugin(req, async () => {
      // Requests nobody confirmed in time don't hold anyone up.
      await req.payload.delete({ collection: MEMBERS as never, where: { and: [{ status: { equals: 'requested' } }, { tokenExpires: { less_than: now.toISOString() } }] }, overrideAccess: true, showHiddenFields: true, req })
      await req.payload.delete({ collection: REQUESTS as never, where: { expiresAt: { less_than: now.toISOString() } }, overrideAccess: true, req })
    })
    const mine = await membershipOf(req, me)
    const already = mine ? (await members(req, idOf(mine.link))).length : 0
    if (already + (mine ? 1 : 2) > opts.maxLinked) {
      await answer
      refuse(`A set can hold at most ${opts.maxLinked} accounts.`, 400, 'setFull')
    }
    const open = await req.payload.count({ collection: REQUESTS as never, where: { requestedBy: { equals: me } }, overrideAccess: true, req })
    if (open.totalDocs >= pendingCap(opts)) {
      await answer
      refuse('Too many link requests. Try again later.', 429, 'tooMany')
    }

    const work = async () => {
      const { docs } = await req.payload.find({ collection: opts.users as never, where: { email: { equals: email } }, limit: 1, depth: 0, overrideAccess: true, pagination: false, req })
      const found = docs[0] as HatsUser | undefined
      let target = found && String(found.id) !== me && !(await membershipOf(req, String(found.id))) ? found : null
      // One open invitation per account, from anyone, so nobody can fill an inbox with them. A request to an account
      // already invited is written and answered the same way, with no invitation.
      if (target && (await req.payload.count({ collection: REQUESTS as never, where: { account: { equals: target.id } }, overrideAccess: true, req })).totalDocs > 0) target = null
      // One record for every request, with the same fields. Only a real invitation's token can ever be used.
      const token = newToken()
      const hours = opts.confirmHours
      const request = await asPlugin(req, () =>
        req.payload.create({
          collection: REQUESTS as never,
          data: { requestedBy: me, account: target ? target.id : null, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString(), link: mine ? idOf(mine.link) : null } as never,
          overrideAccess: true,
          req,
        }),
      )
      // The asker's own note is the same every time and leaves the address out, so it can't tell them anything.
      try {
        await opts.sendEmail({
          payload: req.payload,
          to: String(full.email),
          subject: 'You asked to link an account',
          text: `You asked to link ${labelOf(full)} with another account, so one person can switch between them.\n\nIf the address you entered belongs to an account that can be linked, we’ve emailed it a link to confirm within ${hours} hours. Once it’s confirmed, we’ll email you a link to confirm from your side, and then an administrator reviews the link. If nobody confirms, nothing is linked.\n\nIf you didn’t ask for this, change your password.`,
        })
      } catch (err) {
        req.payload.logger.warn({ err }, 'Hats: link request note not sent')
      }
      if (!target) return
      try {
        await opts.sendEmail({
          payload: req.payload,
          to: String(target.email),
          subject: 'Confirm linking your accounts',
          text: `Someone signed in as ${labelOf(full)} asked to link that account with ${labelOf(target)}, so one person can switch between them.\n\nIf that was you, confirm here within ${hours} hours:\n${confirmLink(req, opts, token)}\n\nIf it wasn’t you, ignore this email: nothing is linked without it.`,
        })
      } catch (err) {
        // The invitation never arrived, so its token must never work.
        req.payload.logger.warn({ err }, 'Hats: link invitation not sent')
        await asPlugin(req, () => req.payload.update({ collection: REQUESTS as never, id: (request as { id: string }).id, data: { account: null, tokenHash: null } as never, overrideAccess: true, req }))
        return
      }
      // With no set yet, the event waits for confirmation, when the set exists, so `link` is always a real set.
      if (mine) await opts.onEvent?.({ type: 'link-requested', req, link: idOf(mine.link), by: me, account: String(target.id) })
    }
    let finished = false
    const done = work()
      .catch((err) => req.payload.logger.warn({ err }, 'Hats: link request not finished'))
      .finally(() => {
        finished = true
      })
    await answer
    if (!finished) void done.then(() => req.payload.logger.info('Hats: a link request finished after its answer. Raise linkAnswerMs if this repeats.'))
    return json({ ok: true, reason: 'linkSent', message: SENT }, 202)
  },
}

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font:1rem/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#222;background:#fff}button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #333;background:#222;color:#fff;cursor:pointer}button:focus-visible{outline:3px solid #c60;outline-offset:2px}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}button{background:#eee;color:#111;border-color:#eee}}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  )
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** GET /api/hats/confirm?token=…: a button, so a mail scanner opening the link doesn't confirm anything. */
const confirmPage: Endpoint = {
  path: '/hats/confirm',
  method: 'get',
  handler: async (req) => {
    const token = new URL(req.url ?? 'http://localhost').searchParams.get('token') ?? ''
    return page(
      'Link your accounts',
      `<p>Confirm that this account belongs to the person who asked to link it. An administrator reviews the link before it works.</p><form method="post"><input type="hidden" name="token" value="${esc(token)}"><button type="submit">Confirm</button></form>`,
    )
  },
}

/** POST /api/hats/confirm (form or JSON { token }). */
const confirm: Endpoint = {
  path: '/hats/confirm',
  method: 'post',
  handler: async (req) => {
    let token = ''
    const type = req.headers.get('content-type') ?? ''
    if (type.includes('application/x-www-form-urlencoded') && req.text) token = new URLSearchParams(await req.text()).get('token') ?? ''
    else {
      await addDataAndFileToRequest(req)
      token = String((req.data as { token?: unknown } | undefined)?.token ?? '')
    }
    const bad = () => page('That link didn’t work', '<p>It may have expired or been used already. Ask again from your account page.</p>', 400)
    if (!token) return bad()
    const opts = hatsOptions(req.payload)
    const hash = hashToken(token)
    const thanks = () => page('Confirmed', '<p>Thanks. Once every account in the link is confirmed, an administrator reviews it. You can close this page.</p>')

    // The asker confirming their own side, after the other account confirmed.
    const { docs } = await req.payload.find({ collection: MEMBERS as never, where: { tokenHash: { equals: hash } }, limit: 1, depth: 0, overrideAccess: true, showHiddenFields: true, pagination: false, req })
    const m = docs[0] as unknown as { id: string; link: unknown; user: unknown; status: string; tokenExpires?: string } | undefined
    if (m) {
      if (m.status !== 'requested' || !m.tokenExpires || new Date(m.tokenExpires).getTime() < Date.now()) return bad()
      if ((await members(req, idOf(m.link))).length > opts.maxLinked) return bad()
      await asPlugin(req, () =>
        req.payload.update({ collection: MEMBERS as never, id: m.id, data: { status: 'confirmed', confirmedAt: new Date().toISOString(), tokenHash: null, tokenExpires: null } as never, overrideAccess: true, req }),
      )
      await opts.onEvent?.({ type: 'link-confirmed', payload: req.payload, link: idOf(m.link), account: idOf(m.user) })
      return thanks()
    }

    // The invited account confirming a request. The token works once: the request is deleted before anything else.
    const found = await req.payload.find({ collection: REQUESTS as never, where: { tokenHash: { equals: hash } }, limit: 1, depth: 0, overrideAccess: true, pagination: false, req })
    const r = found.docs[0] as unknown as { id: string; requestedBy: unknown; account?: unknown; expiresAt: string; link?: string | null } | undefined
    if (!r || r.account == null || new Date(r.expiresAt).getTime() < Date.now()) return bad()
    let gone: unknown
    try {
      gone = await asPlugin(req, () => req.payload.delete({ collection: REQUESTS as never, where: { and: [{ id: { equals: r.id } }, { tokenHash: { equals: hash } }] }, overrideAccess: true, req }))
    } catch {
      return bad() // the same token confirmed at the same moment: the other confirmation has it
    }
    if ((gone as { docs?: unknown[] }).docs?.length !== 1) return bad()
    const by = idOf(r.requestedBy)
    const account = idOf(r.account)
    if (by === account) return bad()
    const asker = await loadUser(req, by)
    const invited = await loadUser(req, account)
    if (!asker || !invited || (await membershipOf(req, account))) return bad()
    const mine = await membershipOf(req, by)
    const existing = mine ? idOf(mine.link) : null
    // The invitation was for the asker's set as it was then. A set the asker started since, from another of their own
    // requests, is still theirs; any other change (they joined or left a set) needs a new request.
    const was = r.link ? String(r.link) : null
    if (existing !== was) {
      const started = was === null && existing ? ((await req.payload.findByID({ collection: LINKS as never, id: existing, depth: 0, overrideAccess: true, disableErrors: true, req })) as { requestedBy?: unknown } | null) : null
      if (!started || idOf(started.requestedBy) !== by) return bad()
    }
    if (existing && (await members(req, existing)).length + 1 > opts.maxLinked) return bad()

    const made: { link?: string; rows: string[] } = { rows: [] }
    try {
      await asPlugin(req, async () => {
        const link = existing ?? String((await req.payload.create({ collection: LINKS as never, data: { requestedBy: by, label: `Started by ${labelOf(asker)}` } as never, overrideAccess: true, req })).id)
        if (!existing) made.link = link
        const now = new Date()
        const row = await req.payload.create({
          collection: MEMBERS as never,
          data: { link, user: account, status: 'confirmed', confirmedAt: now.toISOString(), addedBy: by } as never,
          overrideAccess: true,
          req,
        })
        made.rows.push(String(row.id))
        if (!mine) {
          // The asker confirms from their own email too, now that the other account has said yes.
          const own = newToken()
          const hours = opts.confirmHours
          const ownRow = await req.payload.create({
            collection: MEMBERS as never,
            data: { link, user: by, status: 'requested', tokenHash: hashToken(own), tokenExpires: new Date(now.getTime() + hours * 3_600_000).toISOString(), addedBy: by } as never,
            overrideAccess: true,
            req,
          })
          made.rows.push(String(ownRow.id))
          await opts.sendEmail({
            payload: req.payload,
            to: String(asker.email),
            subject: 'Confirm linking your accounts',
            text: `${labelOf(invited)} agreed to link with ${labelOf(asker)}, so one person can switch between them.\n\nConfirm from your side here within ${hours} hours:\n${confirmLink(req, opts, own)}\n\nIf you didn’t ask for this, ignore this email: nothing is linked without it.`,
          })
        }
      })
    } catch (error) {
      // Someone linked one of these accounts a moment ago, or the email didn't go: undo what this made.
      req.payload.logger.warn({ err: error }, 'Hats: link confirmation not recorded')
      await asPlugin(req, async () => {
        req.context = { ...req.context, hatsDissolving: true }
        for (const id of made.rows) await req.payload.delete({ collection: MEMBERS as never, where: { id: { equals: id } }, overrideAccess: true, req })
        if (made.link) await req.payload.delete({ collection: LINKS as never, where: { id: { equals: made.link } }, overrideAccess: true, req })
      })
        .catch((err) => req.payload.logger.warn({ err }, 'Hats: link confirmation clean-up skipped'))
        .finally(() => {
          req.context.hatsDissolving = undefined
        })
      return bad()
    }
    if (made.link) await opts.onEvent?.({ type: 'link-requested', req, link: made.link, by, account })
    await opts.onEvent?.({ type: 'link-confirmed', payload: req.payload, link: existing ?? made.link!, account })
    return thanks()
  },
}

/** POST /api/hats/unlink { account? }: take an account (default: the acting one) out of the set. Self-serve, at once. */
const unlink: Endpoint = {
  path: '/hats/unlink',
  method: 'post',
  handler: async (req) => {
    await addDataAndFileToRequest(req)
    const { opts, full, person } = await actor(req)
    await blockedReason(req, opts)
    const me = String(full.id)
    const account = String((req.data as { account?: unknown } | undefined)?.account ?? me)
    const mine = await membershipOf(req, me)
    const theirs = account === me ? mine : await membershipOf(req, account)
    // Another account still waiting to confirm is hidden from the set, so it answers as if it weren't there.
    if (!mine || !theirs || idOf(mine.link) !== idOf(theirs.link) || (account !== me && theirs.status === 'requested')) refuse('That account isn’t in your linked set.', 404, 'notInSet')
    const link = idOf(theirs!.link)
    await asPlugin(req, () => req.payload.delete({ collection: MEMBERS as never, id: theirs!.id, overrideAccess: true, req }))
    await opts.onEvent?.({ type: 'unlinked', payload: req.payload, link, account, by: me })
    // If this session was switched in through the account just removed, it ended with the unlink.
    return json({ ok: true, signedOut: account === me ? person !== me : person === account })
  },
}

export const hatEndpoints: Endpoint[] = [me, switchHat, requestLink, confirmPage, confirm, unlink]
export { revokeSessions }
