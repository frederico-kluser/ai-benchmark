"use client"

import { animate } from "motion"
import { splitText } from "motion-plus"
import {
  createElement,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react"
import { useMotionUITheme, useMotionUITransition } from "@/components/motion-ui/ui-theme"

/**
 * ==============   Constants   ================
 */

// Class names set on the spans splitText injects, purely optional styling
// hooks - the mechanic applies its own structural display styles inline on
// these same spans, so it does not depend on any CSS being present.
const LINE_CLASS = "motion-ui-stagger-line"
const WORD_CLASS = "motion-ui-stagger-word"

// Data attributes the container queries to find its choreography targets. The
// headline is the single split target; every follower marked with the item
// attribute is staggered in, in DOM order, after the headline.
const HEADLINE_ATTR = "data-stagger-headline"
const ITEM_ATTR = "data-stagger-item"

// The headline rise: each splitText line travels a short distance UP into
// place (not the full masked-line height the clipped split-reveal uses), fades
// in and clears a soft blur. Authored as literal `transform` / `filter`
// strings, not Motion's `y`/`blur` shorthands, so the animation is
// unambiguously compositor-only. The distance is in em so it tracks the text
// size; the blur matches the kit's other enter/exit softens
// (`blur(4px)` → `blur(0px)`).
const HEADLINE_RISE_FROM = "translateY(0.4em)"
const HEADLINE_RISE_TO = "translateY(0em)"
const ENTER_BLUR_FROM = "blur(4px)"
const ENTER_BLUR_TO = "blur(0px)"

/**
 * ==============   Reduced motion   ================
 */

/** The resolved reduced-motion state the entrance runs in, resolved internally
 *  from the active theme's strategy plus the user's OS preference, never a
 *  prop: `"full"` is the full staggered slide, `"calm"` keeps the opacity fades
 *  but drops all travel and blur and collapses the stagger so everything
 *  arrives together, `"off"` mounts no animation and leaves the final text
 *  visible. */
export type StaggerRevealMode = "full" | "calm" | "off"

/* Theme reduced-motion strategy, resolved the same way for every mechanic in
 * the kit: "off" mounts no animation (the settled text is the end state);
 * "calm" keeps opacity fades but drops travel and stagger. defaultTheme ships
 * "calm". */

/**
 * ==============   useStaggerReveal   ================
 */

/** The handle `useStaggerReveal` returns: a `ref` to attach to the container
 *  element that holds the `StaggerRevealHeadline` and the `StaggerRevealItem`
 *  followers. */
export interface StaggerRevealHandle {
  /** Attach to the container element. The layout effect temporarily hides it
   *  while fonts load and the headline is split; server and no-JS output stays
   *  visible so setup failures never remove the content. */
  ref: RefObject<HTMLElement | null>
}

/** Runs asynchronous measurement/splitting and always invokes the visible-state
 * fallback. Setup errors are intentionally swallowed because the original,
 * unsplit content is the resilient final state. */
export async function runStaggerPreparation(
  prepare: () => Promise<void>,
  reveal: () => void,
): Promise<void> {
  try {
    await prepare()
  } catch {
    // The caller's reveal fallback is the recovery path.
  } finally {
    reveal()
  }
}

/**
 * The orchestration as a hook, for a consumer who wants to own the container
 * element rather than use `StaggerReveal`. Attach the returned `ref` to a
 * container that holds one `StaggerRevealHeadline` (the split target) and any
 * number of `StaggerRevealItem` followers.
 *
 * Its layout effect hides the hydrated container until `document.fonts.ready`
 * resolves and the headline is split, then runs a single delay cursor through
 * the headline lines and followers. Server output remains visible, and any
 * setup failure reveals the original content. Robust to re-runs: a
 * reduced-motion change resets the headline's `textContent` to the original
 * string before re-splitting, so previous spans are never double-wrapped.
 */
export function useStaggerReveal(): StaggerRevealHandle {
  const ref = useRef<HTMLElement | null>(null)
  const theme = useMotionUITheme()
  const { motionMode } = theme

  // gentle drives the large-surface headline reveal; ui drives the followers.
  // Neither useMotionUITransition nor useMotionUITheme is guaranteed referentially stable
  // across renders, and the timeline runs inside an async fonts.ready callback,
  // so capture them in refs the callback reads rather than listing them as
  // effect dependencies (which would re-run the effect and re-split on every
  // render). Only `motionMode` is a real dependency.
  const gentle = useMotionUITransition("gentle")
  const ui = useMotionUITransition("ui")
  const gentleRef = useRef(gentle)
  const uiRef = useRef(ui)
  const themeRef = useRef(theme)
  gentleRef.current = gentle
  uiRef.current = ui
  themeRef.current = theme

  useLayoutEffect(() => {
    const container = ref.current
    if (!container) return
    const headlineEl = container.querySelector<HTMLElement>(
      `[${HEADLINE_ATTR}]`,
    )
    if (!headlineEl) return

    const animations: Array<ReturnType<typeof animate>> = []
    let cancelled = false

    // Hide again on re-run (e.g. a reduced-motion change re-runs the effect) so
    // the fresh, un-split text never flashes before it is masked.
    container.style.visibility = "hidden"

    void runStaggerPreparation(
      async () => {
        // Wait for fonts so line splitting measures the final layout, avoiding
        // a reflow that would regroup the lines mid-entrance. Older or partial
        // DOM implementations without the Font Loading API proceed directly.
        await document.fonts?.ready
        if (cancelled || ref.current !== container) return

        // Reset to the original text so splitText always operates on fresh,
        // un-split markup. On a re-run the headline still holds the spans a
        // previous split injected; re-splitting those would nest them. The
        // original string is the aria-label whole-headline announce (required on
        // the split heading), so it is always present to restore from.
        const original =
          headlineEl.getAttribute("aria-label") ?? headlineEl.textContent ?? ""
        headlineEl.textContent = original

        const { lines } = splitText(headlineEl, {
          lineClass: LINE_CLASS,
          wordClass: WORD_CLASS,
        })

        // Structural display styles, applied inline on the injected spans (the
        // mechanic ships no stylesheet), in every mode so the settled layout is
        // identical whether or not the entrance animates: each visual line is a
        // block so it staggers (and filters) as its own unit; words stay
        // inline-block so wrapping matches the pre-split layout.
        lines.forEach((line) => {
          line.style.display = "block"
          line
            .querySelectorAll<HTMLElement>(`.${WORD_CLASS}`)
            .forEach((word) => {
              word.style.display = "inline-block"
            })
        })

        const followers = Array.from(
          container.querySelectorAll<HTMLElement>(`[${ITEM_ATTR}]`),
        )

        // "off": render the final state, mount no animation at all.
        if (motionMode === "off") return

        const gentleTransition = gentleRef.current
        const uiTransition = uiRef.current
        const tokens = themeRef.current

        // Under "calm" travel, blur and orchestration collapse to zero: opacity
        // fades only, everything arrives together.
        const calm = motionMode === "calm"
        const travel = calm ? 0 : tokens.travel.enter
        const beat = calm ? 0 : tokens.stagger.base
        const lineStagger = calm ? 0 : tokens.stagger.relaxed

        // One coherent entrance timeline, driven by a running delay cursor so the
        // choreography reads the headline line by line, then the supporting copy
        // and calls to action. Opacity overrides the theme ride-along to ease-in
        // (travel/blur keep the token ease) while keeping `inherit: true` so the
        // top-level `delay` still reaches the fade channel.
        let delay = 0
        const gentleOpacity = {
          ...gentleTransition.opacity,
          ease: "easeIn" as const,
        }
        // Followers settle a touch slower than the stock `ui` token so the
        // supporting copy reads as a softer land after the headline. Scaling
        // stiffness and damping by the same time factor preserves the damping
        // ratio, so interruptions still carry velocity into the next spring.
        const followerDuration = uiTransition.duration * 1.25
        const followerTransition = {
          ...uiTransition,
          stiffness: uiTransition.stiffness / 1.25 ** 2,
          damping: uiTransition.damping / 1.25,
          duration: followerDuration,
        }
        const followerOpacity = {
          ...uiTransition.opacity,
          duration: followerDuration,
          ease: "easeIn" as const,
        }

        lines.forEach((line) => {
          if (calm) {
            // No slide or blur under reduced motion: a plain fade, in place.
            animations.push(
              animate(
                line,
                { opacity: [0, 1] },
                { ...gentleTransition, delay, opacity: gentleOpacity },
              ),
            )
          } else {
            // Unclipped line reveal: each splitText line rises a short distance,
            // fades in and clears its enter blur. opacity + literal `transform`
            // + literal `filter` (not the `y`/`blur` shorthands) so Motion hands
            // all three to WAAPI and the reveal runs on the compositor thread.
            animations.push(
              animate(
                line,
                {
                  opacity: [0, 1],
                  transform: [HEADLINE_RISE_FROM, HEADLINE_RISE_TO],
                  filter: [ENTER_BLUR_FROM, ENTER_BLUR_TO],
                },
                { ...gentleTransition, delay, opacity: gentleOpacity },
              ),
            )
          }
          delay += lineStagger
        })

        // Short breath after the headline block before followers enter, so the
        // type reveal lands before the supporting copy starts. Two relaxed
        // stagger beats on top of the per-line cursor — fixed, not scaled by
        // line count. Calm collapses it with the rest of the orchestration.
        if (!calm && lines.length > 0) {
          delay += lineStagger * 2
        }

        followers.forEach((el) => {
          if (calm) {
            animations.push(
              animate(
                el,
                {
                  opacity: [0, 1],
                  transform: ["translateY(0px)", "translateY(0px)"],
                },
                { ...followerTransition, delay, opacity: followerOpacity },
              ),
            )
          } else {
            // Same compositor trio as the headline lines: opacity + literal
            // `transform` + literal `filter` (not the `y`/`blur` shorthands), so
            // the whole reveal stays on the compositor thread rather than paying
            // a per-frame main-thread write.
            animations.push(
              animate(
                el,
                {
                  opacity: [0, 1],
                  transform: [`translateY(${travel}px)`, "translateY(0px)"],
                  filter: [ENTER_BLUR_FROM, ENTER_BLUR_TO],
                },
                { ...followerTransition, delay, opacity: followerOpacity },
              ),
            )
          }
          delay += beat
        })
      },
      () => {
        // Fail open: font loading, measurement, or splitText errors must never
        // leave meaningful content hidden. The identity check prevents a
        // cancelled run from revealing over a newer preparation.
        if (!cancelled && ref.current === container) {
          container.style.visibility = "visible"
        }
      },
    )

    return () => {
      cancelled = true
      animations.forEach((animation) => animation.stop())
    }
  }, [motionMode])

  return { ref }
}

/**
 * ==============   StaggerReveal   ================
 */

/** The elements the container can render as. Defaults to `"div"`. */
export type StaggerRevealTag = "div" | "section" | "header" | "article"

export interface StaggerRevealProps {
  /** The container content: one `StaggerRevealHeadline` and any number of
   *  `StaggerRevealItem` followers, in the order they should stagger in. */
  children: ReactNode
  /** The element to render. Defaults to `"div"`. */
  as?: StaggerRevealTag
  /** Merged onto the container - this is where the layout utilities live
   *  (`mx-auto flex flex-col items-start gap-6 px-6`, etc). */
  className?: string
  /** Forwarded to the container element. */
  id?: string
}

/**
 * The orchestration container. Wraps a `StaggerRevealHeadline` and its
 * `StaggerRevealItem` followers, and runs the single-cursor mount entrance over
 * them via `useStaggerReveal`.
 *
 * Server and no-JS output starts visible. On hydration, the layout effect hides
 * the container before paint while it measures and splits the headline, then
 * reveals it for the entrance. Any setup failure restores visibility.
 */
export function StaggerReveal({
  children,
  as = "div",
  className,
  id,
}: StaggerRevealProps): ReactElement {
  const { ref } = useStaggerReveal()
  return createElement(
    as,
    {
      ref: ref as Ref<HTMLElement>,
      id,
      className,
    },
    children,
  )
}

/**
 * ==============   StaggerRevealHeadline   ================
 */

/** The heading tags the split target can render as. Defaults to `"h1"`. */
export type StaggerRevealHeadlineTag = "h1" | "h2" | "h3"

export interface StaggerRevealHeadlineProps {
  /** The plain headline text to split and reveal. Must be a string -
   *  `splitText` operates on text content, so this cannot be arbitrary JSX. */
  children: string
  /** The element to render. Defaults to `"h1"`. */
  as?: StaggerRevealHeadlineTag
  /** The whole-headline announce for assistive tech, read instead of the
   *  per-word spans `splitText` injects. Defaults to `children`, so the full
   *  line is always announced; the container also restores the original text
   *  from it on a reduced-motion re-run. */
  ariaLabel?: string
  className?: string
  /** Forwarded to the heading (e.g. the `aria-labelledby` target id). */
  id?: string
}

/** The split-target heading the container reveals line by line. Renders plain,
 *  readable text (the split runs after mount) with the whole-headline
 *  `aria-label` announce. Exactly one belongs inside a `StaggerReveal`. */
export function StaggerRevealHeadline({
  children,
  as = "h1",
  ariaLabel,
  className,
  id,
}: StaggerRevealHeadlineProps): ReactElement {
  return createElement(
    as,
    {
      id,
      className,
      "aria-label": ariaLabel ?? children,
      [HEADLINE_ATTR]: "",
    },
    children,
  )
}

/**
 * ==============   StaggerRevealItem   ================
 */

/** The elements a follower can render as. Defaults to `"div"`. */
export type StaggerRevealItemTag =
  | "div"
  | "p"
  | "span"
  | "ul"
  | "section"
  | "figure"

export interface StaggerRevealItemProps {
  /** The follower's content (a paragraph of copy, a CTA cluster, a trust
   *  line). */
  children: ReactNode
  /** The element to render. Defaults to `"div"`. */
  as?: StaggerRevealItemTag
  /** Merged onto the follower - colour/size/layout shadcn utilities live
   *  here. */
  className?: string
  /** Forwarded to the follower element. */
  id?: string
}

/** Tags a follower the container staggers in after the headline. Followers
 *  reveal in DOM order, each a beat after the last, on the same running cursor
 *  the headline started. Drop as many as the layout needs inside a
 *  `StaggerReveal`. */
export function StaggerRevealItem({
  children,
  as = "div",
  className,
  id,
}: StaggerRevealItemProps): ReactElement {
  return createElement(
    as,
    {
      id,
      className,
      [ITEM_ATTR]: "",
    },
    children,
  )
}
