import type { GraphLink, GraphNode, LayoutMode, NodeId } from "./types";

interface LayoutGraph {
    nodes: GraphNode[];
    links: GraphLink[];
    width: number;
    height: number;
}

function getLinkEndpoint(endpoint: NodeId | GraphNode): NodeId {
    return typeof endpoint === "object" ? endpoint.id : endpoint;
}

function compareNodeIds(leftId: NodeId, rightId: NodeId): number {
    const leftNumber = typeof leftId === "number" ? leftId : Number(leftId);
    const rightNumber = typeof rightId === "number" ? rightId : Number(rightId);

    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        return leftNumber - rightNumber;
    }

    return String(leftId).localeCompare(String(rightId));
}

function getSortedNodes(nodes: GraphNode[]): GraphNode[] {
    return [...nodes].sort((leftNode, rightNode) => compareNodeIds(leftNode.id, rightNode.id));
}

function setNodePosition(node: GraphNode, x: number, y: number, fixed: boolean): void {
    node.x = x;
    node.y = y;
    node.anchorX = x;
    node.anchorY = y;
    node.fx = fixed ? x : undefined;
    node.fy = fixed ? y : undefined;
}

function applyCircularLayout(graph: LayoutGraph): void {
    const orderedNodes = getSortedNodes(graph.nodes);

    if (orderedNodes.length === 0) {
        return;
    }

    const radius = Math.min(graph.width, graph.height) * 0.32;
    const centerX = graph.width / 2;
    const centerY = graph.height / 2;

    orderedNodes.forEach((node, index) => {
        const angle = (index / orderedNodes.length) * Math.PI * 2;
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius;
        setNodePosition(node, x, y, true);
    });
}

function applyGridLayout(graph: LayoutGraph): void {
    const orderedNodes = getSortedNodes(graph.nodes);

    if (orderedNodes.length === 0) {
        return;
    }

    const columns = Math.ceil(Math.sqrt(orderedNodes.length));
    const rows = Math.ceil(orderedNodes.length / columns);
    const xStep = graph.width / (columns + 1);
    const yStep = graph.height / (rows + 1);

    orderedNodes.forEach((node, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        const x = (column + 1) * xStep;
        const y = (row + 1) * yStep;
        setNodePosition(node, x, y, true);
    });
}

function applyHorizontalLayout(graph: LayoutGraph): void {
    const orderedNodes = getSortedNodes(graph.nodes);

    if (orderedNodes.length === 0) {
        return;
    }

    const xStep = graph.width / (orderedNodes.length + 1);
    const centerY = graph.height / 2;

    orderedNodes.forEach((node, index) => {
        const x = (index + 1) * xStep;
        const y = centerY + (index % 2 === 0 ? -24 : 24);
        setNodePosition(node, x, y, true);
    });
}

function applyVerticalLayout(graph: LayoutGraph): void {
    const orderedNodes = getSortedNodes(graph.nodes);

    if (orderedNodes.length === 0) {
        return;
    }

    const yStep = graph.height / (orderedNodes.length + 1);
    const centerX = graph.width / 2;

    orderedNodes.forEach((node, index) => {
        const x = centerX + (index % 2 === 0 ? -24 : 24);
        const y = (index + 1) * yStep;
        setNodePosition(node, x, y, true);
    });
}

function applySpiralLayout(graph: LayoutGraph): void {
    const orderedNodes = getSortedNodes(graph.nodes);

    if (orderedNodes.length === 0) {
        return;
    }

    const centerX = graph.width / 2;
    const centerY = graph.height / 2;
    const angleStep = Math.PI * 0.75;
    const radiusStep = Math.min(graph.width, graph.height) * 0.035;

    orderedNodes.forEach((node, index) => {
        const angle = index * angleStep;
        const radius = 40 + index * radiusStep;
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius;
        setNodePosition(node, x, y, true);
    });
}

function buildAdjacencyMap(nodes: GraphNode[], links: GraphLink[]): Map<NodeId, GraphNode[]> {
    const adjacency = new Map<NodeId, GraphNode[]>();

    nodes.forEach(node => {
        adjacency.set(node.id, []);
    });

    links.forEach(linkData => {
        const sourceId = getLinkEndpoint(linkData.source);
        const targetId = getLinkEndpoint(linkData.target);
        const sourceNode = nodes.find(node => node.id === sourceId);
        const targetNode = nodes.find(node => node.id === targetId);

        if (sourceNode && targetNode) {
            adjacency.get(sourceId)?.push(targetNode);
            adjacency.get(targetId)?.push(sourceNode);
        }
    });

    return adjacency;
}

function applyTreeLayout(graph: LayoutGraph): void {
    const adjacency = buildAdjacencyMap(graph.nodes, graph.links);
    const unvisitedNodes = new Set<GraphNode>(getSortedNodes(graph.nodes));
    const componentLayouts: Array<Map<number, GraphNode[]>> = [];

    while (unvisitedNodes.size > 0) {
        const rootNode = getSortedNodes(graph.nodes).find(node => unvisitedNodes.has(node)) || unvisitedNodes.values().next().value;
        if (!rootNode) {
            break;
        }

        const levels = new Map<number, GraphNode[]>();
        const queue: Array<{ node: GraphNode; depth: number }> = [{ node: rootNode, depth: 0 }];
        const visitedComponent = new Set<NodeId>();

        while (queue.length > 0) {
            const current = queue.shift();
            if (!current) {
                continue;
            }

            const { node, depth } = current;
            if (visitedComponent.has(node.id)) {
                continue;
            }

            visitedComponent.add(node.id);
            unvisitedNodes.delete(node);

            const nodesAtLevel = levels.get(depth) || [];
            nodesAtLevel.push(node);
            levels.set(depth, nodesAtLevel);

            (adjacency.get(node.id) || [])
                .sort((leftNode, rightNode) => compareNodeIds(leftNode.id, rightNode.id))
                .forEach(neighbor => {
                    if (!visitedComponent.has(neighbor.id)) {
                        queue.push({ node: neighbor, depth: depth + 1 });
                    }
                });
        }

        componentLayouts.push(levels);
    }

    if (componentLayouts.length === 0) {
        return;
    }

    const componentHeight = graph.height / componentLayouts.length;

    componentLayouts.forEach((levels, componentIndex) => {
        const componentTop = componentIndex * componentHeight;
        const levelEntries = [...levels.entries()].sort((left, right) => left[0] - right[0]);
        const levelHeight = componentHeight / (levelEntries.length + 1);

        levelEntries.forEach(([_depth, levelNodes], levelIndex) => {
            const y = componentTop + (levelIndex + 1) * levelHeight;
            const xStep = graph.width / (levelNodes.length + 1);

            levelNodes
                .sort((leftNode, rightNode) => compareNodeIds(leftNode.id, rightNode.id))
                .forEach((node, nodeIndex) => {
                    const x = (nodeIndex + 1) * xStep;
                    setNodePosition(node, x, y, true);
                });
        });
    });
}

export function applyGraphLayout(graph: LayoutGraph, layout: LayoutMode): void {
    if (layout === "circular") {
        applyCircularLayout(graph);
    } else if (layout === "tree") {
        applyTreeLayout(graph);
    } else if (layout === "grid") {
        applyGridLayout(graph);
    } else if (layout === "horizontal") {
        applyHorizontalLayout(graph);
    } else if (layout === "vertical") {
        applyVerticalLayout(graph);
    } else {
        applySpiralLayout(graph);
    }
}