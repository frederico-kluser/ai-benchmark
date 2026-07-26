import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion"
import { AnimatePresence, motion } from "motion/react"
import type { HTMLMotionProps, Variants } from "motion/react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useMotionUITheme, useMotionUITransition } from "@/components/motion-ui/ui-theme"

/**
 * Accordion - Motion's height-morph disclosure choreography on Base UI's
 * accordion primitive. A row's panel springs its height 0 <-> auto
 * on the theme's `ui` transition for a buttery expand, a linear-gradient
 * `maskImage` fades the fold as it opens, and the inner copy blurs in
 * (blur(3px) -> 0) alongside its opacity. Under reduced motion the height,
 * mask and blur all drop to a plain opacity fade.
 *
 * The DIVISION OF LABOUR is deliberate: Base UI owns everything commodity -
 * open state, toggling, WAI-ARIA wiring (aria-expanded/aria-controls,
 * heading + button semantics, `hidden` on closed panels) and full keyboard
 * navigation (Arrow keys, Home/End between triggers). Motion UI owns only
 * what Base UI cannot give you: the animation choreography, the themed feel,
 * the indicators and hash deep-linking. This is the shape of the whole kit -
 * animation atop the primitives you already use - so swapping our dressing
 * for your own, or grafting the choreography onto an existing Base UI
 * accordion, is a copy-paste, not a rewrite.
 *
 * The composable parts, in Base UI's own vocabulary:
 *
 *  - `Accordion` is the root: `multiple`, `defaultValue`/`value`/
 *    `onValueChange`, plus Motion UI's `deepLink`. Its `className` is the
 *    container look - a bordered card, a chromeless hairline list, anything.
 *  - `AccordionItem` is one disclosure row, keyed by a stable `value` that
 *    doubles as its deep-link anchor id.
 *  - `AccordionTrigger` is the accessible heading + `<button>` (Base UI's),
 *    with a swappable indicator slot.
 *  - `AccordionPanel` is the height-morph collapsible, with the
 *    reduced-motion fallback baked in.
 *  - `AccordionChevron` and `AccordionPlusMinus` are the two shipped
 *    indicators; pass either to the trigger, or supply your own.
 *  - `useAccordionHash` is the headless fragment-open behaviour, for
 *    consumers driving their own open state.
 *
 * Styling reads only shadcn's semantic Tailwind vocabulary; timing reads only
 * the Motion UI theme (`@motion/ui-theme`) - feel is never a prop. The
 * container chrome (card surface, row dividers) and the trigger/panel padding
 * are the consumer's `className`, so one mechanic serves every dressing.
 */

/**
 * ==============   Open-state helpers   ================
 * Pure list transitions, exposed for headless consumers who drive their own
 * `value` array (and unit-testable without a DOM). Toggling inside the
 * component is Base UI's job; `revealOpenIds` powers deep-linking.
 */

/**
 * The toggle transition: flip `value`'s open state within `current`. Under
 * `singleOpen` a newly opened row is the only open row (opening one collapses
 * the rest); otherwise rows open independently. Matches Base UI's own
 * toggling, for consumers driving a controlled `value` themselves.
 *
 * @param current The currently open values.
 * @param value The value being toggled.
 * @param singleOpen One open at a time when true; any number when false.
 * @returns The next open-value list.
 */
export function nextOpenIds(
  current: string[],
  value: string,
  singleOpen: boolean
): string[] {
  const isOpen = current.includes(value)
  if (singleOpen) return isOpen ? [] : [value]
  return isOpen ? current.filter((x) => x !== value) : [...current, value]
}

/**
 * The reveal transition: ensure `value` is open (used by deep-linking, where
 * a fragment should open its target, never close it). Under `singleOpen` the
 * revealed row becomes the only open row; otherwise it is added to the set.
 *
 * @param current The currently open values.
 * @param value The value to reveal.
 * @param singleOpen One open at a time when true; any number when false.
 * @returns The next open-value list.
 */
export function revealOpenIds(
  current: string[],
  value: string,
  singleOpen: boolean
): string[] {
  if (singleOpen) return [value]
  return current.includes(value) ? current : [...current, value]
}

/**
 * ==============   Reduced motion   ================
 */

/* Theme reduced-motion strategy, shared by every part: "off" mounts no
 * animation, "calm" keeps opacity fades but drops travel. The panel and the
 * indicators both collapse to instant/opacity-only whenever motion is not
 * fully allowed. defaultTheme ships "calm". */

/**
 * ==============   Focus rings   ================
 */

/** shadcn's ring utilities, the shared focus-visible treatment. The default
 *  offset ring is right for a chromeless list. */
const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

/** When the accordion sits inside an `overflow-hidden` container (a card that
 *  clips its rounded corners around the height-animated panels), an
 *  outward-offset ring is clipped on the first/last row. `ring-inset` pulls
 *  the ring inward instead - pass `inset` to `AccordionTrigger` in that case. */
const FOCUS_RING_INSET =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"

/**
 * ==============   Contexts   ================
 * Two thin Motion-side contexts, NOT a state manager: Base UI owns the open
 * state. These exist only so the Motion layers (the panel's AnimatePresence
 * mount, the spring-driven indicators) can read "is this row open" as a JS
 * boolean - a CSS `data-panel-open` selector cannot drive a spring.
 */

interface AccordionRootContextValue {
  openValues: string[]
  register: (value: string) => () => void
}

const AccordionRootContext = createContext<AccordionRootContextValue | null>(
  null
)

interface AccordionItemContextValue {
  open: boolean
  value: string
}

const AccordionItemContext = createContext<AccordionItemContextValue | null>(
  null
)

function useAccordionRoot(who: string): AccordionRootContextValue {
  const ctx = useContext(AccordionRootContext)
  if (!ctx) throw new Error(`${who} must be rendered inside <Accordion>.`)
  return ctx
}

function useAccordionItemContext(who: string): AccordionItemContextValue {
  const ctx = useContext(AccordionItemContext)
  if (!ctx) throw new Error(`${who} must be rendered inside <AccordionItem>.`)
  return ctx
}

/**
 * ==============   useAccordionHash   ================
 */

export interface UseAccordionHashOptions {
  /** Called with the matched fragment id on mount and on every `hashchange`,
   *  so you can open that row. Reveal, never toggle - a fragment opens its
   *  target, it does not close an already-open one. */
  onMatch: (id: string) => void
  /** Restrict matches to these ids. Omit to honour any fragment that points
   *  at an element on the page. */
  ids?: readonly string[]
  /** Turn the listener off (a section with no deep-link support). Defaults to
   *  true. */
  enabled?: boolean
}

/**
 * Headless deep-linking. Reads the URL fragment on mount and whenever the hash
 * changes, calls `onMatch` with the id when it points at a known row, and
 * scrolls that row into view (smooth unless the user prefers reduced motion).
 * Runs in an effect, so it never touches `window` during render and cannot
 * cause a hydration mismatch. `Accordion` calls this for you when `deepLink`
 * is set; call it yourself only when you drive your own open state.
 *
 * @param options Match callback, optional id allow-list, and an enabled flag.
 */
export function useAccordionHash({
  onMatch,
  ids,
  enabled = true,
}: UseAccordionHashOptions): void {
  const { motionMode } = useMotionUITheme()
  const reduce = motionMode !== "full"

  useEffect(() => {
    if (!enabled) return

    const openFromHash = () => {
      const hash = window.location.hash.replace(/^#/, "")
      if (!hash) return
      if (ids && !ids.includes(hash)) return
      const el = document.getElementById(hash)
      if (!el) return
      onMatch(hash)
      el.scrollIntoView({
        block: "nearest",
        behavior: reduce ? "auto" : "smooth",
      })
    }

    openFromHash()
    window.addEventListener("hashchange", openFromHash)
    return () => window.removeEventListener("hashchange", openFromHash)
  }, [enabled, ids, onMatch, reduce])
}

/**
 * ==============   Accordion (root)   ================
 */

export interface AccordionProps {
  /** Whether multiple rows can be open at once. Defaults to false (classic
   *  one-open-at-a-time accordion) - the same prop, name and default as Base
   *  UI's `Accordion.Root`. */
  multiple?: boolean
  /** The values open on first render (uncontrolled). Base UI vocabulary: an
   *  array, even under single-open. */
  defaultValue?: string[]
  /** The controlled open values. Omit (and optionally set `defaultValue`) to
   *  let the accordion manage itself. */
  value?: string[]
  /** Called with the next open values whenever a row is toggled. */
  onValueChange?: (value: string[]) => void
  /** Wire deep-linking: open and scroll to the row whose value matches the
   *  URL fragment, on mount and on `hashchange`. Defaults to false. */
  deepLink?: boolean
  /** Merged onto the container element - this is where the container look
   *  lives: a bordered `overflow-hidden rounded-lg border bg-card` card, a
   *  chromeless `border-t` hairline list, or your own. */
  className?: string
  /** The `AccordionItem` rows. */
  children?: ReactNode
}

/** The accordion root: Base UI's `Accordion.Root` (open state, toggling,
 *  keyboard navigation between triggers) plus Motion UI's deep-linking. The
 *  root is held controlled internally so a URL fragment can reveal a row;
 *  pass `value`/`onValueChange` to control it yourself. Renders a single
 *  container element whose look is entirely your `className`. */
export function Accordion({
  multiple = false,
  defaultValue,
  value: controlledValue,
  onValueChange,
  deepLink = false,
  className,
  children,
}: AccordionProps) {
  const [uncontrolledValue, setUncontrolledValue] = useState<string[]>(
    () => defaultValue ?? []
  )
  const openValues = controlledValue ?? uncontrolledValue

  // Rows register their values so deep-linking only honours fragments that
  // point at a real row of THIS accordion, not any element on the page.
  const registered = useRef<Set<string>>(new Set())
  const [ids, setIds] = useState<string[]>([])
  const register = useCallback((value: string) => {
    registered.current.add(value)
    setIds([...registered.current])
    return () => {
      registered.current.delete(value)
      setIds([...registered.current])
    }
  }, [])

  const setValues = useCallback(
    (next: string[]) => {
      setUncontrolledValue(next)
      onValueChange?.(next)
    },
    [onValueChange]
  )

  const reveal = useCallback(
    (id: string) => setValues(revealOpenIds(openValues, id, !multiple)),
    [setValues, openValues, multiple]
  )

  useAccordionHash({ enabled: deepLink, ids, onMatch: reveal })

  const rootContext = useMemo<AccordionRootContextValue>(
    () => ({ openValues, register }),
    [openValues, register]
  )

  return (
    <AccordionRootContext.Provider value={rootContext}>
      <AccordionPrimitive.Root
        multiple={multiple}
        value={openValues}
        onValueChange={(next) => setValues(next as string[])}
        className={className}
      >
        {children}
      </AccordionPrimitive.Root>
    </AccordionRootContext.Provider>
  )
}

/**
 * ==============   AccordionItem   ================
 */

export interface AccordionItemProps
  extends Omit<HTMLMotionProps<"div">, "id"> {
  /** Stable value for this row: its open-state key (Base UI vocabulary) AND
   *  its deep-link anchor id (a link to `#{value}` opens and scrolls to it).
   *  Required. */
  value: string
  /** Merged onto the row element - a per-row divider (`border-b`) lives here. */
  className?: string
  /** The row's `AccordionTrigger` and `AccordionPanel`. */
  children?: ReactNode
}

/** One disclosure row: Base UI's `Accordion.Item` rendered as a `motion.div`,
 *  so entrance props (`variants`, ...) a consumer's stagger passes through
 *  land on the row. Base UI owns the trigger<->panel aria wiring; this
 *  wrapper only exposes the row's open state to the Motion layers and
 *  carries `value` as the deep-link anchor. */
export function AccordionItem({
  value,
  className,
  children,
  ...rest
}: AccordionItemProps) {
  const root = useAccordionRoot("AccordionItem")

  useEffect(() => root.register(value), [root, value])

  const itemContext = useMemo<AccordionItemContextValue>(
    () => ({ open: root.openValues.includes(value), value }),
    [root, value]
  )

  return (
    <AccordionItemContext.Provider value={itemContext}>
      <AccordionPrimitive.Item
        value={value}
        render={
          <motion.div id={value} className={className} {...rest}>
            {children}
          </motion.div>
        }
      />
    </AccordionItemContext.Provider>
  )
}

/**
 * ==============   AccordionTrigger   ================
 */

export interface AccordionTriggerProps {
  /** The trigger label. Wrap it in your own `<span>` to size/weight it
   *  (`text-base font-medium text-balance`); the trigger only lays it out. */
  children?: ReactNode
  /** The open/closed indicator, rendered after the label. Defaults to
   *  `<AccordionChevron />`; pass `<AccordionPlusMinus />` or your own mark. */
  indicator?: ReactNode
  /** Merged onto the `<button>` - trigger padding (`px-6 py-5`) lives here. */
  className?: string
  /** The heading level wrapping the button, for document outline correctness.
   *  Defaults to 3 (Base UI's own default). */
  headingLevel?: 2 | 3 | 4 | 5 | 6
  /** Use the inset focus ring instead of the offset one - set this when the
   *  accordion sits inside an `overflow-hidden` card that would clip an
   *  offset ring on the first/last row. Defaults to false. */
  inset?: boolean
}

/** The accessible trigger: Base UI's `Accordion.Header` + `Accordion.Trigger`
 *  (a real `<button aria-expanded aria-controls>` in a heading, with Arrow
 *  key/Home/End navigation between rows), dressed with the theme's snap-timed
 *  hover colour and the shared focus ring, plus the indicator slot. */
export function AccordionTrigger({
  children,
  indicator,
  className,
  headingLevel = 3,
  inset = false,
}: AccordionTriggerProps) {
  const ring = inset ? FOCUS_RING_INSET : FOCUS_RING
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4" | "h5" | "h6"

  return (
    <AccordionPrimitive.Header
      className="m-0"
      render={headingLevel === 3 ? undefined : <Heading />}
    >
      <AccordionPrimitive.Trigger
        className={`flex w-full items-center justify-between gap-4 text-left text-foreground transition-colors duration-[var(--motion-ui-transition-snap-duration)] ease-[var(--motion-ui-transition-snap)] hover:text-primary ${ring}${className ? ` ${className}` : ""}`}
      >
        {children}
        {indicator ?? <AccordionChevron />}
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

/**
 * ==============   AccordionPanel   ================
 */

/** The height-morph choreography, invariant across every dressing: the panel
 *  springs height 0 <-> auto on the theme's `ui` transition, a mask fades the
 *  fold, and the inner copy blurs in. `contain: layout` scopes the one
 *  deliberate layout property (height auto has no compositor-only equivalent
 *  for arbitrary content) to this panel's own subtree. */
const PANEL_VARIANTS: Variants = {
  open: {
    height: "auto",
    maskImage: "linear-gradient(to bottom, black 100%, transparent 100%)",
  },
  closed: {
    height: 0,
    maskImage: "linear-gradient(to bottom, black 50%, transparent 100%)",
  },
}

/** Inner copy: blurs in with opacity at full motion. */
const CONTENT_VARIANTS: Variants = {
  open: { opacity: 1, filter: "blur(0px)" },
  closed: { opacity: 0, filter: "blur(3px)" },
}

/** Inner copy under reduced motion: a plain opacity fade, no blur. */
const CONTENT_VARIANTS_REDUCED: Variants = {
  open: { opacity: 1 },
  closed: { opacity: 0 },
}

export interface AccordionPanelProps {
  /** The disclosed content (typically a `<p>`). */
  children?: ReactNode
  /** Merged onto the inner content wrapper - panel padding (`px-6 pt-1 pb-6`)
   *  lives here. The outer collapsible owns `overflow-hidden` and
   *  `contain: layout` and is not stylable, so padding never fights the
   *  height morph. */
  className?: string
}

/** The collapsible panel: Base UI's `Accordion.Panel` (`role="region"`
 *  labelled by its trigger, `hidden` when closed at rest) with Motion's
 *  height 0 <-> auto spring, fold mask and inner blur-in inside. `keepMounted`
 *  keeps the region in the DOM so AnimatePresence can run the exit collapse;
 *  the `[&[hidden]]:block` override keeps that exit visible while Base UI has
 *  already marked the panel hidden (the pattern from Motion's own Base UI
 *  example). Under reduced motion it snaps open with an opacity-only fade. */
export function AccordionPanel({ children, className }: AccordionPanelProps) {
  const item = useAccordionItemContext("AccordionPanel")
  const { motionMode } = useMotionUITheme()
  const motionAllowed = motionMode === "full"
  const reduced = !motionAllowed
  const uiTransition = useMotionUITransition("ui")

  return (
    <AccordionPrimitive.Panel
      keepMounted
      className="overflow-hidden [contain:layout] [&[hidden]]:block"
    >
      <AnimatePresence initial={false}>
        {item.open && (
          <motion.div
            initial="closed"
            animate="open"
            exit="closed"
            transition={reduced ? { duration: 0 } : { ...uiTransition }}
            variants={PANEL_VARIANTS}
          >
            <motion.div
              className={className}
              variants={reduced ? CONTENT_VARIANTS_REDUCED : CONTENT_VARIANTS}
            >
              {children}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </AccordionPrimitive.Panel>
  )
}

/**
 * ==============   Indicators   ================
 */

export interface AccordionIndicatorProps {
  /** Force the open/closed state. Omit inside an `AccordionItem` and the
   *  indicator reads the row's state itself. */
  open?: boolean
  /** Merged onto the indicator. The default tone is `text-muted-foreground`. */
  className?: string
}

/** Resolve an indicator's open state: an explicit `open` prop wins, else the
 *  enclosing row's state, else closed (so an indicator renders fine
 *  standalone). */
function useIndicatorOpen(open: boolean | undefined): boolean {
  const item = useContext(AccordionItemContext)
  return open ?? item?.open ?? false
}

/** A chevron that rotates 0 <-> 180 on the theme's snap transition as the row
 *  opens. Decorative (`aria-hidden`); the trigger's `aria-expanded` carries
 *  the state to assistive tech. The default `AccordionTrigger` indicator. */
export function AccordionChevron({ open, className }: AccordionIndicatorProps) {
  const isOpen = useIndicatorOpen(open)
  const { motionMode } = useMotionUITheme()
  const motionAllowed = motionMode === "full"
  const snap = useMotionUITransition("snap")

  return (
    <motion.svg
      className={`shrink-0 text-muted-foreground${className ? ` ${className}` : ""}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      animate={{ rotate: isOpen ? 180 : 0 }}
      transition={motionAllowed ? { ...snap } : { duration: 0 }}
    >
      <path d="m6 9 6 6 6-6" />
    </motion.svg>
  )
}

/** A plus that morphs into a minus as the row opens. Two currentColor bars
 *  share one centred origin: the vertical bar spins 90 -> 0 (closing the "+"
 *  into a "-") while the horizontal bar spins 0 -> 180 on the same snap
 *  spring, so the collapse reads as one coordinated move. Decorative
 *  (`aria-hidden`). */
export function AccordionPlusMinus({
  open,
  className,
}: AccordionIndicatorProps) {
  const isOpen = useIndicatorOpen(open)
  const { motionMode } = useMotionUITheme()
  const motionAllowed = motionMode === "full"
  const snap = useMotionUITransition("snap")
  const transition = motionAllowed ? { ...snap } : { duration: 0 }

  return (
    <span
      className={`relative inline-block size-[18px] shrink-0 text-muted-foreground${className ? ` ${className}` : ""}`}
    >
      <motion.span
        aria-hidden="true"
        className="absolute inset-0 m-auto h-[2px] w-[13px] rounded-full bg-current"
        animate={{ rotate: isOpen ? 180 : 0 }}
        transition={transition}
      />
      <motion.span
        aria-hidden="true"
        className="absolute inset-0 m-auto h-[2px] w-[13px] rounded-full bg-current"
        animate={{ rotate: isOpen ? 0 : 90 }}
        transition={transition}
      />
    </span>
  )
}
