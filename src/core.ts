import * as d3 from "d3";
import type {
    D3ZoomEvent,
    ForceLink,
    Selection,
    SimulationLinkDatum,
    SimulationNodeDatum,
    ZoomTransform,
} from "d3";
import { DEFAULT_COLOR_HINTS } from "./types";
import type {
    BoardChangeReason,
    ColorHints,
    GraphLink,
    GraphNode,
    GraphToken,
    NodeId,
    LayoutMode,
    InteractionMode,
    ProblemDefinition,
    TokenReconfigurationApp,
    TokenReconfigurationAppConfig,
    SerializedProblemContext,
} from "./types";
import type { BoardReading, TokenMove } from "./configuration-board";
import type { Occupancy } from "./configuration-space";
import { createTouchGestures, TOUCH_HIT_RADIUS_PX } from "./touch-gestures";
import { createGridOverlay } from "./grid";
import { applyGraphLayout } from "./layouts";
import { ZOOM_SCALE_RANGE, fitGraphToCanvas } from "./canvas-view";
import { createGraph } from "./graph-factory";
import { createGraphInteractions } from "./graph-interactions";
import { SelectionManager } from "./selection";
import type { SelectionStateSnapshot } from "./selection";

type ForceNodeDatum = GraphNode & SimulationNodeDatum;

type ForceLinkDatum = SimulationLinkDatum<ForceNodeDatum> & {
    source: NodeId | ForceNodeDatum;
    target: NodeId | ForceNodeDatum;
};

type GraphNodeSnapshot = {
    id: NodeId;
    x: number;
    y: number;
    vx: number;
    vy: number;
    fx?: number;
    fy?: number;
    anchorX: number;
    anchorY: number;
    highlighted?: boolean;
};

type AppUndoSnapshot = {
    graph: {
        nodes: GraphNodeSnapshot[];
        links: Array<{ source: NodeId; target: NodeId }>;
        tokens: Array<{ id: string; nodeId: NodeId }>;
        parameter: number;
        nextNodeId: number;
    };
    // Held by reference: the definitions are module constants, so a snapshot
    // cannot drift from the problem it names. Undo has to carry it because
    // switching the problem is a change the user should be able to take back.
    problem: ProblemDefinition;
    selectedTokenId: string | null;
    selection: SelectionStateSnapshot;
};

type SvgSelection = Selection<SVGSVGElement, unknown, null, undefined>;

// The side of the square drawn under a marked vertex. A vertex is r=20, so 44
// leaves it a visible border of blue on every side instead of a square the
// circle hides almost entirely.
const HIGHLIGHT_SQUARE_SIZE = 44;

// How many steps back undo reaches. A snapshot is a full copy of the graph, so
// this is the only thing that bounds what undo costs in memory: recording one
// step and taking one step are each a single copy, however deep the stack is.
const MAX_UNDO_STEPS = 20;

// Does this batch of vertices arrive with its own drawing? A vertex that was
// only named (an id, or no coordinates) is placed by the factory relative to a
// canvas it has not been given a size for yet, so a scenario has to have said
// where EVERY vertex goes before its Configuration can be trusted. The check
// belongs here rather than on the built graph because a vertex with no
// coordinates still ends up at finite numbers, indistinguishable from one that
// was genuinely drawn at that spot.
function inputsCarryPositions(nodes: Array<unknown>): boolean {
    return nodes.length > 0 && nodes.every(node => {
        if (typeof node !== "object" || node === null) {
            return false;
        }

        const { x, y } = node as { x?: unknown; y?: unknown };

        return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y);
    });
}

export function createTokenReconfigurationApp({
    svgSelector,
    parameterInputSelector,
    statusSelector,
    nodes,
    links,
    tokens: initialTokens,
    initialParameter,
    problem: initialProblem,
    onProblemChange,
}: TokenReconfigurationAppConfig): TokenReconfigurationApp {
    const svg = d3.select(svgSelector) as unknown as SvgSelection;
    const pInput = document.querySelector(parameterInputSelector) as HTMLInputElement;
    const statusElement = document.querySelector(statusSelector) as HTMLElement;

    if (!pInput || !statusElement) {
        throw new Error("Token Reconfiguration app root elements were not found.");
    }

    // The canvas owns its own touches (pan/zoom/edit are all manual);
    // everything outside the canvas stays scrollable on a phone.
    svg.style("touch-action", "none");

    // The SVG's width/height ARE its user units (there is no viewBox), so they
    // are kept equal to its rendered box — that makes 1 graph unit ≈ 1 CSS px
    // on a phone, which is what turns vertex r=20 into a ~40 px tap target.
    let width = 0;
    let height = 0;

    const graph = createGraph(nodes, links, initialTokens, initialParameter, initialProblem.rules, width, height);

    const graphNodes: ForceNodeDatum[] = graph.nodes as ForceNodeDatum[];
    const graphLinks: ForceLinkDatum[] = graph.links as ForceLinkDatum[];
    let selectedTokenId: string | null = null;
    let legalMoveTargets = new Set<NodeId>();
    let repulsionEnabled = false;
    let showNeighborhoodCounts = false;
    let showMoveDirections = false;
    let overlayRefreshPaused = false;
    let currentTransform: ZoomTransform = d3.zoomIdentity;
    let parameter = initialParameter;
    // Reassigned by setProblem. The graph keeps its vertices across a switch,
    // so the problem is state of the session, not of the graph's construction.
    let currentProblem = initialProblem;
    const undoStack: AppUndoSnapshot[] = [];
    let undoGroupDepth = 0;
    // Anything watching the board from outside — today, the panel that draws the
    // graph of Configurations. A set rather than one callback so a second watcher
    // can be added without either one having to forward to the other.
    const boardChangeListeners = new Set<(reason: BoardChangeReason) => void>();

    const background = svg.append("rect")
        .attr("class", "graph-background")
        .attr("width", width)
        .attr("height", height);

    const graphViewport = svg.append("g").attr("class", "graph-viewport");
    // The grid first, so it lies under everything the reader has drawn, and it
    // takes no pointer events: a grid is something you aim at, never something
    // you click.
    const gridLayer = graphViewport.append("g")
        .attr("class", "grid-layer")
        .attr("aria-hidden", "true")
        .style("pointer-events", "none");
    const linkLayer = graphViewport.append("g").attr("class", "link-layer");
    // Its own layer, below the vertices, because the mark is meant to sit under a
    // vertex rather than on it. Below the links as well would let a square punch a
    // hole through the edges running into the vertex it marks.
    const highlightLayer = graphViewport.append("g").attr("class", "highlight-layer");
    const nodeLayer = graphViewport.append("g").attr("class", "node-layer");
    const tokenLayer = graphViewport.append("g").attr("class", "token-layer");
    const overlayLayer = graphViewport.append("g").attr("class", "overlay-layer");
    const neighborhoodCountLayer = overlayLayer.append("g").attr("class", "neighborhood-count-layer");
    const moveDirectionLayer = overlayLayer.append("g").attr("class", "move-direction-layer");
    const interactionLayer = graphViewport.append("g").attr("class", "interaction-layer");
    const edgePreview = interactionLayer.append("line")
        .attr("class", "edge-preview")
        .style("display", "none");
    const selectionPreview = interactionLayer.append("rect")
        .attr("class", "selection-preview")
        .style("display", "none");
    // Dashed ring marking the vertex a tap committed as an edge source. It is
    // shown/hidden here, never via the node's class attribute, so
    // updateNodeClasses cannot wipe it and setOverlayRefreshPaused cannot
    // delete it either (overlay children ARE removed there).
    const pendingEdgeHalo = interactionLayer.append("circle")
        .attr("class", "pending-edge-source")
        .attr("r", 26)
        .style("display", "none");

    // A hypothetical move from the Configuration panel. This is deliberately not
    // another node class: it is a transient explanation, not a claimed legal
    // target or a change to the board's state, and neither undo nor saving sees it.
    const movePreviewLayer = graphViewport.append("g")
        .attr("class", "move-preview-layer")
        .attr("aria-hidden", "true")
        .style("display", "none")
        .style("pointer-events", "none");
    movePreviewLayer.append("defs").append("marker")
        .attr("id", "move-preview-arrow")
        .attr("viewBox", "0 0 10 10")
        .attr("refX", 9)
        .attr("refY", 5)
        .attr("markerWidth", 10)
        .attr("markerHeight", 10)
        .attr("markerUnits", "userSpaceOnUse")
        .attr("orient", "auto")
        .append("path")
        .attr("class", "move-preview-arrowhead")
        .attr("d", "M 0 0 L 10 5 L 0 10 z");
    const movePreviewArrow = movePreviewLayer.append("line")
        .attr("class", "move-preview-arrow")
        .attr("marker-end", "url(#move-preview-arrow)");
    const movePreviewSource = movePreviewLayer.append("circle")
        .attr("class", "move-preview-source")
        .attr("r", 27);
    const movePreviewTarget = movePreviewLayer.append("rect")
        .attr("class", "move-preview-target")
        .attr("width", 54)
        .attr("height", 54)
        .attr("rx", 6);
    const movePreviewSourceLabel = movePreviewLayer.append("text")
        .attr("class", "move-preview-label");
    const movePreviewTargetLabel = movePreviewLayer.append("text")
        .attr("class", "move-preview-label is-target")
        .attr("text-anchor", "end");
    let currentMovePreview: { source: GraphNode; target: GraphNode } | null = null;

    function setStatus(message: string): void {
        statusElement.textContent = message;
    }

    // Announced after the change has been made and drawn, so a listener that
    // reads the board back sees the new state and not the one it replaced. The
    // notification is the last thing each operation does: nothing on the canvas
    // depends on a listener finishing, and a watcher that throws loses its
    // picture rather than the edit.
    function notifyBoardChanged(reason: BoardChangeReason): void {
        for (const listener of boardChangeListeners) {
            listener(reason);
        }
    }

    const selection = new SelectionManager(
        graph,
        () => graphNodes,
        setStatus,
        () => updateNodeClasses(),
        () => updateTokenClasses(),
        recordUndoState,
        () => currentProblem,
    );

    const linkForce = d3.forceLink<ForceNodeDatum, ForceLinkDatum>(graphLinks)
        .id((d: ForceNodeDatum) => d.id)
        .distance(120)
        .strength(0.75) as ForceLink<ForceNodeDatum, ForceLinkDatum>;
    const chargeForce = d3.forceManyBody<ForceNodeDatum>().strength(-35);
    const collideForce = d3.forceCollide<ForceNodeDatum>(26);
    const centerForce = d3.forceCenter(width / 2, height / 2);
    const simulation = d3.forceSimulation<ForceNodeDatum>(graphNodes)
        .velocityDecay(0.78)
        .force("link", linkForce)
        .force("charge", null)
        .force("collide", null)
        .force("center", null);

    let interactionMode: InteractionMode = "tokens";
    let pendingEdgeSourceId: NodeId | null = null;
    // Which vertex hints are painted, one switch per hint. A switch that is
    // off leaves its vertices on the neutral .slot fill — the rules behind the
    // hint still apply, so an uncoloured graph stays exactly as legal.
    let colorHints: ColorHints = { ...DEFAULT_COLOR_HINTS };

    // Whether the grid shows, and how far apart its lines are, live inside the
    // overlay and nowhere else: the same two values decide what is drawn and
    // where a released vertex lands, so keeping them in one owner is what stops
    // the grid on screen disagreeing with the grid the vertices snap to. The
    // controls in main.ts remain the thing that sets them.
    const gridOverlay = createGridOverlay({
        layer: gridLayer,
        currentTransform: () => currentTransform,
        canvasSize: () => ({ width, height }),
    });

    const zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent(ZOOM_SCALE_RANGE)
        .filter((event: MouseEvent | WheelEvent | TouchEvent) => {
            // One- and two-finger touches start gestures of their own (the
            // recogniser decides who truly owns a touch), three fingers do
            // not. The mode never matters here: pan/pinch belong to the
            // viewport in BOTH modes.
            if (event.type.startsWith("touch")) {
                return (event as TouchEvent).touches.length <= 2;
            }

            // Alt is refused so that Alt+left-click can mean something of its own
            // on the canvas: accepted here, the press would begin a pan the user
            // never asked for, and a pan that ends without moving still counts as
            // a gesture the click has to survive.
            if (event.altKey) {
                return false;
            }

            return event.type === "wheel" || (event.type === "mousedown" && (event as MouseEvent).button === 0) || event.type === "dblclick";
        })
        .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
            currentTransform = event.transform;
            graphViewport.attr("transform", currentTransform.toString());
            // The grid is drawn only across what the reader can see, so a pan or
            // a wheel turn changes which lines exist — the viewport transform
            // alone would slide a finite patch of lines off with the drawing.
            gridOverlay.render();
        });

    const interactions = createGraphInteractions({
        svg,
        edgePreview,
        selectionPreview,
        simulation,
        getNodeById,
        getSelectedNodeIds: () => selection.getSelectedNodeIds(),
        isNodeSelected: (nodeId: NodeId) => selection.isNodeSelected(nodeId),
        selectNodesInRectangle: (x1, y1, x2, y2) => {
            clearTokenMoveSelection();
            selection.selectNodesInRectangle(x1, y1, x2, y2);
        },
        clearNodeSelection: () => selection.clearNodeSelection(),
        recordUndoState,
        beginUndoGroup,
        endUndoGroup,
        positionGraphElements,
        setStatus,
        refreshGraphAfterMutation,
        addNodeAtPoint,
        addEdge,
        removeEdge,
        removeNode,
        getNodeAtPoint,
        currentTransform: () => currentTransform,
        isRepulsionEnabled: () => repulsionEnabled,
        snapPoint: (x, y) => gridOverlay.snap(x, y),
        setOverlayRefreshPaused: (paused: boolean) => {
            overlayRefreshPaused = paused;
            if (paused) {
                neighborhoodCountLayer.selectAll<SVGTextElement, GraphNode>(".neighborhood-count").remove();
                moveDirectionLayer.selectAll<SVGLineElement, { key: string; x1: number; y1: number; x2: number; y2: number }>(".move-direction-hint").remove();
                return;
            }
            refreshOverlayState();
        },
    });

    function setSimulationForces(): void {
        simulation.force("link", linkForce);
        simulation.force("collide", repulsionEnabled ? collideForce : null);
        simulation.force("charge", repulsionEnabled ? chargeForce : null);
        simulation.force("center", repulsionEnabled ? centerForce : null);
    }

    function releaseNodesForRepulsion(): void {
        graphNodes.forEach(node => {
            node.fx = undefined;
            node.fy = undefined;
        });
    }

    function fixNodesForStaticLayout(): void {
        graphNodes.forEach(node => {
            node.fx = node.x;
            node.fy = node.y;
            node.anchorX = node.x;
            node.anchorY = node.y;
        });
    }

    function syncNodePinning(): void {
        if (repulsionEnabled) {
            releaseNodesForRepulsion();
            return;
        }

        fixNodesForStaticLayout();
    }

    // Moves the window onto a part of the graph without moving the graph. Going
    // through the zoom behaviour rather than the viewport's transform attribute
    // is what keeps the two in step: the behaviour remembers where it thinks the
    // graph is, so a transform it was never told about would be undone by the
    // next wheel tick, and taps would land somewhere else than they look.
    function setCanvasView(view: ZoomTransform): void {
        svg.call(zoomBehavior.transform, view);
    }

    function applyLayout(layout: LayoutMode): void {
        applyGraphLayout({
            graph,
            width,
            height,
        }, layout);

        syncNodePinning();
        setSimulationForces();
        refreshTokenMoveSelectionState();
        updateNodeClasses();
        updateTokenClasses();
        positionGraphElements();
        simulation.alpha(0.8).restart();
    }

    function setRepulsionEnabled(enabled: boolean): void {
        repulsionEnabled = enabled;
        syncNodePinning();
        setSimulationForces();
        positionGraphElements();
        simulation.alpha(0.8).restart();
    }

    function syncSimulation(): void {
        simulation.nodes(graphNodes);
        (simulation.force("link") as ForceLink<ForceNodeDatum, ForceLinkDatum>).links(graphLinks);
        setSimulationForces();
        simulation.alpha(0.6).restart();
    }

    function getNodeById(nodeId: NodeId): ForceNodeDatum | null {
        return graph.nodeById.get(nodeId) as ForceNodeDatum | null || null;
    }

    function getNodeAtPoint(x: number, y: number, ignoredNodeId: NodeId | null = null): GraphNode | null {
        // Hit radius in SCREEN pixels, expressed back in graph units so picking
        // stays equally forgiving at every zoom level. The mouse uses the same
        // path, which makes middle/right-click hit-testing generous on
        // purpose.
        const matchRadius = Math.max(22, TOUCH_HIT_RADIUS_PX / currentTransform.k);
        let closestNode: GraphNode | null = null;
        let closestDistance = Infinity;

        graphNodes.forEach(nodeData => {
            if (nodeData.id === ignoredNodeId || !Number.isFinite(nodeData.x) || !Number.isFinite(nodeData.y)) {
                return;
            }

            const dx = nodeData.x - x;
            const dy = nodeData.y - y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < closestDistance) {
                closestDistance = distance;
                closestNode = nodeData;
            }
        });

        return closestDistance <= matchRadius ? closestNode : null;
    }

    // ---- Touch verbs (wired to touch-gestures.ts below) -----------------
    //
    // The recogniser handles all timing/tolerance. These functions only
    // decide what a tap/hold/empty-tap MEANS in the current mode. The mouse
    // never goes through them.

    function showPendingEdgeSource(nodeId: NodeId): void {
        const nodeData = getNodeById(nodeId);
        if (!nodeData) {
            return;
        }
        pendingEdgeHalo.style("display", null).attr("cx", nodeData.x).attr("cy", nodeData.y);
    }

    function clearPendingEdgeSource(): void {
        pendingEdgeSourceId = null;
        pendingEdgeHalo.style("display", "none");
    }

    function tryToggleEdge(sourceId: NodeId, targetId: NodeId): void {
        if (removeEdge(sourceId, targetId)) {
            refreshGraphAfterMutation(`Edge between nodes ${sourceId} and ${targetId} removed.`);
        } else if (addEdge(sourceId, targetId)) {
            refreshGraphAfterMutation(`Edge added between nodes ${sourceId} and ${targetId}.`);
        } else {
            setStatus(`Edge between nodes ${sourceId} and ${targetId} would violate the current problem constraints, so it was blocked.`);
        }
    }

    function handleTouchTapNode(nodeId: NodeId): void {
        if (interactionMode === "tokens") {
            const token = graph.getTokenAtNode(nodeId);
            // A token is selected and the tapped vertex carries a DIFFERENT
            // token: move the selection to it instead of refusing the tap.
            // The selected token's own vertex is left out so that tap still
            // toggles it off, and legal destinations are left out so a future
            // rule that allows moving onto an occupied vertex still moves.
            if (selectedTokenId && token && token.id !== selectedTokenId && !legalMoveTargets.has(nodeId)) {
                selectToken(token.id);
                return;
            }
            if (selectedTokenId) {
                handleNodeClick(nodeId);
                return;
            }
            if (token) {
                selectToken(token.id);
                return;
            }
            setStatus("That vertex is empty. Hold it to add a token; tap a vertex with a token to see its legal moves.");
            return;
        }

        // Graph mode: tapping a vertex walks the edge-editing verb —
        // first tap arms the source, next tap on another vertex toggles
        // that edge.
        if (pendingEdgeSourceId === null) {
            pendingEdgeSourceId = nodeId;
            showPendingEdgeSource(nodeId);
            setStatus(`Vertex ${nodeId} selected as the edge source. Tap another vertex to add/remove the edge, or tap it again to cancel.`);
            return;
        }
        if (pendingEdgeSourceId === nodeId) {
            clearPendingEdgeSource();
            setStatus("Edge source cancelled.");
            return;
        }
        tryToggleEdge(pendingEdgeSourceId, nodeId);
        clearPendingEdgeSource();
    }

    function handleTouchHoldNode(nodeId: NodeId): void {
        if (navigator.vibrate) {
            navigator.vibrate(15);
        }

        if (interactionMode === "tokens") {
            // Hold toggles: add a token, or remove the one already there.
            if (graph.getTokenAtNode(nodeId)) {
                deleteTokenAtNode(nodeId);
                return;
            }
            if (!addTokenAtNode(nodeId)) {
                setStatus(`A token cannot stand on node ${nodeId} — it would violate the ${currentProblem.name} rule.`);
            }
            return;
        }

        // Graph mode: the deliberate verb — delete the vertex.
        clearPendingEdgeSource();
        if (removeNode(nodeId)) {
            refreshGraphAfterMutation(`Node ${nodeId} removed.`);
        }
    }

    function handleTouchTapEmpty(graphX: number, graphY: number): void {
        if (interactionMode === "tokens") {
            // On the desktop this is the background's click handler; the tap
            // must not silently lose it.
            clearTokenMoveSelection();
            return;
        }

        // Graph mode: tap empty space -> a new isolated vertex. An armed edge
        // source is not cancelled by a stray tap near a vertex.
        addNodeAtPoint(graphX, graphY);
        refreshGraphAfterMutation();
    }

    const touchGestures = createTouchGestures({
        svgNode: svg.node() as SVGSVGElement,
        callbacks: {
            onTapNode: handleTouchTapNode,
            onTapEmpty: handleTouchTapEmpty,
            onLongPressNode: handleTouchHoldNode,
            onDragNode: nodeId => ({
                onMove: (_id, x, y) => {
                    const nodeData = getNodeById(nodeId);
                    if (nodeData) {
                        // A finger drags a vertex just as a mouse does, so it
                        // lands on the grid on exactly the same terms.
                        const [gx, gy] = gridOverlay.snap(x, y);
                        nodeData.fx = gx;
                        nodeData.fy = gy;
                        nodeData.x = gx;
                        nodeData.y = gy;
                        nodeData.anchorX = gx;
                        nodeData.anchorY = gy;
                    }
                },
                onEnd: finishedNodeId => {
                    setStatus(`Node ${finishedNodeId} moved.`);
                },
            }),
        },
        isTouchEditMode: () => interactionMode === "graph",
        isZooming: () => Boolean((svg.node() as SVGSVGElement & { __zooming?: unknown }).__zooming),
        isRepulsionEnabled: () => repulsionEnabled,
        getNodeAtPoint,
        getNodeById: nodeId => getNodeById(nodeId),
        currentTransform: () => currentTransform,
        recordUndoState,
        positionGraphElements,
        setOverlayRefreshPaused: paused => {
            overlayRefreshPaused = paused;
            if (paused) {
                neighborhoodCountLayer.selectAll<SVGTextElement, GraphNode>(".neighborhood-count").remove();
                moveDirectionLayer.selectAll<SVGLineElement, { key: string; x1: number; y1: number; x2: number; y2: number }>(".move-direction-hint").remove();
                return;
            }
            refreshOverlayState();
        },
        setAlphaTarget: alpha => {
            simulation.alphaTarget(alpha).restart();
        },
    });

    // Every new vertex of a mouse or finger gesture comes through here — a
    // middle-click on the background, a right-drag released on empty space, a tap
    // on empty space in graph mode — so this is where a new vertex is put on the
    // grid. A vertex is placed by the same aiming as a move, and one that landed
    // between the lines while the reader was aiming at them would have to be
    // dragged afterwards to be aligned, which is the thing the switch is for.
    function addNodeAtPoint(x: number, y: number): GraphNode {
        recordUndoState();
        const [gx, gy] = gridOverlay.snap(x, y);
        const nodeData = graph.addNodeAtPoint(gx, gy);
        if (repulsionEnabled) {
            nodeData.fx = undefined;
            nodeData.fy = undefined;
        }

        return nodeData;
    }

    function refreshTokenMoveSelectionState(): void {
        legalMoveTargets = selectedTokenId ? new Set(graph.getLegalMoveTargets(selectedTokenId)) : new Set<NodeId>();
    }

    function isTokenFrozen(tokenId: string): boolean {
        return graph.getLegalMoveTargets(tokenId).length === 0;
    }

    function clearTokenMoveSelection(statusMessage: string = ""): void {
        selectedTokenId = null;
        legalMoveTargets = new Set<NodeId>();
        updateNodeClasses();
        updateTokenClasses();
        if (!overlayRefreshPaused) {
            renderMoveDirectionHints();
        }
        setStatus(statusMessage);
    }

    function selectToken(tokenId: string): void {
        if (selectedTokenId === tokenId) {
            clearTokenMoveSelection();
            return;
        }

        selectedTokenId = tokenId;
        legalMoveTargets = new Set(graph.getLegalMoveTargets(tokenId));
        selection.clearNodeSelection();
        updateNodeClasses();
        updateTokenClasses();
        if (!overlayRefreshPaused) {
            renderMoveDirectionHints();
        }

        if (legalMoveTargets.size === 0) {
            setStatus(`Token ${tokenId} is frozen and cannot move.`);
        } else {
            setStatus(`Token ${tokenId} selected. Click one of the highlighted neighbors.`);
        }
    }

    function moveToken(tokenId: string, targetNodeId: NodeId): boolean {
        if (!graph.canMoveToken(tokenId, targetNodeId)) {
            setStatus(`That move would violate the ${currentProblem.name} rule, so it was blocked.`);
            return false;
        }

        const token = graph.tokens.find(item => item.id === tokenId);
        if (!token) {
            clearTokenMoveSelection();
            return false;
        }

        recordUndoState();
        token.nodeId = targetNodeId;
        refreshTokenMoveSelectionState();
        renderTokens();
        refreshOverlayState();
        updateNodeClasses();

        if (legalMoveTargets.size === 0) {
            setStatus(`Token ${tokenId} moved to node ${targetNodeId}. It is now frozen.`);
        } else {
            setStatus(`Token ${tokenId} moved to node ${targetNodeId}.`);
        }

        // Said apart from every other change on purpose: a legal slide lands on an
        // Configuration that was already reachable, so a watcher that has the
        // component drawn already needs to move a marker, not start over.
        notifyBoardChanged("token-moved");

        return true;
    }

    function addTokenAtNode(nodeId: NodeId): boolean {
        if (!graph.canPlaceTokenAtNode(nodeId, graph.tokens, parameter)) {
            return false;
        }

        recordUndoState();
        if (!graph.addTokenAtNode(nodeId, parameter)) {
            return false;
        }

        renderTokens();
        refreshOverlayState();
        updateNodeClasses();
        setStatus(`Token added at node ${nodeId}.`);
        // A token appearing or leaving changes how many tokens every Configuration
        // holds, which is a different board to search.
        notifyBoardChanged("token-added-or-removed");
        return true;
    }

    function deleteTokenAtNode(nodeId: NodeId): boolean {
        const token = graph.getTokenAtNode(nodeId);
        if (!token) {
            return false;
        }

        recordUndoState();
        if (!graph.deleteTokenAtNode(nodeId)) {
            return false;
        }

        if (selectedTokenId === token.id) {
            clearTokenMoveSelection();
        } else {
            updateNodeClasses();
            updateTokenClasses();
        }

        renderTokens();
        refreshOverlayState();
        setStatus(`Token removed from node ${nodeId}.`);
        notifyBoardChanged("token-added-or-removed");
        return true;
    }

    function toggleTokenAtNode(nodeId: NodeId): void {
        if (graph.getTokenAtNode(nodeId)) {
            deleteTokenAtNode(nodeId);
            return;
        }

        addTokenAtNode(nodeId);
    }

    function handleNodeClick(nodeId: NodeId): void {
        if (!selectedTokenId) {
            return;
        }

        if (legalMoveTargets.has(nodeId)) {
            moveToken(selectedTokenId, nodeId);
            return;
        }

        const selectedToken = graph.tokens.find(token => token.id === selectedTokenId);
        if (selectedToken && selectedToken.nodeId === nodeId) {
            clearTokenMoveSelection();
            return;
        }

        setStatus("Click one of the highlighted neighbors to move the selected token.");
    }

    function positionTokens(): void {
        tokenLayer.selectAll<SVGCircleElement, GraphToken>(".token")
            .attr("cx", d => {
                const nodeData = graph.nodeById.get(d.nodeId);
                return nodeData ? nodeData.x : 0;
            })
            .attr("cy", d => {
                const nodeData = graph.nodeById.get(d.nodeId);
                return nodeData ? nodeData.y : 0;
            });
    }

    // The squares under marked vertices. Only the marked ones get an element, so
    // the layer holds nothing at all on an unmarked graph and a deleted vertex's
    // square leaves with it — the mark lives on the node, so there is no
    // collection of ids here to go stale when a vertex is removed.
    function renderNodeHighlights(): void {
        highlightLayer.selectAll<SVGRectElement, ForceNodeDatum>(".node-highlight")
            .data(graphNodes.filter(node => node.highlighted), d => String(d.id))
            .join(
                enter => enter.append("rect")
                    .attr("class", "node-highlight")
                    .attr("width", HIGHLIGHT_SQUARE_SIZE)
                    .attr("height", HIGHLIGHT_SQUARE_SIZE),
                update => update,
                exit => exit.remove(),
            );

        positionNodeHighlights();
    }

    function positionNodeHighlights(): void {
        highlightLayer.selectAll<SVGRectElement, ForceNodeDatum>(".node-highlight")
            .attr("x", d => d.x - HIGHLIGHT_SQUARE_SIZE / 2)
            .attr("y", d => d.y - HIGHLIGHT_SQUARE_SIZE / 2);
    }

    function toggleNodeHighlight(nodeId: NodeId): void {
        const nodeData = graph.nodeById.get(nodeId);

        if (!nodeData) {
            return;
        }

        recordUndoState();
        nodeData.highlighted = !nodeData.highlighted;
        renderNodeHighlights();
        setStatus(nodeData.highlighted
            ? `Vertex ${nodeId} highlighted.`
            : `Highlight removed from vertex ${nodeId}.`);
        // The marks are what a goal is made of, so a mark added or taken off moves
        // the target — never the Configurations themselves.
        notifyBoardChanged("goals-changed");
    }

    function renderNeighborhoodCountLabels(): void {
        if (overlayRefreshPaused || !showNeighborhoodCounts) {
            neighborhoodCountLayer.selectAll<SVGTextElement, GraphNode>(".neighborhood-count").remove();
            return;
        }

        const labels = neighborhoodCountLayer.selectAll<SVGTextElement, GraphNode>(".neighborhood-count")
            .data(graph.nodes, d => String(d.id))
            .join(
                enter => enter.append("text")
                    .attr("class", "neighborhood-count")
                    .attr("text-anchor", "middle")
                    .attr("dominant-baseline", "middle"),
                update => update,
                exit => exit.remove(),
            );

        labels
            .attr("x", d => d.x + 18)
            .attr("y", d => d.y - 16)
            .text(d => String(graph.countTokensInNeighborhood(graph.getClosedNeighborhood(d.id), graph.tokens)));
    }

    function renderMoveDirectionHints(): void {
        if (overlayRefreshPaused || !showMoveDirections) {
            moveDirectionLayer.selectAll<SVGLineElement, { key: string; x1: number; y1: number; x2: number; y2: number }>(".move-direction-hint").remove();
            return;
        }

        const hints = graph.tokens.flatMap(token => {
            const sourceNode = graph.nodeById.get(token.nodeId);
            if (!sourceNode) {
                return [];
            }

            return graph.getLegalMoveTargets(token.id).map(targetNodeId => {
                const targetNode = graph.nodeById.get(targetNodeId);
                if (!targetNode) {
                    return null;
                }

                const dx = targetNode.x - sourceNode.x;
                const dy = targetNode.y - sourceNode.y;
                const length = Math.hypot(dx, dy) || 1;
                const unitX = dx / length;
                const unitY = dy / length;
                const segmentLength = Math.min(28, length * 0.35)
                const startDistance = 12;

                return {
                    key: `${token.id}-${String(targetNodeId)}`,
                    x1: sourceNode.x + unitX * startDistance,
                    y1: sourceNode.y + unitY * startDistance,
                    x2: sourceNode.x + unitX * (startDistance + segmentLength),
                    y2: sourceNode.y + unitY * (startDistance + segmentLength),
                };
            }).filter((hint): hint is { key: string; x1: number; y1: number; x2: number; y2: number } => hint !== null);
        });

        const hintSelection = moveDirectionLayer.selectAll<SVGLineElement, { key: string; x1: number; y1: number; x2: number; y2: number }>(".move-direction-hint")
            .data(hints, d => d.key)
            .join(
                enter => enter.append("line")
                    .attr("class", "move-direction-hint"),
                update => update,
                exit => exit.remove(),
            );

        hintSelection
            .attr("x1", d => d.x1)
            .attr("y1", d => d.y1)
            .attr("x2", d => d.x2)
            .attr("y2", d => d.y2);
    }

    function refreshOverlayState(): void {
        if (overlayRefreshPaused) {
            neighborhoodCountLayer.selectAll<SVGTextElement, GraphNode>(".neighborhood-count").remove();
            moveDirectionLayer.selectAll<SVGLineElement, { key: string; x1: number; y1: number; x2: number; y2: number }>(".move-direction-hint").remove();
            positionMovePreview();
            return;
        }

        renderNeighborhoodCountLabels();
        renderMoveDirectionHints();
    }

    function setMovePreview(move: TokenMove | null): void {
        const source = move === null ? undefined : graph.nodeById.get(move.from);
        const target = move === null ? undefined : graph.nodeById.get(move.to);
        currentMovePreview = source && target && source.id !== target.id
            ? { source, target }
            : null;
        positionMovePreview();
    }

    function positionMovePreview(): void {
        if (!currentMovePreview || overlayRefreshPaused) {
            movePreviewLayer.style("display", "none");
            return;
        }

        const { source, target } = currentMovePreview;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance = Math.hypot(dx, dy);
        const unitX = distance > 0 ? dx / distance : 1;
        const unitY = distance > 0 ? dy / distance : 0;
        const shortening = Math.min(31, distance * 0.4);
        movePreviewLayer.style("display", null);
        movePreviewSource.attr("cx", source.x).attr("cy", source.y);
        movePreviewTarget.attr("x", target.x - 27).attr("y", target.y - 27);
        movePreviewArrow
            .attr("x1", source.x + unitX * shortening)
            .attr("y1", source.y + unitY * shortening)
            .attr("x2", target.x - unitX * shortening)
            .attr("y2", target.y - unitY * shortening);
        movePreviewSourceLabel
            .attr("x", source.x - 28)
            .attr("y", source.y - 34)
            .text(`from ${String(source.id)}`);
        movePreviewTargetLabel
            .attr("x", target.x + 28)
            .attr("y", target.y - 34)
            .text(`to ${String(target.id)}`);
    }

    function positionGraphElements(): void {
        linkLayer.selectAll<SVGLineElement, GraphLink>(".link")
            .attr("x1", d => (d.source as GraphNode).x)
            .attr("y1", d => (d.source as GraphNode).y)
            .attr("x2", d => (d.target as GraphNode).x)
            .attr("y2", d => (d.target as GraphNode).y);

        nodeLayer.selectAll<SVGCircleElement, ForceNodeDatum>(".node")
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);

        // Here rather than only where a mark is toggled, because this is the one
        // place every mover of a vertex passes through — drag, a one-time layout,
        // a canvas resize and the simulation's own ticks.
        positionNodeHighlights();

        if (pendingEdgeSourceId !== null) {
            const sourceNode = getNodeById(pendingEdgeSourceId);
            if (sourceNode) {
                pendingEdgeHalo.attr("cx", sourceNode.x).attr("cy", sourceNode.y);
            }
        }

        positionMovePreview();
        positionTokens();
        refreshOverlayState();
    }

    function updateNodeClasses(): void {
        nodeLayer.selectAll<SVGCircleElement, GraphNode>(".node")
            .attr("class", d => {
                const token = graph.getTokenAtNode(d.id);
                // Every vertex starts on the neutral slot colour; a hint whose
                // switch is on then overrides it. A hint being off means its
                // class is absent, so the CSS never has to know about the
                // switches.
                const classes = ["node", "slot"];

                if (selection.isNodeSelected(d.id)) {
                    classes.push("region-selected");
                }

                if (!token) {
                    if (colorHints.placeable && graph.canPlaceTokenAtNode(d.id)) {
                        classes.push("placeable");
                    }
                } else if (isTokenFrozen(token.id)) {
                    if (colorHints.frozen) {
                        classes.push("frozen");
                    }
                } else if (colorHints.movable) {
                    classes.push("mobile");
                }

                if (selectedTokenId && token && token.id === selectedTokenId) {
                    classes.push("selected");
                }

                if (legalMoveTargets.has(d.id)) {
                    classes.push("selectable");
                }

                return classes.join(" ");
            });
    }

    function updateTokenClasses(): void {
        tokenLayer.selectAll<SVGCircleElement, GraphToken>(".token")
            .attr("class", d => {
                const classes = ["token"];
                if (d.id === selectedTokenId) {
                    classes.push("selected");
                }
                return classes.join(" ");
            });
    }

    function renderTokens(): void {
        const tokenElements = tokenLayer.selectAll<SVGCircleElement, GraphToken>(".token").data(graph.tokens, d => d.id);

        tokenElements.exit().remove();

        tokenElements.enter().append("circle")
            .attr("class", "token")
            .attr("r", 10)
            .call(interactions.tokenDrag)
            .on("click", (event: MouseEvent, d: GraphToken) => {
                // One handler only — a second .on("click") on the same
                // selection would silently replace this one.
                if (event.altKey) {
                    event.preventDefault();
                    event.stopPropagation();
                    // The token is not what gets marked — it stands on the vertex
                    // the user meant, and a token cannot carry a mark of its own
                    // that outlives it.
                    toggleNodeHighlight(d.nodeId);
                    return;
                }

                if (event.ctrlKey) {
                    event.preventDefault();
                    event.stopPropagation();
                    deleteTokenAtNode(d.nodeId);
                    return;
                }

                event.stopPropagation();
                selectToken(d.id);
            })
            .on("mousedown", (event: MouseEvent, d: GraphToken) => {
                if (event.button === 0) {
                    return;
                }

                const nodeData = graph.nodeById.get(d.nodeId);

                if (!nodeData) {
                    return;
                }

                interactions.handleNodeMouseDown(event, nodeData);
            })
            .on("contextmenu", (event: MouseEvent) => event.preventDefault());

        positionTokens();
        updateTokenClasses();
    }

    function addEdge(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        if (!graph.isEdgeAdditionValid(parameter, sourceNodeId, targetNodeId)) {
            return false;
        }

        recordUndoState();
        graph.addEdge(sourceNodeId, targetNodeId, parameter);
        refreshTokenMoveSelectionState();
        return true;
    }

    function removeEdge(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        if (!graph.areNeighbors(sourceNodeId, targetNodeId)) {
            return false;
        }

        recordUndoState();
        graph.removeEdge(sourceNodeId, targetNodeId);
        refreshTokenMoveSelectionState();
        return true;
    }

    function removeNode(nodeId: NodeId): boolean {
        if (!graph.nodeById.has(nodeId)) {
            return false;
        }

        recordUndoState();
        const tokenOnNode = graph.getTokenAtNode(nodeId);
        graph.removeNode(nodeId);

        if (pendingEdgeSourceId === nodeId) {
            clearPendingEdgeSource();
        }

        if (tokenOnNode && selectedTokenId === tokenOnNode.id) {
            selectedTokenId = null;
            legalMoveTargets = new Set<NodeId>();
        }

        interactions.stopEdgeDrag();
        selection.clearNodeSelection();
        refreshTokenMoveSelectionState();
        updateNodeClasses();
        return true;
    }

    function renderGraph(): void {
        linkLayer.selectAll<SVGLineElement, GraphLink>(".link")
            .data(graphLinks, d => graph.getLinkKey(d))
            .join(
                enter => enter.append("line").attr("class", "link"),
                update => update,
                exit => exit.remove(),
            );

        const nodeSelection = nodeLayer.selectAll<SVGCircleElement, ForceNodeDatum>(".node")
            .data(graphNodes, d => d.id)
            .join(
                enter => enter.append("circle")
                    .attr("class", "node")
                    .attr("r", 20),
                update => update,
                exit => exit.remove(),
            );

        nodeSelection
            .call(interactions.nodeDrag)
            .on("click", (event: MouseEvent, d: GraphNode) => {
                // Before Ctrl, so a press somehow carrying both modifiers does
                // one named thing rather than leaving the order of two independent
                // ifs to decide it.
                if (event.altKey) {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleNodeHighlight(d.id);
                    return;
                }

                if (event.ctrlKey) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!interactions.reflectSelectionAcrossYAxis()) {
                        toggleTokenAtNode(d.id);
                    }
                } else {
                    handleNodeClick(d.id);
                }
            })
            .on("mousedown", (event: MouseEvent, d: GraphNode) => interactions.handleNodeMouseDown(event, d))
            .on("contextmenu", (event: MouseEvent) => event.preventDefault());

        background
            .on("mousedown", interactions.handleBackgroundMouseDown)
            .on("dblclick", (event: MouseEvent) => {
                // Block the double-tap-zoom that d3-zoom wires on the svg root.
                // stopPropagation (not just stopImmediatePropagation) prevents the
                // event from ever reaching the svg-level "dblclick.zoom" handler.
                event.stopPropagation();
                event.preventDefault();
            })
            .on("click", (event: MouseEvent) => {
                if (event.button === 0 && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                    clearTokenMoveSelection();
                }
            })
            .on("contextmenu", (event: MouseEvent) => event.preventDefault());

        updateNodeClasses();
        positionGraphElements();
    }

    function refreshGraphAfterMutation(message?: string, boardChangeReason: BoardChangeReason = "graph-changed"): void {
        syncSimulation();
        renderGraph();
        renderNodeHighlights();
        renderTokens();
        refreshTokenMoveSelectionState();
        refreshOverlayState();
        updateNodeClasses();
        updateTokenClasses();
        positionGraphElements();

        if (message) {
            setStatus(message);
        }

        // The chokepoint every graph edit comes through — a vertex or edge added
        // or removed, a paste, an import, a delete, an undo. A caller that used
        // this only to redraw after a different kind of change says so here,
        // rather than announcing a graph change and then trying to take it back
        // with a second notification.
        notifyBoardChanged(boardChangeReason);
    }

    function applyParameterValue(nextParameter: number): void {
        if (Number.isNaN(nextParameter)) {
            pInput.value = String(parameter);
            return;
        }

        if (!graph.isConfigurationValid(graph.tokens, nextParameter)) {
            pInput.value = String(parameter);
            setStatus(`${currentProblem.parameterLabel} = ${nextParameter} would make the current Configuration invalid, so it was rejected.`);
            return;
        }

        recordUndoState();
        parameter = nextParameter;
        graph.setParameter(nextParameter);
        refreshTokenMoveSelectionState();
        refreshOverlayState();
        updateNodeClasses();
        updateTokenClasses();
        setStatus(`${currentProblem.parameterLabel} updated to ${parameter}.`);
        notifyBoardChanged("rules-changed");
    }

    // Changing the problem is a change to the session, so it travels with the
    // graph rather than replacing it: the vertices, their positions and the
    // tokens on them are exactly what the user wants to keep. The parameter
    // moves with it because a value belongs to one problem's scale — k = 3 of
    // k-Limited Packing and d = 3 of a distance rule are different demands, and
    // carrying one into the other would silently reinterpret it.
    // Brings the problem, the parameter and the input element into line with
    // each other. Shared by switching the problem and by undoing a switch, so
    // the two cannot leave the parameter box describing a different problem
    // than the rules the graph is using.
    // The parameter box belongs to a problem: its bounds and its step come from
    // there, so they move whenever the problem or the value does. One owner
    // keeps the box from describing a different problem than the rules do.
    function syncParameterInput(problem: ProblemDefinition, value: number): void {
        pInput.min = String(problem.minParameter);
        pInput.max = String(problem.maxParameter);
        pInput.step = String(problem.parameterStep);
        pInput.value = String(value);
    }

    function adoptProblem(nextProblem: ProblemDefinition, nextParameter: number): void {
        const changed = nextProblem.id !== currentProblem.id;
        currentProblem = nextProblem;
        graph.rules = nextProblem.rules;
        parameter = nextParameter;
        graph.setParameter(nextParameter);
        syncParameterInput(nextProblem, nextParameter);
        refreshTokenMoveSelectionState();
        refreshOverlayState();
        updateNodeClasses();
        updateTokenClasses();

        // Undo reaches here without going through any control, so this is the
        // only place the change can be announced from.
        if (changed) {
            onProblemChange?.(nextProblem);
        }

        // Announced whether or not the problem itself changed: a problem carries
        // its parameter, so an undo that puts the same problem back with a
        // different number has still changed which Configurations are legal.
        notifyBoardChanged("rules-changed");
    }

    function setProblem(nextProblem: ProblemDefinition, nextParameter = nextProblem.defaultParameter): void {
        if (nextProblem.id === currentProblem.id && nextParameter === parameter) {
            return;
        }

        const switchedProblem = nextProblem.id !== currentProblem.id;
        recordUndoState();
        // A Configuration can be legal under one problem and not under another,
        // and dropping a token the user placed would be worse than admitting the
        // pair does not fit: the tokens stay, and the status line says so.
        const violated = !graph.isConfigurationValid(graph.tokens, nextParameter);
        adoptProblem(nextProblem, nextParameter);
        const label = nextProblem.parameterLabel;
        const opening = switchedProblem
            ? `${nextProblem.name} applied to this graph with ${label} = ${nextParameter}`
            : `${label} = ${nextParameter}`;
        setStatus(violated ? `${opening}. Some tokens now break the rule.` : `${opening}.`);
    }

    function setNeighborhoodCountVisibility(enabled: boolean): void {
        showNeighborhoodCounts = enabled;
        refreshOverlayState();
    }

    function setMoveDirectionVisibility(enabled: boolean): void {
        showMoveDirections = enabled;
        refreshOverlayState();
    }

    // Turning the grid on shows it and starts landing dragged vertices on it; the
    // two are one switch because a grid that is drawn but not followed, or obeyed
    // while invisible, is a bug rather than a setting.
    function setSnapToGridEnabled(enabled: boolean): void {
        gridOverlay.setEnabled(enabled);
    }

    // The value arrives already inside the bounds the input offers; the overlay
    // clamps again on its own, so a caller that cannot be shown a box (a future
    // file format, a keyboard shortcut) still cannot ask for a grid of zero.
    function setGridSpacing(spacing: number): void {
        gridOverlay.setSpacing(spacing);
    }

    function copySelection(): boolean {
        return selection.copySelection();
    }

    function pasteSelection(): boolean {
        const pastedNodeIds = selection.pasteSelection();

        if (!pastedNodeIds) {
            return false;
        }

        selectedTokenId = null;
        refreshGraphAfterMutation(`${pastedNodeIds.size} vertices pasted.`);
        return true;
    }

    function saveSelection(): boolean {
        return selection.saveSelection();
    }

    function undo(): boolean {
        const snapshot = undoStack.pop();

        if (!snapshot) {
            setStatus("Nothing to undo.");
            return false;
        }

        interactions.stopEdgeDrag();

        restoreUndoSnapshot(snapshot);
        refreshGraphAfterMutation("Undid last operation.");
        return true;
    }

    function getViewportCenter(): { x: number; y: number } {
        return {
            x: currentTransform.invertX(width / 2),
            y: currentTransform.invertY(height / 2),
        };
    }

    async function importSelection(file: File): Promise<SerializedProblemContext | null> {
        const imported = await selection.importSelection(file, getViewportCenter());

        if (!imported) {
            return null;
        }

        selectedTokenId = null;
        refreshGraphAfterMutation(`Imported ${imported.nodeIds.size} vertices.`);
        return imported.problem ?? null;
    }

    // Read as a copy, field by field, for the same reason the undo snapshot is:
    // whoever receives this holds it while the canvas carries on changing under
    // them, and a live reference would let those changes reach into a picture
    // that is half-drawn.
    function readBoard(): BoardReading {
        return {
            problem: currentProblem,
            parameter,
            nodeIds: graph.nodes.map(node => node.id),
            links: graph.links.map(link => ({
                source: graph.getLinkEndpoint(link.source),
                target: graph.getLinkEndpoint(link.target),
            })),
            // Only which vertex each token stands on. Which token it is does not
            // reach the outside, because no rule reads it.
            occupancy: graph.tokens.map(token => token.nodeId),
            goalNodeIds: graph.nodes.filter(node => node.highlighted).map(node => node.id),
        };
    }

    function occupancyHolds(occupancy: Occupancy, nodeId: NodeId): boolean {
        return occupancy.some(occupiedNodeId => graph.compareNodeIds(occupiedNodeId, nodeId) === 0);
    }

    function applyOccupancy(occupancy: Occupancy): boolean {
        // A jump is only meaningful onto an Configuration this board could hold at
        // all: one token per vertex here, one vertex there. A picture drawn from a
        // board that has since changed arrives here, and moving tokens to make its
        // count match would be inventing or destroying tokens.
        if (occupancy.length !== graph.tokens.length) {
            setStatus(`That Configuration holds ${occupancy.length} tokens and this board holds ${graph.tokens.length}, so it is not one this board can take. The Configuration picture was drawn from an earlier board — switch it off and on again to draw it from this one.`);

            return false;
        }

        const missingNodeId = occupancy.find(nodeId => !graph.nodeById.has(nodeId));

        if (missingNodeId !== undefined) {
            setStatus(`That Configuration stands on vertex ${missingNodeId}, which is no longer on the board. Redraw the Configuration picture to drop the stale ones.`);

            return false;
        }

        const freeNodeIds = occupancy.filter(nodeId => !graph.tokens.some(token => graph.compareNodeIds(token.nodeId, nodeId) === 0));
        const proposedTokens = graph.tokens.map(token => ({ ...token }));
        const movingTokens = proposedTokens.filter(token => !occupancyHolds(occupancy, token.nodeId));

        // Tokens already standing on a wanted vertex stay where they are and only
        // the rest are reassigned, so jumping to a neighbouring Configuration moves
        // the fewest tokens it can rather than redecorating the whole board.
        movingTokens.forEach((token, index) => {
            token.nodeId = freeNodeIds[index];
        });

        // Checked before anything is touched. Every Configuration the panel offers
        // came out of the rules and so passes, which is exactly why the few that
        // do not — a vertex deleted since, a parameter changed since — should be
        // refused quietly instead of drawn illegally.
        if (!graph.isConfigurationValid(proposedTokens, parameter)) {
            setStatus("That Configuration is no longer legal under the rule in force, so it was refused.");

            return false;
        }

        recordUndoState();

        // Written back onto the tokens rather than replacing the array: d3 holds
        // these very objects as its bound data, and swapping them out would leave
        // the drawn tokens trailing a click behind the board.
        graph.tokens.forEach((token, index) => {
            token.nodeId = proposedTokens[index].nodeId;
        });

        clearTokenMoveSelection();
        // The vertices and edges did not change. Tell watchers that directly, so
        // clicking an Configuration moves the marker instead of restarting the
        // search that produced the Configuration being clicked.
        refreshGraphAfterMutation(
            `Board moved to the selected Configuration.`,
            "token-moved",
        );

        return true;
    }

    function deleteSelection(): boolean {
        const deleted = selection.deleteSelection();

        if (deleted) {
            selectedTokenId = null;
            refreshGraphAfterMutation();
        }

        return deleted;
    }

    function handlePChange(event: Event): void {
        const target = event.target as HTMLInputElement | null;
        applyParameterValue(Number.parseInt(target?.value ?? "", 10));
    }

    function recordUndoState(): void {
        if (undoGroupDepth > 0) {
            return;
        }

        undoStack.push(captureUndoSnapshot());
        if (undoStack.length > MAX_UNDO_STEPS) {
            undoStack.shift();
        }
    }

    function beginUndoGroup(): void {
        undoGroupDepth += 1;
    }

    function endUndoGroup(): void {
        undoGroupDepth = Math.max(0, undoGroupDepth - 1);
    }

    function captureUndoSnapshot(): AppUndoSnapshot {
        return {
            graph: {
                nodes: graph.nodes.map(node => ({
                    id: node.id,
                    x: node.x,
                    y: node.y,
                    vx: node.vx,
                    vy: node.vy,
                    fx: node.fx,
                    fy: node.fy,
                    anchorX: node.anchorX,
                    anchorY: node.anchorY,
                    // Listed by name like every field above, so a mark added after
                    // this snapshot was taken is undone rather than surviving the
                    // restore. Spreading the node instead would carry it along by
                    // accident, which is the opposite of a snapshot.
                    highlighted: node.highlighted,
                })),
                links: graph.links.map(link => ({
                    source: graph.getLinkEndpoint(link.source),
                    target: graph.getLinkEndpoint(link.target),
                })),
                tokens: graph.tokens.map(token => ({ ...token })),
                parameter,
                nextNodeId: graph.nextNodeId,
            },
            problem: currentProblem,
            selectedTokenId,
            selection: selection.createSnapshot(),
        };
    }

    function restoreUndoSnapshot(snapshot: AppUndoSnapshot): void {
        graph.nodes.splice(0, graph.nodes.length, ...snapshot.graph.nodes.map(node => ({ ...node })));
        graph.links.splice(0, graph.links.length, ...snapshot.graph.links.map(link => ({ ...link })));
        graph.tokens.splice(0, graph.tokens.length, ...snapshot.graph.tokens.map(token => ({ ...token })));
        graph.parameter = snapshot.graph.parameter;
        graph.nextNodeId = snapshot.graph.nextNodeId;
        graph.refreshNodeIndex();

        // One call brings rules, parameter and the input element back together;
        // assigning them one at a time here is how they could drift apart.
        adoptProblem(snapshot.problem, snapshot.graph.parameter);
        selectedTokenId = snapshot.selectedTokenId;
        // An armed edge source could silently point at a different vertex after
        // the restore — drop it instead of guessing.
        clearPendingEdgeSource();
        selection.restoreSnapshot(snapshot.selection);
        refreshTokenMoveSelectionState();
        refreshOverlayState();
        updateNodeClasses();
        updateTokenClasses();
    }

    syncParameterInput(currentProblem, parameter);
    pInput.addEventListener("change", handlePChange);
    svg.call(zoomBehavior);
    // Double-tap zoom off in every mode — and background's own "dblclick"
    // handler cannot stop it once the background rect has been panned off,
    // so remove it here, not just there. It also kills d3-zoom rerouting a
    // double TAP into the same handler.
    svg.on("dblclick.zoom", null);
    svg.on("contextmenu", (event: MouseEvent) => event.preventDefault());

    // Match the svg's user units to its rendered box (see the width/height
    // declaration): ResizeObserver keeps them in sync across orientation
    // changes and desktop resizes alike.
    let canvasResizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
        canvasResizeObserver = new ResizeObserver(() => syncCanvasSize());
        canvasResizeObserver.observe(svg.node() as SVGSVGElement);
    }

    function syncCanvasSize(): void {
        const rect = (svg.node() as SVGSVGElement).getBoundingClientRect();
        if (rect.width < 60 || rect.height < 60) {
            return;
        }

        const previousWidth = width;
        const previousHeight = height;
        const sizeChanged = Math.abs(rect.width - width) > 1 || Math.abs(rect.height - height) > 1;
        width = rect.width;
        height = rect.height;
        svg.attr("width", width).attr("height", height);
        background.attr("width", width).attr("height", height);
        // The grid covers the pane, so a pane that grew has more of it at the
        // edges than it had before — even when the graph below did not move.
        gridOverlay.render();

        if (!sizeChanged) {
            return;
        }

        if (previousWidth <= 0 || previousHeight <= 0) {
            // Nothing has been framed yet — this is either the first measurement
            // or the first one that had a window worth measuring. A drawing that
            // said where its vertices go is typically wider than a phone, so this
            // is what brings it into view at all; one that names only its
            // vertices is laid out against the size just measured a few lines
            // below, where the opening layout is computed.
            if (shipsOwnPositions) {
                setCanvasView(fitGraphToCanvas(graphNodes, width, height));
            }

            return;
        }

        // The pane changed shape under the drawing — hiding the docked panel is
        // the everyday case, a rotated phone the extreme one. The graph keeps the
        // size it had. Scaling it to the new box instead, which is what happened
        // here, reached the vertices themselves: a pane that only grew wider
        // stretched every arrangement sideways out of proportion, and one that
        // narrowed shrank a hand-placed or simulated Configuration down for no
        // reason the user asked for. Positions are the graph's own — the numbers a
        // file carries and a layout was chosen for — and a window changing size is
        // no reason to rewrite them.
        //
        // What a resized canvas does on its own is move its edges, so the view
        // slides by half the change in each direction: whatever was in the middle
        // of the pane is still in the middle of it, at exactly the scale it was
        // drawn at. A drawing that no longer fits the narrower pane is one wheel
        // turn or a pan away, which is the same answer as anywhere else the view
        // is too tight.
        setCanvasView(d3.zoomIdentity
            .translate(currentTransform.x + (width - previousWidth) / 2, currentTransform.y + (height - previousHeight) / 2)
            .scale(currentTransform.k));
    }

    // Whether the opening Configuration came from the file that was loaded rather
    // than from a layout. Read once here and never recomputed: a canvas resize
    // must keep such a drawing on its own coordinates, which is the whole point
    // of saying where the vertices go.
    const shipsOwnPositions = inputsCarryPositions(nodes);

    syncCanvasSize();
    simulation.on("tick", positionGraphElements);

    refreshGraphAfterMutation();

    if (shipsOwnPositions) {
        // A drawn scenario asked for these coordinates exactly, so nothing here
        // rearranges them — not even to fit them onto the window. What the
        // canvas cannot show at 1:1 is brought in by the viewport transform
        // instead, and the user's next pan or wheel turn takes it back off. The
        // first measurement above usually framed it already; asking again costs
        // nothing and means the invariant holds even when that measurement came
        // too early to be usable.
        setCanvasView(fitGraphToCanvas(graphNodes, width, height));
    } else {
        // A scenario that only names its vertices has no Configuration at all —
        // the factory seeds them around an origin it cannot size yet — so the
        // opening layout still has to be computed, once, here, now that the
        // canvas has a size. The layouts the user picks are one-time and stay
        // out of this.
        applyLayout("circle");
        // And the window is its own again. A previous drawn scenario left this
        // transform on the svg element, where destroy() cannot reach it; without
        // this the gesture would still be holding that drawing's pan and would
        // shove the new one off with it on the first wheel tick.
        setCanvasView(d3.zoomIdentity);
    }

    clearTokenMoveSelection();

    function setInteractionMode(mode: InteractionMode): void {
        interactionMode = mode;
        clearPendingEdgeSource();
        clearTokenMoveSelection();

        if (mode === "graph") {
            setStatus("Switched to graph mode.");
        } else {
            setStatus("Switched to token mode.");
        }
    }

    function setColorHints(hints: ColorHints): void {
        colorHints = { ...hints };
        updateNodeClasses();
    }

    return {
        setStatus,
        setInteractionMode,
        setColorHints,
        setRepulsionEnabled,
        setNeighborhoodCountVisibility,
        setMoveDirectionVisibility,
        setSnapToGridEnabled,
        setGridSpacing,
        applyLayout,
        setProblem,
        clearNodeSelection() {
            selection.clearNodeSelection();
        },
        undo,
        copySelection,
        pasteSelection,
        saveSelection,
        deleteSelection,
        importSelection,
        readBoard,
        applyOccupancy,
        setMovePreview,
        onBoardChange(listener: (reason: BoardChangeReason) => void): () => void {
            boardChangeListeners.add(listener);

            return () => {
                boardChangeListeners.delete(listener);
            };
        },
        destroy() {
            simulation.stop();
            // A listener left behind would hear nothing — this app is gone — but
            // it would also keep whatever it closes over alive, which in a shell
            // that rebuilds the app on every scenario is how a panel from three
            // scenarios ago could still answer to the board.
            boardChangeListeners.clear();
            if (canvasResizeObserver) {
                canvasResizeObserver.disconnect();
            }
            touchGestures.destroy();
            pInput.removeEventListener("change", handlePChange);
            svg.on(".zoom", null);
            svg.on("contextmenu", null);
            background.on("mousedown", null);
            background.on("contextmenu", null);
            interactions.destroy();
            svg.selectAll("*").remove();
        },
    };
}