"use client"

import { AnimatePresence, motion } from "motion/react"
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react"
import { useMotionUITheme, useMotionUITransition } from "@/components/motion-ui/ui-theme"
import type { UITransition } from "@/components/motion-ui/ui-theme"

/**
 * ==============   Constants   ================
 */

/** shadcn's ring utilities, the shared focus-visible treatment.
 *  `ring-offset-background` makes the ring read correctly on both a
 *  `bg-primary` fill and a `bg-muted` ghost. */
const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

/* Reduced motion: "off" (still) mounts no animation (the swap is instant);
 * "calm" keeps opacity only; full motion runs the opacity + blur swap and the
 * layout width animation on the label variant. */

type SwapMotionProps = {
  initial: false | Record<string, string | number>
  animate: Record<string, string | number>
  exit?: Record<string, string | number>
  transition:
    | UITransition
    | {
        duration: number
        ease?: UITransition["ease"] | UITransition["opacity"]["ease"]
      }
}

/** The house short-branch swap: opacity + 4px blur on `ui` at full motion,
 * opacity only in calm mode, and an instant replacement in still mode. */
function buildSwapMotion(
  still: boolean,
  calm: boolean,
  swapTransition: UITransition
): SwapMotionProps {
  const fade = {
    duration: swapTransition.opacity.duration,
    ease: swapTransition.opacity.ease,
  }

  if (still) {
    return {
      initial: false,
      animate: { opacity: 1, filter: "blur(0px)" },
      exit: { opacity: 0 },
      transition: { duration: 0 },
    }
  }

  if (calm) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: fade,
    }
  }

  return {
    initial: { opacity: 0, filter: "blur(4px)" },
    animate: { opacity: 1, filter: "blur(0px)" },
    exit: { opacity: 0, filter: "blur(4px)" },
    transition: { ...swapTransition },
  }
}

/**
 * ==============   CopyButton   ================
 */

/** Which shape the copy button takes. `"label"` swaps visible text
 *  (Copy to Copied) under a width animation; `"icon"` is a compact icon-only
 *  glyph swap with no visible text. */
export type CopyButtonVariant = "label" | "icon"

export interface CopyButtonProps {
  /** The text written to the clipboard when the button is clicked. */
  value: string
  /** The button shape. `"label"` (default) is a primary-fill pill with
   *  visible text; `"icon"` is a compact muted-ghost glyph-only button. */
  variant?: CopyButtonVariant
  /** The visible resting label, `"label"` variant only (ignored by `"icon"`).
   *  Default `"Copy"`. */
  children?: ReactNode
  /** The visible confirmed label shown after a copy, `"label"` variant only.
   *  Default `"Copied"`. */
  copiedText?: ReactNode
  /** The button's accessible name (`aria-label`) while resting. Essential for
   *  the `"icon"` variant, which has no visible text. Default
   *  `"Copy to clipboard"`. */
  label?: string
  /** The accessible name after a copy, also announced via the `aria-live`
   *  region. Default `"Copied to clipboard"`. */
  copiedLabel?: string
  /** How long the confirmed state holds, in milliseconds, before it reverts
   *  to resting. Default `2000`. */
  resetMs?: number
  /** Fired at the copy beat, after the clipboard write is attempted, with the
   *  copied `value`. Use it to tick your own analytics or toast; the button
   *  needs nothing back. */
  onCopy?: (value: string) => void
  /** Disable the button (skips the copy and the swap). */
  disabled?: boolean
  /** Merged onto the button element. */
  className?: string
  /** Ref to the underlying `<button>`, React 19 ref-as-prop style, for
   *  consumers that need to focus or measure it. */
  ref?: Ref<HTMLButtonElement>
}

/** A copy-to-clipboard button that writes `value` on click, confirms with a
 *  clipboard-to-check swap and an aria-live announcement, then reverts after
 *  `resetMs`. Owns its own confirm/reset state; observe copies via `onCopy`.
 *  Pick a shape with `variant`; time nothing yourself (the theme does). */
export function CopyButton({
  value,
  variant = "label",
  children = "Copy",
  copiedText = "Copied",
  label = "Copy to clipboard",
  copiedLabel = "Copied to clipboard",
  resetMs = 2000,
  onCopy,
  disabled,
  className,
  ref,
}: CopyButtonProps) {
  const { motionMode } = useMotionUITheme()
  const still = motionMode === "off"
  const calm = motionMode === "calm"
  const motionAllowed = motionMode === "full"
  const snap = useMotionUITransition("snap") // button press and width-morph feel
  const swapTransition = useMotionUITransition("ui") // branch-swap feel
  const [copied, setCopied] = useState(false)
  const resetRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Clear any pending revert on unmount so a copy just before teardown never
  // calls setState on an unmounted button.
  useEffect(() => () => clearTimeout(resetRef.current!), [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(value)
    } catch {
      // Sandboxed iframes and insecure-context hosts can deny clipboard
      // access; still show the confirm so the interaction reads correctly.
    }
    setCopied(true)
    onCopy?.(value)
    clearTimeout(resetRef.current!)
    resetRef.current = setTimeout(() => setCopied(false), resetMs)
  }

  const isIcon = variant === "icon"
  const glyphSize = isIcon ? 15 : 13

  // Both glyphs stay static. The surrounding branch supplies the complete
  // blur-and-opacity swap.
  const glyph = copied ? (
    <CheckIcon size={glyphSize} />
  ) : (
    <ClipboardIcon size={glyphSize} />
  )

  const buttonClassName = isIcon
    ? `relative inline-flex shrink-0 items-center justify-center rounded-sm border border-border bg-muted px-2 py-1.5 text-muted-foreground transition-colors duration-[var(--motion-ui-transition-snap-duration)] ease-[var(--motion-ui-transition-snap)] hover:text-foreground focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-60 ${FOCUS_RING}${className ? ` ${className}` : ""}`
    : `relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-sm bg-primary px-3.5 py-2.5 font-mono text-xs font-medium uppercase tracking-wider text-primary-foreground transition-colors duration-[var(--motion-ui-transition-snap-duration)] ease-[var(--motion-ui-transition-snap)] hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-60 ${FOCUS_RING}${className ? ` ${className}` : ""}`

  const swapMotion = buildSwapMotion(still, calm, swapTransition)
  const swapWillChange = calm ? "opacity" : "opacity, filter"

  return (
    <motion.button
      ref={ref}
      type="button"
      className={buttonClassName}
      onClick={handleCopy}
      disabled={disabled}
      aria-label={copied ? copiedLabel : label}
      // Only the label variant changes width (Copy -> Copied), so only it needs
      // Motion's layout animation; the icon variant is fixed-size.
      layout={!isIcon && motionAllowed ? true : undefined}
      whileTap={motionAllowed ? { scale: 0.94 } : undefined}
      transition={{ ...snap }}
    >
      {isIcon && (
        // Enlarge the tap target to at least 3rem on coarse pointers without
        // changing the visual size, so the small icon button is still easy to
        // hit on touch. Decorative and non-interactive.
        <span
          className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
          aria-hidden="true"
        />
      )}
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={copied ? "copied" : "idle"}
          className={
            isIcon
              ? `flex items-center${copied ? " text-foreground" : ""}`
              : "flex items-center gap-1.5"
          }
          // Keep the swapping label from reflowing the button width abruptly:
          // layout="position" tweens its position while the button's own
          // layout tweens the width (label variant, full motion only).
          layout={!isIcon && motionAllowed ? "position" : undefined}
          style={{ willChange: still ? undefined : swapWillChange }}
          {...swapMotion}
        >
          {glyph}
          {!isIcon && (copied ? copiedText : children)}
        </motion.span>
      </AnimatePresence>
      {/* Announce the copy to assistive tech; the glyph swap itself is
          decorative. */}
      <span aria-live="polite" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </motion.button>
  )
}

/**
 * ==============   Icons   ================
 * Static glyphs (Lucide "check" / "clipboard"), stroke="currentColor" so they
 * inherit the button's text colour - no icon dependency. Private to the
 * button.
 */
function CheckIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12l5 5L20 6" />
    </svg>
  )
}

function ClipboardIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  )
}
