import * as d3 from "d3";
import type { D3ZoomEvent, Selection, ZoomTransform } from "d3";
import { ConfigurationExplorer } from "./configuration-space";
import type { ConfigurationRecord, Occupancy } from "./configuration-space";
import { createConfigurationProbe, makeOccupancyKey, occupanciesCover } from "./configuration-board";
import type { BoardReading } from "./configuration-board";
import type { NodeId } from "./types";

type SvgSelection = Selection<SVGSVGElement, unknown, null, undefined>;

// Milliseconds of searching per animation frame. Small enough that the canvas
// next door keeps panning smoothly while a component grows; the whole search is
// bounded separately by the explorer's own clock.
const SLICE_MILLISECONDS = 8;

// Ring spacing inside the panel. The innermost ring is held off the centre dot so
// the start is readable on top of its own ring, and the outer ring leaves room
// for the "N moves" label that sits just outside it.
const INNER_RING_FRACTION = 0.26;
const OUTER_PADDING_PX = 26;

const DOT_RADIUS_PX = 5;

interface LayoutPoint {
    key: string;
    x: number;
    y: number;
    depth: number;
    occupancy: Occupancy;
}

interface PanelElements {
    svg: SvgSelection;
    viewport: Selection<SVGGElement, unknown, null, undefined>;
    ringLayer: Selection<SVGGElement, unknown, null, undefined>;
    edgeLayer: Selection<SVGGElement, unknown, null, undefined>;
    pathLayer: Selection<SVGGElement, unknown, null, undefined>;
    nodeLayer: Selection<SVGGElement, unknown, null, undefined>;
}

export interface ReconfigurationPanelOptions {
    svgSelector: string;
    readoutSelector: string;
    // Read fresh every time, because the scenario changes underneath the panel:
    // picking a scenario tears the app down and builds a new one.
    getBoard(): BoardReading | null;
    // Puts the board into the given arrangement. Returns false when it could not.
    applyOccupancy(occupancy: Occupancy): boolean;
    setStatus(message: string): void;
}

export interface ReconfigurationPanel {
    setOpen(open: boolean): void;
    /** The board changed in a way that can change the space: start over. */
    invalidate(): void;
    /** Only the tokens moved: the component is the same, so move the marker. */
    relocate(): void;
    destroy(): void;
}

function formatCount(value: number): string {
    return value.toLocaleString("en-US");
}

/**
 * One dot per arrangement, on a ring per move count, the start at the centre.
 *
 * Depth-first rings rather than a force layout: the whole point of the picture is
 * the DISTANCE from the starting arrangement, and a force layout would spend its
 * one readable signal on clustering instead. Configurations are laid out in the
 * order they were discovered, which keeps the children of a configuration next to
 * each other and the branches apart, for free.
 */
function layoutRings(records: ConfigurationRecord[], width: number, height: number): Map<string, LayoutPoint> {
    const points = new Map<string, LayoutPoint>();
    const deepest = records.reduce((deepest, record) => Math.max(deepest, record.depth), 0);
    const maxRadius = Math.max(40, Math.min(width, height) / 2 - OUTER_PADDING_PX);
    const byDepth = new Map<number, ConfigurationRecord[]>();

    for (const record of records) {
        const layer = byDepth.get(record.depth);

        if (layer) {
            layer.push(record);
        } else {
            byDepth.set(record.depth, [record]);
        }
    }

    for (const [depth, layer] of byDepth) {
        // The start owns the middle; every later ring takes its share of the
        // radius in proportion to how far out it is, so a deep component fills
        // the panel instead of crowding at the edge.
        const radius = depth === 0 || deepest === 0
            ? 0
            : maxRadius * (INNER_RING_FRACTION + (1 - INNER_RING_FRACTION) * (depth / deepest));
        const centreAngle = -Math.PI / 2;

        layer.forEach((record, index) => {
            const angle = radius === 0 ? centreAngle : centreAngle + (index / layer.length) * Math.PI * 2;

            points.set(record.key, {
                key: record.key,
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius,
                depth: record.depth,
                occupancy: record.occupancy,
            });
        });
    }

    return points;
}

export function createReconfigurationPanel({
    svgSelector,
    readoutSelector,
    getBoard,
    applyOccupancy,
    setStatus,
}: ReconfigurationPanelOptions): ReconfigurationPanel {
    const svg = d3.select(svgSelector) as unknown as SvgSelection;
    const readout = document.querySelector(readoutSelector) as HTMLElement | null;

    svg.style("touch-action", "none");

    const viewport = svg.append("g").attr("class", "space-viewport");
    const elements: PanelElements = {
        svg,
        viewport,
        ringLayer: viewport.append("g").attr("class", "space-ring-layer"),
        edgeLayer: viewport.append("g").attr("class", "space-edge-layer"),
        pathLayer: viewport.append("g").attr("class", "space-path-layer"),
        nodeLayer: viewport.append("g").attr("class", "space-node-layer"),
    };

    let width = 0;
    let height = 0;
    let currentTransform: ZoomTransform = d3.zoomIdentity;
    let open = false;
    let frame: number | null = null;
    // Why the last picture was drawn, kept for the readout. Recomputed rather
    // than passed around so a marker-only refresh cannot show a stale verdict.
    let explorer: ConfigurationExplorer | null = null;
    let probe: ReturnType<typeof createConfigurationProbe> | null = null;
    let currentKey: string | null = null;
    let goalKeys: string[] = [];
    let distancesToGoal = new Map<string, number>();
    let currentGoalNodeIds: NodeId[] = [];
    let hoveredKey: string | null = null;
    let destroyed = false;
    let centred = false;
    let restartQueued = false;

    const zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.3, 6])
        .filter((event: MouseEvent | WheelEvent | TouchEvent) => {
            if (event.type.startsWith("touch")) {
                return (event as TouchEvent).touches.length <= 2;
            }

            return event.type === "wheel" || event.type === "dblclick" || (event.type === "mousedown" && (event as MouseEvent).button === 0);
        })
        .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
            currentTransform = event.transform;
            viewport.attr("transform", currentTransform.toString());
        });

    svg.call(zoomBehavior);
    svg.on("dblclick.zoom", null);
    svg.on("contextmenu", (event: MouseEvent) => event.preventDefault());

    // The rings are drawn around the origin, so the viewport has to start
    // centred. Later resizes move that centre by the same delta as the canvas,
    // while leaving the visitor's zoom and any pan relative to that centre intact.
    function syncCanvasSize(): void {
        const rect = (svg.node() as SVGSVGElement).getBoundingClientRect();

        if (rect.width < 60 || rect.height < 60 || (rect.width === width && rect.height === height)) {
            return;
        }

        const previousWidth = width;
        const previousHeight = height;
        width = rect.width;
        height = rect.height;
        svg.attr("width", width).attr("height", height);

        const nextTransform = !centred
            ? d3.zoomIdentity.translate(width / 2, height / 2)
            : currentTransform.translate((width - previousWidth) / 2, (height - previousHeight) / 2);
        centred = true;

        // Going through the zoom behaviour rather than assigning the transform
        // attribute keeps the next pan in step with the displayed picture.
        svg.call(zoomBehavior.transform, nextTransform);

        // Resizing also changes the radii, not just the SVG coordinate system.
        // explorer starts null, which renders an empty panel before it opens.
        render();
    }

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => syncCanvasSize());
        resizeObserver.observe(svg.node() as SVGSVGElement);
    }

    syncCanvasSize();

    function startSearch(): void {
        if (destroyed || !open) {
            return;
        }

        stopSearch();
        syncCanvasSize();

        const board = getBoard();

        if (!board) {
            explorer = null;
            probe = null;
            render();

            return;
        }

        // Held locally as well as in `probe`: the closures below outlive this
        // call, and they must ask the probe that was built from THIS reading
        // rather than whichever one exists by the time they run.
        const activeProbe = createConfigurationProbe(board);
        probe = activeProbe;
        currentGoalNodeIds = board.goalNodeIds;

        const start = [...board.occupancy].sort(activeProbe.compareIds);
        currentKey = makeOccupancyKey(start, activeProbe.compareIds);

        explorer = new ConfigurationExplorer({
            start,
            successorsOf: occupancy => activeProbe.successorsOf(occupancy),
            makeKey: occupancy => makeOccupancyKey(occupancy, activeProbe.compareIds),
        });

        goalKeys = [];
        distancesToGoal = new Map();

        // Nothing to arrange: an empty board, or one with no tokens to move.
        if (board.nodeIds.length === 0 || start.length === 0) {
            render();

            return;
        }

        runSearch();
    }

    /**
     * Grows the component a slice per animation frame, redrawing whenever a new
     * ring has appeared. The picture arriving ring by ring is the honest version
     * of a search that may never finish: a visitor watches it being found rather
     * than waiting for an answer that might take a minute.
     */
    function runSearch(): void {
        let lastDepth = -1;

        const step = () => {
            if (destroyed || !open || !explorer) {
                frame = null;

                return;
            }

            explorer.expandWithin(SLICE_MILLISECONDS);

            // A frontier that has been fully expanded, or a limit reached. Both
            // mean there is nothing more this explorer can find, so asking again
            // would only burn frames.
            const finished = explorer.pending === 0 || explorer.haltReason !== "complete";

            if (explorer.maxDepthSeen !== lastDepth || finished) {
                lastDepth = explorer.maxDepthSeen;
                render();
            }

            frame = finished ? null : requestAnimationFrame(step);
        };

        frame = requestAnimationFrame(step);
    }

    function stopSearch(): void {
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }

        explorer?.cancel();
    }

    /**
     * Which arrangements meet the goal, and how far every other one is from
     * meeting it. Every marked vertex has to carry a token; extra tokens elsewhere
     * are allowed, so a level can mark three squares on a board holding five
     * tokens.
     */
    function measureAgainstGoal(): void {
        distancesToGoal = new Map();
        goalKeys = [];

        if (!explorer || !probe || currentGoalNodeIds.length === 0) {
            return;
        }

        for (const record of explorer.configurations()) {
            if (occupanciesCover(currentGoalNodeIds, record.occupancy, probe.compareIds)) {
                goalKeys.push(record.key);
            }
        }

        distancesToGoal = explorer.distancesFrom(goalKeys);
    }

    function describeVerdict(): string {
        if (!explorer || !probe) {
            return "Open a graph to see its arrangements.";
        }

        if (currentGoalNodeIds.length === 0) {
            return "No square is marked yet, so there is nothing to aim at. Alt+click vertices to mark where the tokens should end up.";
        }

        if (currentKey !== null && distancesToGoal.get(currentKey) === 0) {
            return "Solved: every marked vertex carries a token.";
        }

        const remaining = currentKey === null ? undefined : distancesToGoal.get(currentKey);

        if (remaining !== undefined) {
            return `Shortest way left to the marked squares: ${remaining} move${remaining === 1 ? "" : "s"}.`;
        }

        // Only a search that ran to the end of the component is allowed to say a
        // goal cannot be reached. Anything else and the honest sentence is that
        // the search stopped, which is a different claim about the world.
        if (!explorer.conclusive) {
            const why = explorer.haltReason === "state-limit"
                ? `after ${formatCount(explorer.limitsInUse.maxConfigurations)} arrangements`
                : explorer.haltReason === "depth-limit"
                    ? `at ${explorer.limitsInUse.maxDepth} moves out`
                    : `after ${(explorer.limitsInUse.maxMilliseconds / 1000).toFixed(1)} s`;

            return `The marked squares were not reached ${why}. A limit reached is not a proof that they cannot be.`;
        }

        // If there are exactly as many marked vertices as tokens, the marks
        // themselves name ONE arrangement, whose legality we can check directly.
        // With fewer marks, many arrangements could cover them: checking just the
        // marked vertices would not prove that any completion with the right
        // number of tokens is legal, so do not claim one exists in another
        // component.
        if (currentGoalNodeIds.length === probe.tokenCount
            && probe.isValid([...currentGoalNodeIds].sort(probe.compareIds))) {
            return "The arrangement on the marked squares is legal, but no sequence of legal moves reaches it from the starting arrangement.";
        }

        return "No legal arrangement with a token on every marked square is reachable from the starting arrangement.";
    }

    function describeOccupancy(occupancy: Occupancy | null): string {
        if (!occupancy || occupancy.length === 0) {
            return "no tokens on the board";
        }

        return `here: ${occupancy.map(id => String(id)).join(" · ")}`;
    }

    function renderReadout(): void {
        if (!readout) {
            return;
        }

        const hovered = hoveredKey && explorer ? explorer.recordAt(hoveredKey) : null;
        const lines: string[] = [];

        if (explorer) {
            const counts = `${formatCount(explorer.size)} arrangement${explorer.size === 1 ? "" : "s"} within ${explorer.maxDepthSeen} move${explorer.maxDepthSeen === 1 ? "" : "s"}`;
            const status = explorer.conclusive
                ? "the whole component"
                : explorer.haltReason !== "complete"
                    ? `stopped ${explorer.haltReason === "state-limit"
                        ? `at ${formatCount(explorer.limitsInUse.maxConfigurations)}`
                        : explorer.haltReason === "depth-limit"
                            ? `at depth ${explorer.limitsInUse.maxDepth}`
                            : explorer.haltReason === "cancelled"
                                ? "for a newer board"
                                : `after ${(explorer.limitsInUse.maxMilliseconds / 1000).toFixed(1)} s`}`
                    : "searching…";

            lines.push(`${counts} · ${status}`);
        }

        lines.push(describeVerdict());

        lines.push(hovered
            ? `that arrangement: ${hovered.occupancy.map(id => String(id)).join(" · ")} — ${hovered.depth} move${hovered.depth === 1 ? "" : "s"} from the start`
            : describeOccupancy(explorer?.recordAt(currentKey ?? "")?.occupancy ?? null));

        readout.textContent = "";

        for (const line of lines) {
            const paragraph = document.createElement("p");
            paragraph.textContent = line;
            readout.appendChild(paragraph);
        }
    }

    function render(): void {
        measureAgainstGoal();

        const records = explorer?.configurations() ?? [];
        const points = layoutRings(records, width || 800, height || 500);

        // Rings, so a visitor can read a move count off the picture rather than
        // counting lines.
        const depths = [...new Set(records.map(record => record.depth))].sort((left, right) => left - right);
        const maxRadius = Math.max(40, Math.min(width || 800, height || 500) / 2 - OUTER_PADDING_PX);
        const deepest = depths[depths.length - 1] ?? 0;

        elements.ringLayer.selectAll<SVGCircleElement, number>(".space-ring")
            .data(depths.filter(depth => depth > 0), depth => String(depth))
            .join(
                enter => enter.append("circle").attr("class", "space-ring"),
                update => update,
                exit => exit.remove(),
            )
            .attr("r", depth => deepest === 0 ? 0 : maxRadius * (INNER_RING_FRACTION + (1 - INNER_RING_FRACTION) * (depth / deepest)))
            .attr("fill", "none");

        const edges = (explorer?.edges ?? [])
            .map(edge => ({ from: points.get(edge.from), to: points.get(edge.to) }))
            .filter((edge): edge is { from: LayoutPoint; to: LayoutPoint } => Boolean(edge.from && edge.to));

        elements.edgeLayer.selectAll<SVGLineElement, { from: LayoutPoint; to: LayoutPoint }>(".space-edge")
            .data(edges, edge => `${edge.from.key}|${edge.to.key}`)
            .join(
                enter => enter.append("line").attr("class", "space-edge"),
                update => update,
                exit => exit.remove(),
            )
            .attr("x1", edge => edge.from.x)
            .attr("y1", edge => edge.from.y)
            .attr("x2", edge => edge.to.x)
            .attr("y2", edge => edge.to.y);

        // The way down to the nearest marked arrangement, drawn from the dot the
        // board is actually on. Same information as "N moves left", in a form a
        // visitor can follow with a finger.
        const descent: LayoutPoint[] = [];

        if (explorer && currentKey && distancesToGoal.has(currentKey)) {
            let cursor: string | null = currentKey;

            // Walks downhill on the distances measured from the goals. Each hop
            // strictly lowers the number, so the walk ends at a goal on its own;
            // the zero check is what makes that certain rather than hoped for.
            while (cursor !== null) {
                const point = points.get(cursor);

                if (!point) break;

                descent.push(point);

                // Annotated by hand: the type checker would otherwise infer
                // `cursor` from the assignment below, which is written in terms of
                // this number, and give up on both.
                const distance: number = distancesToGoal.get(cursor)!;

                if (distance === 0) break;

                cursor = explorer.neighboursOf(cursor).find(key => distancesToGoal.get(key) === distance - 1) ?? null;
            }
        }

        elements.pathLayer.selectAll<SVGPolylineElement, LayoutPoint[]>(".space-descent")
            .data(descent.length > 1 ? [descent] : [], () => "descent")
            .join(
                enter => enter.append("polyline").attr("class", "space-descent"),
                update => update,
                exit => exit.remove(),
            )
            .attr("points", chain => chain.map(point => `${point.x},${point.y}`).join(" "));

        elements.nodeLayer.selectAll<SVGCircleElement, LayoutPoint>(".space-node")
            .data([...points.values()], point => point.key)
            .join(
                enter => enter.append("circle")
                    .attr("class", "space-node")
                    .attr("r", DOT_RADIUS_PX)
                    .on("pointerenter", (event: PointerEvent, point: LayoutPoint) => {
                        hoveredKey = point.key;
                        renderReadout();
                    })
                    .on("pointerleave", () => {
                        hoveredKey = null;
                        renderReadout();
                    })
                    .on("click", (event: MouseEvent, point: LayoutPoint) => {
                        if (point.key === currentKey) {
                            return;
                        }

                        if (applyOccupancy(point.occupancy)) {
                            setStatus(`Jumped to the arrangement ${point.depth} moves from where the level starts. The jump itself is not a legal move — Ctrl+Z puts the board back.`);
                        }
                    }),
                update => update,
                exit => exit.remove(),
            )
            .attr("cx", point => point.x)
            .attr("cy", point => point.y)
            .classed("is-goal", point => goalKeys.includes(point.key))
            .classed("is-on-path", point => descent.some(node => node.key === point.key))
            .classed("is-current", point => point.key === currentKey);

        renderReadout();
    }

    return {
        setOpen(nextOpen: boolean) {
            if (nextOpen === open) {
                return;
            }

            open = nextOpen;

            if (open) {
                startSearch();
            } else {
                stopSearch();
            }
        },
        // Coalesced into one restart per frame. An undo of a problem switch
        // announces a rules change and a graph change in the same breath, and a
        // drag can announce both ends of an edge; restarting the search once per
        // announcement would throw away the picture each time for the same result.
        invalidate() {
            if (!open || restartQueued) {
                return;
            }

            restartQueued = true;
            requestAnimationFrame(() => {
                restartQueued = false;

                if (open && !destroyed) {
                    startSearch();
                }
            });
        },
        relocate() {
            if (!open || !probe) {
                return;
            }

            const board = getBoard();

            if (!board) {
                return;
            }

            // A move lands inside the component that was already searched, so
            // only the marker and the verdict change. Re-searching here would
            // throw away a picture that took seconds to build, on every move.
            currentKey = makeOccupancyKey([...board.occupancy].sort(probe.compareIds), probe.compareIds);
            currentGoalNodeIds = board.goalNodeIds;
            render();
        },
        destroy() {
            destroyed = true;
            stopSearch();
            resizeObserver?.disconnect();
            svg.on(".zoom", null);
            svg.on("contextmenu", null);
            svg.selectAll("*").remove();
        },
    };
}
