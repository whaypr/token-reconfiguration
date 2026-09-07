import type { GraphToken, NodeId } from "./types";
import type { GraphRuleContext, TypedProblemRules } from "./problem-rules";

function getDistance(state: GraphRuleContext, sourceNodeId: NodeId, targetNodeId: NodeId, links = state.links): number {
    if (sourceNodeId === targetNodeId) return 0;
    const distances = new Map<NodeId, number>([[sourceNodeId, 0]]);
    const queue: NodeId[] = [sourceNodeId];

    while (queue.length > 0) {
        const currentNodeId = queue.shift()!;
        const currentDistance = distances.get(currentNodeId)!;

        for (const link of links) {
            const sourceId = state.getLinkEndpoint(link.source);
            const targetId = state.getLinkEndpoint(link.target);
            const neighborId = sourceId === currentNodeId ? targetId : targetId === currentNodeId ? sourceId : null;
            if (neighborId === null || distances.has(neighborId)) continue;
            if (neighborId === targetNodeId) return currentDistance + 1;
            distances.set(neighborId, currentDistance + 1);
            queue.push(neighborId);
        }
    }

    return Infinity;
}

function isConfigurationValidWithLinks(
    state: GraphRuleContext,
    candidateTokens: GraphToken[],
    distance: number,
    links: GraphRuleContext["links"],
): boolean {
    for (let firstIndex = 0; firstIndex < candidateTokens.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < candidateTokens.length; secondIndex += 1) {
            if (getDistance(state, candidateTokens[firstIndex].nodeId, candidateTokens[secondIndex].nodeId, links) < distance) return false;
        }
    }
    return true;
}

export function isConfigurationValid(state: GraphRuleContext, candidateTokens: GraphToken[], distance: number): boolean {
    return isConfigurationValidWithLinks(state, candidateTokens, distance, state.links);
}

export function canPlaceTokenAtNode(state: GraphRuleContext, nodeId: NodeId, candidateTokens: GraphToken[], distance: number): boolean {
    if (state.tokens.some(token => token.nodeId === nodeId)) return false;
    return isConfigurationValid(state, [...candidateTokens, { id: "__proposed__", nodeId }], distance);
}

export function canMoveToken(state: GraphRuleContext, tokenId: string, targetNodeId: NodeId, distance: number): boolean {
    const token = state.tokens.find(item => item.id === tokenId);
    if (!token || token.nodeId === targetNodeId || !state.areNeighbors(token.nodeId, targetNodeId)) return false;
    if (state.tokens.some(item => item.nodeId === targetNodeId && item.id !== tokenId)) return false;
    const proposedTokens = state.tokens.map(item => item.id === tokenId ? { ...item, nodeId: targetNodeId } : item);
    return isConfigurationValid(state, proposedTokens, distance);
}

export function getLegalMoveTargets(state: GraphRuleContext, tokenId: string, distance: number): NodeId[] {
    const token = state.tokens.find(item => item.id === tokenId);
    if (!token) return [];
    return state.links
        .map(link => {
            const sourceId = state.getLinkEndpoint(link.source);
            const targetId = state.getLinkEndpoint(link.target);
            if (sourceId === token.nodeId) return targetId;
            if (targetId === token.nodeId) return sourceId;
            return null;
        })
        .filter((nodeId): nodeId is NodeId => nodeId !== null && canMoveToken(state, tokenId, nodeId, distance));
}

export function isEdgeAdditionValid(state: GraphRuleContext, distance: number, sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
    if (sourceNodeId === targetNodeId || state.hasEdge(sourceNodeId, targetNodeId)) return false;

    const proposedLinks = [...state.links, { source: sourceNodeId, target: targetNodeId }];

    for (let firstIndex = 0; firstIndex < state.tokens.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < state.tokens.length; secondIndex += 1) {
            const firstToken = state.tokens[firstIndex];
            const secondToken = state.tokens[secondIndex];
            const currentDistance = getDistance(state, firstToken.nodeId, secondToken.nodeId);
            const proposedDistance = getDistance(state, firstToken.nodeId, secondToken.nodeId, proposedLinks);

            if (currentDistance >= distance && proposedDistance < distance) return false;
        }
    }

    return true;
}

export const distanceDRules: TypedProblemRules = {
    isConfigurationValid,
    canPlaceTokenAtNode,
    canMoveToken,
    getLegalMoveTargets,
    isEdgeAdditionValid,
};