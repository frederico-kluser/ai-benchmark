"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { AnimatePresence, motion } from "motion/react"
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react"
import { useMotionUITheme, useMotionUITransition } from "@/components/motion-ui/ui-theme"
import type { UITransition } from "@/components/motion-ui/ui-theme"

/**
 * Smooth tabs - a sliding-indicator tabs choreography on Base UI's tabs
 * primitive. A segmented tablist whose active pill is a single shared-layout
 * element (one `layoutId`) that slides between tabs on the theme's `snap`
 * spring, paired with a directional panel crossfade (x-slide + blur +
 * opacity) driven by `AnimatePresence mode="sync"` with a signed direction,
 * stacked in one CSS grid cell so equal-height panels never collapse the
 * card between swaps.
 *
 * Base UI owns everything commodity - the selection semantics, the
 * `role="tablist"/"tab"/"tabpanel"` + aria-selected/aria-controls wiring, and
 * the roving-tabindex keyboard navigation (Arrow/Home/End; `activateOnFocus`
 * makes selection follow focus). Motion UI owns only what Base UI cannot
 * give you: the shared-layout pill, the directional crossfade, the themed
 * feel and the reduced-motion tiers - animation atop the primitives you
 * already use.
 *
 * This shares the sliding-pill primitive with `segmented-toggle`, but is a
 * separate component: it adds the directional panel crossfade and the full
 * tablist semantics a bare toggle does not carry.
 *
 * The API is composable parts sharing a context, not a finished page - you
 * supply your own tab labels and panel content and inherit the choreography,
 * the ARIA wiring, the keyboard nav, and the still/calm/motionAllowed
 * reduced-motion tiers:
 *
 *  - `SmoothTabs` is the root: it owns the selected value (controlled or
 *    uncontrolled), the slide direction, the shared pill `layoutId`, the
 *    theme-timed transitions, and the crossfade geometry, and provides them
 *    through context. `contentOffsetX` is the one content-effect prop; timing
 *    is theme-owned and is never a prop.
 *  - `SmoothTabsList` is the tablist rail: Base UI's `Tabs.List` (keyboard
 *    nav included) dressed as the recessed shell.
 *  - `SmoothTabsTab` is one tab: Base UI's `Tabs.Tab` (a real `role="tab"`
 *    button) carrying the shared sliding pill when it is selected.
 *  - `SmoothTabsPanels` is the crossfade viewport: it clips the sliding panels
 *    and drives the directional `AnimatePresence` swap; the active panel is a
 *    real Base UI `Tabs.Panel`.
 *  - `SmoothTabsPanel` is a declarative config holder (a `value` and the panel
 *    `children`); `SmoothTabsPanels` renders the single active one inside the
 *    animated `role="tabpanel"` wrapper.
 *  - `useSmoothTabsContext` reads the active value and a selector, for a
 *    consumer that wants to drive or reflect the tabs from outside a part.
 *
 * Styling reads only shadcn's semantic Tailwind vocabulary; timing reads only
 * the Motion UI theme (`@motion/ui-theme`) - feel is never a prop. The pill's
 * fill is `bg-primary`, so it tracks your theme.
 */

/**
 * ==============   Focus ring   ================
 */

/** shadcn's ring utilities, the shared focus-visible treatment for every
 *  interactive element in this component. `ring-offset-background` tracks
 *  whichever surface is active. */
const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

/**
 * ==============   Reduced motion   ================
 */

/* Theme reduced-motion strategy: "still" mounts no animation (panels swap
 * instantly, the pill snaps), "calm" keeps opacity fades but drops travel
 * (the slide distance and the blur both collapse to zero). defaultTheme
 * ships "calm". */

/**
 * ==============   Context   ================
 * A Motion-side context, NOT a state manager: Base UI owns the selection
 * mechanics. This carries what the Motion layers need as JS values - the
 * active value, the signed slide direction, the shared pill `layoutId` and
 * the theme-timed transitions - which CSS data-attribute selectors cannot
 * drive.
 */

/** The panel crossfade transition: an eased tween of the "ui" token's
 *  duration, or a zero-duration instant for the "still" reduced-motion tier. */
type PanelTransition =
  | { duration: number }
  | { type: "tween"; duration: number; ease: UITransition["ease"] }

interface SmoothTabsContextValue {
  /** The currently selected tab's value. */
  value: string
  /** Select a tab by value: computes the slide direction from the tablist's
   *  DOM order, then commits the new value (controlled or uncontrolled). */
  selectValue: (value: string) => void
  /** Sign of the last change (+1 forward, -1 back, 0 initial), so the crossfade
   *  slides the right way. */
  direction: number
  /** The tablist container, shared so the direction computation reads the
   *  rendered DOM order. */
  listRef: RefObject<HTMLDivElement | null>
  /** The shared-layout id the single sliding pill animates under. */
  indicatorLayoutId: string
  /** The theme transition the pill slides on (the `snap` token). */
  snapTransition: UITransition
  /** Whether the pill should slide (false under reduced motion: it snaps). */
  animateIndicator: boolean
  /** Horizontal slide distance (px) for the panel crossfade; 0 under reduced
   *  motion. */
  slide: number
  /** Resting opacity of an off-stage panel (0 normally; 1 under "still", where
   *  there is no fade). */
  restOpacity: number
  /** Resting blur of an off-stage panel (`blur(4px)` normally; `blur(0px)`
   *  under any reduced-motion tier). */
  restBlur: string
  /** The enter/active transition (token-timed, or instant under "still"). */
  enterTransition: PanelTransition
  /** The exit transition (half the token duration, or instant under "still"). */
  exitTransition: PanelTransition
  /** Custom passed to AnimatePresence + each panel (mirrors `direction`). */
  presenceCustom: number
}

const SmoothTabsContext = createContext<SmoothTabsContextValue | null>(null)

function useContextOrThrow(who: string): SmoothTabsContextValue {
  const ctx = useContext(SmoothTabsContext)
  if (!ctx) throw new Error(`${who} must be rendered inside <SmoothTabs>.`)
  return ctx
}

/** Public hook: read the active tab value and a selector, for a consumer that
 *  wants to drive or reflect the tabs from outside a part (a "next" button, a
 *  breadcrumb that mirrors the active view). Must be called inside a
 *  `<SmoothTabs>`. */
export function useSmoothTabsContext(): {
  /** The currently selected tab's value. */
  value: string
  /** Select a tab by value (drives the same slide + direction a click does). */
  select: (value: string) => void
} {
  const ctx = useContextOrThrow("useSmoothTabsContext")
  return { value: ctx.value, select: ctx.selectValue }
}

/**
 * ==============   SmoothTabs (root)   ================
 */

export interface SmoothTabsProps {
  /** The uncontrolled initial selected tab value. One of the child
   *  `SmoothTabsTab`/`SmoothTabsPanel` values. Ignored if `value` is passed. */
  defaultValue?: string
  /** The selected tab value (controlled). Pair with `onValueChange`. */
  value?: string
  /** Called with the newly selected tab's value whenever the selection changes
   *  (click or keyboard). Required for controlled use. */
  onValueChange?: (value: string) => void
  /** Horizontal distance (px) the outgoing/incoming panel slides during the
   *  crossfade. The one genuine content-effect constant; timing (the indicator
   *  spring, the crossfade duration) is theme-owned and is not a prop. */
  contentOffsetX?: number
  /** Merged onto the root wrapper - lay the tablist and panels out here
   *  (a `flex flex-col gap-4` stack, a `max-width`). */
  className?: string
  /** `SmoothTabsList` and `SmoothTabsPanels`. */
  children?: ReactNode
}

/** The tabs root: Base UI's `Tabs.Root` (selection semantics) held controlled
 *  so the slide direction can be computed before each change commits, plus
 *  the shared pill and the theme-timed transitions, provided through context.
 *  Renders a single wrapper element; lay its two children (a `SmoothTabsList`
 *  and a `SmoothTabsPanels`) out via `className`. */
export function SmoothTabs({
  defaultValue = "",
  value: controlledValue,
  onValueChange,
  contentOffsetX = 50,
  className,
  children,
}: SmoothTabsProps) {
  const baseId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const [internalValue, setInternalValue] = useState(defaultValue)
  const [direction, setDirection] = useState(0)

  const value = controlledValue ?? internalValue

  const { motionMode } = useMotionUITheme()
  const still = motionMode === "off"
  const motionAllowed = motionMode === "full"
  // The indicator is a toggle-style move, so it reads "snap"; the panel
  // crossfade reads "ui" (the default reveal token).
  const snapTransition = useMotionUITransition("snap")
  const uiTransition = useMotionUITransition("ui")

  const selectValue = useCallback(
    (next: string) => {
      // Direction from the tablist's DOM order (via each tab's data-value), so
      // forward tabs slide in from the right and back tabs from the left. DOM
      // is robust to any child ordering the consumer composes.
      let dir = 0
      const list = listRef.current
      if (list) {
        const values = Array.from(
          list.querySelectorAll<HTMLElement>('[role="tab"]')
        ).map((el) => el.dataset.value)
        const from = values.indexOf(value)
        const to = values.indexOf(next)
        if (from !== -1 && to !== -1 && from !== to) dir = to > from ? 1 : -1
      }
      setDirection(dir)
      if (controlledValue === undefined) setInternalValue(next)
      onValueChange?.(next)
    },
    [value, controlledValue, onValueChange]
  )

  // Crossfade geometry + timing. `slide` collapses to 0 under any reduced-motion
  // request (calm keeps the opacity fade; off is instant), and the blur is
  // dropped for both reduced-motion tiers. Timing derives from the "ui" token's
  // duration + ease rather than a literal; the exit runs at half the token
  // duration.
  const slide = motionAllowed ? contentOffsetX : 0
  const restBlur = motionAllowed ? "blur(4px)" : "blur(0px)"
  const restOpacity = still ? 1 : 0
  const enterTransition: PanelTransition = still
    ? { duration: 0 }
    : { type: "tween", duration: uiTransition.duration, ease: uiTransition.ease }
  const exitTransition: PanelTransition = still
    ? { duration: 0 }
    : {
        type: "tween",
        duration: uiTransition.duration * 0.5,
        ease: uiTransition.ease,
      }

  const ctx = useMemo<SmoothTabsContextValue>(
    () => ({
      value,
      selectValue,
      direction,
      listRef,
      indicatorLayoutId: `${baseId}-indicator`,
      snapTransition,
      animateIndicator: motionAllowed,
      slide,
      restOpacity,
      restBlur,
      enterTransition,
      exitTransition,
      presenceCustom: direction,
    }),
    [
      value,
      selectValue,
      direction,
      baseId,
      snapTransition,
      motionAllowed,
      slide,
      restOpacity,
      restBlur,
      enterTransition,
      exitTransition,
    ]
  )

  return (
    <SmoothTabsContext.Provider value={ctx}>
      <TabsPrimitive.Root
        value={value}
        onValueChange={(next) => selectValue(next as string)}
        className={className}
      >
        {children}
      </TabsPrimitive.Root>
    </SmoothTabsContext.Provider>
  )
}

/**
 * ==============   SmoothTabsList   ================
 */

export interface SmoothTabsListProps {
  /** Accessible name for the `role="tablist"` (e.g. "Workspace views").
   *  Strongly recommended - a tablist with no label is opaque to screen-reader
   *  users. */
  ariaLabel?: string
  /** Merged onto the tablist shell - extend the default recessed `bg-muted`
   *  rail here. */
  className?: string
  /** The `SmoothTabsTab` children. */
  children?: ReactNode
}

/** The tablist rail: Base UI's `Tabs.List` (roving-tabindex keyboard
 *  navigation; `activateOnFocus` makes selection follow focus - automatic
 *  activation) dressed as a recessed `bg-muted` well. */
export function SmoothTabsList({
  ariaLabel,
  className,
  children,
}: SmoothTabsListProps) {
  const ctx = useContextOrThrow("SmoothTabsList")

  return (
    <TabsPrimitive.List
      activateOnFocus
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      ref={ctx.listRef}
      className={`flex rounded-lg border border-border bg-muted p-1${className ? ` ${className}` : ""}`}
    >
      {children}
    </TabsPrimitive.List>
  )
}

/**
 * ==============   SmoothTabsTab   ================
 */

export interface SmoothTabsTabProps {
  /** This tab's value. When it matches the group's selected value the tab is
   *  active and carries the sliding pill. Must match a `SmoothTabsPanel`. */
  value: string
  /** The tab's label (and any inline content). */
  children?: ReactNode
  /** Merged onto the tab `<button>`. */
  className?: string
}

/** One tab: Base UI's `Tabs.Tab` (a real `role="tab"` button with the
 *  aria-selected/aria-controls wiring and roving tabindex) timed by the
 *  theme's snap colour transition, carrying the shared sliding pill when it
 *  is selected. Must be rendered inside a `SmoothTabsList`. */
export function SmoothTabsTab({ value, children, className }: SmoothTabsTabProps) {
  const ctx = useContextOrThrow("SmoothTabsTab")
  const selected = ctx.value === value

  return (
    <TabsPrimitive.Tab
      value={value}
      data-value={value}
      className={`relative z-10 flex-1 rounded-sm px-4 py-2.5 text-sm font-medium transition-colors duration-[var(--motion-ui-transition-snap-duration)] ease-[var(--motion-ui-transition-snap)] ${FOCUS_RING} ${
        selected
          ? "text-primary-foreground"
          : "text-muted-foreground hover:text-foreground"
      }${className ? ` ${className}` : ""}`}
    >
      {/* Label above the pill: the pill is absolute inset-0 behind this span,
          which keeps its own stacking context so the text stays legible on
          the primary fill. */}
      <span className="relative z-10">{children}</span>
      {selected && (
        <motion.span
          layoutId={ctx.indicatorLayoutId}
          aria-hidden="true"
          className="absolute inset-0 z-0 rounded-sm bg-primary"
          transition={
            ctx.animateIndicator ? { ...ctx.snapTransition } : { duration: 0 }
          }
        />
      )}
    </TabsPrimitive.Tab>
  )
}

/**
 * ==============   SmoothTabsPanels   ================
 */

export interface SmoothTabsPanelsProps {
  /** The `SmoothTabsPanel` children. Only the one matching the selected value
   *  is shown; enter/exit run together in a shared grid cell so the card
   *  height holds when panels are the same size. */
  children?: ReactNode
  /** Merged onto the crossfade viewport - give it its card surface, border and
   *  a `min-h-*` so a taller panel does not leave a short one looking collapsed. */
  className?: string
}

/** The crossfade viewport: clips the horizontally-sliding panels
 *  (`overflow-hidden`) and drives a directional `AnimatePresence mode="sync"`
 *  swap stacked in one CSS grid cell. Reads its `SmoothTabsPanel` children as
 *  config, and renders the single active one as a real Base UI `Tabs.Panel`
 *  (role/aria wired by the primitive) rendered as the animated `motion.div`.
 *  `keepMounted` + `[&[hidden]]:block` keep the outgoing panel visible while
 *  its exit animation runs. */
export function SmoothTabsPanels({ children, className }: SmoothTabsPanelsProps) {
  const ctx = useContextOrThrow("SmoothTabsPanels")

  const panels = Children.toArray(children).filter(
    (child): child is ReactElement<SmoothTabsPanelProps> =>
      isValidElement(child) && "value" in (child.props as SmoothTabsPanelProps)
  )
  const active = panels.find((panel) => panel.props.value === ctx.value)

  // Crossfade geometry + timing come from the root via context, so the exact
  // reduced-motion behaviour (slide/opacity/blur/timing) is owned in one place.
  const contentVariants = {
    enter: (d: number) => ({
      x: d * ctx.slide,
      opacity: ctx.restOpacity,
      filter: ctx.restBlur,
    }),
    active: { x: 0, opacity: 1, filter: "blur(0px)" },
    exit: (d: number) => ({
      x: d * -ctx.slide,
      opacity: ctx.restOpacity,
      filter: ctx.restBlur,
      transition: ctx.exitTransition,
    }),
  }

  return (
    <div
      className={`relative grid overflow-hidden${className ? ` ${className}` : ""}`}
    >
      {/* `mode="sync"` + shared grid cell: enter and exit run together in the
          same row, so equal-height panels never collapse the card between
          swaps (mode="wait" would unmount the outgoing panel before the
          incoming one mounts, which reads as a height stutter). */}
      <AnimatePresence mode="sync" initial={false} custom={ctx.presenceCustom}>
        {active && (
          <TabsPrimitive.Panel
            key={active.props.value}
            value={active.props.value}
            keepMounted
            render={
              <motion.div
                tabIndex={0}
                custom={ctx.presenceCustom}
                variants={contentVariants}
                initial="enter"
                animate="active"
                exit="exit"
                transition={ctx.enterTransition}
                className={`col-start-1 row-start-1 [&[hidden]]:block ${FOCUS_RING}${active.props.className ? ` ${active.props.className}` : ""}`}
              >
                {active.props.children}
              </motion.div>
            }
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * ==============   SmoothTabsPanel   ================
 */

export interface SmoothTabsPanelProps {
  /** This panel's value. It is shown when it matches the group's selected
   *  value; must match a `SmoothTabsTab`. */
  value: string
  /** The panel's content. */
  children?: ReactNode
  /** Merged onto the animated `role="tabpanel"` wrapper `SmoothTabsPanels`
   *  renders for the active panel (its padding, its inner layout). */
  className?: string
}

/** A declarative panel: it holds a `value` and its content, and renders
 *  nothing itself. Its parent `SmoothTabsPanels` reads these props and renders
 *  the single active panel inside the animated `role="tabpanel"` wrapper, so
 *  the crossfade is one shared element across every tab. Must be a child of
 *  `SmoothTabsPanels`. */
export function SmoothTabsPanel(_props: SmoothTabsPanelProps) {
  return null
}
