'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { defaultText, hatsApi, type HatsMenu, type HatsText, type MenuHat } from './api.js'
import { actionFor, backHat, cleanCode, clip, currentHatOf, focusAfter, groupsOf, helpLine, radioId, saveNote, session, type Group, type HatHelp, type SignedInMenu, type SwitchedNote, type SwitcherOptions } from './model.js'
import { css } from './styles.js'
import { HatsSwitchedNote } from './SwitchedNote.js'

export type HatSwitcherProps = SwitcherOptions & {
  apiRoute?: string
  /** Called after a switch instead of reloading the page (for example, to go where the new hat belongs). */
  onSwitched?: () => void
  text?: Partial<HatsText>
  /**
   * Help shown on the code screen under "Use another way", for the site's other ways to give a code (a recovery
   * code, say). Leave it out and the link isn't shown.
   */
  anotherWay?: string
  /** How long the "Now acting as" note stays, in milliseconds. Default 5000; it waits while hovered or focused. */
  noteMs?: number
}

type Asking = { group: Group; hat: MenuHat }
type Text = HatsText

const PHONE = '(max-width: 639.98px)'

const Lock = () => (
  <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
)

/** The props the panel needs to draw itself. Exported for tests; sites use `HatSwitcher`. */
export type SwitcherViewProps = {
  t: Text
  base: string
  menu: SignedInMenu
  groups: Group[]
  current: MenuHat | undefined
  back: MenuHat | null
  busy: string | null
  error: string
  asking: Asking | null
  code: string
  codeError: string
  otherWay: boolean
  anotherWay?: string
  hatHelp?: HatHelp
  onRowClick?: (group: Group, hat: MenuHat) => void
  onBack?: () => void
  onClose?: () => void
  onCode?: (code: string) => void
  onSubmitCode?: () => void
  onCancelCode?: () => void
  onOtherWay?: () => void
}

/** The panel: the hat worn now, a group per account with a button per hat, or the code screen. */
export function SwitcherView(p: SwitcherViewProps) {
  const { t, base, groups, current, back, busy, asking } = p
  const currentGroup = groups[0]!
  const ids = { title: `${base}-title`, code: `${base}-code`, close: `${base}-close`, codeHelp: `${base}-code-help`, codeErr: `${base}-code-err`, other: `${base}-other` }
  const help = (h: MenuHat, g: Group = currentGroup) => helpLine(p.hatHelp, h, g)

  if (asking) {
    const { group, hat } = asking
    const working = busy === 'code'
    return (
      <>
        <div className="hats-sw-head">
          <h2 className="hats-sw-title" id={ids.title}>
            {t.confirmTitle}
          </h2>
          <button type="button" id={ids.close} className="hats-sw-close" aria-label={t.close} onClick={p.onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <form
          className="hats-sw-body hats-sw-code"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            p.onSubmitCode?.()
          }}
        >
          <p id={ids.codeHelp}>{t.confirmBody(hat.label, group.title)}</p>
          <label htmlFor={ids.code}>{t.codeField}</label>
          <input
            id={ids.code}
            className="hats-sw-input"
            value={p.code}
            onChange={(e) => p.onCode?.(e.target.value)}
            autoComplete="one-time-code"
            inputMode={p.otherWay ? 'text' : 'numeric'}
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={p.codeError ? true : undefined}
            aria-describedby={[ids.codeHelp, p.codeError ? ids.codeErr : null, p.otherWay && p.anotherWay ? ids.other : null].filter(Boolean).join(' ')}
          />
          <p id={ids.codeErr} className="hats-sw-error" role="alert">
            {p.codeError}
          </p>
          {p.anotherWay ? (
            p.otherWay ? (
              <p id={ids.other} className="hats-sw-help hats-sw-more">
                {p.anotherWay}
              </p>
            ) : (
              <p className="hats-sw-more">
                <button type="button" className="hats-sw-link" onClick={p.onOtherWay}>
                  {t.anotherWay}
                </button>
              </p>
            )
          ) : null}
          <div className="hats-sw-actions">
            <button type="submit" className="hats-sw-btn" data-primary="true" aria-disabled={working || undefined}>
              {working ? t.switching : t.confirmButton(hat.label)}
            </button>
            <button type="button" className="hats-sw-btn" onClick={p.onCancelCode}>
              {t.cancel}
            </button>
          </div>
        </form>
      </>
    )
  }

  return (
    <>
      <div className="hats-sw-head">
        <h2 className="hats-sw-title" id={ids.title}>
          {t.title}
        </h2>
        <button type="button" id={ids.close} className="hats-sw-close" aria-label={t.close} onClick={p.onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className="hats-sw-body" aria-busy={busy ? true : undefined}>
        {current ? (
          <div className="hats-sw-now">
            <p className="hats-sw-now-label">{t.actingNow}</p>
            <p className="hats-sw-now-hat">
              <span>{current.label}</span>
              <span className="hats-sw-tag">{t.current}</span>
            </p>
            <p className="hats-sw-help">{currentGroup.title}</p>
            {help(current) ? <p className="hats-sw-help">{help(current)}</p> : null}
          </div>
        ) : null}
        {groups.map((g) => (
          <fieldset key={String(g.id)} className="hats-sw-group">
            <legend>
              <span className="hats-sw-acct">{g.title}</span>
              <span className="hats-sw-email">{g.email}</span>
            </legend>
            <div className="hats-sw-rows">
              {g.hats.map((h) => {
                const rid = radioId(base, g.account, h.id)
                const isCurrent = actionFor(g, h, current) === 'none'
                const line = help(h, g)
                return (
                  <button
                    key={h.id}
                    type="button"
                    id={rid}
                    className="hats-sw-row"
                    data-current={isCurrent || undefined}
                    aria-current={isCurrent ? 'true' : undefined}
                    aria-disabled={busy ? true : undefined}
                    onClick={() => p.onRowClick?.(g, h)}
                  >
                    <span className="hats-sw-row-text">
                      <span className="hats-sw-row-name">{h.label}</span>
                      {line ? <span className="hats-sw-help">{line}</span> : null}
                    </span>
                    {busy === rid ? (
                      <span className="hats-sw-tag">{t.switching}</span>
                    ) : isCurrent ? (
                      <span className="hats-sw-tag">{t.current}</span>
                    ) : h.needsCode ? (
                      <span className="hats-sw-tag">
                        <Lock />
                        {t.needsCode}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </fieldset>
        ))}
        <p className="hats-sw-error" role="alert">
          {p.error}
        </p>
        <p className="hats-sw-vh" role="status">
          {busy ? t.switching : ''}
        </p>
      </div>
      {back ? (
        <div className="hats-sw-foot">
          <button type="button" className="hats-sw-btn hats-sw-wide" aria-disabled={busy === 'back' || undefined} onClick={p.onBack}>
            {busy === 'back' ? t.switching : t.backTo(back.label)}
          </button>
        </div>
      ) : null}
    </>
  )
}

/**
 * The switch: the hat you're acting in, the others you can switch to, grouped by account. Safe hats switch in one
 * tap (a button per hat, `aria-current` on the one worn); a hat that asks for a code opens a code screen first. After the switch the page reloads (or `onSwitched`
 * runs) and a short note says what you're acting as now, with a way back. Renders nothing for an account with
 * nothing to switch to. Below 640px wide the panel is a bottom sheet.
 */
export function HatSwitcher({ apiRoute = '/api', onSwitched, text, anotherWay, noteMs = 5000, ...opts }: HatSwitcherProps) {
  const t: Text = { ...defaultText, ...text }
  const api = hatsApi(apiRoute, t)
  const base = `hats${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const [menu, setMenu] = useState<HatsMenu | null>(null)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState<Asking | null>(null)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState('')
  const [otherWay, setOtherWay] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const draft = useRef<{ key: string; code: string } | null>(null)
  const focusNext = useRef<string | null>(null)
  const triggerId = `${base}-trigger`

  useEffect(() => {
    void api.menu().then(setMenu)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiRoute])

  useLayoutEffect(() => {
    if (!focusNext.current) return
    const el = document.getElementById(focusNext.current)
    focusNext.current = null
    el?.focus()
  })

  const signedIn = menu?.signedIn ? menu : null
  const groups = signedIn ? groupsOf(signedIn, opts) : []
  const current = signedIn ? currentHatOf(signedIn) : undefined
  const back = signedIn ? backHat(signedIn) : null
  const currentRadio = current ? radioId(base, undefined, current.id) : ''
  const firstGroup = groups[0]
  const firstRow = firstGroup?.hats[0] ? radioId(base, firstGroup.account, firstGroup.hats[0].id) : ''

  const close = useCallback(
    (returnFocus = true) => {
      setOpen(false)
      setAsking(null)
      setCode('')
      setCodeError('')
      setOtherWay(false)
      setError('')
      draft.current = null
      if (returnFocus) trigger.current?.focus()
    },
    [],
  )

  const show = () => {
    setOpen(true)
    // The hat worn, else the first hat, else Close: focus always lands inside the panel.
    focusNext.current = currentRadio || firstRow || `${base}-close`
  }

  useEffect(() => {
    if (!open) return
    // A tap outside the wrapper closes. The scrim is inside it and closes on click (below), so the tap ends on the
    // scrim and never reaches the page underneath.
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close(false)
    }
    document.addEventListener('pointerdown', onDown)
    // On a phone the sheet covers the page: keep the page behind it from scrolling.
    const phone = window.matchMedia?.(PHONE).matches
    const root = document.documentElement
    const before = root.style.overflow
    if (phone) root.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('pointerdown', onDown)
      if (phone) root.style.overflow = before
    }
  }, [open, close])

  const finish = (note: Omit<SwitchedNote, 'at'>) => {
    saveNote(session(), note)
    if (onSwitched) onSwitched()
    else window.location.reload()
  }

  async function go(group: Group, hat: MenuHat, key: string, withCode?: string) {
    if (busy) return
    setBusy(key)
    setError('')
    setCodeError('')
    const res = await api.switchTo({ account: group.account, hat: hat.id, code: withCode })
    if (res.ok) {
      const first = group.first
      finish({ hat: hat.label, back: first && first.id !== hat.id && !first.needsCode ? { id: first.id, label: first.label } : null })
      return
    }
    setBusy(null)
    if (res.needsCode) {
      if (!asking) openCode(group, hat)
      else setCodeError(withCode ? res.message || t.enterCode : t.enterCode)
      return
    }
    if (asking) setCodeError(res.message)
    else setError(res.message)
  }

  function openCode(group: Group, hat: MenuHat) {
    setAsking({ group, hat })
    const kept = draft.current?.key === radioId(base, group.account, hat.id) ? draft.current.code : ''
    draft.current = null
    setCode(kept)
    setCodeError('')
    setOtherWay(false)
    setError('')
    focusNext.current = focusAfter('open-code', { trigger: triggerId, radio: '', code: `${base}-code` })
  }

  function activate(group: Group, hat: MenuHat) {
    if (busy) return
    const what = actionFor(group, hat, current)
    if (what === 'none') return
    if (what === 'code') openCode(group, hat)
    else void go(group, hat, radioId(base, group.account, hat.id))
  }

  const onPanelKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (asking) {
        // Step back to the list and keep what was typed: reopening the code screen for the same hat has it.
        const rid = radioId(base, asking.group.account, asking.hat.id)
        draft.current = { key: rid, code }
        setAsking(null)
        setCodeError('')
        setCode('')
        focusNext.current = focusAfter('cancel-code', { trigger: triggerId, radio: rid, code: `${base}-code` })
        return
      }
      close()
      return
    }
    if (e.key !== 'Tab' || !panel.current) return
    const stops = tabStops(panel.current)
    if (!stops.length) return
    const first = stops[0]!
    const last = stops.at(-1)!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const live = <HatsSwitchedNote apiRoute={apiRoute} text={text} onSwitched={onSwitched} noteMs={noteMs} />

  if (!signedIn || !signedIn.showSwitch)
    return (
      <div className="hats-sw">
        {live}
      </div>
    )

  const words = t.trigger(current?.label ?? t.switchFallback)

  return (
    <div className="hats-sw" ref={wrap}>
      {/* First in both trees, so the note isn't remounted (and lost) when the menu arrives. */}
      {live}
      <style>{css}</style>
      <button ref={trigger} id={triggerId} type="button" className="hats-sw-trigger" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? `${base}-panel` : undefined} onClick={() => (open ? close() : show())}>
        <span aria-hidden="true">{clip(words)}</span>
        <span className="hats-sw-vh">
          {words}. {t.switchHint}
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <>
          <div
            className="hats-sw-scrim"
            aria-hidden="true"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              close()
            }}
          />
          <div ref={panel} id={`${base}-panel`} className="hats-sw-panel" role="dialog" aria-modal="true" aria-labelledby={`${base}-title`} onKeyDown={onPanelKey}>
            <SwitcherView
              t={t}
              base={base}
              menu={signedIn}
              groups={groups}
              current={current}
              back={back}
              busy={busy}
              error={error}
              asking={asking}
              code={code}
              codeError={codeError}
              otherWay={otherWay}
              anotherWay={anotherWay}
              hatHelp={opts.hatHelp}
              onRowClick={(g, h) => activate(g, h)}
              onBack={() => {
                const g = groups[0]
                if (back && g) void go(g, back, 'back')
              }}
              onClose={() => close()}
              onCode={(c) => {
                setCode(cleanCode(c, otherWay))
                if (codeError) setCodeError('')
              }}
              onSubmitCode={() => {
                if (!asking) return
                const c = cleanCode(code, otherWay)
                if (!c) {
                  setCodeError(t.enterCode)
                  focusNext.current = `${base}-code`
                  return
                }
                void go(asking.group, asking.hat, 'code', c)
              }}
              onCancelCode={() => {
                if (!asking) return
                const rid = radioId(base, asking.group.account, asking.hat.id)
                setAsking(null)
                setCodeError('')
                setCode('')
                draft.current = null
                focusNext.current = focusAfter('cancel-code', { trigger: triggerId, radio: rid, code: `${base}-code` })
              }}
              onOtherWay={() => {
                setOtherWay(true)
                focusNext.current = `${base}-code`
              }}
            />
          </div>
        </>
      ) : null}
    </div>
  )
}

/** The panel's tab stops in order: every enabled control. */
function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getAttribute('tabindex') !== '-1',
  )
}
