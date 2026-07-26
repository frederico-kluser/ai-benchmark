import { AnimatePresence, motion } from "motion/react"
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useMotionUITheme, useMotionUITransition } from "@/components/motion-ui/ui-theme"

/** Filters falsy class parts and joins them - keeps conditional className
 *  composition readable without a `clsx`-style dependency. */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ")
}

/**
 * ==============   useToastStack   ================
 */

/** A queued toast is identified by a stable, monotonically increasing numeric
 *  id: the newest toast has the highest id and sits at the front of the
 *  ordered queue. */
export type ToastItem = number

/** The headless toast queue returned by `useToastStack`. */
export interface UseToastStackResult {
  /** The live queue of toast ids, newest first - map it into `Toast` children
   *  inside a `ToastStack`. */
  toasts: ToastItem[]
  /** Push a new toast onto the front of the queue, returning its id. Wire this
   *  to your own trigger. */
  add(): ToastItem
  /** Remove the toast with `id` (typically from its dismiss button). */
  dismiss(id: ToastItem): void
}

/**
 * The headless toast queue. Owns nothing visual: it hands back the ordered id
 * list plus `add`/`dismiss` so a consumer wires their own trigger and their own
 * event source, then renders the ids as `Toast` children of a `ToastStack`.
 * Newest toasts are prepended, so the queue is naturally front-to-back.
 */
export function useToastStack(): UseToastStackResult {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)

  const add = useCallback<UseToastStackResult["add"]>(() => {
    const id = ++nextId.current
    setToasts((prev) => [id, ...prev])
    return id
  }, [])

  const dismiss = useCallback<UseToastStackResult["dismiss"]>((id) => {
    setToasts((prev) => prev.filter((t) => t !== id))
  }, [])

  return { toasts, add, dismiss }
}

/**
 * ==============   Context   ================
 *
 * The container owns the resolved geometry + reduced-motion mode and the
 * per-toast index; each `Toast` reads them so its y/scale/opacity comes from
 * the same formula for every toast. A separate visibility context lets an
 * interactive control inside a hidden toast fall out of the tab order.
 */

interface ToastStackContextValue {
  maxVisible: number
  stackOffsetY: number
  stackScale: number
  stackOpacity: number
  /** Reduced motion, "calm" strategy: keep opacity fades, drop travel/scale. */
  calm: boolean
  /** Reduced motion, "off" strategy: mount no animation at all. */
  still: boolean
}

const ToastStackContext = createContext<ToastStackContextValue | null>(null)
const ToastIndexContext = createContext(0)

interface ToastVisibility {
  /** Whether the toast is inside the `maxVisible` window (visible and
   *  interactive) rather than kept mounted but hidden behind the stack. */
  isVisible: boolean
}

const ToastVisibilityContext = createContext<ToastVisibility>({ isVisible: true })

/**
 * Reports whether the enclosing `Toast` is inside the visible window. Read it
 * from a control the consumer drops into a toast (a dismiss button) so the
 * control can set `tabIndex={isVisible ? undefined : -1}` and stay out of the
 * tab order while its toast is hidden behind the stack. Returns `isVisible:
 * true` outside a `Toast`, so a control reused elsewhere never breaks.
 */
export function useToast(): ToastVisibility {
  return useContext(ToastVisibilityContext)
}

/**
 * ==============   Toast   ================
 */

export interface ToastProps {
  /** The toast's content - typically a `NotificationCard` carrying the icon,
   *  title, body and a dismiss button. The Toast never styles the face, only
   *  moves it. */
  children?: ReactNode
  /** Merged onto the animated card element. Positioning (absolute bottom / full
   *  width / stacking transform) is owned by the mechanic; use this only for
   *  extra per-toast styling. */
  className?: string
}

/**
 * One animated card in the stack. Reads its index and the shared geometry from
 * the `ToastStack` context and renders the `motion.div` that carries the
 * fan-out choreography: the index-derived rise/scale/fade, the settle spring
 * with a per-step stagger, the enter/exit throws, and the z-order. Toasts
 * beyond `maxVisible` are kept mounted (so the stack keeps its depth) but
 * faded out, `aria-hidden`, and pointer-inert.
 */
export function Toast({ children, className }: ToastProps) {
  const ctx = useContext(ToastStackContext)
  if (!ctx) throw new Error("Toast must be rendered inside <ToastStack>.")
  const index = useContext(ToastIndexContext)
  const { maxVisible, stackOffsetY, stackScale, stackOpacity, calm, still } = ctx
  const theme = useMotionUITheme()

  // The stacking settle is a card reveal, so it reads the "ui" transition; the
  // exit is a quick dismissal, so it degrades the "snap" token to a tween.
  const settle = useMotionUITransition("ui")
  const exit = useMotionUITransition("snap")

  const isVisible = index < maxVisible
  const y = -index * stackOffsetY
  const scale = 1 - index * stackScale
  const opacity = isVisible ? 1 - index * stackOpacity : 0

  // Entrance/exit throw derived from the theme's travel tokens, never a magic
  // number: a toast rises a section-scale throw into place and drops an
  // enter-scale throw on the way out. Both collapse to 0 under calm.
  const enterRise = calm ? 0 : theme.travel.section
  const exitDrop = calm ? 0 : theme.travel.enter

  return (
    <ToastVisibilityContext.Provider value={{ isVisible }}>
      <motion.div
        className={cx("absolute bottom-0 left-0 w-full origin-bottom", className)}
        style={{
          zIndex: maxVisible - index,
          pointerEvents: isVisible ? "auto" : "none",
        }}
        initial={
          still
            ? false
            : {
                opacity: 0,
                transform: `translateY(${enterRise}px) scale(${calm ? 1 : 0.85})`,
              }
        }
        animate={{ opacity, transform: `translateY(${y}px) scale(${scale})` }}
        exit={
          still
            ? { opacity: 0, transition: { duration: 0 } }
            : {
                opacity: 0,
                transform: `translateY(${exitDrop}px) scale(${calm ? 1 : 0.8})`,
                transition: { ...exit, type: "tween" },
              }
        }
        transition={{ ...settle, delay: calm ? 0 : index * theme.stagger.tight }}
        aria-hidden={isVisible ? undefined : true}
      >
        {children}
      </motion.div>
    </ToastVisibilityContext.Provider>
  )
}

/**
 * ==============   ToastStack   ================
 */

export interface ToastStackProps {
  /** The `Toast` children, newest first (map `useToastStack().toasts` in
   *  order). More may be passed than are shown; the stack keeps `maxVisible + 2`
   *  mounted (the extra two are the hidden exit tail) and drops the rest. */
  children?: ReactNode
  /** How many toasts stay fully visible before the rest hide behind them.
   *  Defaults to `4`. */
  maxVisible?: number
  /** Vertical push, in px, applied per step back in the stack. Defaults to
   *  `10`. */
  stackOffsetY?: number
  /** Scale shed per step back in the stack (`0.06` = 6% smaller each). Defaults
   *  to `0.06`. */
  stackScale?: number
  /** Opacity shed per step back in the stack. Defaults to `0.2`. */
  stackOpacity?: number
  /** Merged onto the fixed viewport element - reposition the well (e.g. top
   *  instead of bottom) or widen it here. */
  className?: string
}

/**
 * The stack viewport. Paints the fixed bottom-centred well, wraps the toasts in
 * an `AnimatePresence` so enter and exit are layout-animated, and computes the
 * shared geometry + reduced-motion mode every `Toast` reads. The well is
 * `pointer-events-none` so the gaps around the toasts never swallow clicks;
 * each visible toast re-enables pointer events for itself. Render `Toast`
 * children inside; the stack positions them, they supply their own content.
 */
export function ToastStack({
  children,
  maxVisible = 4,
  stackOffsetY = 10,
  stackScale = 0.06,
  stackOpacity = 0.2,
  className,
}: ToastStackProps) {
  const theme = useMotionUITheme()
  // Theme reduced-motion strategy: "calm" keeps opacity fades but drops
  // travel/scale entrance; "off" mounts no animation. defaultTheme ships "calm".
  const still = theme.motionMode === "off"
  const calm = theme.motionMode === "calm"

  const contextValue: ToastStackContextValue = {
    maxVisible,
    stackOffsetY,
    stackScale,
    stackOpacity,
    calm,
    still,
  }

  // Keep the visible window plus a two-toast hidden tail mounted, so a toast
  // pushed past the window still animates its exit rather than vanishing.
  const items = Children.toArray(children)
    .filter(isValidElement)
    .slice(0, maxVisible + 2)

  return (
    <div
      className={cx(
        "pointer-events-none fixed inset-x-0 bottom-6 mx-auto w-[min(22rem,calc(100vw-2rem))]",
        className
      )}
      style={{ zIndex: maxVisible }}
    >
      <ToastStackContext.Provider value={contextValue}>
        <AnimatePresence initial={false}>
          {items.map((child, index) => (
            <ToastIndexContext.Provider key={child.key ?? index} value={index}>
              {child}
            </ToastIndexContext.Provider>
          ))}
        </AnimatePresence>
      </ToastStackContext.Provider>
    </div>
  )
}
