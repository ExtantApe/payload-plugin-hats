'use client'

import { useEffect, useState } from 'react'

import { defaultText, hatsApi, type HatsText } from './api.js'
import { dropNote, saveNote, session, takeNote, type SwitchedNote } from './model.js'
import { css } from './styles.js'

export type HatsSwitchedNoteProps = {
  apiRoute?: string
  text?: Partial<HatsText>
  /** Called after "Switch back" works, instead of reloading the page. */
  onSwitched?: () => void
  /** How long the note stays, in milliseconds. Default 5000; it waits while hovered or focused. */
  noteMs?: number
}

/**
 * The note after a switch: "Now acting as Curator. Switch back to Member." in a status region, for 5 seconds (longer
 * while it's hovered or focused), with a dismiss button. The switch saves it in this tab's sessionStorage before the
 * page reloads or moves on; whichever page loads next shows it once and moves focus to that page's heading.
 * `HatSwitcher` includes it. Put it on pages that have no switch (a site's own pages, say), so the note follows a
 * switch that lands there.
 */
export function HatsSwitchedNote({ apiRoute = '/api', text, onSwitched, noteMs = 5000 }: HatsSwitchedNoteProps) {
  const t = { ...defaultText, ...text }
  const [note, setNote] = useState<SwitchedNote | null>(null)
  const [noteError, setNoteError] = useState('')
  const [held, setHeld] = useState(false)
  useEffect(() => {
    // Read without removing: it's removed only once shown, so a page that mounts twice (Strict Mode) or is replaced
    // before the note appears still shows it.
    const found = takeNote(session(), Date.now(), true)
    if (!found) return
    // Shown a moment after the empty status region exists, so screen readers announce it.
    const shown = setTimeout(() => {
      dropNote(session())
      setNote(found)
    }, 150)
    // The page heading; on a page without an h1, the main region or the first content heading (Payload's dashboard).
    // Tried a few times, since the admin draws its heading after hydrating.
    let tries = 0
    let heading: ReturnType<typeof setTimeout>
    const toHeading = () => {
      const h =
        document.querySelector<HTMLElement>('main h1, h1') ??
        document.querySelector<HTMLElement>('main, [role="main"]') ??
        [...document.querySelectorAll<HTMLElement>('h2')].find((x) => !x.closest('header, nav, dialog, [role="dialog"], .hats-sw')) ??
        null
      if (!h) {
        if (++tries < 6) heading = setTimeout(toHeading, 300)
        return
      }
      if (!h.hasAttribute('tabindex')) {
        // Focusable for this move only, with no ring: it isn't a control, and the ring goes once focus moves on.
        h.setAttribute('tabindex', '-1')
        const before = h.style.outline
        h.style.outline = 'none'
        h.addEventListener('blur', () => (h.removeAttribute('tabindex'), (h.style.outline = before)), { once: true })
      }
      h.focus({ preventScroll: true })
    }
    heading = setTimeout(toHeading, 300)
    return () => (clearTimeout(shown), clearTimeout(heading))
  }, [])

  useEffect(() => {
    if (!note || held || noteError) return
    const id = setTimeout(() => setNote(null), noteMs)
    return () => clearTimeout(id)
  }, [note, held, noteError, noteMs])

  async function switchBack() {
    if (!note?.back || noteError === t.switching) return
    setNoteError(t.switching)
    const res = await hatsApi(apiRoute, t).switchTo({ hat: note.back.id })
    if (!res.ok) return setNoteError(res.message || t.failed)
    saveNote(session(), { hat: note.back.label, back: null })
    if (onSwitched) onSwitched()
    else window.location.reload()
  }

  return (
    <div className="hats-sw-note">
      <style>{css}</style>
      <div role="status">
        {note ? (
          <div
            className="hats-sw-banner"
            onPointerEnter={() => setHeld(true)}
            onPointerLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setHeld(false)}
          >
            <p>
              {t.nowActing(note.hat)}
              {note.back ? (
                <>
                  {' '}
                  <button type="button" className="hats-sw-link" onClick={() => void switchBack()}>
                    {t.switchBack(note.back.label)}
                  </button>
                </>
              ) : null}
              {noteError ? <span className="hats-sw-help"> {noteError}</span> : null}
            </p>
            <button type="button" className="hats-sw-close" aria-label={t.dismiss} onClick={() => setNote(null)}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
