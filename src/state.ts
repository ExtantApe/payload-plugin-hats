import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'

import type { Payload, PayloadRequest } from 'payload'

import type { HatsEvent, HatsState, HatsUser, ResolvedHatsOptions } from './types.js'

const KEY = '_hats'

/** Attaches the session's hat state to a user without it ever being serialised into a response. */
export function attachState<T extends object>(user: T, state: HatsState): T {
  Object.defineProperty(user, KEY, { value: state, enumerable: false, configurable: true, writable: false })
  return user
}

/** The hat state of a signed-in user (or request), for audit logs and the site's own checks. */
export function hatsStateOf(userOrReq: unknown): HatsState | null {
  if (!userOrReq || typeof userOrReq !== 'object') return null
  const user = 'payload' in userOrReq && 'user' in userOrReq ? (userOrReq as PayloadRequest).user : userOrReq
  return ((user as Record<string, unknown> | null)?.[KEY] as HatsState | undefined) ?? null
}

export const hatsOptions = (payload: Payload) => payload.config.custom?.hats as ResolvedHatsOptions

export const newToken = () => randomBytes(32).toString('base64url')
export const hashToken = (token: string) => createHash('sha256').update(`hats:${token}`).digest('hex')

/**
 * The marks the plugin puts on its own writes. They live in an async context only this module holds, so code outside
 * the plugin can't set them: nothing in `context` (which any server code can pass) counts. A mark is set for one
 * request object and holds for the code `withMark` runs and everything that code awaits, Payload's hooks included
 * (the Local API keeps the same request object through nested calls and hooks when `req` is passed, which every
 * plugin write does). It ends when that code returns, and code started elsewhere, or by the site from inside it
 * through `unmarked`, never sees it. (Symbol keys on `context` don't work: Payload treats a context with only symbol
 * keys as empty.)
 */
export const INTERNAL: unique symbol = Symbol('hats: the plugin itself')
export const DISSOLVING: unique symbol = Symbol('hats: dissolving a set')
type Mark = typeof INTERNAL | typeof DISSOLVING
type Marks = ReadonlyMap<object, ReadonlySet<Mark>>
const marks = new AsyncLocalStorage<Marks>()

const has = (req: PayloadRequest | undefined, mark: Mark) => Boolean(req && marks.getStore()?.get(req)?.has(mark))
export const isInternal = (req: PayloadRequest) => has(req, INTERNAL)
export const isDissolving = (req: PayloadRequest) => has(req, DISSOLVING)

/** Runs `fn` with the request carrying `mark`. The mark holds only inside `fn`, however it is nested or run alongside. */
export async function withMark<T>(req: PayloadRequest, mark: Mark, fn: () => Promise<T>): Promise<T> {
  const now = new Map(marks.getStore() ?? [])
  now.set(req, new Set([...(now.get(req) ?? []), mark]))
  return await marks.run(now, fn)
}

/** Runs `fn` with the request marked as the plugin's own. */
export const asPlugin = <T>(req: PayloadRequest, fn: () => Promise<T>): Promise<T> => withMark(req, INTERNAL, fn)

/**
 * An id as a relationship to `slug` stores it: a number where that collection's ids are numbers (SQL adapters by
 * default, or a custom number id), otherwise as it is. The plugin compares ids as strings, so every id it writes
 * into a relationship goes through this first.
 */
export function relId(payload: Payload, slug: string, v: unknown): string | number | null {
  if (v == null) return null
  const id = idOf(v)
  const type = (payload.collections as Record<string, { customIDType?: string } | undefined>)[slug]?.customIDType ?? payload.db.defaultIDType
  return type === 'number' && /^-?\d+(\.\d+)?$/.test(id) ? Number(id) : id
}

/**
 * Runs one of the site's own callbacks with the plugin's marks off the request, so nothing the site does from it
 * passes as the plugin. The marks come back afterwards.
 */
export async function unmarked<T>(req: PayloadRequest | undefined, fn: () => T | Promise<T>): Promise<T> {
  const held = marks.getStore()
  if (!req || !held?.has(req)) return await fn()
  const now = new Map(held)
  now.delete(req)
  return await marks.run(now, fn)
}

/**
 * Runs `fn` after every earlier `serial` call on the same request has finished. Payload deletes the documents of a
 * bulk delete side by side on one request; the plugin's clean-up after each account runs one at a time, so two
 * accounts leaving one set together can't each see the other still there.
 */
const queues = new WeakMap<object, Promise<unknown>>()
export function serial<T>(req: PayloadRequest, fn: () => Promise<T>): Promise<T> {
  const before = queues.get(req) ?? Promise.resolve()
  const run = before.then(fn, fn)
  queues.set(
    req,
    run.catch(() => undefined),
  )
  return run
}

/** The longest the plugin waits for the site's `onEvent` handler; it carries on unwaited after. */
export const TELL_MS = 2000

/** An error's name for the log, only when it's a short plain word; anything else, or a name that throws, is `Error`. */
export function safeName(error: unknown): string {
  try {
    const name = (error as { name?: unknown } | null | undefined)?.name
    return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : typeof error === 'object' && error ? 'Error' : typeof error
  } catch {
    return 'Error'
  }
}

/**
 * Tells the site about an event once the change is made. The handler runs unmarked. One that throws is logged by its
 * error's name only (a message can carry what the event was about) and skipped, and one still running after
 * `TELL_MS` is left to finish unwaited, so a handler can never block or undo what already happened.
 */
export async function tell(payload: Payload, req: PayloadRequest | undefined, event: HatsEvent) {
  const onEvent = hatsOptions(payload).onEvent
  if (!onEvent) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), TELL_MS)
  })
  const run = unmarked(req, () => onEvent(event)).then(
    () => 'ok' as const,
    (error: unknown) => {
      payload.logger.error({ msg: `Hats: an onEvent handler failed on ${event.type} (${safeName(error)})` })
      return 'failed' as const
    },
  )
  try {
    if ((await Promise.race([run, late])) === 'late') payload.logger.warn({ msg: `Hats: an onEvent handler on ${event.type} is still running; the plugin didn't wait for it` })
  } finally {
    clearTimeout(timer)
  }
}

/** Link requests still working after their answer, so tests (and a graceful shutdown) can wait for them. */
const working = new Set<Promise<unknown>>()
export function trackWork(p: Promise<unknown>) {
  working.add(p)
  void p.finally(() => working.delete(p))
}
/** Resolves once every link request's work has finished, including any started meanwhile. */
export async function linkWorkSettled() {
  while (working.size) await Promise.allSettled([...working])
}

export const idOf = (v: unknown) => String(v && typeof v === 'object' && 'id' in v ? (v as { id: unknown }).id : v)
export type { HatsUser }
