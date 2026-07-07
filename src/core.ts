import * as d3 from "d3";
import type { D3ZoomEvent, ZoomTransform } from "d3-zoom";
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
} from "./types";
import { applyGraphLayout } from "./layouts";
import { createGraph } from "./graph-factory";
import { createGraphInteractions } from "./graph-interactions";

type ForceNodeDatum = GraphNode & SimulationNodeDatum;

type ForceLinkDatum = SimulationLinkDatum<ForceNodeDatum> & {
    source: NodeId | ForceNodeDatum;
    target: NodeId | ForceNodeDatum;
};

type SvgSelection = Selection<SVGSVGElement, unknown, null, undefined>;

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

    const graph = createGraph(nodes, links, initialTokens, initialP, width, height);

    const graphNodes: ForceNodeDatum[] = graph.nodes as ForceNodeDatum[];
    const graphLinks: ForceLinkDatum[] = graph.links as ForceLinkDatum[];
    let selectedTokenId: string | null = null;
    let legalMoveTargets = new Set<NodeId>();
    let p = initialP;
    let currentLayout: LayoutMode = "circular";
    let repulsionEnabled = false;
    let currentTransform: ZoomTransform = d3.zoomIdentity;

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

    const interactions = createGraphInteractions({
        svg,
        backgroundNode: background.node() as SVGRectElement,
        edgePreview,
        simulation,
        getNodeById: nodeId => graph.nodeById.get(nodeId) ?? null,
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
        currentLayout = layout;

        applyGraphLayout({
            graph,
            width,
            height,
        }, layout);

        syncNodePinning();
        setSimulationForces();
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

    function syncSimulation(): void {
        simulation.nodes(graphNodes);
        (simulation.force("link") as ForceLink<ForceNodeDatum, ForceLinkDatum>).links(graphLinks);
        setSimulationForces();
        simulation.alpha(0.6).restart();
    }

    function refreshSelectionState(): void {
        legalMoveTargets = selectedTokenId ? new Set(graph.getLegalMoveTargets(selectedTokenId)) : new Set<NodeId>();
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

    function positionGraphElements(): void {
        linkLayer.selectAll<SVGLineElement, GraphLink>(".link")
            .attr("x1", d => (d.source as GraphNode).x)
            .attr("y1", d => (d.source as GraphNode).y)
            .attr("x2", d => (d.target as GraphNode).x)
            .attr("y2", d => (d.target as GraphNode).y);

        nodeLayer.selectAll<SVGCircleElement, ForceNodeDatum>(".node")
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);

        positionTokens();
    }

    function setStatus(message: string): void {
        statusElement.textContent = message;
    }

    function isTokenFrozen(tokenId: string): boolean {
        return graph.getLegalMoveTargets(tokenId).length === 0;
    }

    function updateNodeClasses(): void {
        nodeLayer.selectAll<SVGCircleElement, GraphNode>(".node")
            .attr("class", d => {
                const token = graph.getTokenAtNode(d.id);
                const classes = ["node"];

                if (!token) {
                    classes.push("empty");
                    if (graph.canPlaceTokenAtNode(d.id)) {
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
        const tokenElements = tokenLayer.selectAll<SVGCircleElement, GraphToken>(".token").data(graph.tokens, d => d.id);

        tokenElements.exit().remove();

        tokenElements.enter().append("circle")
            .attr("class", "token")
            .attr("r", 10)
            .call(interactions.tokenDrag)
            .on("click", (event: MouseEvent, d: GraphToken) => {
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
            .on("contextmenu", (event: MouseEvent) => event.preventDefault())
            .on("click", (event: MouseEvent, d: GraphToken) => {
                if (event.ctrlKey) {
                    event.preventDefault();
                    event.stopPropagation();
                    deleteTokenAtNode(d.nodeId);
                }
            });

        positionTokens();
        updateTokenClasses();
    }

    function clearSelection(statusMessage: string = defaultStatusMessage): void {
        selectedTokenId = null;
        legalMoveTargets = new Set<NodeId>();
        updateNodeClasses();
        updateTokenClasses();
        setStatus(statusMessage);
    }

    function selectToken(tokenId: string): void {
        if (selectedTokenId === tokenId) {
            clearSelection();
            return;
        }

        selectedTokenId = tokenId;
        legalMoveTargets = new Set(graph.getLegalMoveTargets(tokenId));
        updateNodeClasses();
        updateTokenClasses();

        if (legalMoveTargets.size === 0) {
            setStatus(`Token ${tokenId} is frozen and cannot move.`);
        } else {
            setStatus(`Token ${tokenId} selected. Click one of the highlighted neighbors.`);
        }
    }

    function moveToken(tokenId: string, targetNodeId: NodeId): boolean {
        if (!graph.canMoveToken(tokenId, targetNodeId)) {
            setStatus("That move would violate the p-fairness rule, so it was blocked.");
            return false;
        }

        const token = graph.tokens.find(item => item.id === tokenId);
        if (!token) {
            clearSelection();
            return false;
        }

        token.nodeId = targetNodeId;
        legalMoveTargets = selectedTokenId ? new Set(graph.getLegalMoveTargets(selectedTokenId)) : new Set<NodeId>();
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
        if (!graph.addTokenAtNode(nodeId, p)) {
            return false;
        }

        renderTokens();
        updateNodeClasses();
        setStatus(`Token added at node ${nodeId}.`);
        return true;
    }

    function deleteTokenAtNode(nodeId: NodeId): boolean {
        const token = graph.getTokenAtNode(nodeId);
        if (!graph.deleteTokenAtNode(nodeId)) {
            return false;
        }

        if (!token) {
            return false;
        }

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

    function addNodeAtPoint(x: number, y: number): GraphNode {
        const nodeData = graph.addNodeAtPoint(x, y);
        if (repulsionEnabled) {
            nodeData.fx = undefined;
            nodeData.fy = undefined;
        }

        return nodeData;
    }

    function addEdge(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        if (!graph.addEdge(sourceNodeId, targetNodeId, p)) {
            return false;
        }

        refreshSelectionState();
        return true;
    }

    function removeEdge(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        const removed = graph.removeEdge(sourceNodeId, targetNodeId);

        if (!removed) {
            return false;
        }

        refreshSelectionState();
        return true;
    }

    function removeNode(nodeId: NodeId): boolean {
        const tokenOnNode = graph.getTokenAtNode(nodeId);
        const removed = graph.removeNode(nodeId);
        if (!removed) {
            return false;
        }

        if (tokenOnNode) {
            if (selectedTokenId === tokenOnNode.id) {
                selectedTokenId = null;
                legalMoveTargets = new Set<NodeId>();
            }
        }

        interactions.stopEdgeDrag();
        refreshSelectionState();
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
                    toggleTokenAtNode(d.id);
                } else {
                    handleNodeClick(d.id);
                }
            })
            .on("mousedown", (event: MouseEvent, d: GraphNode) => interactions.handleNodeMouseDown(event, d))
            .on("contextmenu", (event: MouseEvent) => event.preventDefault());

        background
            .on("mousedown", interactions.handleBackgroundMouseDown)
            .on("contextmenu", (event: MouseEvent) => event.preventDefault());

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

    function applyPValue(nextP: number): void {
        if (Number.isNaN(nextP)) {
            pInput.value = String(p);
            return;
        }

        if (!graph.isConfigurationValid(graph.tokens, nextP)) {
            pInput.value = String(p);
            setStatus(`p = ${nextP} would make the current configuration invalid, so it was rejected.`);
            return;
        }

        p = nextP;
        graph.setP(nextP);
        refreshSelectionState();
        updateNodeClasses();
        updateTokenClasses();
        setStatus(`p updated to ${p}.`);
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
            interactions.destroy();
            svg.selectAll("*").remove();
        },
    };
}