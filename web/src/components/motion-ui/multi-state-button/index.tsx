"use client"

import { animate, AnimatePresence, motion } from "motion/react"
import { useEffect, useRef, type ReactNode } from "react"
import { useMotionUITheme, useMotionUITransition } from "@/components/motion-ui/ui-theme"

/** shadcn's ring utilities, the shared focus-visible treatment for the
 *  button. */
const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

/** How hard the shake throws, as a multiple of the theme's hover travel. A
 *  token-derived amplitude (`travel.hover`), not a magic pixel count, so it
 *  scales with the active theme's sense of movement. */
const SHAKE_TRAVEL_FACTOR = 1.5

/** The blur applied at the start/end of the content crossfade, in px. A tuned
 *  constant of the mechanic (the crossfade's shape), not a timing value - the
 *  crossfade's duration comes from the "ui" theme token. */
const CROSSFADE_BLUR = 6

/**
 * The one-shot feedback fired when the state settles. `"shake"` throws the
 * button left/right (a failed action); `"pop"` scales it up and back (a
 * completed one); `"none"` (default) fires nothing. Feedback never plays under
 * reduced motion.
 */
export type MultiStateFeedback = "none" | "shake" | "pop"

export interface MultiStateButtonProps {
  /** The current state key - the consumer owns and advances the state machine.
   *  Each change keys the content crossfade, morphs the pill width and (if
   *  `feedback` is set) fires the settle feedback. Any string works: an
   *  "idle" / "loading" / "success" submit flow, a four-step cycle, etc. */
  state: string
  /** The visible label for the current state - the text that morphs. */
  children: ReactNode
  /** An optional leading glyph for the current state, rendered before the
   *  label (decorative, wrapped `aria-hidden`). Size and colour it from the
   *  glyph itself - typically an inlined spinner/check/cross per integration.
   *  Omit for a text-only state (e.g. an idle "Subscribe"). */
  icon?: ReactNode
  /** Surface-colour classes for the CURRENT state, merged onto the morphing
   *  pill (e.g. `"bg-primary text-primary-foreground"` for a neutral state,
   *  `"bg-success text-success-foreground"` for a completed one). Changing
   *  this with `state` cross-fades the colour on the theme's snap curve.
   *  Default `"bg-primary text-primary-foreground"`. */
  surfaceClassName?: string
  /** Constant pill styling applied in EVERY state - shape, padding and text
   *  size - kept separate from `surfaceClassName` so the per-state colour is
   *  the only thing that changes. Default `"rounded-md px-5 py-3 text-sm
   *  font-medium"`. */
  pillClassName?: string
  /** Imperative feedback fired when `state` settles: `"shake"` for a failed
   *  action, `"pop"` for a completed one, `"none"` (default) for neither.
   *  Derive it from the current state (e.g. `state === "failed" ? "shake" :
   *  state === "ready" ? "pop" : "none"`). Never plays under reduced motion. */
  feedback?: MultiStateFeedback
  /** Whether the pill animates its width on the compositor (via Motion layout
   *  projection) as the content changes. Default `true`; set `false` for a
   *  fixed-width button whose content swaps in place. */
  widthMorph?: boolean
  /** Accessible status text for the current state, announced through an
   *  internal `aria-live="polite"` region rendered alongside the button. Omit
   *  to supply your own live region (a form's shared status line, say). When
   *  set, also pass `aria-label` so the announcement does not leak into the
   *  button's accessible name. */
  announce?: string
  /** Accessible name for the button. Set this when the visible label alone
   *  does not describe the action in every state (e.g. a submit whose label is
   *  just a glyph), so a screen-reader user hears the current action. */
  "aria-label"?: string
  /** Button type. `"button"` (default) for a standalone action; `"submit"`
   *  for a form-embedded one whose form owns the submit. */
  type?: "button" | "submit"
  /** Disables the button (e.g. while a request is in flight). Adds
   *  `pointer-events-none`; add your own dimming via `className` if wanted. */
  disabled?: boolean
  /** Click handler - advance your state machine, or leave undefined and let a
   *  `type="submit"` button's form handle it. */
  onClick?: () => void
  /** Merged onto the button root (the focus target). */
  className?: string
}

/* Theme reduced-motion strategy (`useMotionUITheme`): "off" (still) mounts no
 * animation and swaps content discretely; "calm" keeps opacity crossfades but
 * drops the blur and the settle feedback; full motion runs everything.
 * defaultTheme ships "calm". */

/**
 * A pill button whose content crossfades and whose width morphs on the
 * compositor as its consumer-owned `state` changes, with an optional
 * shake/pop when the state settles. Composes the per-state glyph + label the
 * consumer supplies; times everything from the Motion UI theme.
 */
export function MultiStateButton({
  state,
  children,
  icon,
  surfaceClassName = "bg-primary text-primary-foreground",
  pillClassName = "rounded-md px-5 py-3 text-sm font-medium",
  feedback = "none",
  widthMorph = true,
  announce,
  "aria-label": ariaLabel,
  type = "button",
  disabled,
  onClick,
  className,
}: MultiStateButtonProps) {
  const uiTheme = useMotionUITheme()
  const still = uiTheme.motionMode === "off"
  const motionAllowed = uiTheme.motionMode === "full"

  // Named transitions, resolved by name (never literal values):
  // - snap:   the pill's width morph and the per-state colour crossfade.
  // - ui:     the content (glyph + label) blur crossfade.
  // - lively: the celebratory success pop.
  const snap = useMotionUITransition("snap")
  const ui = useMotionUITransition("ui")
  const lively = useMotionUITransition("lively")

  // The shake/pop is a transform-only one-shot on a WRAPPER node (never the
  // layout element, whose transform belongs to Motion's projection), fired
  // imperatively when the state settles. Amplitude is theme travel, duration
  // the matched transition - both tokens, no magic numbers.
  const feedbackRef = useRef<HTMLDivElement>(null)
  const shakeX = uiTheme.travel.hover * SHAKE_TRAVEL_FACTOR

  useEffect(() => {
    const node = feedbackRef.current
    if (!node || !motionAllowed || feedback === "none") return
    if (feedback === "shake") {
      animate(
        node,
        { x: [0, -shakeX, shakeX, -shakeX, 0] },
        { duration: ui.duration, ease: "easeInOut", times: [0, 0.25, 0.5, 0.75, 1] },
      )
    } else if (feedback === "pop") {
      animate(
        node,
        { scale: [1, 1.2, 1] },
        { duration: lively.duration, ease: "easeInOut", times: [0, 0.5, 1] },
      )
    }
  }, [state, feedback, motionAllowed, shakeX, ui.duration, lively.duration])

  const layoutOn = widthMorph && !still

  // The content crossfade: blur at full motion, a plain opacity fade when
  // calm, an instant swap when still. `AnimatePresence initial={false}` keeps
  // the first render from animating.
  const contentInitial = still
    ? false
    : motionAllowed
      ? { opacity: 0, filter: `blur(${CROSSFADE_BLUR}px)` }
      : { opacity: 0 }
  const contentAnimate = motionAllowed
    ? { opacity: 1, filter: "blur(0px)" }
    : { opacity: 1 }
  const contentExit = motionAllowed
    ? { opacity: 0, filter: `blur(${CROSSFADE_BLUR}px)` }
    : { opacity: 0 }
  const contentTransition = still
    ? { duration: 0 }
    : motionAllowed
      ? { ...ui }
      : { type: "tween" as const, duration: ui.opacity.duration, ease: ui.opacity.ease }

  return (
    <>
      <motion.button
        type={type}
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        className={`inline-flex rounded-md disabled:pointer-events-none ${FOCUS_RING}${className ? ` ${className}` : ""}`}
        whileTap={motionAllowed && !disabled ? { scale: 0.97 } : undefined}
        transition={{ ...snap }}
      >
        <motion.div ref={feedbackRef} className="inline-flex">
          {/* The layout element: Motion's projection animates its width as the
              popLayout content below changes size. transition-colors rides the
              snap fade channel so the per-state surface colour crosses on the
              same curve as the springs. */}
          <motion.div
            layout={layoutOn}
            transition={{ ...snap }}
            className={`relative flex items-center overflow-hidden transition-colors duration-[var(--motion-ui-transition-snap-duration)] ease-[var(--motion-ui-transition-snap)] ${pillClassName} ${surfaceClassName}`}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={state}
                className="flex items-center gap-2 whitespace-nowrap"
                initial={contentInitial}
                animate={contentAnimate}
                exit={contentExit}
                transition={contentTransition}
              >
                {icon != null && (
                  <span
                    aria-hidden="true"
                    className="flex shrink-0 items-center justify-center"
                  >
                    {icon}
                  </span>
                )}
                <span className="block">{children}</span>
              </motion.span>
            </AnimatePresence>
          </motion.div>
        </motion.div>
      </motion.button>

      {announce !== undefined && (
        <span aria-live="polite" className="sr-only">
          {announce}
        </span>
      )}
    </>
  )
}
