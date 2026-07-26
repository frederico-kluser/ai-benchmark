import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useTransform,
} from "motion/react"
import type { AnimationPlaybackControls, MotionValue } from "motion/react"
import { useRef, useState, type ReactNode } from "react"
import { useMotionUITheme, useMotionUITransition } from "@/components/motion-ui/ui-theme"

/** shadcn's ring utilities, the shared focus-visible treatment for the styled
 *  button. */
const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

/** Scale reached at the end of a full-motion hold. Success mode multiplies
 *  back by its reciprocal so the button springs to its resting size without
 *  disturbing the completed progress wipe underneath. */
const HELD_SCALE = 0.8

/* Theme reduced-motion strategy (`useMotionUITheme`): "off" (still) mounts no
 * transform; "calm" keeps opacity fades but drops travel/scale. defaultTheme
 * ships "calm". Only the button's scale-down consults this - the hold-progress
 * fill is functional feedback and survives reduced motion (only the transform
 * drops). */

/**
 * ==============   useHoldToConfirm   ================
 */

export interface UseHoldToConfirmOptions {
  /** Seconds the gesture must be held for `progress` to reach 1 and confirm.
   *  Default 2. */
  holdSeconds?: number
  /** Fired once when a hold completes (progress reaches 1). Update your own
   *  confirmed/committed state here. */
  onConfirm?: () => void
  /** Fired when a hold is released before it completes (the retract). */
  onCancel?: () => void
}

export interface UseHoldToConfirmResult {
  /** The single source of truth: 0 at rest, 1 confirmed. Drive any animation
   *  off it (a fill wipe, a scale, a ring) with `useTransform`. */
  progress: MotionValue<number>
  /** Stop any in-flight ramp and snap `progress` back to 0, clearing the
   *  completed lock so the gesture can run again. */
  reset: () => void
  /** Spread onto the interactive element (a `<button>`): pointer-capture hold,
   *  release-to-cancel, and Space-key hold, plus a context-menu
   *  guard so a long-press does not open the OS callout. */
  holdHandlers: {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void
    onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => void
    onPointerCancel: (event: React.PointerEvent<HTMLButtonElement>) => void
    onPointerLeave: (event: React.PointerEvent<HTMLButtonElement>) => void
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
    onKeyUp: (event: React.KeyboardEvent<HTMLButtonElement>) => void
    onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void
  }
}

/** Headless press-and-hold: owns the `progress` MotionValue and the whole
 *  gesture, leaving the surface (and what `progress` drives) entirely to the
 *  consumer. */
export function useHoldToConfirm({
  holdSeconds = 2,
  onConfirm,
  onCancel,
}: UseHoldToConfirmOptions = {}): UseHoldToConfirmResult {
  // Retract with the theme's "snap" transition (tween degradation), so the
  // cancel feel is a token, never a magic number.
  const snapTransition = useMotionUITransition("snap")

  // 0 at rest, 1 confirmed. Every derived animation reads it.
  const progress = useMotionValue(0)
  const holdAnim = useRef<AnimationPlaybackControls | null>(null)
  const holding = useRef(false)
  const done = useRef(false)

  const startHold = () => {
    if (done.current || holding.current) return
    holding.current = true
    holdAnim.current?.stop()
    progress.set(0)
    // A deterministic easeOut ramp: progress must reach full exactly when the
    // hold completes, so this is a functional ramp, not a feel spring (which
    // would overshoot a progress meter).
    holdAnim.current = animate(progress, 1, {
      duration: holdSeconds,
      ease: "easeOut",
      onComplete: () => {
        holding.current = false
        done.current = true
        onConfirm?.()
      },
    })
  }

  const cancelHold = () => {
    if (!holding.current) return
    holding.current = false
    holdAnim.current?.stop()
    holdAnim.current = animate(progress, 0, { ...snapTransition, type: "tween" })
    onCancel?.()
  }

  const reset = () => {
    holdAnim.current?.stop()
    holding.current = false
    done.current = false
    progress.set(0)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    // Ignore the OS key-repeat that fires while a key is held down.
    if (event.repeat) return
    if (event.key === " ") {
      event.preventDefault()
      startHold()
    }
  }

  const handleKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " ") {
      event.preventDefault()
      cancelHold()
    }
  }

  return {
    progress,
    reset,
    holdHandlers: {
      onPointerDown: (event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId)
        startHold()
      },
      onPointerUp: cancelHold,
      onPointerCancel: cancelHold,
      onPointerLeave: cancelHold,
      onKeyDown: handleKeyDown,
      onKeyUp: handleKeyUp,
      onContextMenu: (event) => event.preventDefault(),
    },
  }
}

/**
 * ==============   HoldToConfirmButton   ================
 */

export interface HoldToConfirmButtonProps {
  /** Seconds the button must be held to confirm. Default 2. */
  holdSeconds?: number
  /** What happens visually after confirmation. `"callback"` leaves the
   *  completed state to the consumer, which can replace surrounding content.
   *  `"success"` keeps the button mounted and wipes its success state in from
   *  the left. Default `"callback"`. */
  mode?: "callback" | "success"
  /** Label shown beside the built-in check in `"success"` mode. Default
   *  `"Confirmed"`. */
  successLabel?: ReactNode
  /** Fired once the hold completes. Flip your own confirmed state here. */
  onConfirm?: () => void
  /** Fired when the hold is released early. */
  onCancel?: () => void
  /** The button label (typically an icon + text). Rendered in BOTH the
   *  resting layer and the clipped destructive fill layer, so it is legible at
   *  every point of the wipe. */
  children?: ReactNode
  /** Merged onto the button element. */
  className?: string
  /** Points at the consumer's own hint/instruction text, wired through to the
   *  button's `aria-describedby`. */
  "aria-describedby"?: string
}

/** The finished destructive hold button: a resting `bg-secondary` pill whose
 *  label is wiped left-to-right by an opaque `bg-destructive` fill as the hold
 *  advances, paired with a slow scale-down. One fill, no competing ring - the
 *  sole progress signal. Drives itself off `useHoldToConfirm`. */
export function HoldToConfirmButton({
  holdSeconds = 2,
  mode = "callback",
  successLabel = "Confirmed",
  onConfirm,
  onCancel,
  children,
  className,
  "aria-describedby": ariaDescribedby,
}: HoldToConfirmButtonProps) {
  const { motionMode } = useMotionUITheme()
  const still = motionMode === "off"
  const calm = motionMode === "calm"
  const motionAllowed = motionMode === "full"
  const successTransition = useMotionUITransition("ui")
  const restoreTransition = useMotionUITransition("snap")
  const successScale = useMotionValue(1)
  const [confirmed, setConfirmed] = useState(false)
  const { progress, holdHandlers } = useHoldToConfirm({
    holdSeconds,
    onConfirm: () => {
      if (mode === "success") {
        setConfirmed(true)
        animate(successScale, motionAllowed ? 1 / HELD_SCALE : 1, {
          ...restoreTransition,
        })
      }
      onConfirm?.()
    },
    onCancel,
  })

  // Every derived animation reads `progress`. The scale-down is a transform,
  // so it drops under reduced motion; the fill wipe is functional feedback and
  // survives it.
  const holdScale = useTransform(
    progress,
    [0, 1],
    [1, motionAllowed ? HELD_SCALE : 1]
  )
  const buttonScale = useTransform(
    () => holdScale.get() * successScale.get()
  )
  // Left-to-right reveal of the destructive fill layer. clip-path keeps the
  // fill a single opaque layer - no alpha haze.
  const fillClip = useTransform(
    progress,
    [0, 1],
    ["inset(0 100% 0 0)", "inset(0 0% 0 0)"]
  )
  const successInitial = still
    ? false
    : calm
      ? { opacity: 0 }
      : { opacity: 1, clipPath: "inset(0 100% 0 0)" }
  const successAnimate = calm
    ? { opacity: 1 }
    : { opacity: 1, clipPath: "inset(0 0% 0 0)" }
  const successSwapTransition = still
    ? { duration: 0 }
    : calm
      ? {
          duration: successTransition.opacity.duration,
          ease: successTransition.opacity.ease,
        }
      : successTransition
  const successComplete = mode === "success" && confirmed

  return (
    <motion.button
      type="button"
      aria-describedby={ariaDescribedby}
      aria-disabled={successComplete || undefined}
      {...(successComplete ? {} : holdHandlers)}
      style={{ scale: buttonScale }}
      // The two -webkit arbitrary properties are behavioural, not a token
      // concern: they suppress the iOS long-press callout + tap highlight so a
      // press-and-hold reads as a gesture, not a text selection. Kept on the
      // component so the button is self-contained.
      className={`relative z-0 inline-flex h-[3.25rem] w-60 select-none touch-none items-center justify-center overflow-hidden rounded-md bg-secondary text-sm font-medium text-secondary-foreground [-webkit-tap-highlight-color:transparent] [-webkit-touch-callout:none] ${FOCUS_RING}${className ? ` ${className}` : ""}`}
    >
      {/* Base label, visible over the un-filled (secondary) portion. */}
      <span
        aria-hidden={successComplete || undefined}
        className="relative z-10 inline-flex items-center gap-2"
      >
        {children}
      </span>
      {/* Fill layer: an opaque destructive surface carrying its OWN copy of the
          label in destructive-foreground, clipped to the advancing fill edge so
          every pixel is either fully secondary+secondary-text or fully
          destructive+destructive-fg-text - legible at any progress, no
          mid-sweep contrast wobble. */}
      <motion.span
        aria-hidden="true"
        style={{ clipPath: fillClip }}
        className="pointer-events-none absolute inset-0 z-20 inline-flex items-center justify-center gap-2 bg-destructive text-destructive-foreground"
      >
        {children}
      </motion.span>
      <AnimatePresence initial={false}>
        {successComplete ? (
          <motion.span
            key="success"
            role="status"
            initial={successInitial}
            animate={successAnimate}
            transition={successSwapTransition}
            className="pointer-events-none absolute inset-0 z-30 inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground"
          >
            <SuccessIcon />
            {successLabel}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </motion.button>
  )
}

function SuccessIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
