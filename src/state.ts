import { createHash, randomBytes } from 'node:crypto'

import type { Payload, PayloadRequest } from 'payload'

import type { HatsState, HatsUser, ResolvedHatsOptions } from './types.js'

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
 * The marks the plugin puts on its own writes. They live in a map only this module holds, keyed by the request
 * object, so code outside the plugin can't set them: nothing in `context` (which any server code can pass) counts.
 * Payload's Local API keeps the same request object through nested calls and hooks when `req` is passed, which every
 * plugin write does. (Symbol keys on `context` don't work: Payload treats a context with only symbol keys as empty.)
 */
export const INTERNAL: unique symbol = Symbol('hats: the plugin itself')
export const DISSOLVING: unique symbol = Symbol('hats: dissolving a set')
type Mark = typeof INTERNAL | typeof DISSOLVING
const marks = new WeakMap<object, Map<Mark, number>>()

const has = (req: PayloadRequest | undefined, mark: Mark) => Boolean(req && (marks.get(req)?.get(mark) ?? 0) > 0)
export const isInternal = (req: PayloadRequest) => has(req, INTERNAL)
export const isDissolving = (req: PayloadRequest) => has(req, DISSOLVING)

/** Runs `fn` with the request carrying `mark`, then takes the mark off again. Nested and parallel calls count up. */
export async function withMark<T>(req: PayloadRequest, mark: Mark, fn: () => Promise<T>): Promise<T> {
  const held = marks.get(req) ?? new Map<Mark, number>()
  marks.set(req, held)
  held.set(mark, (held.get(mark) ?? 0) + 1)
  try {
    return await fn()
  } finally {
    held.set(mark, (held.get(mark) ?? 1) - 1)
  }
}

/** Runs `fn` with the request marked as the plugin's own, then puts the mark back as it was. */
export const asPlugin = <T>(req: PayloadRequest, fn: () => Promise<T>): Promise<T> => withMark(req, INTERNAL, fn)

export const idOf = (v: unknown) => String(v && typeof v === 'object' && 'id' in v ? (v as { id: unknown }).id : v)
export type { HatsUser }
