/**
 * The switcher's decisions, kept apart from React so they can be tested on their own: which hat is worn, how the
 * groups and rows are ordered, which hats ask for a code, what the trigger says, where focus goes, and the note
 * kept across the reload after a switch.
 */
import type { HatsMenu, MenuHat } from './api.js'

export type SignedInMenu = Extract<HatsMenu, { signedIn: true }>

/** What a site can say about one account, to head its group (for example its job: "Maintainer account"). */
export type AccountInfo = { id: string | number; label: string; hats: MenuHat[]; current: boolean }

export type SwitcherOptions = {
  /** The heading for an account's group. Default: "This account" for the current one, "Linked account" for others. */
  accountTitle?: (account: AccountInfo) => string
  /**
   * One helper line under each hat: by hat id, or a function of the hat and its account (so the same hat can read
   * differently on different accounts). A hat with none shows no line.
   */
  hatHelp?: HatHelp
  /** The order of hats inside a group. Default: as the site gives them, with hats that ask for a code last. */
  orderHats?: (hats: MenuHat[]) => MenuHat[]
}

export type HatHelp = Record<string, string> | ((hat: MenuHat, account: AccountInfo) => string | null | undefined)

/** The helper line for one hat on one account's group, if the site gave one. */
export function helpLine(help: HatHelp | undefined, hat: MenuHat, group: Group): string | undefined {
  if (!help) return undefined
  const line = typeof help === 'function' ? help(hat, { id: group.id, label: group.email, hats: group.hats, current: group.current }) : help[hat.id]
  return line || undefined
}

export type Group = {
  /** Undefined for the current account (a switch without `account` stays on it). */
  account: string | number | undefined
  id: string | number
  title: string
  email: string
  current: boolean
  hats: MenuHat[]
  /** The account's narrowest hat, as the site gave it (before ordering): where "Back to …" goes. */
  first: MenuHat | undefined
}

/** A hat that asks for a code, or that the site marks sensitive, sits after the ones that don't. */
export const isSensitive = (h: MenuHat) => h.needsCode || h.sensitive === true

/** Default order: as given, with sensitive hats after the others. Stable, so the site's own order holds inside each part. */
export const defaultOrder = (hats: MenuHat[]) => [...hats.filter((h) => !isSensitive(h)), ...hats.filter(isSensitive)]

/** The hat worn now: the menu's hat, or the account's full set (the last hat) for a plain sign-in. */
export const currentHatOf = (menu: SignedInMenu): MenuHat | undefined => menu.hats.find((h) => h.id === menu.hat) ?? menu.hats.at(-1)


/** The groups, current account first, then linked accounts in the order the server gives. */
export function groupsOf(menu: SignedInMenu, opts: SwitcherOptions = {}, words: { accountThis: string; accountLinked: string } = { accountThis: 'This account', accountLinked: 'Linked account' }): Group[] {
  const order = opts.orderHats ?? defaultOrder
  const title = opts.accountTitle ?? ((a: AccountInfo) => (a.current ? words.accountThis : words.accountLinked))
  const one = (id: string | number, email: string, hats: MenuHat[], current: boolean): Group => ({
    account: current ? undefined : id,
    id,
    title: title({ id, label: email, hats, current }),
    email,
    current,
    hats: order(hats),
    first: hats[0],
  })
  return [one(menu.account.id, menu.account.label, menu.hats, true), ...menu.linked.map((l) => one(l.id, l.label, l.hats, false))]
}

/** What tapping a row does: nothing for the hat worn now, the code screen for one that asks, else switch at once. */
export function actionFor(group: Group, hat: MenuHat, current: MenuHat | undefined): 'none' | 'code' | 'switch' {
  if (group.current && current && hat.id === current.id) return 'none'
  return hat.needsCode ? 'code' : 'switch'
}

/**
 * The narrowest hat on the current account, offered as "Back to …" when the hat worn is above it. Null when already
 * there or when the narrowest would itself ask for a code.
 */
export function backHat(menu: SignedInMenu): MenuHat | null {
  const first = menu.hats[0]
  const current = currentHatOf(menu)
  if (!first || !current || first.id === current.id || first.needsCode) return null
  return first
}

/** Trigger words, at most `max` characters, cut with an ellipsis. */
export const clip = (s: string, max = 24) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`)

/** A stable element id for one hat's radio, so the code screen can hand focus back to it. */
export const radioId = (base: string, account: string | number | undefined, hat: string) =>
  `${base}-r-${String(account ?? 'self').replace(/[^A-Za-z0-9_-]/g, '_')}-${hat.replace(/[^A-Za-z0-9_-]/g, '_')}`

/**
 * Where focus goes after an action: back to the hat's radio when the code screen is left with Cancel, to the
 * trigger when the panel closes, and to the code box when the code screen opens.
 */
export function focusAfter(action: 'cancel-code' | 'close' | 'open-code', ids: { trigger: string; radio: string; code: string }): string {
  if (action === 'cancel-code') return ids.radio
  if (action === 'open-code') return ids.code
  return ids.trigger
}

/**
 * A typed or pasted code, ready to send: spaces removed, and dashes too for the numeric code ("123 456" and
 * "123-456" both become "123456"). Recovery codes (`otherWay`) keep their dashes. Not capped; the server decides.
 */
export const cleanCode = (raw: string, otherWay = false) => raw.replace(otherWay ? /\s+/g : /[\s-]+/g, '')

/** The note kept across the reload after a switch, read once by the next page. */
export type SwitchedNote = { hat: string; back: { id: string; label: string } | null; at: number }
export const NOTE_KEY = 'hats:switched'
/** A note older than this is stale (a switch that never reloaded, or a tab left for later) and is dropped. */
export const NOTE_MAX_AGE_MS = 60_000

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function saveNote(store: Store | undefined, note: Omit<SwitchedNote, 'at'>, now = Date.now()) {
  try {
    store?.setItem(NOTE_KEY, JSON.stringify({ ...note, at: now }))
  } catch {
    // Storage full or blocked: the switch still happened, there's just no note.
  }
}

/**
 * Reads the note. By default it's removed, so it shows once; `keep` leaves it for whoever shows it to remove
 * (a page that mounts twice, or is replaced before the note appears, must not lose it). Anything malformed or stale
 * is dropped.
 */
export function takeNote(store: Store | undefined, now = Date.now(), keep = false): SwitchedNote | null {
  try {
    const raw = store?.getItem(NOTE_KEY)
    if (!raw) return null
    const n = JSON.parse(raw) as Partial<SwitchedNote>
    const bad = typeof n.hat !== 'string' || typeof n.at !== 'number' || now - n.at > NOTE_MAX_AGE_MS || n.at > now + 5_000
    if (!keep || bad) store?.removeItem(NOTE_KEY)
    if (bad) return null
    if (typeof n.hat !== 'string' || typeof n.at !== 'number') return null
    const back = n.back && typeof n.back.id === 'string' && typeof n.back.label === 'string' ? { id: n.back.id, label: n.back.label } : null
    return { hat: n.hat, back, at: n.at }
  } catch {
    try {
      store?.removeItem(NOTE_KEY)
    } catch {
      // Nothing more to do.
    }
    return null
  }
}

/** Removes the note once it has been shown. */
export function dropNote(store: Store | undefined) {
  try {
    store?.removeItem(NOTE_KEY)
  } catch {
    // Storage blocked: nothing was kept anyway.
  }
}

/** This tab's sessionStorage, or nothing where there is none (server render, storage blocked). */
export const session = (): Store | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}
