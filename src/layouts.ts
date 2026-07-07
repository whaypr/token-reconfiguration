import type { GraphNode, LayoutMode, NodeId } from "./types";
import { Graph } from "./graph";

interface LayoutContext {
    graph: Graph;
    width: number;
    height: number;
}

function setNodePosition(node: GraphNode, x: number, y: number, fixed: boolean): void {
    node.x = x;
    node.y = y;
    node.anchorX = x;
    node.anchorY = y;
    node.fx = fixed ? x : undefined;
    node.fy = fixed ? y : undefined;
}

function applyCircularLayout(context: LayoutContext): void {
    const orderedNodes = context.graph.getSortedNodes();

    if (orderedNodes.length === 0) {
        return;
    }

    const radius = Math.min(context.width, context.height) * 0.32;
    const centerX = context.width / 2;
    const centerY = context.height / 2;

    orderedNodes.forEach((node, index) => {
        const angle = (index / orderedNodes.length) * Math.PI * 2;
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius;
        setNodePosition(node, x, y, true);
    });
}

function applyGridLayout(context: LayoutContext): void {
    const orderedNodes = context.graph.getSortedNodes();

    if (orderedNodes.length === 0) {
        return;
    }

    const columns = Math.ceil(Math.sqrt(orderedNodes.length));
    const rows = Math.ceil(orderedNodes.length / columns);
    const xStep = context.width / (columns + 1);
    const yStep = context.height / (rows + 1);

    orderedNodes.forEach((node, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        const x = (column + 1) * xStep;
        const y = (row + 1) * yStep;
        setNodePosition(node, x, y, true);
    });
}

function applyHorizontalLayout(context: LayoutContext): void {
    const orderedNodes = context.graph.getSortedNodes();

    if (orderedNodes.length === 0) {
        return;
    }

    const xStep = context.width / (orderedNodes.length + 1);
    const centerY = context.height / 2;

    orderedNodes.forEach((node, index) => {
        const x = (index + 1) * xStep;
        const y = centerY + (index % 2 === 0 ? -24 : 24);
        setNodePosition(node, x, y, true);
    });
}

function applyVerticalLayout(context: LayoutContext): void {
    const orderedNodes = context.graph.getSortedNodes();

    if (orderedNodes.length === 0) {
        return;
    }

    const yStep = context.height / (orderedNodes.length + 1);
    const centerX = context.width / 2;

    orderedNodes.forEach((node, index) => {
        const x = centerX + (index % 2 === 0 ? -24 : 24);
        const y = (index + 1) * yStep;
        setNodePosition(node, x, y, true);
    });
}

function applySpiralLayout(context: LayoutContext): void {
    const orderedNodes = context.graph.getSortedNodes();

    if (orderedNodes.length === 0) {
        return;
    }

    const centerX = context.width / 2;
    const centerY = context.height / 2;
    const angleStep = Math.PI * 0.75;
    const radiusStep = Math.min(context.width, context.height) * 0.035;

    orderedNodes.forEach((node, index) => {
        const angle = index * angleStep;
        const radius = 40 + index * radiusStep;
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius;
        setNodePosition(node, x, y, true);
    });
}

function buildAdjacencyMap(context: LayoutContext): Map<NodeId, GraphNode[]> {
    const adjacency = new Map<NodeId, GraphNode[]>();
    const nodes = context.graph.nodes;
    const links = context.graph.links;

    nodes.forEach(node => {
        adjacency.set(node.id, []);
    });

    links.forEach(linkData => {
        const sourceId = context.graph.getLinkEndpoint(linkData.source);
        const targetId = context.graph.getLinkEndpoint(linkData.target);
        const sourceNode = nodes.find(node => node.id === sourceId);
        const targetNode = nodes.find(node => node.id === targetId);

        if (sourceNode && targetNode) {
            adjacency.get(sourceId)?.push(targetNode);
            adjacency.get(targetId)?.push(sourceNode);
        }
    });

    return adjacency;
}

function applyTreeLayout(context: LayoutContext): void {
    const adjacency = buildAdjacencyMap(context);
    const orderedNodes = context.graph.getSortedNodes();
    const unvisitedNodes = new Set<GraphNode>(orderedNodes);
    const componentLayouts: Array<Map<number, GraphNode[]>> = [];

    while (unvisitedNodes.size > 0) {
        const rootNode = orderedNodes.find(node => unvisitedNodes.has(node)) || unvisitedNodes.values().next().value;
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
                .sort((leftNode, rightNode) => context.graph.compareNodeIds(leftNode.id, rightNode.id))
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

    const componentHeight = context.height / componentLayouts.length;

    componentLayouts.forEach((levels, componentIndex) => {
        const componentTop = componentIndex * componentHeight;
        const levelEntries = [...levels.entries()].sort((left, right) => left[0] - right[0]);
        const levelHeight = componentHeight / (levelEntries.length + 1);

        levelEntries.forEach(([_depth, levelNodes], levelIndex) => {
            const y = componentTop + (levelIndex + 1) * levelHeight;
            const xStep = context.width / (levelNodes.length + 1);

            levelNodes
                .sort((leftNode, rightNode) => context.graph.compareNodeIds(leftNode.id, rightNode.id))
                .forEach((node, nodeIndex) => {
                    const x = (nodeIndex + 1) * xStep;
                    setNodePosition(node, x, y, true);
                });
        });
    });
}

export function applyGraphLayout(context: LayoutContext, layout: LayoutMode): void {
    if (layout === "circular") {
        applyCircularLayout(context);
    } else if (layout === "tree") {
        applyTreeLayout(context);
    } else if (layout === "grid") {
        applyGridLayout(context);
    } else if (layout === "horizontal") {
        applyHorizontalLayout(context);
    } else if (layout === "vertical") {
        applyVerticalLayout(context);
    } else {
        applySpiralLayout(context);
    }
}