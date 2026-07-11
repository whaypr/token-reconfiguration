import type { Graph } from "./graph";
import type { GraphNode, NodeId, SerializedSubgraph, SerializedSubgraphNode } from "./types";

export function getSelectedBounds(graph: Graph, selectedNodeIds: Set<NodeId>): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const selectedNodes = graph.nodes.filter(node => selectedNodeIds.has(node.id));

    if (selectedNodes.length === 0) {
        return null;
    }

    const xs = selectedNodes.map(node => node.x);
    const ys = selectedNodes.map(node => node.y);

    return {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
    };
}

export function serializeSelectedSubgraph(graph: Graph, selectedNodeIds: Set<NodeId>): SerializedSubgraph | null {
    const selectedNodes = graph.nodes.filter(node => selectedNodeIds.has(node.id));

    if (selectedNodes.length === 0) {
        return null;
    }

    const selectedLinks = graph.links.filter(link => {
        const sourceId = graph.getLinkEndpoint(link.source);
        const targetId = graph.getLinkEndpoint(link.target);
        return selectedNodeIds.has(sourceId) && selectedNodeIds.has(targetId);
    });

    const selectedTokens = graph.tokens.filter(token => selectedNodeIds.has(token.nodeId));

    return {
        version: 1,
        nodes: selectedNodes.map(node => ({ id: node.id, x: node.x, y: node.y })),
        links: selectedLinks.map(link => ({
            source: graph.getLinkEndpoint(link.source),
            target: graph.getLinkEndpoint(link.target),
        })),
        tokens: selectedTokens.map(token => ({ id: token.id, nodeId: token.nodeId })),
    };
}

function makeUniqueTokenId(existingIds: Set<string>, index: number): string {
    let candidateId = `t${Date.now()}_${index}`;
    while (existingIds.has(candidateId)) {
        candidateId = `${candidateId}_${Math.floor(Math.random() * 1000)}`;
    }
    return candidateId;
}

export function pasteSerializedSubgraph(
    graph: Graph,
    data: SerializedSubgraph,
    offsetX: number,
    offsetY: number,
): Set<NodeId> {
    const nodeIdMap = new Map<NodeId, NodeId>();
    const pastedNodeIds = new Set<NodeId>();
    const existingTokenIds = new Set(graph.tokens.map(token => token.id));

    data.nodes.forEach(node => {
        const newId = graph.allocateNodeId();
        nodeIdMap.set(node.id, newId);

        const pastedNode: GraphNode = {
            id: newId,
            x: node.x + offsetX,
            y: node.y + offsetY,
            vx: 0,
            vy: 0,
            fx: node.x + offsetX,
            fy: node.y + offsetY,
            anchorX: node.x + offsetX,
            anchorY: node.y + offsetY,
        };

        graph.nodes.push(pastedNode);
        pastedNodeIds.add(newId);
    });

    data.links.forEach(link => {
        const sourceId = nodeIdMap.get(link.source);
        const targetId = nodeIdMap.get(link.target);

        if (sourceId !== undefined && targetId !== undefined) {
            graph.links.push({ source: sourceId, target: targetId });
        }
    });

    data.tokens.forEach((token, index) => {
        const newNodeId = nodeIdMap.get(token.nodeId);
        if (newNodeId === undefined) {
            return;
        }

        const newTokenId = makeUniqueTokenId(existingTokenIds, index);
        existingTokenIds.add(newTokenId);
        graph.tokens.push({ id: newTokenId, nodeId: newNodeId });
    });

    graph.refreshNodeIndex();
    return pastedNodeIds;
}