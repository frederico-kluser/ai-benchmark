import { motion, type MotionProps, type MotionStyle, type MotionValue } from "motion/react"
import { useEffect, useRef, type ReactNode, type RefObject } from "react"

/**
 * Overlay - the accessible primitives every modal surface shares. This is
 * deliberately not a monolithic Dialog: it ships the three concerns every
 * overlay needs, so a command palette, a bottom sheet, a mega-menu or an
 * expanding card can compose one implementation of the accessibility
 * plumbing and keep its own entrance choreography on top:
 *
 *  - `useFocusTrap` cycles Tab/Shift+Tab inside your open panel, moves focus
 *    in when it engages, routes Escape back to your close handler, and
 *    restores focus to the trigger when it releases.
 *  - `useScrollLock` freezes background scroll on `documentElement` while the
 *    overlay is open and restores the previous value on close.
 *  - `Backdrop` is the dimming scrim. Its opacity is either a plain number
 *    (a fading dialog scrim) or a bound `MotionValue` (a scrim whose opacity
 *    tracks a sheet's drag position, or a view-transition scrim), so every
 *    scrim variant is the same component.
 *
 * These primitives are structural, so they own no entrance animation and no
 * reduced-motion branch of their own: the composing overlay decides its
 * motion and hands the result to `Backdrop`'s motion props.
 */

/**
 * ==============   getFocusableElements   ================
 */

/** The tabbable-descendant selector shared by the focus trap: real links,
 *  enabled form controls and buttons, and anything explicitly made tabbable.
 *  Elements pulled out of the tab order with `tabindex="-1"` (e.g. a command
 *  palette's rows, which are driven by `aria-activedescendant`) are excluded,
 *  so the trap only ever lands on genuinely reachable controls. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Returns the tabbable descendants of `container`, in document order. The
 * focus trap uses this to find the ends of the cycle; a consumer can call it
 * directly to move focus into an overlay manually. Returns an empty array for
 * a null container (an unmounted panel), so callers never need a null guard.
 */
export function getFocusableElements(
  container: HTMLElement | null
): HTMLElement[] {
  if (!container) return []
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

/**
 * ==============   useFocusTrap   ================
 */

/** What `useFocusTrap` needs to engage: the open flag, the panel it guards,
 *  and optional hooks for Escape, where focus starts, and whether focus is
 *  restored on close. */
export interface FocusTrapOptions {
  /** Whether the trap is engaged. Flipping this to `true` moves focus into
   *  `container` and starts cycling Tab; flipping it back to `false` releases
   *  the trap and (by default) restores focus to the trigger. */
  active: boolean
  /** Ref to the overlay panel whose focusable descendants Tab cycles within -
   *  typically your `role="dialog"` element. Also mark the resting page
   *  content behind it `inert` + `aria-hidden` yourself so the overlay is the
   *  only thing in the tab order and a11y tree; that is a render concern on
   *  your own background element, not something a hook can reach. */
  container: RefObject<HTMLElement | null>
  /** Called when Escape is pressed while the trap is active. Wire it to your
   *  close handler. */
  onEscape?: () => void
  /** Ref to the element focused when the trap engages. Defaults to the first
   *  focusable descendant, falling back to the container. Pass your close
   *  button's ref to open focus there (the command-palette / sheet pattern). */
  initialFocus?: RefObject<HTMLElement | null>
  /** Whether to return focus to whatever was focused before the trap engaged
   *  (usually the trigger) when it releases. Defaults to `true`. */
  restoreFocus?: boolean
}

/**
 * Traps keyboard focus inside an open overlay. While `active`, Tab and
 * Shift+Tab cycle between the first and last focusable descendants of
 * `container` (never escaping to the page behind the scrim), Escape calls
 * `onEscape`, and focus is moved into the panel on the next frame with
 * `preventScroll` so a mount/layout animation is neither raced nor scrolled
 * out of view. On release it restores focus to the element that had it before
 * the overlay opened. Pair with `aria-modal="true"` on your panel and
 * `inert` on the background; the trap is what makes those promises real.
 */
export function useFocusTrap({
  active,
  container,
  onEscape,
  initialFocus,
  restoreFocus = true,
}: FocusTrapOptions): void {
  // Keep the latest onEscape without re-arming the keydown listener each
  // render (the listener is installed once per open cycle).
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  useEffect(() => {
    if (!active) return
    const node = container.current
    // Remember what had focus (the trigger) so we can hand it back on close.
    const previouslyFocused = document.activeElement as HTMLElement | null

    // Move focus in on the next frame so an entrance/layout animation does
    // not race the focus call, and never scroll the surface out of view.
    const raf = requestAnimationFrame(() => {
      const target =
        initialFocus?.current ?? getFocusableElements(node)[0] ?? node
      target?.focus({ preventScroll: true })
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onEscapeRef.current?.()
        return
      }
      if (event.key !== "Tab" || !node) return
      const focusables = getFocusableElements(node)
      if (focusables.length === 0) {
        // Nothing to land on: swallow Tab so focus cannot leave the overlay.
        event.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const activeEl = document.activeElement
      const inside = node.contains(activeEl)
      if (event.shiftKey) {
        if (activeEl === first || !inside) {
          event.preventDefault()
          last.focus()
        }
      } else if (activeEl === last || !inside) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", onKeyDown)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener("keydown", onKeyDown)
      if (restoreFocus) previouslyFocused?.focus?.({ preventScroll: true })
    }
  }, [active, container, initialFocus, restoreFocus])
}

/**
 * ==============   useScrollLock   ================
 */

/**
 * Freezes background scroll while `active`, by setting `overflow: hidden` on
 * `document.documentElement`, and restores the previous value when it flips
 * off or the component unmounts. Guard-free on the server (no-op when there
 * is no `document`). Call it alongside `useFocusTrap` so the page behind an
 * open overlay can neither scroll nor be tabbed into.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === "undefined") return
    const root = document.documentElement
    const previousOverflow = root.style.overflow
    root.style.overflow = "hidden"
    return () => {
      root.style.overflow = previousOverflow
    }
  }, [active])
}

/**
 * ==============   Backdrop   ================
 */

export interface BackdropProps
  extends Pick<MotionProps, "initial" | "animate" | "exit" | "transition"> {
  /** The scrim's opacity. A number for a plain fading dialog scrim (drive it
   *  with `animate`/`exit`), or a `MotionValue<number>` to bind opacity to
   *  something live - a sheet's drag position via `useTransform`, a
   *  view-transition layer - so the scrim dims in lockstep with the gesture.
   *  Merged into `style`, where a bound value wins over any `animate` opacity. */
  opacity?: number | MotionValue<number>
  /** Click-to-dismiss handler. */
  onClick?: () => void
  /** When set, the scrim is itself the keyboard-reachable dismiss control: it
   *  renders as a real `<button>` carrying this `aria-label` (the bottom-sheet
   *  pattern). Omit it and the scrim renders `aria-hidden` decoration instead,
   *  in which case keyboard users dismiss via your Escape handler or an
   *  explicit close button. */
  label?: string
  /** The scrim surface class. Defaults to `bg-black` - the universal modal
   *  scrim literal shadcn's own Dialog overlay uses, which dims correctly in
   *  both light and dark mode where a semantic token would invert. Pass your
   *  own section-local veil (e.g. a
   *  `color-mix(in srgb, var(--background) 72%, transparent)` class) to
   *  override it. `absolute inset-0` is always applied. */
  className?: string
  /** Extra inline styles, merged under `opacity`. */
  style?: MotionStyle
  /** Rarely needed - content rendered inside the scrim. */
  children?: ReactNode
}

/**
 * The dimming scrim behind an open overlay. A thin, unopinionated element: it
 * paints the full-bleed surface and forwards your own entrance choreography
 * (`initial`/`animate`/`exit`/`transition`) untouched, so a dialog can fade
 * it in, a sheet can bind its opacity to a drag, and a view transition can
 * animate it on its own layer, all from the same component. Wrap it in your
 * `AnimatePresence` and pair it with `useFocusTrap` + `useScrollLock`.
 */
export function Backdrop({
  opacity,
  onClick,
  label,
  className,
  style,
  children,
  initial,
  animate,
  exit,
  transition,
}: BackdropProps) {
  const mergedStyle: MotionStyle =
    opacity !== undefined ? { ...style, opacity } : { ...style }
  const surfaceClass = `absolute inset-0 ${className ?? "bg-black"}`

  if (label) {
    return (
      <motion.button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={surfaceClass}
        style={mergedStyle}
        initial={initial}
        animate={animate}
        exit={exit}
        transition={transition}
      >
        {children}
      </motion.button>
    )
  }

  return (
    <motion.div
      aria-hidden="true"
      onClick={onClick}
      className={surfaceClass}
      style={mergedStyle}
      initial={initial}
      animate={animate}
      exit={exit}
      transition={transition}
    >
      {children}
    </motion.div>
  )
}
