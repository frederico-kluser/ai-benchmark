import { AnimateView } from "motion-plus/animate-view"
import { motion, useInView } from "motion/react"
import type { TargetAndTransition } from "motion/react"
import {
  createContext,
  useContext,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react"
import { useMotionUITheme, useMotionUITransition } from "@/components/motion-ui/ui-theme"

/**
 * Skeleton - a recessed shimmer-placeholder vocabulary for loading states.
 * shadcn already ships a `Skeleton` primitive, so the name lands as a
 * first-class citizen; what this adds is the Motion choreography.
 *
 * The load story is the product, not a finished page. It ships one primitive
 * plus two independent reveal strategies, so you graft whichever handoff fits
 * onto your own content and copy:
 *
 *  - `Skeleton` is the shimmer bone: a recessed `bg-muted` block with a
 *    compositor-only `translateX` sweep, `useInView`-gated so the loop pauses
 *    off-screen, that sizes itself to invisibly-rendered children so the
 *    handoff has zero layout shift.
 *  - `useSkeletonSweep` is that gate on its own (the token-derived tween + the
 *    in-view / reduced-motion shimmering flag), for building a custom bone.
 *  - `SkeletonReveal` is the single-card handoff: skeleton and loaded card
 *    share one view-transition name and the old skeleton layer wipes away
 *    left-to-right under a `--wipe`-driven mask crossfade (motion-plus
 *    `AnimateView`). The `@property --wipe` registration and the
 *    `::view-transition-*` mask CSS ship with it.
 *  - `SkeletonResolveList` / `SkeletonResolveRow` / `useSkeletonResolve` are
 *    the row-by-row handoff: each row stacks its real content (in normal flow,
 *    defining the box) under a bones overlay, and the two crossfade on a
 *    per-row stagger so a feed fills in top-to-bottom with zero layout shift.
 *
 * Styling reads only shadcn's semantic Tailwind vocabulary; the shimmer
 * highlight is an OPAQUE `color-mix` off `--muted`, never an alpha wash.
 * Timing reads only the Motion UI theme (`@motion/ui-theme`) - feel is never
 * a prop.
 */

/**
 * ==============   Motion mode   ================
 */

/* Theme reduced-motion gate: "off" mounts no animation (render the final
 * state), "calm" keeps opacity fades but drops travel and the continuous
 * shimmer. Works with no provider mounted (falls back to `defaultTheme`), so
 * every part is safe standalone. defaultTheme ships "calm". */

/**
 * ==============   useSkeletonSweep   ================
 */

/** The infinite compositor tween that drives a shimmer sweep - a linear,
 *  repeating `translateX` played over the `ambient` cycle. Derived from the
 *  theme, never hand-typed, so retuning the theme retimes every bone. */
export interface SweepTransition {
  type: "tween"
  duration: number
  ease: "linear"
  repeat: number
}

/** What `useSkeletonSweep` resolves: the gate and the tween a bone's sweep
 *  overlay consumes. */
export interface SkeletonSweep {
  /** True only when the shimmer should actually run: your `active` gate AND
   *  motion is allowed AND the observed element is on screen. Drive the sweep
   *  overlay's `animate`/`transition` off this. */
  shimmering: boolean
  /** The token-derived infinite tween for the sweep overlay. */
  sweepTransition: SweepTransition
}

/** Options for `useSkeletonSweep`. */
export interface UseSkeletonSweepOptions<T extends Element> {
  /** Ref to the element whose viewport presence gates the loop - typically the
   *  bone itself, or one shared stage wrapper gating a whole card of bones. */
  ref: RefObject<T | null>
  /** Your own gate, e.g. `!loaded`. The shimmer additionally, and
   *  independently, pauses under `prefers-reduced-motion` and while the
   *  observed element is off screen. Defaults to `true`. */
  active?: boolean
}

/**
 * Resolves the shimmer gate and cadence for a skeleton bone. The cadence is
 * derived from the `ambient` token (a shimmer wants a longer, calmer sweep, so
 * it runs at 2.5x the cycle length), and the gate folds together your `active`
 * flag, the theme's reduced-motion strategy, and the observed element's
 * viewport presence. Attach `ref` to the element you want to gate on. Used by
 * `Skeleton`; call it directly to build a bone with bespoke geometry that
 * still shares the kit's shimmer feel.
 */
export function useSkeletonSweep<T extends Element>({
  ref,
  active = true,
}: UseSkeletonSweepOptions<T>): SkeletonSweep {
  const ambient = useMotionUITransition("ambient")
  const { motionMode } = useMotionUITheme()
  const motionAllowed = motionMode === "full"
  const inView = useInView(ref)
  const sweepTransition: SweepTransition = {
    type: "tween",
    duration: ambient.duration * 2.5,
    ease: "linear",
    repeat: Infinity,
  }
  return { shimmering: active && motionAllowed && inView, sweepTransition }
}

/**
 * ==============   Skeleton   ================
 */

/** The shimmer sweep's ground: an OPAQUE srgb gradient, muted at both edges so
 *  it blends into the `bg-muted` bone it slides over, with a lighter
 *  foreground-into-muted band in the middle. Never an alpha wash - the
 *  highlight is drawn ink, so its contrast never depends on what happens to
 *  sit behind the block. The overlay is translated on the compositor; this
 *  only paints its surface. */
const SWEEP_GRADIENT =
  "linear-gradient(90deg, var(--muted) 0%, color-mix(in srgb, var(--foreground) 10%, var(--muted)) 50%, var(--muted) 100%)"

export interface SkeletonProps {
  /** Run the shimmer when `true`; hold a steady block when `false`. This is
   *  YOUR gate (typically `!loaded`); the bone additionally, and
   *  independently, holds steady under `prefers-reduced-motion` and while
   *  scrolled off screen, so you never fold those in yourself. Defaults to
   *  `true`. */
  animate?: boolean
  /** Merged onto the bone. Size and shape the placeholder here
   *  (`h-4 w-40`, `size-9 rounded-full`, ...); a bone with children instead
   *  sizes itself to them. */
  className?: string
  /** Extra inline styles, merged onto the bone. */
  style?: CSSProperties
  /** Rendered invisibly to size the bone to the exact geometry of the real
   *  content it stands in for, so the handoff has zero layout shift. Omit and
   *  size the bone with `className` instead. */
  children?: ReactNode
}

/**
 * A single skeleton placeholder: a recessed `bg-muted` block with a
 * compositor-only shimmer sweeping across it. Owns its own in-view gate, so an
 * off-screen bone never burns a compositor frame, and the sweep is a
 * literal-transform string, so it stays unambiguously compositor-only.
 * Decorative (`aria-hidden`): a screen reader hears the real content, not the
 * placeholder, so mark the loaded copy alive and the bones stay silent.
 */
export function Skeleton({
  animate = true,
  className,
  style,
  children,
}: SkeletonProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { shimmering, sweepTransition } = useSkeletonSweep({ ref, active: animate })
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={`relative overflow-hidden rounded-md bg-muted${className ? ` ${className}` : ""}`}
      style={style}
    >
      {children ? <div className="invisible">{children}</div> : null}
      <motion.span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        // Rest state: parked off to the left so no highlight shows when the
        // loop is paused (off screen or reduced motion). Literal-transform
        // keyframes keep the sweep unambiguously compositor-only.
        style={{ transform: "translateX(-100%)", backgroundImage: SWEEP_GRADIENT }}
        animate={
          shimmering
            ? { transform: ["translateX(-100%)", "translateX(100%)"] }
            : undefined
        }
        transition={shimmering ? sweepTransition : undefined}
      />
    </div>
  )
}

/**
 * ==============   SkeletonReveal   ================
 */

/** Injects the view-transition CSS a `SkeletonReveal` needs: the `@property
 *  --wipe` registration and the `::view-transition-*` mask rules for one
 *  handoff `name`. These pseudo-elements are generated on the document root,
 *  OUTSIDE any themed subtree, so shadcn vars do NOT resolve here - the rules
 *  use structural values only (a black/transparent mask, z-index). Rendered
 *  plain so it ships and applies identically under SSR and in the browser; a
 *  second reveal with the same `name` re-declares identical rules, which is
 *  harmless. */
function SkeletonRevealStyle({ name }: { name: string }) {
  const css = `@property --wipe {
  syntax: "<percentage>";
  inherits: true;
  initial-value: -100%;
}
::view-transition-group(${name}) {
  overflow: hidden;
}
::view-transition-image-pair(${name}) {
  mix-blend-mode: normal;
}
::view-transition-old(${name}) {
  z-index: 2;
  mask-image: linear-gradient(to right, black var(--wipe), transparent calc(var(--wipe) + 100%));
  -webkit-mask-image: linear-gradient(to right, black var(--wipe), transparent calc(var(--wipe) + 100%));
}`
  return <style dangerouslySetInnerHTML={{ __html: css }} />
}

export interface SkeletonRevealProps {
  /** Whether the skeleton is showing (`true`) or the loaded content has taken
   *  over (`false`). Flip it to run the handoff; you own the load timer. */
  loading: boolean
  /** The skeleton placeholder, shown while `loading`. Build it from `Skeleton`
   *  bones sized to your loaded content so the wipe has no layout shift. */
  skeleton: ReactNode
  /** The loaded content, shown once `loading` is `false`. Give it and the
   *  skeleton the same shell so `AnimateView` morphs shell-to-shell and only
   *  their contents crossfade. */
  children: ReactNode
  /** The shared view-transition name the skeleton and loaded layers hand off
   *  across. Must be unique per independent reveal on the page. Defaults to
   *  `velocity-skeleton-card`. */
  name?: string
  /** Merged onto the wrapper around the handoff (size the stage here). */
  className?: string
}

/**
 * The single-card load handoff. While `loading`, it shows your `skeleton`;
 * when `loading` flips to `false`, the skeleton and loaded layers - which
 * share the `name` view-transition name - crossfade, and the old skeleton
 * layer wipes away left-to-right under a `--wipe`-driven mask at the `gentle`
 * token's duration. Under reduced motion the wipe degrades: "calm" keeps a
 * plain opacity crossfade at the same perceived length, "off" is instant. The
 * `@property --wipe` and `::view-transition-*` CSS ship with the component, so
 * there is nothing extra to install.
 */
export function SkeletonReveal({
  loading,
  skeleton,
  children,
  name = "velocity-skeleton-card",
  className,
}: SkeletonRevealProps) {
  const { motionMode } = useMotionUITheme()
  const calm = motionMode === "calm"
  const motionAllowed = motionMode === "full"
  const gentle = useMotionUITransition("gentle")
  const wipeTransition = {
    type: "tween" as const,
    duration: gentle.duration,
    ease: gentle.ease,
  }
  // Full motion runs the mask wipe (--wipe drives the ::view-transition-old
  // mask); calm drops it to a plain opacity crossfade at the same perceived
  // length; "off" is instant.
  const update: TargetAndTransition = motionAllowed
    ? { "--wipe": ["100%", "-100%"], transition: wipeTransition }
    : calm
      ? { transition: wipeTransition }
      : { transition: { duration: 0 } }

  return (
    <div className={className}>
      <SkeletonRevealStyle name={name} />
      <AnimateView name={name} update={update}>
        {loading ? skeleton : children}
      </AnimateView>
    </div>
  )
}

/**
 * ==============   useSkeletonResolve   ================
 */

/** What `useSkeletonResolve` resolves for one row: the shared crossfade
 *  transition (carrying the per-row stagger delay) and the two animate targets
 *  the content and bones layers ride. */
export interface SkeletonResolve {
  /** True once this row has resolved to its loaded content. */
  loaded: boolean
  /** Whether full motion is allowed (false under reduced motion). */
  motionAllowed: boolean
  /** Transition for BOTH layers, so the bones fade out exactly as the content
   *  fades in. Carries the per-row `delay`. */
  transition: ReturnType<typeof useMotionUITransition> & { delay: number }
  /** `animate` target for the real-content layer: fades in and settles up a
   *  few px (no travel under reduced motion). */
  content: { opacity: number; transform: string }
  /** `animate` target for the bones overlay: fades out as the row resolves. */
  skeleton: { opacity: number }
}

/** Options for `useSkeletonResolve`. */
export interface UseSkeletonResolveOptions {
  /** This row's position, used to stagger its handoff after the rows above. */
  index: number
  /** Whether the feed is still loading (`true`) or has resolved (`false`). */
  loading: boolean
  /** Per-row delay step, in seconds. Defaults to the theme's `base` stagger. */
  stagger?: number
}

/**
 * Resolves the crossfade timing and animate targets for one row of a staggered
 * skeleton resolve. Reveal timing reads the `ui` token; the per-row delay is
 * `index * stagger` (theme `base` stagger by default), so the feed fills in
 * top-to-bottom. Both the stagger and the content-layer rise collapse under
 * reduced motion, and the reset (loading back to `true`) snaps every row
 * together with no delay. Used by `SkeletonResolveRow`; call it directly to
 * drive a bespoke row layout.
 */
export function useSkeletonResolve({
  index,
  loading,
  stagger,
}: UseSkeletonResolveOptions): SkeletonResolve {
  const reveal = useMotionUITransition("ui")
  const theme = useMotionUITheme()
  const motionAllowed = theme.motionMode === "full"
  const loaded = !loading
  const step = stagger ?? theme.stagger.base
  // Stagger only on the way IN, and only under full motion; the reset snaps
  // every row's bones back together with no delay.
  const delay = loaded && motionAllowed ? index * step : 0
  return {
    loaded,
    motionAllowed,
    transition: { ...reveal, delay },
    content: {
      opacity: loaded ? 1 : 0,
      transform:
        loaded || !motionAllowed
          ? "translateY(0px)"
          : `translateY(${theme.travel.hover}px)`,
    },
    skeleton: { opacity: loaded ? 0 : 1 },
  }
}

/**
 * ==============   SkeletonResolveList   ================
 */

interface SkeletonResolveContextValue {
  loading: boolean
  stagger?: number
}

const SkeletonResolveContext = createContext<SkeletonResolveContextValue | null>(
  null
)

export interface SkeletonResolveListProps {
  /** Whether the feed is still loading (`true`) or has resolved (`false`).
   *  Shared with every `SkeletonResolveRow` inside, so you set it once. */
  loading: boolean
  /** The rows - one `SkeletonResolveRow` per feed item (or your own markup
   *  driven by `useSkeletonResolve`). Rendered as-is, so you own the list
   *  element and its semantics. */
  children: ReactNode
  /** Per-row delay step, in seconds, shared with every row. Defaults to the
   *  theme's `base` stagger. */
  stagger?: number
}

/**
 * Shares one `loading` flag (and optional `stagger`) with the
 * `SkeletonResolveRow`s nested inside it, so you set the load state once rather
 * than on every row. Renders no DOM of its own - wrap it around your own list
 * element (a `<ul>`, a table body) and keep full control of the markup.
 */
export function SkeletonResolveList({
  loading,
  children,
  stagger,
}: SkeletonResolveListProps) {
  return (
    <SkeletonResolveContext.Provider value={{ loading, stagger }}>
      {children}
    </SkeletonResolveContext.Provider>
  )
}

/**
 * ==============   SkeletonResolveRow   ================
 */

export interface SkeletonResolveRowProps {
  /** This row's position, used to stagger its handoff after the rows above. */
  index: number
  /** The real content layer. Sits in normal flow and defines the row's box the
   *  whole time (invisible while loading), so nothing reflows at the handoff -
   *  give it its own padding and layout. */
  content: ReactNode
  /** The bones overlay - typically `Skeleton` bones laid out to mirror
   *  `content`'s geometry. Rendered absolutely on top and faded out as the row
   *  resolves. */
  skeleton: ReactNode
  /** Whether the feed is loading. Optional inside a `SkeletonResolveList`
   *  (inherited); required for a standalone row. */
  loading?: boolean
  /** Per-row delay step, in seconds. Falls back to the list's value, then the
   *  theme's `base` stagger. */
  stagger?: number
  /** Merged onto the row wrapper (the positioned container of both layers). */
  className?: string
}

/**
 * One row of a staggered skeleton resolve. Stacks your `content` (normal flow,
 * defining the box) under your `skeleton` overlay (absolute), and crossfades
 * the two on this row's staggered delay so the row resolves in place with zero
 * layout shift. Reads `loading`/`stagger` from an enclosing
 * `SkeletonResolveList` when present; pass `loading` directly for a standalone
 * row. Renders a `<div>` wrapper - put it inside your own `<li>`/row element.
 */
export function SkeletonResolveRow({
  index,
  content,
  skeleton,
  loading,
  stagger,
  className,
}: SkeletonResolveRowProps) {
  const ctx = useContext(SkeletonResolveContext)
  const isLoading = loading ?? ctx?.loading ?? false
  const step = stagger ?? ctx?.stagger
  const { loaded, transition, content: contentTarget, skeleton: skeletonTarget } =
    useSkeletonResolve({ index, loading: isLoading, stagger: step })

  return (
    <div className={`relative${className ? ` ${className}` : ""}`}>
      {/* Content layer: normal flow, so it defines the row's height the whole
          time; invisible and aria-hidden until its row resolves. */}
      <motion.div
        initial={false}
        animate={contentTarget}
        transition={transition}
        aria-hidden={!loaded}
      >
        {content}
      </motion.div>
      {/* Skeleton overlay: absolute on top, sized to the real content behind
          it, faded out exactly as the content fades in. */}
      <motion.div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        initial={false}
        animate={skeletonTarget}
        transition={transition}
      >
        {skeleton}
      </motion.div>
    </div>
  )
}
