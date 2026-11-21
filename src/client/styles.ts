/**
 * The switcher's look. Every color and size reads a `--hats-*` variable first, then the Payload admin's theme
 * variables, then the surrounding text, so it follows the admin's light and dark themes and a site's own tokens.
 * No fixed colors.
 */
const v = (name: string, fallback: string) => `var(--hats-${name}, ${fallback})`

export const tokens = {
  ink: v('ink', 'var(--theme-text, currentColor)'),
  paper: v('paper', 'var(--theme-elevation-0, Canvas)'),
  line: v('line', 'var(--theme-elevation-150, color-mix(in srgb, currentColor 30%, transparent))'),
  // Field borders need 3:1 (WCAG 1.4.11), which elevation 150 doesn't give.
  field: v('field', 'var(--theme-elevation-600, color-mix(in srgb, currentColor 60%, transparent))'),
  // Payload's elevation 650 keeps 4.5:1 on its own backgrounds in light and dark.
  muted: v('muted', 'var(--theme-elevation-650, color-mix(in srgb, currentColor 78%, transparent))'),
  hover: v('hover', 'var(--theme-elevation-50, color-mix(in srgb, currentColor 6%, transparent))'),
  selected: v('selected', 'var(--theme-elevation-100, color-mix(in srgb, currentColor 10%, transparent))'),
  error: v('error', 'var(--theme-error-650, currentColor)'),
  focus: v('focus', 'var(--accessibility-outline, 2px solid currentColor)'),
  scrim: v('scrim', 'color-mix(in srgb, var(--theme-elevation-1000, CanvasText) 45%, transparent)'),
  shadow: v('shadow', '0 8px 28px color-mix(in srgb, var(--theme-elevation-1000, CanvasText) 22%, transparent)'),
  radius: v('radius', 'var(--style-radius-l, 8px)'),
  radiusSmall: v('radius-small', 'var(--style-radius-m, 4px)'),
  small: v('small', '0.875rem'),
  row: v('row', '48px'),
  gap: v('gap', '8px'),
  space: v('space', '16px'),
}

const t = tokens

/** Phone below 640px: a bottom sheet. Wider: a popover under the trigger. */
export const css = `
.hats-sw{position:relative;display:inline-block;font:inherit;color:${t.ink}}
.hats-sw *{box-sizing:border-box}
.hats-sw :focus-visible,.hats-sw-note :focus-visible{outline:${t.focus};outline-offset:2px}
.hats-sw-vh{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.hats-sw-trigger{font:inherit;color:${t.ink};background:${t.paper};border:1px solid ${t.field};border-radius:999px;min-height:36px;padding:4px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.hats-sw-trigger:hover{background:${t.hover}}
.hats-sw-scrim{display:none}
.hats-sw-panel{position:absolute;inset-inline-end:0;top:calc(100% + 6px);z-index:60;width:360px;max-width:90vw;max-height:min(80vh,640px);display:flex;flex-direction:column;background:${t.paper};color:${t.ink};border:1px solid ${t.line};border-radius:${t.radius};box-shadow:${t.shadow};text-align:start;white-space:normal;overflow-wrap:anywhere;line-height:1.4}
@media (max-width:639.98px){
  .hats-sw-scrim{display:block;position:fixed;inset:0;z-index:59;background:${t.scrim}}
  .hats-sw-panel{position:fixed;inset-inline:0;bottom:0;top:auto;width:100%;max-width:none;max-height:85dvh;border-radius:${t.radius} ${t.radius} 0 0;border-bottom:0;padding-bottom:env(safe-area-inset-bottom)}
}
.hats-sw-head{display:flex;align-items:center;justify-content:space-between;gap:${t.gap};padding:${t.gap} ${t.gap} 0 ${t.space}}
.hats-sw-title{font-size:1.125rem;font-weight:600;margin:0}
.hats-sw-close{font:inherit;font-size:1.5rem;line-height:1;color:${t.ink};background:transparent;border:0;border-radius:${t.radiusSmall};width:${t.row};height:${t.row};cursor:pointer;flex:none}
.hats-sw-close:hover{background:${t.hover}}
.hats-sw-body{overflow-y:auto;overscroll-behavior:contain;padding:0 ${t.space} ${t.space};flex:1 1 auto}
.hats-sw-now{margin:${t.gap} 0 0;padding:12px;border-radius:${t.radiusSmall};background:${t.selected}}
.hats-sw-now-label{font-size:${t.small};color:${t.muted};margin:0}
.hats-sw-now-hat{font-weight:600;margin:2px 0 0;display:flex;flex-wrap:wrap;align-items:center;gap:${t.gap}}
.hats-sw-help{font-size:${t.small};color:${t.muted};margin:2px 0 0}
.hats-sw-tag{font-size:${t.small};font-weight:600;border:1px solid ${t.field};border-radius:999px;padding:0 8px;line-height:1.6;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;flex:none}
.hats-sw-group{border:0;margin:${t.space} 0 0;padding:${t.space} 0 0;min-inline-size:0;border-top:1px solid ${t.line}}
.hats-sw-group legend{padding:0;margin:0 0 ${t.gap};float:left;width:100%}
.hats-sw-group legend+*{clear:both}
.hats-sw-acct{display:block;font-weight:600}
.hats-sw-email{display:block;font-size:${t.small};color:${t.muted};text-decoration:none;font-weight:400}
.hats-sw-rows{display:flex;flex-direction:column;gap:${t.gap};clear:both}
.hats-sw-row{font:inherit;color:inherit;text-align:start;background:transparent;border:0;width:100%;display:flex;align-items:center;gap:12px;min-height:${t.row};padding:6px 10px;border-radius:${t.radiusSmall};cursor:pointer}
.hats-sw-row:hover{background:${t.hover}}
.hats-sw-row[data-current="true"]{background:${t.selected}}
.hats-sw-row[aria-disabled="true"]{cursor:progress}
.hats-sw-row-text{flex:1 1 auto;min-width:0}
.hats-sw-row-name{display:block}
.hats-sw-row[data-current="true"] .hats-sw-row-name{font-weight:600}
.hats-sw-row .hats-sw-help{display:block}
.hats-sw-foot{flex:none;border-top:1px solid ${t.line};padding:${t.gap} ${t.space};background:${t.paper};border-radius:0 0 ${t.radius} ${t.radius}}
.hats-sw-btn{font:inherit;color:${t.ink};background:${t.paper};border:1px solid ${t.line};border-radius:${t.radiusSmall};min-height:${t.row};padding:8px 16px;cursor:pointer}
.hats-sw-btn:hover{background:${t.hover}}
.hats-sw-btn[data-primary="true"]{background:${t.ink};color:${t.paper};border-color:${t.ink};font-weight:600}
.hats-sw-btn[aria-disabled="true"]{cursor:progress;opacity:.75}
.hats-sw-wide{width:100%;text-align:start}
.hats-sw-link{font:inherit;color:inherit;background:none;border:0;padding:0;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.hats-sw-code{padding-top:${t.gap}}
.hats-sw-code p{margin:0 0 12px}
.hats-sw-code .hats-sw-more{margin-top:${t.gap}}
.hats-sw-more .hats-sw-link{min-height:32px;min-width:32px;display:inline-flex;align-items:center}
.hats-sw-code label{display:block;font-weight:600;margin-bottom:4px}
.hats-sw-input{font:inherit;font-size:1.25rem;letter-spacing:.15em;color:${t.ink};background:${t.paper};border:1px solid ${t.field};border-radius:${t.radiusSmall};min-height:${t.row};padding:6px 12px;width:100%;max-width:14em}
.hats-sw-input[aria-invalid="true"]{border-color:${t.error};border-width:2px}
.hats-sw-actions{display:flex;flex-wrap:wrap;gap:${t.gap};margin-top:${t.space}}
.hats-sw-error{color:${t.error};font-size:${t.small};margin:6px 0 0}
.hats-sw-error:empty{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.hats-sw-banner{position:fixed;z-index:70;inset-inline:${t.space};bottom:calc(${t.space} + env(safe-area-inset-bottom));margin-inline:auto;max-width:480px;display:flex;align-items:center;gap:${t.gap};background:${t.paper};color:${t.ink};border:1px solid ${t.line};border-radius:${t.radius};box-shadow:${t.shadow};padding:${t.gap} ${t.gap} ${t.gap} ${t.space}}
.hats-sw-banner:empty{display:none}
.hats-sw-banner p{margin:0;flex:1 1 auto}
`

/** The account page's buttons carry inline styles, so their focus ring comes from here and works outside Payload admin. */
export const linkedCss = `
.hats-la-btn:focus-visible,.hats-la-input:focus-visible{outline:${t.focus};outline-offset:2px}
`
