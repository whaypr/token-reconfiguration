import * as d3 from "d3";
import type { D3ZoomEvent, ZoomTransform } from "d3-zoom";
import type { Selection } from "d3-selection";
import type { ForceLink, SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { DEFAULT_COLOR_HINTS } from "./types";
import type {
    ColorHints,
    GraphLink,
    GraphNode,
    GraphToken,
    NodeId,
    LayoutMode,
    InteractionMode,
    PFairnessApp,
    PFairnessAppConfig,
} from "./types";
import { createTouchGestures, TOUCH_HIT_RADIUS_PX } from "./touch-gestures";
import { applyGraphLayout } from "./layouts";
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
};

type AppUndoSnapshot = {
    graph: {
        nodes: GraphNodeSnapshot[];
        links: Array<{ source: NodeId; target: NodeId }>;
        tokens: Array<{ id: string; nodeId: NodeId }>;
        parameter: number;
        nextNodeId: number;
    };
    selectedTokenId: string | null;
    selection: SelectionStateSnapshot;
};

type SvgSelection = Selection<SVGSVGElement, unknown, null, undefined>;

export function createPFairnessApp({
    svgSelector,
    parameterInputSelector,
    statusSelector,
    nodes,
    links,
    tokens: initialTokens,
    initialParameter,
    problem,
}: PFairnessAppConfig): PFairnessApp {
    const svg = d3.select(svgSelector) as unknown as SvgSelection;
    const pInput = document.querySelector(parameterInputSelector) as HTMLInputElement;
    const statusElement = document.querySelector(statusSelector) as HTMLElement;

    if (!pInput || !statusElement) {
        throw new Error("p-Fairness app root elements were not found.");
    }

    // The canvas owns its own touches (pan/zoom/edit are all manual);
    // everything outside the canvas stays scrollable on a phone.
    svg.style("touch-action", "none");

    // The SVG's width/height ARE its user units (there is no viewBox), so they
    // are kept equal to its rendered box — that makes 1 graph unit ≈ 1 CSS px
    // on a phone, which is what turns vertex r=20 into a ~40 px tap target.
    let width = 0;
    let height = 0;

    const graph = createGraph(nodes, links, initialTokens, initialParameter, problem.rules, width, height);

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
    const undoStack: AppUndoSnapshot[] = [];
    let undoGroupDepth = 0;

    const background = svg.append("rect")
        .attr("class", "graph-background")
        .attr("width", width)
        .attr("height", height);

    const graphViewport = svg.append("g").attr("class", "graph-viewport");
    const linkLayer = graphViewport.append("g").attr("class", "link-layer");
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

    function setStatus(message: string): void {
        statusElement.textContent = message;
    }

    const selection = new SelectionManager(
        graph,
        () => graphNodes,
        setStatus,
        () => updateNodeClasses(),
        () => updateTokenClasses(),
        recordUndoState,
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

    const zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.15, 3])
        .filter((event: MouseEvent | WheelEvent | TouchEvent) => {
            // One- and two-finger touches start gestures of their own (the
            // recogniser decides who truly owns a touch), three fingers do
            // not. The mode never matters here: pan/pinch belong to the
            // viewport in BOTH modes.
            if (event.type.startsWith("touch")) {
                return (event as TouchEvent).touches.length <= 2;
            }
            return event.type === "wheel" || (event.type === "mousedown" && (event as MouseEvent).button === 0) || event.type === "dblclick";
        })
        .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
            currentTransform = event.transform;
            graphViewport.attr("transform", currentTransform.toString());
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
                setStatus(`A token cannot stand on node ${nodeId} — it would violate the ${problem.name} rule.`);
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
                        nodeData.fx = x;
                        nodeData.fy = y;
                        nodeData.x = x;
                        nodeData.y = y;
                        nodeData.anchorX = x;
                        nodeData.anchorY = y;
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

    function addNodeAtPoint(x: number, y: number): GraphNode {
        recordUndoState();
        const nodeData = graph.addNodeAtPoint(x, y);
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
            setStatus(`That move would violate the ${problem.name} rule, so it was blocked.`);
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
            return;
        }

        renderNeighborhoodCountLabels();
        renderMoveDirectionHints();
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

        if (pendingEdgeSourceId !== null) {
            const sourceNode = getNodeById(pendingEdgeSourceId);
            if (sourceNode) {
                pendingEdgeHalo.attr("cx", sourceNode.x).attr("cy", sourceNode.y);
            }
        }

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

    function refreshGraphAfterMutation(message?: string): void {
        syncSimulation();
        renderGraph();
        renderTokens();
        refreshTokenMoveSelectionState();
        refreshOverlayState();
        updateNodeClasses();
        updateTokenClasses();
        positionGraphElements();

        if (message) {
            setStatus(message);
        }
    }

    function applyParameterValue(nextParameter: number): void {
        if (Number.isNaN(nextParameter)) {
            pInput.value = String(parameter);
            return;
        }

        if (!graph.isConfigurationValid(graph.tokens, nextParameter)) {
            pInput.value = String(parameter);
            setStatus(`${problem.parameterLabel} = ${nextParameter} would make the current configuration invalid, so it was rejected.`);
            return;
        }

        recordUndoState();
        parameter = nextParameter;
        graph.setParameter(nextParameter);
        refreshTokenMoveSelectionState();
        refreshOverlayState();
        updateNodeClasses();
        updateTokenClasses();
        setStatus(`${problem.parameterLabel} updated to ${parameter}.`);
    }

    function setNeighborhoodCountVisibility(enabled: boolean): void {
        showNeighborhoodCounts = enabled;
        refreshOverlayState();
    }

    function setMoveDirectionVisibility(enabled: boolean): void {
        showMoveDirections = enabled;
        refreshOverlayState();
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

    async function importSelection(file: File): Promise<boolean> {
        const pastedNodeIds = await selection.importSelection(file, getViewportCenter());

        if (!pastedNodeIds) {
            return false;
        }

        selectedTokenId = null;
        refreshGraphAfterMutation(`Imported ${pastedNodeIds.size} vertices.`);
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
        if (undoStack.length > 5) {
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
                })),
                links: graph.links.map(link => ({
                    source: graph.getLinkEndpoint(link.source),
                    target: graph.getLinkEndpoint(link.target),
                })),
                tokens: graph.tokens.map(token => ({ ...token })),
                parameter,
                nextNodeId: graph.nextNodeId,
            },
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

        parameter = snapshot.graph.parameter;
        pInput.value = String(snapshot.graph.parameter);
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

    pInput.value = String(parameter);
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
        // A real size change (phone shows ~370x500, desktop ~1200x800) has to
        // move the graph with it, or every vertex keeps the coordinates of the
        // canvas it was arranged in and sits outside the visible one, where
        // taps land on empty space. It is scaled rather than laid out again:
        // a layout is one-time now, and what needs fitting may just as well be
        // a hand-dragged or force-simulated arrangement. Only after the first
        // measurement — before it there is no shape to scale, and vertices
        // would be multiplied out of the origin they were seeded at.
        const sizeChanged = Math.abs(rect.width - width) > 1 || Math.abs(rect.height - height) > 1;
        const scaleX = sizeChanged && width > 0 ? rect.width / width : 1;
        const scaleY = sizeChanged && height > 0 ? rect.height / height : 1;
        width = rect.width;
        height = rect.height;
        svg.attr("width", width).attr("height", height);
        background.attr("width", width).attr("height", height);
        if (scaleX !== 1 || scaleY !== 1) {
            graphNodes.forEach(node => {
                node.x *= scaleX;
                node.y *= scaleY;
                node.anchorX *= scaleX;
                node.anchorY *= scaleY;
                // The pin travels with the vertex: leaving it behind would let
                // the simulation drag it back to the old canvas size.
                if (node.fx !== undefined) {
                    node.fx *= scaleX;
                }
                if (node.fy !== undefined) {
                    node.fy *= scaleY;
                }
            });
        }
        syncSimulation();
    }

    syncCanvasSize();
    simulation.on("tick", positionGraphElements);

    refreshGraphAfterMutation();
    // No scenario ships coordinates, and the factory seeds every vertex at the
    // origin because the canvas has no size yet, so the opening arrangement
    // still has to be computed — once, here, now that it does. The layouts the
    // user picks are one-time and stay out of this.
    applyLayout("circle");
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
        applyLayout,
        clearNodeSelection() {
            selection.clearNodeSelection();
        },
        undo,
        copySelection,
        pasteSelection,
        saveSelection,
        deleteSelection,
        importSelection,
        destroy() {
            simulation.stop();
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