import type { GraphLink, GraphNode, GraphToken, NodeId, ProblemRules } from "./types";

export type GraphRuleContext = {
    nodes: GraphNode[];
    links: GraphLink[];
    tokens: GraphToken[];
    getClosedNeighborhood(nodeId: NodeId): Set<NodeId>;
    countTokensInNeighborhood(neighborhood: Set<NodeId>, candidateTokens: GraphToken[]): number;
    areNeighbors(sourceNodeId: NodeId, targetNodeId: NodeId): boolean;
    getLinkEndpoint(endpoint: NodeId | GraphNode): NodeId;
    hasEdge(sourceNodeId: NodeId, targetNodeId: NodeId): boolean;
};

export type TypedProblemRules = {
    [Key in keyof ProblemRules]: ProblemRules[Key] extends (...args: infer Arguments) => infer Result
        ? (state: GraphRuleContext, ...args: Arguments extends [unknown, ...infer Rest] ? Rest : never) => Result
        : never;
};