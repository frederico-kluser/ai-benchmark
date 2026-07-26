import {
  motion,
  useMotionTemplate,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react"
import {
  createContext,
  useContext,
  type CSSProperties,
  type ReactNode,
} from "react"
import { useMotionUITheme } from "@/components/motion-ui/ui-theme"

/**
 * Shrink header - the scroll-aware condensing header mechanic. A fixed header
 * that starts full-height and transparent, then condenses into a compact,
 * solid, bordered bar as the page scrolls. It never hides: once condensed it
 * stays visible at any scroll depth - the deeper you scroll the tighter the
 * chrome, then it holds.
 *
 * The API is composable parts, not a finished page: you keep your own
 * wordmark, nav and CTA and graft the condense choreography onto them.
 *
 *  - `ShrinkHeader` owns the page `useScroll` and turns scroll depth into a
 *    spring-smoothed condense progress (0 at the top, 1 once past
 *    `condenseDistance`), then publishes it - plus the derived fill scale and
 *    row recentre offset - to its parts through context. Its own CSS height is
 *    a constant (`tallHeight`) that NEVER animates.
 *  - `ShrinkHeaderFill` is the background-only fill layer: it scales vertically
 *    from its top edge (`scaleY`) and fades its opacity in as the header
 *    condenses, so the bar visually shrinks and its border/shadow/blur chrome
 *    fades in - all on the compositor, never a height write.
 *  - `ShrinkHeaderRow` is the content row: it rides a matching `translateY` so
 *    the (unshrunk) wordmark/nav/CTA stay vertically centred against the now
 *    visually-smaller fill.
 *  - `useCondenseProgress` hands a consumer the raw 0 -> 1 condense progress
 *    MotionValue, for scaling their own clusters (the wordmark and nav/CTA each
 *    ride their own `scale` off it) or deriving any other condense-linked
 *    transform.
 *
 * The performance constraint is the whole design: the header's height is a
 * layout-affecting property, so animating it would thrash layout every frame.
 * Instead the height stays constant and a text-free fill layer scales (a pure
 * compositor operation, and text-free so a vertical scale reads as a clean
 * size change rather than distorted glyphs) while the content row and clusters
 * ride `translateY`/`scale`. Timing reads only the Motion UI theme
 * (`@motion/ui-theme`) - the smoothing is the `gentle` transition - so feel is
 * never a prop. Styling reads only shadcn's semantic Tailwind vocabulary. The
 * geometry (`tallHeight`/`compactHeight`) and the scroll trigger
 * (`condenseDistance`) are shape, not feel, so they are props.
 */

/**
 * ==============   Constants   ================
 */

/** The header's real, constant CSS height (px) at the top of the page, before
 *  it condenses. A layout dimension, not a timing value - it is set once and
 *  never animates (that is the point of the mechanic). */
const DEFAULT_TALL_HEIGHT = 104

/** The fill layer's visual height (px) once fully condensed. The fill's
 *  `scaleY` runs from 1 down to `compactHeight / tallHeight`; the header's own
 *  height stays `tallHeight` throughout. */
const DEFAULT_COMPACT_HEIGHT = 54

/** The scroll distance (px) over which the header condenses, when a consumer
 *  does not set `condenseDistance`. */
const DEFAULT_CONDENSE_DISTANCE = 220

/**
 * ==============   Motion mode   ================
 */

/* Theme reduced-motion strategy, shared by the header. Scroll-linked condense
 * is a continuous effect, not a one-time entrance, so BOTH reduced-motion
 * tiers ("off" and "calm") pin it: the header renders permanently at its
 * compact, solid visual state rather than scrubbing with scroll. Works with no
 * provider mounted (falls back to defaultTheme), so the header is safe
 * standalone. */

/**
 * ==============   Header context   ================
 */

interface ShrinkHeaderContextValue {
  /** Condense progress: 0 at the top of the page, 1 once scrolled past
   *  `condenseDistance`. A spring-smoothed MotionValue. */
  condense: MotionValue<number>
  /** The fill layer's vertical scale, 1 -> `compactHeight / tallHeight`. */
  fillScaleY: MotionValue<number>
  /** The content row's recentre offset (px), 0 -> `-(tall - compact) / 2`,
   *  keeping the row centred against the visually-smaller fill. */
  rowY: MotionValue<number>
  /** Whether the condense scrubs with scroll (false pins it compact for
   *  reduced motion). */
  motionAllowed: boolean
}

const ShrinkHeaderContext = createContext<ShrinkHeaderContextValue | null>(null)

function useShrinkHeaderContext(part: string): ShrinkHeaderContextValue {
  const ctx = useContext(ShrinkHeaderContext)
  if (!ctx) {
    throw new Error(`${part} must be rendered inside a <ShrinkHeader>.`)
  }
  return ctx
}

/**
 * ==============   ShrinkHeader   ================
 */

export interface ShrinkHeaderProps {
  /** The header contents: a `ShrinkHeaderFill` and a `ShrinkHeaderRow` (which
   *  wraps your wordmark, nav and CTA). */
  children?: ReactNode
  /** Scroll distance (px) over which the header condenses from transparent and
   *  full-height to solid and compact. Defaults to `220`. */
  condenseDistance?: number
  /** The header's constant height (px) at the top of the page. Defaults to
   *  `104`. Never animates - the fill layer scales instead. */
  tallHeight?: number
  /** The fill's visual height (px) once fully condensed. Defaults to `54`. */
  compactHeight?: number
  /** Merged onto the `<header>` element, last. The header is fixed to the top
   *  at full width; use this for a font base, extra z-index, etc. */
  className?: string
}

/**
 * The fixed header root. Owns the page `useScroll`, turns scroll depth into a
 * spring-smoothed condense progress and the derived fill scale / row recentre
 * offset, and publishes them to its parts via context. Its `<header>` is fixed
 * to the top of the viewport at a constant `tallHeight` - the height NEVER
 * animates; the fill layer inside it scales instead.
 */
export function ShrinkHeader({
  children,
  condenseDistance = DEFAULT_CONDENSE_DISTANCE,
  tallHeight = DEFAULT_TALL_HEIGHT,
  compactHeight = DEFAULT_COMPACT_HEIGHT,
  className,
}: ShrinkHeaderProps) {
  const uiTheme = useMotionUITheme()
  const motionMode = uiTheme.motionMode
  const motionAllowed = motionMode === "full"
  const { scrollY } = useScroll()

  // Condense progress: 0 at the top, 1 once scrolled `condenseDistance` px.
  // Under reduced motion the output collapses to a constant 1 (chrome always
  // solid, always at compact visual size) rather than swapping the transform
  // out conditionally, so the hook is always called with the same shape.
  const condenseRaw = useTransform(
    scrollY,
    [0, condenseDistance],
    motionAllowed ? [0, 1] : [1, 1]
  )
  const condense = useSpring(condenseRaw, uiTheme.transitions.gentle)

  // Geometry: the fill scales from its top edge down to the compact ratio, and
  // the content row rides down half the height it loses so it stays centred
  // against the visually-smaller fill. Pure compositor transforms - no height
  // write anywhere.
  const fillCompactScale = compactHeight / tallHeight
  const rowCompactOffset = -(tallHeight - compactHeight) / 2
  const fillScaleY = useTransform(condense, [0, 1], [1, fillCompactScale])
  const rowY = useTransform(condense, [0, 1], [0, rowCompactOffset])

  const value: ShrinkHeaderContextValue = {
    condense,
    fillScaleY,
    rowY,
    motionAllowed,
  }

  return (
    <ShrinkHeaderContext.Provider value={value}>
      <header
        // height is a static, one-time write (never animated), so it does not
        // thrash layout - that is exactly why the fill scales instead.
        style={{ height: tallHeight }}
        className={`fixed inset-x-0 top-0 z-50 w-full${
          className ? ` ${className}` : ""
        }`}
      >
        {children}
      </header>
    </ShrinkHeaderContext.Provider>
  )
}

/**
 * ==============   ShrinkHeaderFill   ================
 */

/** The fill's translucent chrome tone: an 88% `--card`-toward-transparent srgb
 *  mix. A backdrop-blur navbar fill is chrome sitting OVER page content, not
 *  drawn ink, so it is deliberately translucent. A tone shadcn does not name,
 *  derived inline off `--card`. */
const FILL_TONE = "color-mix(in srgb, var(--card) 88%, transparent)"

export interface ShrinkHeaderFillProps {
  /** Merged onto the fill element, last - override the surface, border, shadow
   *  or blur here. The defaults (a hairline bottom border, a soft shadow, a
   *  backdrop blur and the translucent card tone) are the condensed-bar chrome;
   *  pass classes to tune them. */
  className?: string
  /** Merged onto the fill element's inline style, last, so a consumer can
   *  override the default translucent tone. */
  style?: CSSProperties
}

/**
 * The background-only fill layer. It is `aria-hidden` (pure chrome, no text),
 * pinned to the header bounds, and scales vertically from its TOP edge
 * (`scaleY`, origin-top) while fading its opacity in as the header condenses -
 * so the bar visually shrinks from full-height-transparent to compact-solid
 * and its border/shadow/blur "fade in" as one with the fill's own opacity.
 * Both are compositor-only transforms. Must be rendered inside a
 * `<ShrinkHeader>`.
 */
export function ShrinkHeaderFill({ className, style }: ShrinkHeaderFillProps) {
  const { condense, fillScaleY } = useShrinkHeaderContext("<ShrinkHeaderFill>")

  return (
    <motion.div
      aria-hidden="true"
      className={`absolute inset-0 origin-top border-b border-border shadow-lg backdrop-blur-md${
        className ? ` ${className}` : ""
      }`}
      style={{
        backgroundColor: FILL_TONE,
        ...style,
        opacity: condense,
        scaleY: fillScaleY,
      }}
    />
  )
}

/**
 * ==============   ShrinkHeaderRow   ================
 */

export interface ShrinkHeaderRowProps {
  /** The row contents: your wordmark, nav and CTA. Scale them yourself off
   *  `useCondenseProgress` so they condense with the bar. */
  children?: ReactNode
  /** Merged onto the row element, last. Use it for the row's layout - measure,
   *  centring, horizontal padding, flex distribution. */
  className?: string
}

/**
 * The content row. Rides a `translateY` (derived from the same condense
 * progress) so its contents stay vertically centred against the
 * visually-smaller fill as the header condenses. Sits above the fill (`z-10`)
 * and fills the header height. Must be rendered inside a `<ShrinkHeader>`.
 */
export function ShrinkHeaderRow({ children, className }: ShrinkHeaderRowProps) {
  const { rowY } = useShrinkHeaderContext("<ShrinkHeaderRow>")
  const rowTransform = useMotionTemplate`translateY(${rowY}px)`

  return (
    <motion.div
      className={`relative z-10 flex h-full w-full items-center${
        className ? ` ${className}` : ""
      }`}
      style={{ transform: rowTransform }}
    >
      {children}
    </motion.div>
  )
}

/**
 * ==============   useCondenseProgress   ================
 */

/**
 * Returns the enclosing `ShrinkHeader`'s raw condense progress MotionValue
 * (0 at the top of the page, 1 once fully condensed). Scale your own clusters
 * off it - `useTransform(condense, [0, 1], [1, 0.82])` for a wordmark that
 * shrinks to 82%, say - or derive any other condense-linked transform. Throws
 * if called outside a `ShrinkHeader`.
 */
export function useCondenseProgress(): MotionValue<number> {
  return useShrinkHeaderContext("useCondenseProgress").condense
}
