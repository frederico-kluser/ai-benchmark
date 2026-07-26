import { animate, motion, useMotionValue } from "motion/react"
import { useEffect, useId, useRef } from "react"
import { useMotionUITheme, useMotionUITransition } from "@/components/motion-ui/ui-theme"

/**
 * ==============   Constants   ================
 */

// The neutral (non-accent) chart tone and the gridline tone: chart marks are
// tones shadcn does not name, so they are derived inline via color-mix off the
// semantic vars.
const NEUTRAL_LINE = "color-mix(in srgb, var(--foreground) 45%, var(--muted))"
const NEUTRAL_AREA = "color-mix(in srgb, var(--foreground) 10%, var(--muted))"
const GRID_STROKE =
  "color-mix(in srgb, var(--foreground) 8%, var(--background))"

// Default viewBox geometry. preserveAspectRatio is "none", so these are a
// normalisation space, not a pixel size; the chart stretches to fill whatever
// width/height the className gives its <svg>.
const DEFAULT_WIDTH = 280
const DEFAULT_HEIGHT = 64
const DEFAULT_PAD_Y = 10

/**
 * ==============   buildSparkPath   ================
 */

/** Geometry options for `buildSparkPath` - the normalised viewBox the points
 *  are mapped into. Matches a `Sparkline`'s `width`/`height`/`padY`. */
export interface SparkPathOptions {
  /** viewBox width the points span horizontally. Default 280. */
  width?: number
  /** viewBox height the points are scaled within. Default 64. */
  height?: number
  /** Vertical inset, so the peak and trough never touch the top/bottom edge.
   *  Default 10. */
  padY?: number
}

/** The shapes `buildSparkPath` returns: the line `d`, the closed-to-baseline
 *  area `d`, and the mapped points (with `first`/`last` broken out for an
 *  endpoint dot). */
export interface SparkGeometry {
  /** The `M ... L ...` line path across every reading. */
  d: string
  /** `d` closed down to the baseline and back - the fillable area path. */
  areaD: string
  /** Every reading mapped to a viewBox point. */
  points: { x: number; y: number }[]
  /** The first (left-most) point, omitted for an empty history. */
  first?: { x: number; y: number }
  /** The last (right-most) point, omitted for an empty history. */
  last?: { x: number; y: number }
}

/**
 * Maps a numeric `history` window to sparkline geometry: each reading becomes
 * an evenly-spaced point, min/max-normalised into the padded viewBox, then
 * joined into a line `d` and a baseline-closed area `d`. Pure geometry (no
 * React, no timing), exported so a consumer can feed their own history and
 * drive a `Sparkline` - or draw the shapes themselves.
 */
export function buildSparkPath(
  history: number[],
  options: SparkPathOptions = {},
): SparkGeometry {
  const {
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    padY = DEFAULT_PAD_Y,
  } = options
  if (history.length === 0) {
    return {
      d: "",
      areaD: "",
      points: [],
      first: undefined,
      last: undefined,
    }
  }
  const max = Math.max(...history)
  const min = Math.min(...history)
  const range = Math.max(1, max - min)
  // Guard a single-reading window so the step is finite (a lone point sits at
  // x 0 rather than dividing by zero).
  const step = width / Math.max(1, history.length - 1)
  const points = history.map((value, i) => {
    const x = i * step
    const norm = (value - min) / range
    const y = height - padY - norm * (height - padY * 2)
    return { x, y }
  })
  const d = points.reduce(
    (path, point, i) =>
      i === 0 ? `M ${point.x},${point.y}` : `${path} L ${point.x},${point.y}`,
    "",
  )
  const first = points[0]
  const last = points[points.length - 1]
  const areaD = `${d} L ${last.x},${height} L ${first.x},${height} Z`
  return { d, areaD, points, first, last }
}

/** Motion targets for a data-driven state change. Keeping the line, area, and
 * endpoint in one geometry-derived object ensures all three marks animate to
 * the same reading window rather than updating on separate paths. */
export function buildSparkAnimation(geometry: SparkGeometry) {
  return {
    line: { d: geometry.d },
    area: { d: geometry.areaD },
    dot: geometry.last
      ? { cx: geometry.last.x, cy: geometry.last.y }
      : undefined,
  }
}

/**
 * ==============   Sparkline   ================
 */

/** The line/area colour tier. `"primary"` paints the brand accent (a
 *  `--primary` line over a fading `--primary` area gradient); `"neutral"`
 *  paints a quiet `--foreground`-derived chart tone (a flat area), reserving
 *  the accent for the endpoint dot only. */
export type SparklineTone = "primary" | "neutral"

export interface SparklineProps {
  /** Data mode: a window of readings mapped to the curve via `buildSparkPath`.
   *  Re-render with a fresh array to morph the line, area, and endpoint to the
   *  next state. Takes precedence over `path`. */
  history?: number[]
  /** Literal mode: a hand-drawn SVG path `d` string, used verbatim as the
   *  line (and closed to the baseline for the area). Ignored when `history`
   *  is given. */
  path?: string
  /** viewBox width. Also the baseline width the area closes across and the
   *  default endpoint-dot x in literal mode. Default 280. */
  width?: number
  /** viewBox height. Also the baseline the area closes down to. Default 64. */
  height?: number
  /** Vertical inset for `history` mapping (see `SparkPathOptions.padY`).
   *  Default 10. */
  padY?: number
  /** Line/area colour tier (see `SparklineTone`). Default `"primary"`. */
  tone?: SparklineTone
  /** Render the area fill under the line (gradient for `primary`, flat for
   *  `neutral`). Default false. */
  area?: boolean
  /** Faint horizontal gridline y-positions, in viewBox coordinates. Omit for
   *  no grid. */
  grid?: number[]
  /** Render the accent endpoint dot. In data mode it sits on the last
   *  reading; in literal mode pass `dotX`/`dotY`. Default false. */
  dot?: boolean
  /** Endpoint-dot x in literal mode (data mode uses the last point). Defaults
   *  to `width`. */
  dotX?: number
  /** Endpoint-dot y in literal mode (data mode uses the last point). Defaults
   *  to 0. */
  dotY?: number
  /** Endpoint-dot radius. Default 3.5. */
  dotRadius?: number
  /** Draw the line in once via a `pathLength` reveal (paint-tier, one-shot).
   *  Default false renders the line already drawn. */
  draw?: boolean
  /** Gate for the `draw` reveal: the line holds at `pathLength` 0 until this
   *  is true, then draws once - so a consumer can wait for a panel entrance.
   *  Default true. */
  revealed?: boolean
  /** Bump this on every live tick to pulse the endpoint dot (a compositor
   *  `scale` keyframe). Omit for a static dot. Requires `dot` and motion. */
  tickKey?: number
  /** Line stroke width, in viewBox units. Default 2. */
  strokeWidth?: number
  /** Keep the stroke a constant screen width regardless of any transform
   *  scaling the chart (crisp under a zoom). Default false. */
  nonScalingStroke?: boolean
  /** Reduced-motion gate. When omitted, derived from the theme + the user's
   *  `prefers-reduced-motion` - pass a section's own gate to keep the whole
   *  panel in step. */
  motionAllowed?: boolean
  /** An accessible label. When set the chart is exposed as `role="img"` with
   *  this label; omitted, it is `aria-hidden` decoration (the default, since a
   *  consumer's caption usually carries the meaning). */
  label?: string
  /** Merged onto the `<svg>`. Size the chart here (e.g. `h-24 w-full`). */
  className?: string
}

/* Theme reduced-motion strategy: "off" freezes every animation (the line
 * renders fully drawn, the dot never pulses); "calm" keeps opacity but drops
 * travel - for a paint-tier draw and a scale pulse there is nothing to keep,
 * so both collapse to "not allowed". defaultTheme ships "calm". */

/**
 * The line + area micro-chart. Renders only the `<svg>`; compose a caption or
 * delta beside it in your own markup (that copy is content, not part of the
 * mechanic). Every mark is compositor- or paint-friendly: the draw-in is a
 * one-shot `pathLength`, the dot pulse is a `scale` transform, and live data
 * morphs the line, area, and endpoint together between ticks.
 */
export function Sparkline({
  history,
  path,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  padY = DEFAULT_PAD_Y,
  tone = "primary",
  area = false,
  grid,
  dot = false,
  dotX,
  dotY,
  dotRadius = 3.5,
  draw = false,
  revealed = true,
  tickKey,
  strokeWidth = 2,
  nonScalingStroke = false,
  motionAllowed,
  label,
  className,
}: SparklineProps) {
  const { motionMode } = useMotionUITheme()
  const fullMotion = motionMode === "full"
  const allowMotion = motionAllowed ?? fullMotion
  const gentle = useMotionUITransition("gentle") // the draw-in reveal
  const ui = useMotionUITransition("ui") // the live graph state morph
  const snap = useMotionUITransition("snap") // the per-tick dot pulse

  // A per-instance gradient id, so two primary-area sparklines on one page do
  // not collide on the same <linearGradient>. useId can emit colons, which are
  // invalid inside a url(#...) reference, so strip them.
  const gradientId = `spark-fill-${useId().replace(/:/g, "")}`

  // The leading dot pulses on each new tick (skip the first commit so it does
  // not fire on mount). transformBox fill-box scales the circle about its own
  // centre; the will-change is scoped to this transform, not stood permanently.
  const dotScale = useMotionValue(1)
  const firstTick = useRef(true)
  useEffect(() => {
    if (firstTick.current) {
      firstTick.current = false
      return
    }
    if (!allowMotion || tickKey === undefined) return
    const controls = animate(dotScale, [1, 1.7, 1], { ...snap })
    return () => controls.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickKey, allowMotion])

  // Resolve the geometry: data mode maps the history; literal mode uses the
  // path verbatim and closes it to the baseline for the area.
  let lineD = ""
  let areaD = ""
  let dotPos = { x: dotX ?? width, y: dotY ?? 0 }
  let stateAnimation: ReturnType<typeof buildSparkAnimation> | undefined
  if (history) {
    const geometry = buildSparkPath(history, { width, height, padY })
    lineD = geometry.d
    areaD = geometry.areaD
    if (geometry.last) dotPos = geometry.last
    stateAnimation = buildSparkAnimation(geometry)
  } else if (path) {
    lineD = path
    areaD = `${path} L ${width} ${height} L 0 ${height} Z`
  }

  const drawing = draw && allowMotion
  const hasLine = lineD.length > 0
  const morphing = Boolean(history?.length && allowMotion)
  const strokeColor = tone === "primary" ? "var(--primary)" : NEUTRAL_LINE
  const morphTransition = { ...ui, type: "tween" as const }
  const lineAnimation = drawing
    ? {
        ...(morphing ? stateAnimation?.line : undefined),
        pathLength: revealed ? 1 : 0,
      }
    : morphing
      ? stateAnimation?.line
      : draw
        ? { pathLength: 1 }
        : undefined

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`w-full${className ? ` ${className}` : ""}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
    >
      {area && hasLine && tone === "primary" && (
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
      )}

      {grid?.map((y) => (
        <line
          key={y}
          x1="0"
          y1={y}
          x2={width}
          y2={y}
          strokeWidth="1"
          style={{ stroke: GRID_STROKE }}
        />
      ))}

      {area &&
        hasLine &&
        (tone === "primary" ? (
          <motion.path
            d={areaD}
            fill={`url(#${gradientId})`}
            animate={morphing ? stateAnimation?.area : undefined}
            transition={morphing ? morphTransition : undefined}
          />
        ) : (
          <motion.path
            d={areaD}
            style={{ fill: NEUTRAL_AREA }}
            animate={morphing ? stateAnimation?.area : undefined}
            transition={morphing ? morphTransition : undefined}
          />
        ))}

      <motion.path
        d={lineD}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect={nonScalingStroke ? "non-scaling-stroke" : undefined}
        // Draw-in: held at pathLength 0 until `revealed`, then drawn once over
        // the gentle reveal token (as a tween, so it fills at a steady rate).
        // Reduced motion (or draw off) renders the line already drawn.
        initial={drawing ? { pathLength: 0 } : false}
        animate={lineAnimation}
        transition={
          drawing
            ? {
                d: morphTransition,
                pathLength: { ...gentle, type: "tween" },
              }
            : morphing
              ? morphTransition
              : undefined
        }
      />

      {dot && hasLine && (
        <motion.circle
          cx={dotPos.x}
          cy={dotPos.y}
          r={dotRadius}
          fill="var(--primary)"
          animate={morphing ? stateAnimation?.dot : undefined}
          transition={morphing ? morphTransition : undefined}
          // Pulse on tick: scale about the circle's own centre; will-change is
          // scoped to this transform, not stood permanently. Static when no
          // tickKey is driving it.
          style={
            tickKey !== undefined
              ? {
                  scale: dotScale,
                  transformBox: "fill-box",
                  willChange: "transform",
                }
              : undefined
          }
        />
      )}
    </svg>
  )
}
