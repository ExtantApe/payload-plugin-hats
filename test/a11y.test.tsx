// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultText, type MenuHat } from '../src/client/api.js'
import * as clientEntry from '../src/client/index.js'
import { LinkedAccounts } from '../src/client/LinkedAccounts.js'
import { SwitcherView } from '../src/client/HatSwitcher.js'
import { backHat, currentHatOf, groupsOf, saveNote, session, type SignedInMenu } from '../src/client/model.js'
import { HatsSwitchedNote } from '../src/client/SwitchedNote.js'
import { css, linkedCss } from '../src/client/styles.js'

const hat = (id: string, label: string, needsCode = false): MenuHat => ({ id, label, needsCode, sensitive: needsCode })
const menu: SignedInMenu = {
  signedIn: true,
  account: { id: 'a1', label: 'keeper@example.invalid' },
  signedInAs: 'a1',
  hat: 'member',
  hats: [hat('member', 'Member'), hat('curator', 'Curator', true)],
  linked: [{ id: 'b2', label: 'staff@example.invalid', hats: [hat('member', 'Member')] }],
  link: null,
  set: [],
  canLink: true,
  showSwitch: true,
  maxLinked: 4,
}

const view = (over: Record<string, unknown> = {}, t = defaultText) =>
  render(
    <SwitcherView
      t={t}
      base="hx"
      menu={menu}
      groups={groupsOf(menu, {}, t)}
      current={currentHatOf(menu)}
      back={backHat(menu)}
      busy={null}
      error=""
      asking={null}
      code=""
      codeError=""
      otherWay={false}
      {...over}
    />,
  )

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
  document.documentElement.style.scrollPaddingBottom = ''
  document.body.innerHTML = ''
})

describe('error live region (WCAG 4.1.3)', () => {
  it('is in the DOM while empty, so the first error is announced', () => {
    const { container, rerender } = view()
    const region = container.querySelector('.hats-sw-error')
    expect(region).not.toBeNull()
    expect(region!.getAttribute('role')).toBe('alert')
    expect(region!.textContent).toBe('')
    rerender(<SwitcherView t={defaultText} base="hx" menu={menu} groups={groupsOf(menu)} current={currentHatOf(menu)} back={null} busy={null} error="Nope." asking={null} code="" codeError="" otherWay={false} />)
    expect(container.querySelector('.hats-sw-error')).toBe(region)
    expect(region!.textContent).toBe('Nope.')
  })
  it('stays on the code screen too', () => {
    const { container } = view({ asking: { group: groupsOf(menu)[0], hat: menu.hats[1] } })
    expect(container.querySelector('.hats-sw-error[role="alert"]')).not.toBeNull()
  })
  it('hides when empty with a clip pattern, never display:none', () => {
    const rule = css.match(/\.hats-sw-error:empty\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/clip:rect\(0 0 0 0\)/)
    expect(rule).toMatch(/position:absolute/)
    expect(rule).not.toMatch(/display:\s*none/)
    expect(css).not.toMatch(/\.hats-sw-error[^{]*\{[^}]*display:\s*none/)
  })
})

describe('switching status (WCAG 4.1.3)', () => {
  it('keeps aria-busy on the rows, off the body that holds the status', () => {
    const { container } = view({ busy: 'hx-a' })
    expect(container.querySelector('.hats-sw-body')!.hasAttribute('aria-busy')).toBe(false)
    expect(container.querySelector('.hats-sw-rows')!.getAttribute('aria-busy')).toBe('true')
    const status = container.querySelector('[role="status"]')!
    expect(status.textContent).toBe('Switching…')
    expect(status.closest('[aria-busy]')).toBeNull()
  })
})

describe('the note: dismiss and the banner (WCAG 2.4.3, 2.4.11)', () => {
  const show = async () => {
    saveNote(session(), { hat: 'Curator', back: { id: 'member', label: 'Member' } })
    render(
      <>
        <button className="hats-sw-trigger">Acting as Curator</button>
        <HatsSwitchedNote />
      </>,
    )
    await screen.findByText(/Now acting as Curator/)
  }
  it('moves focus to the trigger after Dismiss', async () => {
    await show()
    const dismiss = screen.getByRole('button', { name: 'Dismiss' })
    dismiss.focus()
    fireEvent.click(dismiss)
    expect(document.activeElement).toBe(document.querySelector('.hats-sw-trigger'))
  })
  it('without a trigger, moves focus to the h1 with tabindex -1, and takes the tabindex off after', async () => {
    saveNote(session(), { hat: 'Curator', back: { id: 'member', label: 'Member' } })
    render(
      <>
        <h1>Dashboard</h1>
        <HatsSwitchedNote />
      </>,
    )
    await screen.findByText(/Now acting as Curator/)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(document.activeElement).toBe(h1)
    expect(h1.getAttribute('tabindex')).toBe('-1')
    ;(document.querySelector('body') as HTMLElement).focus()
    h1.blur()
    expect(h1.hasAttribute('tabindex')).toBe(false)
  })
  it('keeps scroll padding as tall as the banner covers while it shows, and puts it back after', async () => {
    document.documentElement.style.scrollPaddingBottom = '5px'
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: window.innerHeight - 72 } as DOMRect)
    await show()
    expect(document.documentElement.style.scrollPaddingBottom).toBe('72px')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(document.documentElement.style.scrollPaddingBottom).toBe('5px')
    vi.restoreAllMocks()
  })
})

describe('linked accounts focus (WCAG 2.4.3)', () => {
  const linked = {
    ...menu,
    maxLinked: 4,
    set: [
      { id: 'a1', label: 'keeper@example.invalid', status: 'approved', you: true },
      { id: 'b2', label: 'staff@example.invalid', status: 'approved', you: false },
    ],
  }
  const stub = (unlinkOk = true) => {
    let current = linked
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/hats/unlink')) {
          if (!unlinkOk) return new Response(JSON.stringify({ message: 'No.' }), { status: 409 })
          current = { ...linked, set: [linked.set[0]!] }
          return new Response('{}', { status: 200 })
        }
        return new Response(JSON.stringify(current), { status: 200 })
      }),
    )
  }
  it('Unlink focuses the first button of the confirm group; Keep returns to that row’s Unlink', async () => {
    stub()
    render(<LinkedAccounts />)
    const unlink = await screen.findByRole('button', { name: 'Unlink staff@example.invalid' })
    fireEvent.click(unlink)
    const group = screen.getByRole('group')
    await waitFor(() => expect(document.activeElement).toBe(group.querySelector('button')))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    const again = screen.getByRole('button', { name: 'Unlink staff@example.invalid' })
    await waitFor(() => expect(document.activeElement).toBe(again))
  })
  it('after an unlink, focus goes to the list heading', async () => {
    stub()
    render(<LinkedAccounts />)
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink staff@example.invalid' }))
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Unlink' }))
    const heading = screen.getByRole('heading', { name: 'Linked accounts' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(heading.getAttribute('tabindex')).toBe('-1')
  })
  it('after a refusal, focus returns to that row’s Unlink button', async () => {
    stub(false)
    render(<LinkedAccounts />)
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink staff@example.invalid' }))
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Unlink' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Unlink staff@example.invalid' })))
  })
  it('gives its buttons a focus ring from the plugin’s token', () => {
    expect(linkedCss).toMatch(/\.hats-la-btn:focus-visible[^{]*\{outline:var\(--hats-focus,/)
  })
})

describe('borders and targets', () => {
  it('draws the trigger and tag borders with the field token (1.4.11)', () => {
    expect(css).toMatch(/\.hats-sw-trigger\{[^}]*border:1px solid var\(--hats-field,/)
    expect(css).toMatch(/\.hats-sw-tag\{[^}]*border:1px solid var\(--hats-field,/)
  })
  it('gives Use another way a 32px minimum height (2.5.8)', () => {
    expect(css).toMatch(/\.hats-sw-more \.hats-sw-link\{[^}]*min-height:32px/)
  })
})

describe('text props (WCAG 3.1.2 and translation)', () => {
  const marked = Object.fromEntries(
    Object.entries(defaultText).map(([k, v]) => [k, typeof v === 'string' ? `«${k}»` : typeof v === 'function' ? () => `«${k}»` : v]),
  ) as unknown as typeof defaultText
  it('draws no English default in the list view when every text is replaced', () => {
    const { container } = view({ busy: 'hx-x', error: '' }, marked)
    const out = container.textContent! + [...container.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).join(' ')
    for (const word of ['Switch role', 'Close', 'Current', 'Needs a code', 'This account', 'Linked account', 'Switching', 'Back to', 'You are acting']) expect(out).not.toContain(word)
    expect(out).toContain('«accountThis»')
    expect(out).toContain('«accountLinked»')
  })
  it('has an English default for every key the account page and the note read', () => {
    for (const k of ['linkedIntro', 'status', 'unlinkAsk', 'unlinkNamed', 'title', 'close', 'current', 'needsCode', 'backTo', 'confirmTitle', 'confirmBody', 'confirmButton', 'nowActing', 'switchBack', 'dismiss', 'accountThis', 'accountLinked'])
      expect(defaultText).toHaveProperty(k)
  })
})

describe('client entry', () => {
  it('exports HatsSwitchedNote, HatSwitcher and LinkedAccounts', () => {
    expect(typeof clientEntry.HatsSwitchedNote).toBe('function')
    expect(typeof clientEntry.HatSwitcher).toBe('function')
    expect(typeof clientEntry.LinkedAccounts).toBe('function')
  })
})
