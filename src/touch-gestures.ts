import * as d3 from "d3";
import type { ZoomTransform } from "d3-zoom";
import type { GraphNode, NodeId } from "./types";

// ---------------------------------------------------------------------------
// Touch gesture recogniser — the single owner of all touch* listeners on the
// <svg>. DOM click/mousedown handlers elsewhere only ever see real mouse input.
//
// Event topology this relies on (verified against node_modules/d3-zoom and
// d3-selection): our listeners are registered on the svg node itself, in the
// capture phase, before svg.call(zoomBehavior) attaches d3-zoom's handlers.
// - When the target is inside the canvas (a .node circle), capture on the svg
//   ancestor runs before d3-zoom's bubble-phase "touchstart.zoom" there.
// - When the target IS the svg, both sets are AT_TARGET and fire in
//   registration order — ours first.
// So we always get to decide first, per touch:
//   - A second finger down anywhere: abort our gesture and stop suppressing.
//     d3-zoom's touchstarted re-reads ALL of event.touches (with clean = false
//     because changedTouches.length !== touches.length) and picks up finger #1's
//     current position as touch0, so pinch starts cleanly mid-gesture.
//   - A gesture that exceeded one finger, or moved past tolerance, can never
//     produce a tap/hold consequence.
//   - preventDefault() is irrelevant to d3-zoom (touchstarted never consults
//     defaultPrevented), but it kills the synthesised click and the iOS text
//     callout, so we use it in both modes. To make sure no second VERB fires
//     from that dead click, taps/holds also arm a ~700 ms "click just came from
//     a touch we consumed" latch that the svg-level click swallower honours.
// ---------------------------------------------------------------------------

const LONG_PRESS_MS = 400;
const TAP_DRAG_TOLERANCE_PX = 12;
export const TOUCH_HIT_RADIUS_PX = 30;
const TOUCH_CLICK_SUPPRESS_MS = 700;

export interface TouchGestureDrag {
    onMove(nodeId: NodeId, graphX: number, graphY: number): void;
    onEnd(nodeId: NodeId): void;
}

export interface TouchGestureCallbacks {
    onTapNode(nodeId: NodeId): void;
    onTapEmpty(graphX: number, graphY: number): void;
    onLongPressNode(nodeId: NodeId): void;
    onDragNode(nodeId: NodeId): TouchGestureDrag | null;
}

export interface TouchGesturesContext {
    svgNode: SVGSVGElement;
    callbacks: TouchGestureCallbacks;
    isTouchEditMode(): boolean;
    isZooming(): boolean;
    isRepulsionEnabled(): boolean;
    getNodeAtPoint(graphX: number, graphY: number, ignoredNodeId?: NodeId | null): GraphNode | null;
    getNodeById(nodeId: NodeId): { x: number; y: number; fx?: number; fy?: number; anchorX: number; anchorY: number } | null;
    currentTransform(): ZoomTransform;
    recordUndoState(): void;
    positionGraphElements(): void;
    setOverlayRefreshPaused(paused: boolean): void;
    setAlphaTarget(alpha: number): void;
}

type TouchGestureState = {
    touchId: number;
    targetNodeId: NodeId | null;
    startClientX: number;
    startClientY: number;
    startGraphX: number;
    startGraphY: number;
    moved: boolean;
    longPressTimer: number | null;
    // Tap-vs-hold is decided by this flag, NEVER by timer identity. Relying
    // on the timer id or whether its callback has run races with the browser
    // (timer callbacks can be deferred past touchend by layout/simulation
    // work, and our own endGesture() can also run through a different path);
    // a tap that depends on the object's current timer slot can then be
    // read as "hold already fired" and silently vanish.
    longPressFired: boolean;
    dragHandle: TouchGestureDrag | null;
    undoRecorded: boolean;
};

export interface TouchGesturesController {
    destroy(): void;
}

export function createTouchGestures(context: TouchGesturesContext): TouchGesturesController {
    const { svgNode } = context;
    const abortController = new AbortController();

    let gesture: TouchGestureState | null = null;
    // An extra finger went down past d3-zoom's pinch-capable window, so the
    // viewport cannot follow it either — the whole contact is dead. Any blur
    // or mode change ends it too.
    let deadTouchSequenceEnd = 0;
    // Set when a tap/hold finished; the svg click swallower eats exactly the
    // one click the browser will synthesise from it.
    let lastConsumedTouchEnd = 0;

    // d3.pointer against the svg gives SVG user units — NOT the graph
    // coordinates nodes actually live in. The graph viewport carries the
    // pan/zoom transform, so the transform must be undone from the SAME
    // coordinate space d3-zoom maintains: its own pointer() calls run
    // against this same svg element with zero extra offset.
    function touchToGraphPoint(touch: Touch): [number, number] {
        const [ux, uy] = d3.pointer(touch, svgNode) as [number, number];
        return context.currentTransform().invert([ux, uy]);
    }

    function releaseLongPressTimer(state: TouchGestureState): void {
        if (state.longPressTimer !== null) {
            window.clearTimeout(state.longPressTimer);
            state.longPressTimer = null;
        }
    }

    // Balance every side effect a live gesture may have left open. A gesture
    // is "cancelled" when something other than our touchend ends it (pinch,
    // blur, mode change, destroy) — the verb then must NOT fire: the vertex
    // is left where the drag put it, but neither the drag commit nor the
    // release bookkeeping runs twice.
    function endGesture(state: TouchGestureState, committed: boolean): void {
        releaseLongPressTimer(state);

        if (committed && state.targetNodeId !== null && state.dragHandle) {
            state.dragHandle.onEnd(state.targetNodeId);
        }

        context.setAlphaTarget(0);
        context.setOverlayRefreshPaused(false);

        if (gesture === state) {
            gesture = null;
        }
    }

    // Only call after the vertex already moved at least once (committing a
    // still-tapped vertex would needlessly rewrite fx/fy).
    function commitDraggedVertex(nodeId: NodeId): void {
        const nodeData = context.getNodeById(nodeId);
        if (nodeData && !context.isRepulsionEnabled()) {
            nodeData.fx = nodeData.x;
            nodeData.fy = nodeData.y;
        }
    }

    function beginGesture(event: TouchEvent): void {
        const touch = event.changedTouches[0];
        const [graphX, graphY] = touchToGraphPoint(touch);
        const hit = context.getNodeAtPoint(graphX, graphY, null);
        const wantDrag = context.isTouchEditMode() && hit !== null;

        const state: TouchGestureState = {
            touchId: touch.identifier,
            targetNodeId: hit ? hit.id : null,
            startClientX: touch.clientX,
            startClientY: touch.clientY,
            startGraphX: graphX,
            startGraphY: graphY,
            moved: false,
            dragHandle: null,
            undoRecorded: false,
            longPressFired: false,
            longPressTimer: null,
        };

        const nodeId = hit ? hit.id : null;
        if (nodeId !== null) {
            state.longPressTimer = window.setTimeout(() => {
                // The hold is the action; it must not ALSO count as a tap when
                // the finger finally comes up.
                state.longPressFired = true;
                state.longPressTimer = null;
                context.callbacks.onLongPressNode(nodeId);
                lastConsumedTouchEnd = performance.now();
                endGesture(state, false);
            }, LONG_PRESS_MS);
        }

        if (wantDrag && nodeId !== null) {
            state.dragHandle = context.callbacks.onDragNode(nodeId);
        }

        gesture = state;

        if (wantDrag) {
            // Claim this one-finger gesture. Empty-space and Tokens-mode starts
            // fall through to d3-zoom so one-finger pan still works.
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }

    function handleTouchStart(event: TouchEvent): void {
        if (context.isZooming()) {
            // Third finger in a pinch: pinch stays the owner (d3-zoom ignores
            // it), but this contact must not start a NEW gesture after the
            // pinch ends. It is not the "stationary lift-off" case, which is
            // exactly when pageXOffset is zero.
            if (event.changedTouches.length === 2 && (window.pageXOffset || window.pageYOffset)) {
                deadTouchSequenceEnd = performance.now() + TOUCH_CLICK_SUPPRESS_MS;
                event.preventDefault();
                event.stopImmediatePropagation();
            }
            return;
        }

        if (performance.now() < deadTouchSequenceEnd) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }

        // Whatever we do below, no click should follow this touch.
        event.preventDefault();

        if (event.touches.length >= 2) {
            // Pan became pinch: hand off — d3-zoom sees the event below.
            if (gesture) {
                endGesture(gesture, true);
            }
            return;
        }

        if (gesture) {
            endGesture(gesture, false);
        }

        beginGesture(event);
    }

    function handleTouchMove(event: TouchEvent): void {
        if (!gesture) {
            return;
        }

        if (event.touches.length >= 2) {
            // d3-zoom took over on the second touchstart; our part is done.
            return;
        }

        const touch = Array.from(event.changedTouches).find(item => item.identifier === gesture!.touchId);
        if (!touch) {
            return;
        }

        const state = gesture;

        if (!state.moved) {
            const distance = Math.hypot(touch.clientX - state.startClientX, touch.clientY - state.startClientY);
            if (distance <= TAP_DRAG_TOLERANCE_PX) {
                return;
            }

            state.moved = true;
            releaseLongPressTimer(state);
        }

        if (!state.moved) {
            return;
        }

        if (state.targetNodeId !== null && state.dragHandle) {
            if (!state.undoRecorded) {
                context.recordUndoState();
                state.undoRecorded = true;
            }

            context.setOverlayRefreshPaused(true);
            context.setAlphaTarget(0.25);

            const [graphX, graphY] = touchToGraphPoint(touch);
            state.dragHandle.onMove(state.targetNodeId, graphX, graphY);
            context.positionGraphElements();
            // This one-finger move is a vertex drag. d3-zoom must not ALSO
            // turn it into a pan (zoomed in, that is a visible double
            // response), and our capture listener fires before its, so
            // stopping it here leaves the viewport untouched by the drag.
            event.stopImmediatePropagation();
        }
    }

    function handleTouchEnd(event: TouchEvent): void {
        const endedGestureTouch = gesture
            ? Array.from(event.changedTouches).find(item => item.identifier === gesture!.touchId)
            : undefined;

        if (event.touches.length >= 1) {
            // A pinch shrank back to one finger, or our earlier extra contact
            // just left. The contact that remains (if any) started as part of
            // the pinch, so future moves belong to d3-zoom, not us — and our
            // own mid-flight gesture (if finger #1 was ours when the pinch
            // began) must not leave alphaTarget/overlay paused or fx/fy
            // frozen in mid-frame.
            if (gesture && endedGestureTouch) {
                endGesture(gesture, false);
            }
            return;
        }

        const state = gesture;
        gesture = null;
        if (!state) {
            return;
        }

        if (!endedGestureTouch) {
            endGesture(state, false);
            return;
        }

        releaseLongPressTimer(state);

        if (!state.moved && state.longPressFired) {
            // Hold already produced its action; the release is just cleanup.
            context.setAlphaTarget(0);
            context.setOverlayRefreshPaused(false);
            return;
        }

        if (state.moved) {
            if (state.targetNodeId !== null && state.dragHandle) {
                commitDraggedVertex(state.targetNodeId);
            }
            endGesture(state, true);
            lastConsumedTouchEnd = performance.now();
        } else if (event.type === "touchend") {
            // Tap. (longPressFired is false here, so this is genuinely a tap.)
            lastConsumedTouchEnd = performance.now();
            if (state.targetNodeId !== null) {
                context.callbacks.onTapNode(state.targetNodeId);
            } else {
                context.callbacks.onTapEmpty(state.startGraphX, state.startGraphY);
            }
            endGesture(state, false);
        } else {
            endGesture(state, false);
        }
    }

    function handleTouchCancel(): void {
        if (gesture) {
            endGesture(gesture, false);
        }
    }

    function swallowSynthesisedClick(event: Event): void {
        // Real mouse clicks never share this reach; only the click the browser
        // builds from a touch we consumed does.
        if (performance.now() - lastConsumedTouchEnd < TOUCH_CLICK_SUPPRESS_MS) {
            lastConsumedTouchEnd = 0;
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }

    function cancelAll(): void {
        deadTouchSequenceEnd = performance.now() + TOUCH_CLICK_SUPPRESS_MS;
        if (gesture) {
            endGesture(gesture, false);
        }
    }

    const options: AddEventListenerOptions = { capture: true, signal: abortController.signal };
    svgNode.addEventListener("touchstart", handleTouchStart, options);
    svgNode.addEventListener("touchmove", handleTouchMove, { ...options, passive: false });
    svgNode.addEventListener("touchend", handleTouchEnd, options);
    svgNode.addEventListener("touchcancel", handleTouchCancel, options);
    svgNode.addEventListener("click", swallowSynthesisedClick, options);
    window.addEventListener("blur", cancelAll, options);
    document.addEventListener("visibilitychange", cancelAll, options);

    return {
        destroy() {
            abortController.abort();
            if (gesture) {
                endGesture(gesture, false);
            }
        },
    };
}
