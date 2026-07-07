import type { GraphLink, GraphNode, GraphToken, NodeId } from "./types";
import {
    canMoveToken as canMoveTokenInGraph,
    canPlaceTokenAtNode as canPlaceTokenAtNodeInGraph,
    getLegalMoveTargets as getLegalMoveTargetsInGraph,
    isConfigurationValid as isConfigurationValidInGraph,
    isEdgeAdditionValid as isEdgeAdditionValidInGraph,
} from "./p-fairness-rules";

export class Graph {
    public readonly nodes: GraphNode[];
    public readonly links: GraphLink[];
    public tokens: GraphToken[];
    public p: number;
    public nextNodeId: number;
    public nodeById: Map<NodeId, GraphNode>;

    constructor({
        nodes,
        links,
        tokens,
        p,
        nextNodeId,
    }: {
        nodes: GraphNode[];
        links: GraphLink[];
        tokens: GraphToken[];
        p: number;
        nextNodeId: number;
    }) {
        this.nodes = nodes;
        this.links = links;
        this.tokens = tokens;
        this.p = p;
        this.nextNodeId = nextNodeId;
        this.nodeById = new Map(nodes.map(node => [node.id, node]));
    }

    getSortedNodes(): GraphNode[] {
        return [...this.nodes].sort((leftNode, rightNode) => this.compareNodeIds(leftNode.id, rightNode.id));
    }

    getLinkKey(linkData: GraphLink): string {
        const sourceId = this.getLinkEndpoint(linkData.source);
        const targetId = this.getLinkEndpoint(linkData.target);

        return String(sourceId) < String(targetId)
            ? `${sourceId}--${targetId}`
            : `${targetId}--${sourceId}`;
    }
    
    getClosedNeighborhood(nodeId: NodeId): Set<NodeId> {
        const neighborhood = new Set<NodeId>([nodeId]);

        this.links.forEach(linkData => {
            const sourceId = this.getLinkEndpoint(linkData.source);
            const targetId = this.getLinkEndpoint(linkData.target);

            if (sourceId === nodeId) neighborhood.add(targetId);
            if (targetId === nodeId) neighborhood.add(sourceId);
        });

        return neighborhood;
    }
    
    areNeighbors(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        return this.links.some(linkData => {
            const sourceId = this.getLinkEndpoint(linkData.source);
            const targetId = this.getLinkEndpoint(linkData.target);
            return (sourceId === sourceNodeId && targetId === targetNodeId) ||
                (sourceId === targetNodeId && targetId === sourceNodeId);
        });
    }
    
    hasEdge(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        return this.areNeighbors(sourceNodeId, targetNodeId);
    }

    countTokensInNeighborhood(neighborhood: Set<NodeId>, candidateTokens: GraphToken[]): number {
        return candidateTokens.filter(token => neighborhood.has(token.nodeId)).length;
    }

    compareNodeIds(leftId: NodeId, rightId: NodeId): number {
        const leftNumber = typeof leftId === "number" ? leftId : Number(leftId);
        const rightNumber = typeof rightId === "number" ? rightId : Number(rightId);

        if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
            return leftNumber - rightNumber;
        }

        return String(leftId).localeCompare(String(rightId));
    }

    refreshNodeIndex(): void {
        this.nodeById = new Map(this.nodes.map(node => [node.id, node]));
    }

    setP(nextP: number): void {
        this.p = nextP;
    }

    getTokenAtNode(nodeId: NodeId, ignoredTokenId: string | null = null): GraphToken | null {
        return this.tokens.find(token => token.nodeId === nodeId && token.id !== ignoredTokenId) || null;
    }

    isConfigurationValid(candidateTokens: GraphToken[] = this.tokens, candidateP: number = this.p): boolean {
        return isConfigurationValidInGraph(this, candidateTokens, candidateP);
    }

    canPlaceTokenAtNode(nodeId: NodeId, candidateTokens: GraphToken[] = this.tokens, candidateP: number = this.p): boolean {
        return canPlaceTokenAtNodeInGraph(this, nodeId, candidateTokens, candidateP);
    }

    canMoveToken(tokenId: string, targetNodeId: NodeId, candidateP: number = this.p): boolean {
        return canMoveTokenInGraph(this, tokenId, targetNodeId, candidateP);
    }

    getLegalMoveTargets(tokenId: string, candidateP: number = this.p): NodeId[] {
        return getLegalMoveTargetsInGraph(this, tokenId, candidateP);
    }

    isEdgeAdditionValid(p: number, sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        return isEdgeAdditionValidInGraph(this, p, sourceNodeId, targetNodeId);
    }

    addNodeAtPoint(x: number, y: number): GraphNode {
        const nodeData: GraphNode = {
            id: this.nextNodeId,
            x,
            y,
            vx: 0,
            vy: 0,
            fx: x,
            fy: y,
            anchorX: x,
            anchorY: y,
        };

        this.nextNodeId += 1;
        this.nodes.push(nodeData);
        this.refreshNodeIndex();
        return nodeData;
    }

    getLinkEndpoint(endpoint: NodeId | GraphNode): NodeId {
        return typeof endpoint === "object" ? endpoint.id : endpoint;
    }

    addEdge(sourceNodeId: NodeId, targetNodeId: NodeId, p: number): boolean {
        if (!this.isEdgeAdditionValid(p, sourceNodeId, targetNodeId)) {
            return false;
        }

        this.links.push({ source: sourceNodeId, target: targetNodeId });
        return true;
    }

    removeEdge(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
        let removed = false;

        for (let index = this.links.length - 1; index >= 0; index -= 1) {
            const linkData = this.links[index];
            const linkSourceId = this.getLinkEndpoint(linkData.source);
            const linkTargetId = this.getLinkEndpoint(linkData.target);

            if ((linkSourceId === sourceNodeId && linkTargetId === targetNodeId) ||
                (linkSourceId === targetNodeId && linkTargetId === sourceNodeId)) {
                this.links.splice(index, 1);
                removed = true;
            }
        }

        return removed;
    }

    removeNode(nodeId: NodeId): boolean {
        const nodeIndex = this.nodes.findIndex(nodeData => nodeData.id === nodeId);
        if (nodeIndex === -1) {
            return false;
        }

        const tokenOnNode = this.getTokenAtNode(nodeId);
        if (tokenOnNode) {
            this.deleteTokenAtNode(nodeId);
        }

        this.nodes.splice(nodeIndex, 1);

        for (let index = this.links.length - 1; index >= 0; index -= 1) {
            const linkData = this.links[index];
            const sourceId = this.getLinkEndpoint(linkData.source);
            const targetId = this.getLinkEndpoint(linkData.target);
            if (sourceId === nodeId || targetId === nodeId) {
                this.links.splice(index, 1);
            }
        }

        this.refreshNodeIndex();
        return true;
    }

    moveToken(tokenId: string, targetNodeId: NodeId): boolean {
        const token = this.tokens.find(item => item.id === tokenId);
        if (!token) {
            return false;
        }

        token.nodeId = targetNodeId;
        return true;
    }

    addTokenAtNode(nodeId: NodeId, p: number): boolean {
        if (this.getTokenAtNode(nodeId)) {
            return false;
        }

        const tokenId = `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
        const proposedTokens = [...this.tokens, { id: tokenId, nodeId }];

        if (!this.isConfigurationValid(proposedTokens, p)) {
            return false;
        }

        this.tokens.push({ id: tokenId, nodeId });
        return true;
    }

    deleteTokenAtNode(nodeId: NodeId): boolean {
        const tokenIndex = this.tokens.findIndex(token => token.nodeId === nodeId);
        if (tokenIndex === -1) {
            return false;
        }

        this.tokens.splice(tokenIndex, 1);
        return true;
    }

    toggleTokenAtNode(nodeId: NodeId, p: number): boolean {
        if (this.getTokenAtNode(nodeId)) {
            return this.deleteTokenAtNode(nodeId);
        }

        return this.addTokenAtNode(nodeId, p);
    }
}