"use client"

import { motion } from "motion/react"
import type { CSSProperties, ReactNode, Ref } from "react"
import { useMotionUITheme, useMotionUITransition } from "@/components/motion-ui/ui-theme"

/**
 * ==============   Constants   ================
 */

/** The default non-highlighted fill: 55% `--foreground` mixed into `--card`,
 *  an opaque meter-fill tone shadcn does not name. A bar sitting on a
 *  different surface passes the matching mix via `tone`. */
const DEFAULT_FILL_TONE = "color-mix(in srgb, var(--foreground) 55%, var(--card))"

/** The reference-tick tone: 62% `--foreground` into `--background`, biased
 *  toward the page surface so the mark stays legible over both a neutral fill
 *  and the brighter `--primary` fill. Decorative, so it never needs to clear
 *  AA - the tick's meaning is carried by an sr-only equivalent in your label
 *  slot. */
const TICK_TONE = "color-mix(in srgb, var(--foreground) 62%, var(--background))"

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/* Theme reduced-motion strategy, shared with the kit's other reveals: "off"
 * mounts no animation (the fill renders at its final width); "calm" keeps an
 * opacity fade but drops the scaleX travel and the gate wait; full motion
 * springs the fill out of its left edge once the gate releases. defaultTheme
 * ships "calm". */

/**
 * ==============   ProgressBar   ================
 */

export interface ProgressBarProps {
  /** Fill length as a share in [0,1] (0 = empty, 1 = full). Drives the
   *  rendered fill width and, when `progressbar` is set, the reported
   *  `aria-valuenow` as a whole percentage. Values outside [0,1] are clamped. */
  value: number
  /** Animate the fill in with a left-anchored `scaleX` reveal on the theme's
   *  `ui` spring instead of painting it statically. Gate the reveal with
   *  `revealed` and cascade a column of bars with `index`. Default `false`: a
   *  static determinate meter, the shape a media scrubber wants. */
  reveal?: boolean
  /** Gate for `reveal`: while `false` the fill holds empty (`scaleX 0`); flip
   *  it `true` to release the reveal. Drive it from your own entrance
   *  choreography so a row of bars stays at zero until the container has
   *  settled, then fills in one beat. Ignored when `reveal` is `false`.
   *  Default `true`: reveals as soon as it mounts / scrolls into view. */
  revealed?: boolean
  /** Stagger index for `reveal`: the reveal spring is delayed by
   *  `index * theme.stagger.base`, so a column of bars cascades in order.
   *  Ignored when `reveal` is `false`. Default `0`. */
  index?: number
  /** A fixed reference marker painted over the track, as a share in [0,1]
   *  (e.g. a category median the fill is benchmarked against). Omit for no
   *  tick. Decorative and `aria-hidden`: carry its meaning with an sr-only
   *  equivalent inside `valueLabel`. */
  referenceTick?: number
  /** Paint the fill with the brand slot (`bg-primary`) - the one highlighted
   *  row in a group of bars. Default `false`: the neutral `tone` fill. */
  highlight?: boolean
  /** The opaque colour of a non-highlighted fill. Defaults to a 55%
   *  `--foreground` into `--card` mix; pass your own `color-mix` off a
   *  semantic var when the bar sits on a different surface. Never a raw hex -
   *  keep it derived off the theme. Ignored when `highlight` is set. */
  tone?: string
  /** Track height: `"sm"` is a 4px hairline (a media scrubber), `"md"` the 8px
   *  default (a benchmark / funnel bar). */
  size?: "sm" | "md"
  /** Expose the track as an ARIA `progressbar` with `aria-valuemin` 0,
   *  `aria-valuemax` 100 and `aria-valuenow` derived from `value`. Pair with
   *  `aria-label`. Omit when the surrounding label already carries the value
   *  (the benchmark / funnel case) - then the track is `aria-hidden`. */
  progressbar?: boolean
  /** Accessible name for the track when `progressbar` is set. */
  "aria-label"?: string
  /** Leading label slot, laid out opposite `valueLabel`. Fully styled by you
   *  (a metric name, a funnel step, an elapsed time). Omit for a bare track. */
  label?: ReactNode
  /** Trailing label slot, laid out opposite `label`. Fully styled by you (the
   *  percentage plus a trend badge, or a remaining time). Put any sr-only
   *  detail - "category median 78%, up" - inside this node. */
  valueLabel?: ReactNode
  /** Where the label row sits relative to the track: `"top"` above (benchmark
   *  / funnel) or `"bottom"` below (a scrubber's time labels). Default
   *  `"top"`. No effect when both label slots are omitted. */
  labelPlacement?: "top" | "bottom"
  /** Merged onto the root wrapper. Set spacing (`gap-*`) and layout here. */
  className?: string
  /** Merged onto the root wrapper, for consumers that need to measure it. */
  ref?: Ref<HTMLDivElement>
}

/** A horizontal progress track with a determinate fill. Static by default (a
 *  determinate meter); pass `reveal` to spring the fill out of its left edge
 *  on the theme's `ui` spring, gated by `revealed` and cascaded by `index`.
 *  Add a `referenceTick` for a benchmark mark, `highlight` for the brand fill,
 *  `progressbar` for the ARIA role, and the `label`/`valueLabel` slots for a
 *  label row. */
export function ProgressBar({
  value,
  reveal = false,
  revealed = true,
  index = 0,
  referenceTick,
  highlight = false,
  tone = DEFAULT_FILL_TONE,
  size = "md",
  progressbar = false,
  "aria-label": ariaLabel,
  label,
  valueLabel,
  labelPlacement = "top",
  className,
  ref,
}: ProgressBarProps) {
  const uiTheme = useMotionUITheme()
  const uiTransition = useMotionUITransition("ui")
  const motionMode = uiTheme.motionMode
  const still = motionMode === "off"
  const calm = motionMode === "calm"

  const share = clamp01(value)
  const viewport = { once: uiTheme.inView.once, amount: uiTheme.inView.amount }

  // Per-tier fill motion. Static (`reveal` off) and "off" render at the final
  // width with no animation. "calm" fades the fill in at its final width on
  // scroll-in, no scaleX travel and no gate wait. Full motion springs scaleX
  // out of the left edge once `revealed` flips, delayed by the per-index
  // stagger - so a column of bars cascades and never races its container
  // entrance. No standing `will-change`: Motion promotes for the active
  // animation and demotes after.
  const fillMotion =
    !reveal || still
      ? { initial: false as const }
      : calm
        ? {
            initial: { opacity: 0 },
            whileInView: { opacity: 1 },
            viewport,
            transition: { ...uiTransition },
          }
        : {
            initial: { scaleX: 0 },
            animate: { scaleX: revealed ? 1 : 0 },
            transition: {
              ...uiTransition,
              delay: index * uiTheme.stagger.base,
            },
          }

  const fillStyle: CSSProperties = {
    width: `${share * 100}%`,
    ...(highlight ? {} : { backgroundColor: tone }),
  }

  const hasLabelRow = label != null || valueLabel != null
  const labelRow = hasLabelRow ? (
    <div className="flex w-full items-baseline justify-between gap-4">
      <span className="min-w-0">{label}</span>
      {valueLabel != null ? <span className="shrink-0">{valueLabel}</span> : null}
    </div>
  ) : null

  return (
    <div
      ref={ref}
      className={`flex w-full flex-col gap-2${className ? ` ${className}` : ""}`}
    >
      {labelPlacement === "top" ? labelRow : null}

      <div
        role={progressbar ? "progressbar" : undefined}
        aria-label={progressbar ? ariaLabel : undefined}
        aria-valuemin={progressbar ? 0 : undefined}
        aria-valuemax={progressbar ? 100 : undefined}
        aria-valuenow={progressbar ? Math.round(share * 100) : undefined}
        aria-hidden={progressbar ? undefined : true}
        className={`relative w-full overflow-hidden rounded-full bg-muted ${size === "sm" ? "h-1" : "h-2"}`}
      >
        <motion.div
          className={`absolute inset-y-0 left-0 origin-left rounded-full${highlight ? " bg-primary" : ""}`}
          style={fillStyle}
          {...fillMotion}
        />

        {/* Category-median reference tick: an opaque neutral mark centred on
            its share, sitting above the fill. Decorative - the label slot
            carries the accessible equivalent. */}
        {referenceTick !== undefined ? (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 w-[2px] -translate-x-1/2"
            style={{
              left: `${clamp01(referenceTick) * 100}%`,
              backgroundColor: TICK_TONE,
            }}
          />
        ) : null}
      </div>

      {labelPlacement === "bottom" ? labelRow : null}
    </div>
  )
}
