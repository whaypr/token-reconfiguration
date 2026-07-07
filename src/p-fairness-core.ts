import * as d3 from "d3";
import type { D3DragEvent, DragBehavior } from "d3-drag";
import type { D3ZoomEvent, ZoomBehavior, ZoomTransform } from "d3-zoom";
import type { Selection } from "d3-selection";
import type { ForceLink, SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type {
    GraphLink,
    GraphNode,
    GraphToken,
    NodeId,
    LayoutMode,
    PFairnessApp,
    PFairnessAppConfig,
    ScenarioNodeInput,
} from "./types";
import { applyGraphLayout } from "./layouts";

type ForceNodeDatum = GraphNode & SimulationNodeDatum;

type ForceLinkDatum = SimulationLinkDatum<ForceNodeDatum> & {
    source: NodeId | ForceNodeDatum;
    target: NodeId | ForceNodeDatum;
};

type SvgSelection = Selection<SVGSVGElement, unknown, null, undefined>;
type GroupSelection = Selection<SVGGElement, unknown, null, undefined>;
type LinkSelection = Selection<SVGLineElement, GraphLink, SVGGElement, unknown>;
type NodeSelection = Selection<SVGCircleElement, GraphNode, SVGGElement, unknown>;
type TokenSelection = Selection<SVGCircleElement, GraphToken, SVGGElement, unknown>;

function normalizeNodeInput(node: NodeId | ScenarioNodeInput): ScenarioNodeInput {
    return typeof node === "object" && node !== null ? node : { id: node };
}

function getLinkEndpoint(endpoint: NodeId | GraphNode): NodeId {
    return typeof endpoint === "object" ? endpoint.id : endpoint;
}

function createGraphNode(node: NodeId | ScenarioNodeInput, index: number, totalNodes: number, width: number, height: number): GraphNode {
    const normalized = normalizeNodeInput(node);
    const hasPosition = Number.isFinite(normalized.x) && Number.isFinite(normalized.y);
    const fallbackRadius = Math.min(width, height) * 0.32;
    const angle = totalNodes > 0 ? (index / totalNodes) * Math.PI * 2 : 0;
    const x = hasPosition ? normalized.x! : width / 2 + Math.cos(angle) * fallbackRadius;
    const y = hasPosition ? normalized.y! : height / 2 + Math.sin(angle) * fallbackRadius;

    return {
        id: normalized.id,
        x,
        y,
        vx: 0,
        vy: 0,
        fx: x,
        fy: y,
        anchorX: x,
        anchorY: y,
    };
}

export function createPFairnessApp({
    svgSelector,
    pInputSelector,
    statusSelector,
    nodes,
    links,
    tokens: initialTokens,
    initialP,
}: PFairnessAppConfig): PFairnessApp {
    const svg = d3.select(svgSelector) as unknown as SvgSelection;
    const width = Number(svg.attr("width"));
    const height = Number(svg.attr("height"));
    const pInput = document.querySelector(pInputSelector) as HTMLInputElement;
    const statusElement = document.querySelector(statusSelector) as HTMLElement;

    if (!pInput || !statusElement) {
        throw new Error("p-Fairness app root elements were not found.");
    }

    svg.style("touch-action", "none");

    const graphNodes: ForceNodeDatum[] = nodes.map((node, index) => createGraphNode(node, index, nodes.length, width, height));
    let graphLinks: ForceLinkDatum[] = links.map(link => ({ ...link }));
    let nodeById = new Map<NodeId, GraphNode>(graphNodes.map(node => [node.id, node]));

    let tokens: GraphToken[] = initialTokens.map(token => ({ ...token }));
    let selectedTokenId: string | null = null;
    let legalMoveTargets = new Set<NodeId>();
    let p = initialP;
    let currentLayout: LayoutMode = "circular";
    let repulsionEnabled = false;
    let edgeDragState: { source: ForceNodeDatum; x1: number; y1: number; x2: number; y2: number } | null = null;
    let currentTransform: ZoomTransform = d3.zoomIdentity;

    let nextNodeId = graphNodes.reduce((maxId, node) => {
        const numericId = typeof node.id === "number" ? node.id : Number(node.id);
        return Number.isFinite(numericId) ? Math.max(maxId, numericId) : maxId;
    }, -1) + 1;

    const defaultStatusMessage = "Select a token to see legal moves. Middle-click empty space to add a node, middle-click a node to remove it, right-drag from a vertex to create an edge, and left-drag the background to pan.";

    const background = svg.append("rect")
        .attr("class", "graph-background")
        .attr("width", width)
        .attr("height", height);

    const graphViewport = svg.append("g").attr("class", "graph-viewport");
    const linkLayer = graphViewport.append("g").attr("class", "link-layer");
    const nodeLayer = graphViewport.append("g").attr("class", "node-layer");
    const tokenLayer = graphViewport.append("g").attr("class", "token-layer");
    const interactionLayer = graphViewport.append("g").attr("class", "interaction-layer");
    const edgePreview = interactionLayer.append("line")
        .attr("class", "edge-preview")
        .style("display", "none");

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

    const zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.5, 3])
        .filter((event: MouseEvent | WheelEvent) => event.type === "wheel" || (event.type === "mousedown" && event.button === 0) || event.type === "dblclick")
        .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
            currentTransform = event.transform;
            graphViewport.attr("transform", currentTransform.toString());
        });

    const nodeDrag = d3.drag<SVGCircleElement, ForceNodeDatum>()
        .filter((event: MouseEvent) => event.button === 0)
        .on("start", handleNodeDragStart)
        .on("drag", handleNodeDragged)
        .on("end", handleNodeDragEnd);

    function toGraphPoint(event: MouseEvent | PointerEvent | D3DragEvent<SVGCircleElement, ForceNodeDatum, ForceNodeDatum>): [number, number] {
        const [x, y] = d3.pointer(event, svg.node());
        return currentTransform.invert([x, y]);
    }

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
        currentLayout = layout;

        applyGraphLayout({
            nodes: graphNodes,
            links: graphLinks,
            width,
            height,
        }, layout);

        syncNodePinning();
        setSimulationForces();
        refreshNodeIndex();
        refreshSelectionState();
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

    function getLinkKey(linkData: GraphLink): string {
        const sourceId = getLinkEndpoint(linkData.source as NodeId | GraphNode);
        const targetId = getLinkEndpoint(linkData.target as NodeId | GraphNode);
        return String(sourceId) < String(targetId)
            ? `${sourceId}--${targetId}`
            : `${targetId}--${sourceId}`;
    }

    function refreshNodeIndex(): void {
        nodeById = new Map(graphNodes.map(node => [node.id, node]));
    }

    function syncSimulation(): void {
        refreshNodeIndex();
        simulation.nodes(graphNodes);
        (simulation.force("link") as ForceLink<ForceNodeDatum, ForceLinkDatum>).links(graphLinks);
        setSimulationForces();
        simulation.alpha(0.6).restart();
    }

    function positionTokens(): void {
        tokenLayer.selectAll<SVGCircleElement, GraphToken>(".token")
            .attr("cx", d => {
                const nodeData = nodeById.get(d.nodeId);
                return nodeData ? nodeData.x : 0;
            })
            .attr("cy", d => {
                const nodeData = nodeById.get(d.nodeId);
                return nodeData ? nodeData.y : 0;
            });
    }

    function positionGraphElements(): void {
        linkLayer.selectAll<SVGLineElement, GraphLink>(".link")
            .attr("x1", d => (d.source as GraphNode).x)
            .attr("y1", d => (d.source as GraphNode).y)
            .attr("x2", d => (d.target as GraphNode).x)
            .attr("y2", d => (d.target as GraphNode).y);

        nodeLayer.selectAll<SVGCircleElement, GraphNode>(".node")
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);

        if (edgeDragState) {
            edgePreview
                .style("display", null)
                .attr("x1", edgeDragState.x1)
                .attr("y1", edgeDragState.y1)
                .attr("x2", edgeDragState.x2)
                .attr("y2", edgeDragState.y2);
        } else {
            edgePreview.style("display", "none");
        }

        positionTokens();
    }

    function setStatus(message: string): void {
        statusElement.textContent = message;
    }

    function getClosedNeighborhood(nodeId: NodeId): Set<NodeId> {
        const neighborhood = new Set<NodeId>([nodeId]);

        graphLinks.forEach(linkData => {
            const sourceId = getLinkEndpoint(linkData.source as NodeId | GraphNode);
            const targetId = getLinkEndpoint(linkData.target as NodeId | GraphNode);

            if (sourceId === nodeId) neighborhood.add(targetId);
            if (targetId === nodeId) neighborhood.add(sourceId);
        });

        return neighborhood;
    }

    function getTokenAtNode(nodeId: NodeId, ignoredTokenId: string | null = null): GraphToken | null {
        return tokens.find(token => token.nodeId === nodeId && token.id !== ignoredTokenId) || null;
    }

    function countTokensInNeighborhood(neighborhood: Set<NodeId>, candidateTokens: GraphToken[] = tokens): number {
        return candidateTokens.filter(token => neighborhood.has(token.nodeId)).length;
    }

    function isConfigurationValid(candidateTokens: GraphToken[] = tokens, candidateP: number = p): boolean {
        return graphNodes.every(nodeData => {
            const neighborhood = getClosedNeighborhood(nodeData.id);
            return countTokensInNeighborhood(neighborhood, candidateTokens) <= candidateP;
        });
    }

    function canPlaceTokenAtNode(nodeId: NodeId, candidateTokens: GraphToken[] = tokens, candidateP: number = p): boolean {
        if (getTokenAtNode(nodeId)) {
            return false;
        }

        const proposedTokens = [...candidateTokens, { id: "__proposed__", nodeId }];
        return isConfigurationValid(proposedTokens, candidateP);
    }

    function areNeighbors(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        return graphLinks.some(linkData => {
            const sourceId = getLinkEndpoint(linkData.source as NodeId | GraphNode);
            const targetId = getLinkEndpoint(linkData.target as NodeId | GraphNode);
            return (sourceId === sourceNodeId && targetId === targetNodeId) ||
                (sourceId === targetNodeId && targetId === sourceNodeId);
        });
    }

    function canMoveToken(tokenId: string, targetNodeId: NodeId, candidateP: number = p): boolean {
        const token = tokens.find(item => item.id === tokenId);
        if (!token) {
            return false;
        }

        if (token.nodeId === targetNodeId) {
            return false;
        }

        if (!areNeighbors(token.nodeId, targetNodeId)) {
            return false;
        }

        if (getTokenAtNode(targetNodeId, tokenId)) {
            return false;
        }

        const proposedTokens = tokens.map(item => item.id === tokenId
            ? { ...item, nodeId: targetNodeId }
            : item);

        return isConfigurationValid(proposedTokens, candidateP);
    }

    function getLegalMoveTargets(tokenId: string): NodeId[] {
        const token = tokens.find(item => item.id === tokenId);
        if (!token) {
            return [];
        }

        return graphLinks
            .map(linkData => {
                const sourceId = getLinkEndpoint(linkData.source as NodeId | GraphNode);
                const targetId = getLinkEndpoint(linkData.target as NodeId | GraphNode);
                if (sourceId === token.nodeId) return targetId;
                if (targetId === token.nodeId) return sourceId;
                return null;
            })
            .filter((nodeId): nodeId is NodeId => nodeId !== null && canMoveToken(tokenId, nodeId));
    }

    function isTokenFrozen(tokenId: string): boolean {
        return getLegalMoveTargets(tokenId).length === 0;
    }

    function updateNodeClasses(): void {
        nodeLayer.selectAll<SVGCircleElement, GraphNode>(".node")
            .attr("class", d => {
                const token = getTokenAtNode(d.id);
                const classes = ["node"];

                if (!token) {
                    classes.push("empty");
                    if (canPlaceTokenAtNode(d.id)) {
                        classes.push("placeable");
                    }
                } else if (isTokenFrozen(token.id)) {
                    classes.push("frozen");
                } else {
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
        const tokenElements = tokenLayer.selectAll<SVGCircleElement, GraphToken>(".token").data(tokens, d => d.id);

        tokenElements.exit().remove();

        tokenElements.enter().append("circle")
            .attr("class", "token")
            .attr("r", 10)
            .on("click", (event: MouseEvent, d: GraphToken) => {
                event.stopPropagation();
                selectToken(d.id);
            })
            .on("dblclick", (event: MouseEvent, d: GraphToken) => {
                event.preventDefault();
                event.stopPropagation();
                deleteTokenAtNode(d.nodeId);
            });

        positionTokens();
        updateTokenClasses();
    }

    function clearSelection(): void {
        selectedTokenId = null;
        legalMoveTargets = new Set<NodeId>();
        updateNodeClasses();
        updateTokenClasses();
        setStatus(defaultStatusMessage);
    }

    function selectToken(tokenId: string): void {
        if (selectedTokenId === tokenId) {
            clearSelection();
            return;
        }

        selectedTokenId = tokenId;
        legalMoveTargets = new Set(getLegalMoveTargets(tokenId));
        updateNodeClasses();
        updateTokenClasses();

        if (legalMoveTargets.size === 0) {
            setStatus(`Token ${tokenId} is frozen and cannot move.`);
        } else {
            setStatus(`Token ${tokenId} selected. Click one of the highlighted neighbors.`);
        }
    }

    function moveToken(tokenId: string, targetNodeId: NodeId): boolean {
        if (!canMoveToken(tokenId, targetNodeId)) {
            setStatus("That move would violate the p-fairness rule, so it was blocked.");
            return false;
        }

        const token = tokens.find(item => item.id === tokenId);
        if (!token) {
            clearSelection();
            return false;
        }

        token.nodeId = targetNodeId;
        legalMoveTargets = selectedTokenId ? new Set(getLegalMoveTargets(selectedTokenId)) : new Set<NodeId>();
        renderTokens();
        updateNodeClasses();

        if (legalMoveTargets.size === 0) {
            setStatus(`Token ${tokenId} moved to node ${targetNodeId}. It is now frozen.`);
        } else {
            setStatus(`Token ${tokenId} moved to node ${targetNodeId}.`);
        }

        return true;
    }

    function addTokenAtNode(nodeId: NodeId): boolean {
        if (getTokenAtNode(nodeId)) {
            return false;
        }

        const tokenId = `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
        const proposedTokens = [...tokens, { id: tokenId, nodeId }];

        if (!isConfigurationValid(proposedTokens, p)) {
            setStatus(`Cannot add a token at node ${nodeId}; it would violate p-fairness.`);
            return false;
        }

        tokens.push({ id: tokenId, nodeId });
        renderTokens();
        updateNodeClasses();
        setStatus(`Token added at node ${nodeId}.`);
        return true;
    }

    function deleteTokenAtNode(nodeId: NodeId): boolean {
        const token = getTokenAtNode(nodeId);
        if (!token) {
            return false;
        }

        tokens = tokens.filter(item => item.id !== token.id);

        if (selectedTokenId === token.id) {
            clearSelection();
        } else {
            updateNodeClasses();
            updateTokenClasses();
        }

        renderTokens();
        setStatus(`Token removed from node ${nodeId}.`);
        return true;
    }

    function toggleTokenAtNode(nodeId: NodeId): void {
        if (getTokenAtNode(nodeId)) {
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

        const selectedToken = tokens.find(token => token.id === selectedTokenId);
        if (selectedToken && selectedToken.nodeId === nodeId) {
            clearSelection();
            return;
        }

        setStatus("Click one of the highlighted neighbors to move the selected token.");
    }

    function getNodeAtPoint(x: number, y: number, ignoredNodeId: NodeId | null = null): GraphNode | null {
        const matchRadius = 22;
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

    function hasEdge(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        return graphLinks.some(linkData => {
            const sourceId = getLinkEndpoint(linkData.source as NodeId | GraphNode);
            const targetId = getLinkEndpoint(linkData.target as NodeId | GraphNode);
            return (sourceId === sourceNodeId && targetId === targetNodeId) ||
                (sourceId === targetNodeId && targetId === sourceNodeId);
        });
    }

    function isEdgeAdditionValid(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        if (sourceNodeId === targetNodeId || hasEdge(sourceNodeId, targetNodeId)) {
            return false;
        }

        const proposedLinks = [...graphLinks, { source: sourceNodeId, target: targetNodeId }];

        return graphNodes.every(nodeData => {
            const neighborhood = new Set<NodeId>([nodeData.id]);

            proposedLinks.forEach(linkData => {
                const linkSourceId = getLinkEndpoint(linkData.source as NodeId | GraphNode);
                const linkTargetId = getLinkEndpoint(linkData.target as NodeId | GraphNode);

                if (linkSourceId === nodeData.id) {
                    neighborhood.add(linkTargetId);
                }

                if (linkTargetId === nodeData.id) {
                    neighborhood.add(linkSourceId);
                }
            });

            return countTokensInNeighborhood(neighborhood) <= p;
        });
    }

    function addNodeAtPoint(x: number, y: number): GraphNode {
        const nodeData: GraphNode = {
            id: nextNodeId,
            x,
            y,
            vx: 0,
            vy: 0,
            fx: x,
            fy: y,
            anchorX: x,
            anchorY: y,
        };

        if (repulsionEnabled) {
            nodeData.fx = undefined;
            nodeData.fy = undefined;
        }

        nextNodeId += 1;
        graphNodes.push(nodeData);
        return nodeData;
    }

    function addEdge(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        if (!isEdgeAdditionValid(sourceNodeId, targetNodeId)) {
            return false;
        }

        graphLinks.push({ source: sourceNodeId, target: targetNodeId });
        refreshSelectionState();
        return true;
    }

    function removeEdge(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        const beforeCount = graphLinks.length;
        graphLinks = graphLinks.filter(linkData => {
            const linkSourceId = getLinkEndpoint(linkData.source as NodeId | GraphNode);
            const linkTargetId = getLinkEndpoint(linkData.target as NodeId | GraphNode);
            return !((linkSourceId === sourceNodeId && linkTargetId === targetNodeId) ||
                (linkSourceId === targetNodeId && linkTargetId === sourceNodeId));
        });

        if (graphLinks.length === beforeCount) {
            return false;
        }

        refreshSelectionState();
        return true;
    }

    function refreshSelectionState(): void {
        legalMoveTargets = selectedTokenId ? new Set(getLegalMoveTargets(selectedTokenId)) : new Set<NodeId>();
    }

    function removeNode(nodeId: NodeId): boolean {
        const nodeIndex = graphNodes.findIndex(nodeData => nodeData.id === nodeId);
        if (nodeIndex === -1) {
            return false;
        }

        const tokenOnNode = getTokenAtNode(nodeId);
        if (tokenOnNode) {
            tokens = tokens.filter(token => token.id !== tokenOnNode.id);
            if (selectedTokenId === tokenOnNode.id) {
                selectedTokenId = null;
                legalMoveTargets = new Set<NodeId>();
            }
        }

        if (edgeDragState && edgeDragState.source.id === nodeId) {
            stopEdgeDrag();
        }

        graphNodes.splice(nodeIndex, 1);
        graphLinks = graphLinks.filter(linkData => {
            const sourceId = getLinkEndpoint(linkData.source as NodeId | GraphNode);
            const targetId = getLinkEndpoint(linkData.target as NodeId | GraphNode);
            return sourceId !== nodeId && targetId !== nodeId;
        });

        refreshNodeIndex();
        refreshSelectionState();
        return true;
    }

    function renderGraph(): void {
        linkLayer.selectAll<SVGLineElement, GraphLink>(".link")
            .data(graphLinks, getLinkKey)
            .join(
                enter => enter.append("line").attr("class", "link"),
                update => update,
                exit => exit.remove(),
            );

        const nodeSelection = nodeLayer.selectAll<SVGCircleElement, GraphNode>(".node")
            .data(graphNodes, d => d.id)
            .join(
                enter => enter.append("circle")
                    .attr("class", "node")
                    .attr("r", 20),
                update => update,
                exit => exit.remove(),
            );

        nodeSelection
            .call(nodeDrag)
            .on("click", (_event: MouseEvent, d: GraphNode) => handleNodeClick(d.id))
            .on("dblclick", (event: MouseEvent, d: GraphNode) => {
                event.preventDefault();
                event.stopPropagation();
                toggleTokenAtNode(d.id);
            })
            .on("mousedown", (event: MouseEvent, d: GraphNode) => handleNodeMouseDown(event, d))
            .on("contextmenu", (event: MouseEvent) => event.preventDefault());

        background
            .on("mousedown", handleBackgroundMouseDown)
            .on("contextmenu", (event: MouseEvent) => event.preventDefault());

        refreshNodeIndex();
        updateNodeClasses();
        positionGraphElements();
    }

    function refreshGraphAfterMutation(message?: string): void {
        syncSimulation();
        renderGraph();
        renderTokens();
        refreshSelectionState();
        updateNodeClasses();
        updateTokenClasses();
        positionGraphElements();

        if (message) {
            setStatus(message);
        }
    }

    function handleNodeMouseDown(event: MouseEvent, nodeData: GraphNode): void {
        if (event.button === 1) {
            event.preventDefault();
            event.stopPropagation();
            if (removeNode(nodeData.id)) {
                refreshGraphAfterMutation(`Node ${nodeData.id} removed.`);
            }
            return;
        }

        if (event.button === 2) {
            event.preventDefault();
            event.stopPropagation();
            startEdgeDrag(nodeData);
        }
    }

    function handleBackgroundMouseDown(event: MouseEvent): void {
        if (event.button !== 1 || event.target !== background.node()) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        const [x, y] = toGraphPoint(event);
        const nodeData = addNodeAtPoint(x, y);
        refreshGraphAfterMutation(`Node ${nodeData.id} added.`);
    }

    function startEdgeDrag(nodeData: ForceNodeDatum): void {
        const [x, y] = [nodeData.x, nodeData.y];
        edgeDragState = {
            source: nodeData,
            x1: x,
            y1: y,
            x2: x,
            y2: y,
        };

        edgePreview
            .style("display", null)
            .attr("x1", x)
            .attr("y1", y)
            .attr("x2", x)
            .attr("y2", y);

        window.addEventListener("mousemove", handleWindowMouseMove);
        window.addEventListener("mouseup", handleWindowMouseUp);
    }

    function stopEdgeDrag(): void {
        if (!edgeDragState) {
            return;
        }

        edgeDragState = null;
        edgePreview.style("display", "none");
        window.removeEventListener("mousemove", handleWindowMouseMove);
        window.removeEventListener("mouseup", handleWindowMouseUp);
    }

    function handleWindowMouseMove(event: MouseEvent): void {
        if (!edgeDragState) {
            return;
        }

        const [x, y] = toGraphPoint(event);
        edgeDragState.x2 = x;
        edgeDragState.y2 = y;
        edgePreview
            .attr("x2", x)
            .attr("y2", y);
    }

    function handleWindowMouseUp(event: MouseEvent): void {
        if (!edgeDragState || event.button !== 2) {
            return;
        }

        event.preventDefault();
        const [x, y] = toGraphPoint(event);
        const sourceNodeId = edgeDragState.source.id;
        const targetNode = getNodeAtPoint(x, y, sourceNodeId);

        if (targetNode) {
            if (removeEdge(sourceNodeId, targetNode.id)) {
                refreshGraphAfterMutation(`Edge between nodes ${sourceNodeId} and ${targetNode.id} removed.`);
            } else if (addEdge(sourceNodeId, targetNode.id)) {
                refreshGraphAfterMutation(`Edge added between nodes ${sourceNodeId} and ${targetNode.id}.`);
            } else {
                setStatus(`Edge between nodes ${sourceNodeId} and ${targetNode.id} would violate p-fairness, so it was blocked.`);
            }
            stopEdgeDrag();
            return;
        }

        const newNodeData = addNodeAtPoint(x, y);
        if (addEdge(sourceNodeId, newNodeData.id)) {
            refreshGraphAfterMutation(`Node ${newNodeData.id} added and connected to node ${sourceNodeId}.`);
        }

        stopEdgeDrag();
    }

    function handleNodeDragStart(event: D3DragEvent<SVGCircleElement, ForceNodeDatum, ForceNodeDatum>, nodeData: ForceNodeDatum): void {
        if (!event.active) {
            simulation.alphaTarget(0.25).restart();
        }

        nodeData.fx = nodeData.x;
        nodeData.fy = nodeData.y;
        setStatus(`Dragging node ${nodeData.id}.`);
    }

    function handleNodeDragged(event: D3DragEvent<SVGCircleElement, ForceNodeDatum, ForceNodeDatum>, nodeData: ForceNodeDatum): void {
        const [x, y] = toGraphPoint(event.sourceEvent as MouseEvent | PointerEvent);
        nodeData.fx = x;
        nodeData.fy = y;
        nodeData.anchorX = x;
        nodeData.anchorY = y;
        positionGraphElements();
    }

    function handleNodeDragEnd(event: D3DragEvent<SVGCircleElement, ForceNodeDatum, ForceNodeDatum>, nodeData: ForceNodeDatum): void {
        if (!event.active) {
            simulation.alphaTarget(0);
        }

        if (repulsionEnabled) {
            nodeData.fx = undefined;
            nodeData.fy = undefined;
        } else {
            nodeData.anchorX = nodeData.x;
            nodeData.anchorY = nodeData.y;
            nodeData.fx = nodeData.x;
            nodeData.fy = nodeData.y;
        }
        setStatus(`Node ${nodeData.id} moved.`);
    }

    function applyPValue(nextP: number): void {
        if (Number.isNaN(nextP)) {
            pInput.value = String(p);
            return;
        }

        if (!isConfigurationValid(tokens, nextP)) {
            pInput.value = String(p);
            setStatus(`p = ${nextP} would make the current configuration invalid, so it was rejected.`);
            return;
        }

        p = nextP;
        refreshSelectionState();
        updateNodeClasses();
        updateTokenClasses();
        setStatus(`p updated to ${p}.`);
    }

    function updateFairness(): void {
        refreshSelectionState();
        updateNodeClasses();
        updateTokenClasses();
    }

    function handlePChange(event: Event): void {
        const target = event.target as HTMLInputElement | null;
        applyPValue(Number.parseInt(target?.value ?? "", 10));
    }

    pInput.value = String(p);
    pInput.addEventListener("change", handlePChange);
    svg.call(zoomBehavior);
    svg.on("contextmenu", (event: MouseEvent) => event.preventDefault());

    simulation.on("tick", positionGraphElements);

    refreshGraphAfterMutation();
    applyLayout(currentLayout);
    clearSelection();

    return {
        setStatus,
        setRepulsionEnabled,
        applyLayout,
        destroy() {
            simulation.stop();
            pInput.removeEventListener("change", handlePChange);
            svg.on(".zoom", null);
            svg.on("contextmenu", null);
            background.on("mousedown", null);
            background.on("contextmenu", null);
            window.removeEventListener("mousemove", handleWindowMouseMove);
            window.removeEventListener("mouseup", handleWindowMouseUp);
            svg.selectAll("*").remove();
        },
    };
}