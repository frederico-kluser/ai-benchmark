import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { motion } from "motion/react"
import {
  createContext,
  useContext,
  useId,
  useMemo,
  type ReactNode,
} from "react"
import { useMotionUITheme, useMotionUITransition } from "@/components/motion-ui/ui-theme"
import type { UITransition } from "@/components/motion-ui/ui-theme"

/**
 * Segmented toggle - a sliding-pill segmented control built on Base UI's
 * toggle-group primitive. Two or more real `aria-pressed` buttons share a
 * single selection pill that slides from the old option to the newly chosen
 * one on the theme's `snap` spring: a compositor-only transform (Motion
 * `layoutId` shared layout), no layout thrash.
 *
 * Base UI owns the commodity layer - the `role="group"` + `aria-pressed`
 * semantics and Arrow-key roving-focus navigation between options. Motion UI
 * owns the choreography: the shared pill, the themed feel, the
 * reduced-motion snap. A segmented control always has exactly one selection,
 * so the group ignores Base UI's deselect (pressing the active option again
 * keeps it pressed).
 *
 * The API is composable parts you graft onto your own layout, not a finished
 * control with baked-in copy:
 *
 *  - `SegmentedToggle` is the root: a controlled `value`/`onChange` group
 *    that owns the shared pill's `layoutId` and the theme-timed slide, and
 *    lays its options out as a bordered segmented shell.
 *  - `SegmentedToggleOption` is one option: Base UI's `Toggle` (a real
 *    `<button aria-pressed>`) whose `children` are its label (and any extra
 *    content, e.g. a "Save 20%" highlight). The option whose `value` matches
 *    the group's carries the sliding pill.
 *
 * Styling reads only shadcn's semantic Tailwind vocabulary; timing reads only
 * the Motion UI theme (`@motion/ui-theme`) - feel is never a prop. The pill's
 * fill is `bg-primary`, so it tracks your theme.
 */

/**
 * ==============   Focus ring   ================
 */

/** shadcn's ring utilities, the shared focus-visible treatment for every
 *  option button in this component. `ring-offset-background` keeps the ring
 *  legible on both `bg-background` and the `bg-card` shell. */
const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

/**
 * ==============   Reduced motion   ================
 */

/* Theme reduced-motion strategy: "still" mounts no animation, "calm" keeps
 * opacity fades but drops travel. Either way the pill must not slide - a
 * translating indicator is travel, so it snaps to the new option
 * (`duration: 0`) whenever motion is not fully allowed. defaultTheme ships
 * "calm". */

/**
 * ==============   Context   ================
 */

interface SegmentedToggleContextValue {
  /** The group's currently selected value. Selection itself is Base UI's job
   *  (the group's `onValueChange`); the context only lets each option read
   *  whether it carries the pill. */
  value: string
  /** The shared-layout id every option's pill animates under, so the single
   *  pill slides between options instead of cross-fading. Unique per group. */
  layoutId: string
  /** The theme transition the pill slides on (the `snap` token). */
  indicatorTransition: UITransition
  /** Whether the pill should slide (false under reduced motion: it snaps). */
  animateIndicator: boolean
}

const SegmentedToggleContext =
  createContext<SegmentedToggleContextValue | null>(null)

function useSegmentedToggleContext(who: string): SegmentedToggleContextValue {
  const ctx = useContext(SegmentedToggleContext)
  if (!ctx) throw new Error(`${who} must be rendered inside <SegmentedToggle>.`)
  return ctx
}

/**
 * ==============   SegmentedToggle (root)   ================
 */

export interface SegmentedToggleProps<T extends string = string> {
  /** The currently selected option's value (controlled). */
  value: T
  /** Called with the newly selected option's value when an option is pressed. */
  onChange: (value: T) => void
  /** Accessible name for the `role="group"` container (e.g. "Billing period").
   *  Strongly recommended - a segmented group with no label is opaque to
   *  screen-reader users. */
  ariaLabel?: string
  /** Override the shared pill's `layoutId`. Defaults to a per-instance id, so
   *  two toggles on one page never share a pill. Set this only if you need a
   *  stable id across remounts. */
  layoutId?: string
  /** Merged onto the segmented shell - extend the default bordered `bg-card`
   *  container (widths, a `w-full` stretch) here. */
  className?: string
  /** The `SegmentedToggleOption` children. */
  children?: ReactNode
}

/** The segmented toggle root: a controlled `role="group"` that owns the shared
 *  sliding pill and the theme-timed slide, and lays its options out as a
 *  bordered segmented shell. Renders a single container element whose base look
 *  is a `bg-card` pill row; extend it with `className`. */
export function SegmentedToggle<T extends string = string>({
  value,
  onChange,
  ariaLabel,
  layoutId,
  className,
  children,
}: SegmentedToggleProps<T>) {
  const generatedId = useId()
  const snap = useMotionUITransition("snap")
  const { motionMode } = useMotionUITheme()
  const motionAllowed = motionMode === "full"

  const ctx = useMemo<SegmentedToggleContextValue>(
    () => ({
      value,
      layoutId: layoutId ?? `segmented-toggle-${generatedId}`,
      indicatorTransition: snap,
      animateIndicator: motionAllowed,
    }),
    [value, layoutId, generatedId, snap, motionAllowed]
  )

  return (
    <SegmentedToggleContext.Provider value={ctx}>
      <ToggleGroupPrimitive
        value={[value]}
        onValueChange={(next: string[]) => {
          // A segmented control always has exactly one selection: Base UI
          // reports a deselect as an empty array, which we ignore so pressing
          // the active option again keeps it pressed.
          if (next[0] && next[0] !== value) onChange(next[0] as T)
        }}
        aria-label={ariaLabel}
        className={`relative inline-flex items-center gap-1 rounded-sm border border-border bg-card p-1${className ? ` ${className}` : ""}`}
      >
        {children}
      </ToggleGroupPrimitive>
    </SegmentedToggleContext.Provider>
  )
}

/**
 * ==============   SegmentedToggleOption   ================
 */

export interface SegmentedToggleOptionProps {
  /** This option's value. When it matches the group's `value` the option is
   *  selected and carries the sliding pill. */
  value: string
  /** The option's content: its label, plus any extra content that rides in the
   *  segment (a "Save 20%" highlight, a small icon). Content is yours - the
   *  component owns only the choreography and the segment styling. */
  children?: ReactNode
  /** Merged onto the option `<button>`. */
  className?: string
}

/** One option of the toggle: Base UI's `Toggle` (a real `<button
 *  aria-pressed>` with Arrow-key navigation from the group) timed by the
 *  theme's snap colour transition, carrying the shared sliding pill when it is
 *  the selected value. Must be rendered inside a `SegmentedToggle`. */
export function SegmentedToggleOption({
  value,
  children,
  className,
}: SegmentedToggleOptionProps) {
  const ctx = useSegmentedToggleContext("SegmentedToggleOption")
  const selected = ctx.value === value

  return (
    <TogglePrimitive
      value={value}
      className={`relative z-10 flex items-center gap-2 rounded-sm px-4 py-2 text-sm font-medium ${FOCUS_RING} ${
        selected
          ? "text-primary-foreground"
          : "text-muted-foreground hover:text-foreground"
      } transition-colors duration-[var(--motion-ui-transition-snap-duration)] ease-[var(--motion-ui-transition-snap)]${className ? ` ${className}` : ""}`}
    >
      {/* Label above the pill: the pill is absolute inset-0 behind this span,
          which keeps its own stacking context so the text stays legible on
          the primary fill. */}
      <span className="relative z-10 flex items-center gap-2 leading-none">
        {children}
      </span>
      {selected && (
        <motion.span
          layoutId={ctx.layoutId}
          className="absolute inset-0 rounded-sm bg-primary"
          transition={
            ctx.animateIndicator ? { ...ctx.indicatorTransition } : { duration: 0 }
          }
          aria-hidden="true"
        />
      )}
    </TogglePrimitive>
  )
}
