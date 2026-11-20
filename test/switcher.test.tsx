import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { defaultText, type MenuHat } from '../src/client/api.js'
import { SwitcherView, type SwitcherViewProps } from '../src/client/HatSwitcher.js'
import { HatsSwitchedNote } from '../src/client/SwitchedNote.js'
import { actionFor, backHat, clip, currentHatOf, defaultOrder, dropNote, focusAfter, groupsOf, helpLine, NOTE_KEY, radioId, saveNote, takeNote, type SignedInMenu } from '../src/client/model.js'
import { css } from '../src/client/styles.js'

const hat = (id: string, label: string, needsCode = false, sensitive = needsCode): MenuHat => ({ id, label, needsCode, sensitive })

const menu = (over: Partial<SignedInMenu> = {}): SignedInMenu => ({
  signedIn: true,
  account: { id: 'a1', label: 'keeper@example.invalid' },
  signedInAs: 'a1',
  hat: 'author',
  hats: [hat('member', 'Member'), hat('curator', 'Curator', true), hat('author', 'Author'), hat('all', 'All my roles', true)],
  linked: [{ id: 'b2', label: 'staff@example.invalid', hats: [hat('member', 'Member'), hat('tenant-admin', 'Administrator', true)] }],
  link: 'l1',
  set: [],
  canLink: true,
  showSwitch: true,
  maxLinked: 4,
  ...over,
})

const store = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
}

const view = (over: Partial<SwitcherViewProps> = {}) => {
  const m = over.menu ?? menu()
  const groups = groupsOf(m, { accountTitle: (a) => (a.current ? 'Keeper account' : 'Staff account') })
  const html = renderToStaticMarkup(
    <SwitcherView
      t={defaultText}
      base="hx"
      menu={m}
      groups={groups}
      current={currentHatOf(m)}
      back={backHat(m)}
      selected=""
      busy={null}
      error=""
      asking={null}
      code=""
      codeError=""
      otherWay={false}
      hatHelp={{ member: 'Browse and keep animals.', curator: 'Review contributions.' }}
      {...over}
    />,
  )
  return { html, groups, doc: new DOMParserLite(html) }
}

/** Just enough parsing for these checks, without a DOM library. */
class DOMParserLite {
  constructor(readonly html: string) {}
  count(re: RegExp) {
    return (this.html.match(re) ?? []).length
  }
}

describe('order', () => {
  it('puts the current account first and keeps the server’s order for linked accounts', () => {
    const g = groupsOf(menu({ linked: [{ id: 'b2', label: 'b', hats: [] }, { id: 'c3', label: 'c', hats: [] }] }))
    expect(g.map((x) => x.id)).toEqual(['a1', 'b2', 'c3'])
    expect(g[0]).toMatchObject({ current: true, account: undefined, title: 'This account' })
    expect(g[1]).toMatchObject({ current: false, account: 'b2', title: 'Linked account' })
  })

  it('lists safe hats in the site’s order, then sensitive ones', () => {
    expect(defaultOrder(menu().hats).map((h) => h.id)).toEqual(['member', 'author', 'curator', 'all'])
    // A hat with a code remembered is still sensitive, so it stays with the others that need care.
    expect(defaultOrder([hat('curator', 'Curator', false, true), hat('member', 'Member')]).map((h) => h.id)).toEqual(['member', 'curator'])
  })

  it('takes the site’s titles and order', () => {
    const g = groupsOf(menu(), { accountTitle: (a) => `${a.hats.at(-1)!.label} account`, orderHats: (h) => [...h].reverse() })
    expect(g[0]!.title).toBe('All my roles account')
    expect(g[0]!.hats[0]!.id).toBe('all')
    expect(g[0]!.first!.id).toBe('member')
  })
})

describe('what a tap does', () => {
  const m = menu()
  const [mine, theirs] = groupsOf(m)
  const current = currentHatOf(m)

  it('does nothing on the hat worn now, opens the code screen for a hat that asks, and switches a safe one', () => {
    expect(actionFor(mine!, hat('author', 'Author'), current)).toBe('none')
    expect(actionFor(mine!, hat('curator', 'Curator', true), current)).toBe('code')
    expect(actionFor(mine!, hat('member', 'Member'), current)).toBe('switch')
  })

  it('treats the same hat on another account as a switch', () => {
    expect(actionFor(theirs!, hat('author', 'Author'), current)).toBe('switch')
    expect(actionFor(theirs!, hat('tenant-admin', 'Administrator', true), current)).toBe('code')
  })

  it('gates on needsCode alone, so a remembered code switches at once', () => {
    expect(actionFor(mine!, hat('curator', 'Curator', false, true), current)).toBe('switch')
  })

  it('reads a plain sign-in as wearing the last hat', () => {
    expect(currentHatOf(menu({ hat: null }))!.id).toBe('all')
  })
})

describe('helper lines', () => {
  it('take a map by hat id or a function of the hat and its account', () => {
    const [mine, theirs] = groupsOf(menu())
    expect(helpLine({ member: 'Browse.' }, hat('member', 'Member'), mine!)).toBe('Browse.')
    expect(helpLine({}, hat('member', 'Member'), mine!)).toBeUndefined()
    const fn = (h: MenuHat, a: { current: boolean }) => `${h.label} on ${a.current ? 'mine' : 'theirs'}`
    expect(helpLine(fn, hat('member', 'Member'), theirs!)).toBe('Member on theirs')
    expect(helpLine(() => '', hat('member', 'Member'), mine!)).toBeUndefined()
  })
})

describe('back to Member', () => {
  it('is offered above Member only', () => {
    expect(backHat(menu())!.id).toBe('member')
    expect(backHat(menu({ hat: 'member' }))).toBeNull()
    expect(backHat(menu({ hat: null }))!.id).toBe('member')
  })
  it('is not offered when the narrowest hat would itself ask for a code', () => {
    expect(backHat(menu({ hats: [hat('curator', 'Curator', true), hat('all', 'All', true)], hat: 'all' }))).toBeNull()
  })
})

describe('the trigger', () => {
  it('keeps to 24 characters', () => {
    expect(clip(defaultText.trigger('Author'))).toBe('Acting as Author')
    const long = clip(defaultText.trigger('Maintainer (all my roles)'))
    expect(long.length).toBeLessThanOrEqual(24)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('radio semantics', () => {
  it('draws a fieldset and legend per account, with the job label and the email under it', () => {
    const { html, doc } = view()
    expect(doc.count(/<fieldset/g)).toBe(2)
    expect(doc.count(/<legend>/g)).toBe(2)
    expect(html).toMatch(/<legend><span class="hats-sw-acct">Keeper account<\/span><span class="hats-sw-email">keeper@example.invalid<\/span><\/legend>/)
    expect(html.indexOf('Keeper account')).toBeLessThan(html.indexOf('Staff account'))
  })

  it('gives each hat a native radio with a label, one name per account, helper lines tied by aria-describedby', () => {
    const { html, doc } = view()
    expect(doc.count(/type="radio"/g)).toBe(6)
    expect(doc.count(/name="hx-acct-a1"/g)).toBe(4)
    expect(doc.count(/name="hx-acct-b2"/g)).toBe(2)
    const rid = radioId('hx', undefined, 'member')
    expect(html).toContain(`<label class="hats-sw-row" for="${rid}">`)
    expect(html).toContain(`aria-describedby="${rid}-help"`)
    expect(html).toContain(`id="${rid}-help" class="hats-sw-help">Browse and keep animals.`)
  })

  it('keeps the current hat focusable and marks it with the word Current', () => {
    const { html } = view()
    expect(html).not.toMatch(/disabled/)
    expect(html).toMatch(/data-current="true"[^>]*for="hx-r-self-author"/)
    // "Current" twice: the top block and the row. No check mark stands in for it.
    expect(html.match(/>Current</g)).toHaveLength(2)
    expect(html).not.toContain('✓')
  })

  it('tags each hat that asks for a code with a lock and the words, never on the current hat', () => {
    const { html } = view()
    expect(html.match(/Needs a code/g)).toHaveLength(3)
    expect(html.match(/<svg aria-hidden="true"/g)).toHaveLength(3)
  })

  it('orders inside a group: Member, Author, then sensitive hats', () => {
    const { html } = view()
    const at = (id: string) => html.indexOf(`value="${id}"`)
    expect(at('member')).toBeLessThan(at('author'))
    expect(at('author')).toBeLessThan(at('curator'))
    expect(at('curator')).toBeLessThan(at('all'))
  })

  it('shows the hat worn now with its account and helper line, and Back to Member above Member', () => {
    const { html } = view({ menu: menu({ hat: 'curator' }) })
    expect(html).toMatch(/You are acting as<\/p><p class="hats-sw-now-hat"><span>Curator<\/span>/)
    expect(html).toContain('Review contributions.')
    expect(html).toContain('Back to Member')
    expect(view({ menu: menu({ hat: 'member' }) }).html).not.toContain('Back to')
  })

  it('names the dialog by its title', () => {
    expect(view().html).toContain('<h2 class="hats-sw-title" id="hx-title">Switch role</h2>')
  })

  it('shows Switching… on the row being switched', () => {
    const rid = radioId('hx', 'b2', 'member')
    const { html } = view({ busy: rid })
    expect(html).toContain('Switching…')
    expect(html).toContain('aria-busy="true"')
  })
})

describe('the code screen', () => {
  const m = menu()
  const groups = groupsOf(m, { accountTitle: (a) => (a.current ? 'Keeper account' : 'Maintainer account') })
  const asking = { group: groups[1]!, hat: hat('tenant-admin', 'Administrator', true) }

  it('asks plainly, names the hat and the account, and offers Switch and Cancel', () => {
    const { html } = view({ groups, asking })
    expect(html).toContain('Confirm it’s you')
    expect(html).toContain('Enter the 6-digit code from your authenticator app to act as Administrator on the Maintainer account.')
    expect(html).toContain('>Switch to Administrator<')
    expect(html).toContain('>Cancel<')
    expect(html).toContain('autoComplete="one-time-code"')
    expect(html).not.toContain('Use another way')
  })

  it('marks a wrong code with aria-invalid and points to the message', () => {
    const { html } = view({ groups, asking, codeError: 'That code didn’t work. Try a new one.' })
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby="hx-code-help hx-code-err"')
    expect(html).toMatch(/id="hx-code-err" class="hats-sw-error" role="alert">That code didn’t work/)
    expect(view({ groups, asking }).html).not.toContain('aria-invalid')
  })

  it('offers another way only when the site describes one, and then takes a longer code', () => {
    expect(view({ groups, asking, anotherWay: 'Use a recovery code.' }).html).toContain('Use another way')
    const { html } = view({ groups, asking, anotherWay: 'Use a recovery code.', otherWay: true })
    expect(html).toContain('Use a recovery code.')
    expect(html).toContain('inputMode="text"')
    expect(html).toContain('aria-describedby="hx-code-help hx-other"')
  })

  it('says this account in its own words when the site gives no title', () => {
    expect(defaultText.confirmBody('Curator', 'This account')).toMatch(/as Curator on this account\.$/)
  })
})

describe('focus', () => {
  const ids = { trigger: 't', radio: 'r', code: 'c' }
  it('goes back to the hat’s radio on Cancel, to the trigger on close, and to the code box when it opens', () => {
    expect(focusAfter('cancel-code', ids)).toBe('r')
    expect(focusAfter('close', ids)).toBe('t')
    expect(focusAfter('open-code', ids)).toBe('c')
  })
  it('makes radio ids that stay valid for any account id', () => {
    expect(radioId('hx', 'a b/c', 'tenant-admin')).toBe('hx-r-a_b_c-tenant-admin')
    expect(radioId('hx', undefined, 'member')).toBe('hx-r-self-member')
  })
})

describe('the note after a switch', () => {
  it('survives one reload and shows once', () => {
    const s = store()
    saveNote(s, { hat: 'Curator', back: { id: 'member', label: 'Member' } }, 1000)
    expect(takeNote(s, 2000)).toEqual({ hat: 'Curator', back: { id: 'member', label: 'Member' }, at: 1000 })
    expect(takeNote(s, 2000)).toBeNull()
  })
  it('can be read without removing it, until it is shown', () => {
    const s = store()
    saveNote(s, { hat: 'Author', back: { id: 'member', label: 'Member' } }, 1000)
    expect(takeNote(s, 2000, true)?.hat).toBe('Author')
    expect(takeNote(s, 2000, true)?.hat).toBe('Author')
    dropNote(s)
    expect(takeNote(s, 2000, true)).toBeNull()
    saveNote(s, { hat: 'Author', back: null }, 0)
    expect(takeNote(s, 61_000, true)).toBeNull()
    expect(s.m.size).toBe(0)
  })

  it('drops a stale, future or malformed note', () => {
    const s = store()
    saveNote(s, { hat: 'Curator', back: null }, 0)
    expect(takeNote(s, 61_000)).toBeNull()
    saveNote(s, { hat: 'Curator', back: null }, 100_000)
    expect(takeNote(s, 0)).toBeNull()
    s.setItem(NOTE_KEY, '{nope')
    expect(takeNote(s)).toBeNull()
    s.setItem(NOTE_KEY, JSON.stringify({ hat: 3, at: Date.now() }))
    expect(takeNote(s)).toBeNull()
  })
  it('keeps going when storage refuses', () => {
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') }, removeItem: () => undefined }
    expect(() => saveNote(broken, { hat: 'x', back: null })).not.toThrow()
    expect(takeNote(broken)).toBeNull()
  })
})

describe('the note on the page', () => {
  it('draws an empty status region first, so the note is announced when it arrives', () => {
    const html = renderToStaticMarkup(<HatsSwitchedNote />)
    expect(html).toContain('<div role="status"></div>')
  })
  it('words the note and the way back', () => {
    expect(defaultText.nowActing('Curator')).toBe('Now acting as Curator.')
    expect(defaultText.switchBack('Member')).toBe('Switch back to Member.')
  })
})

describe('theme', () => {
  it('uses no fixed colors', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/rgb\(/)
  })
  it('is a bottom sheet under 640px, 85dvh at most, with room for the safe area, and a 360px popover above', () => {
    expect(css).toMatch(/@media \(max-width:639\.98px\)\{[^@]*max-height:85dvh[^@]*env\(safe-area-inset-bottom\)/)
    expect(css).toMatch(/\.hats-sw-panel\{position:absolute[^}]*width:360px;max-width:90vw/)
  })
})
