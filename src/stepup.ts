import type { PayloadRequest } from 'payload'

import type { Hat, HatsUser, ResolvedHatsOptions } from './types.js'

/** The key a good code is remembered under: the linked set with `rememberPer: 'set'` (when the account is in one), else the account. */
export const memoryKey = (opts: ResolvedHatsOptions, account: string, set: string | null) => (opts.stepUp?.rememberPer === 'set' && set ? `set:${set}` : account)

/** Whether a good code was given recently enough to count. */
export const remembered = (opts: ResolvedHatsOptions, steppedUp: Record<string, string> | null | undefined, account: string, set: string | null) => {
  const at = steppedUp?.[memoryKey(opts, account, set)]
  return Boolean(at && Date.now() - new Date(at).getTime() < (opts.stepUp?.rememberMinutes ?? 180) * 60_000)
}

/**
 * Does moving to `hat` on `target` need a code (before any memory is taken into account)? Without `stepUpWhen` that is
 * the hat's `sensitive` flag. With it, the site's answer decides, and only an exact `false` skips the code: `true`, a
 * throw, a rejection or any other answer (`'no'`, `0`, `undefined`) asks.
 */
export async function needsStepUp(
  opts: ResolvedHatsOptions,
  args: { req: PayloadRequest; from: { user: HatsUser; hat: string | null }; target: HatsUser; hats: Hat[]; hat: Hat },
): Promise<boolean> {
  const when = opts.stepUpWhen
  if (!when) return Boolean(args.hat.sensitive)
  try {
    // The target as it would be worn: the account's last hat is all of its roles, so nothing is narrowed.
    const user = args.hat.id === args.hats.at(-1)?.id ? args.target : opts.wear(args.target, args.hat.id)
    const answer = await when({ req: args.req, from: args.from, to: { user, hat: args.hat.id } })
    return answer !== false
  } catch {
    return true
  }
}
