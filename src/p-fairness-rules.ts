import type { GraphToken, NodeId } from "./types";
import type { GraphRuleContext, TypedProblemRules } from "./problem-rules";

export function isConfigurationValid(
    state: GraphRuleContext,
    candidateTokens: GraphToken[],
    candidateP: number,
): boolean {
    return state.nodes.every(nodeData => {
        const neighborhood = state.getClosedNeighborhood(nodeData.id);
        return state.countTokensInNeighborhood(neighborhood, candidateTokens) <= candidateP;
    });
}

export function canPlaceTokenAtNode(
    state: GraphRuleContext,
    nodeId: NodeId,
    candidateTokens: GraphToken[],
    candidateP: number,
): boolean {
    if (state.tokens.some(token => token.nodeId === nodeId)) {
        return false;
    }

    const proposedTokens = [...candidateTokens, { id: "__proposed__", nodeId }];
    return isConfigurationValid(state, proposedTokens, candidateP);
}

export function canMoveToken(
    state: GraphRuleContext,
    tokenId: string,
    targetNodeId: NodeId,
    candidateP: number,
): boolean {
    const token = state.tokens.find(item => item.id === tokenId);
    if (!token) {
        return false;
    }

    if (token.nodeId === targetNodeId) {
        return false;
    }

    if (!state.areNeighbors(token.nodeId, targetNodeId)) {
        return false;
    }

    if (state.tokens.some(item => item.nodeId === targetNodeId && item.id !== tokenId)) {
        return false;
    }

    const proposedTokens = state.tokens.map(item => item.id === tokenId
        ? { ...item, nodeId: targetNodeId }
        : item);

    return isConfigurationValid(state, proposedTokens, candidateP);
}

export function getLegalMoveTargets(
    state: GraphRuleContext,
    tokenId: string,
    candidateP: number,
): NodeId[] {
    const token = state.tokens.find(item => item.id === tokenId);
    if (!token) {
        return [];
    }

    return state.links
        .map(linkData => {
            const sourceId = state.getLinkEndpoint(linkData.source);
            const targetId = state.getLinkEndpoint(linkData.target);
            if (sourceId === token.nodeId) return targetId;
            if (targetId === token.nodeId) return sourceId;
            return null;
        })
        .filter((nodeId): nodeId is NodeId => nodeId !== null && canMoveToken(state, tokenId, nodeId, candidateP));
}

export function isEdgeAdditionValid(
    state: GraphRuleContext,
    p: number,
    sourceNodeId: NodeId,
    targetNodeId: NodeId,
): boolean {
    if (sourceNodeId === targetNodeId || state.hasEdge(sourceNodeId, targetNodeId)) {
        return false;
    }

    const proposedLinks = [...state.links, { source: sourceNodeId, target: targetNodeId }];

    return state.nodes.every(nodeData => {
        const neighborhood = new Set<NodeId>([nodeData.id]);

        proposedLinks.forEach(linkData => {
            const linkSourceId = state.getLinkEndpoint(linkData.source);
            const linkTargetId = state.getLinkEndpoint(linkData.target);

            if (linkSourceId === nodeData.id) {
                neighborhood.add(linkTargetId);
            }

            if (linkTargetId === nodeData.id) {
                neighborhood.add(linkSourceId);
            }
        });

        return state.countTokensInNeighborhood(neighborhood, state.tokens) <= p;
    });
}

export const pFairnessRules: TypedProblemRules = {
    isConfigurationValid,
    canPlaceTokenAtNode,
    canMoveToken,
    getLegalMoveTargets,
    isEdgeAdditionValid,
};