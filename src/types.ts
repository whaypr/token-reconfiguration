export type NodeId = number | string;
export type LayoutMode = "circular" | "tree" | "grid" | "horizontal" | "vertical" | "spiral";

// Which verb a touch means on the canvas. The mouse never consults this:
// every desktop gesture works in both modes.
export type InteractionMode = "tokens" | "graph";

export interface ScenarioNodeInput {
    id: NodeId;
    x?: number;
    y?: number;
}

export interface GraphLinkInput {
    source: NodeId;
    target: NodeId;
}

export interface TokenInput {
    id: string;
    nodeId: NodeId;
}

export interface Scenario {
    id: string;
    name: string;
    description: string;
    initialP: number;
    nodes: Array<NodeId | ScenarioNodeInput>;
    links: GraphLinkInput[];
    tokens: TokenInput[];
}

export interface GraphNode extends ScenarioNodeInput {
    x: number;
    y: number;
    vx: number;
    vy: number;
    fx?: number;
    fy?: number;
    anchorX: number;
    anchorY: number;
}

export interface GraphLink {
    source: NodeId | GraphNode;
    target: NodeId | GraphNode;
}

export interface GraphToken {
    id: string;
    nodeId: NodeId;
}

export interface ProblemRules {
    isConfigurationValid(state: unknown, candidateTokens: GraphToken[], parameter: number): boolean;
    canPlaceTokenAtNode(state: unknown, nodeId: NodeId, candidateTokens: GraphToken[], parameter: number): boolean;
    canMoveToken(state: unknown, tokenId: string, targetNodeId: NodeId, parameter: number): boolean;
    getLegalMoveTargets(state: unknown, tokenId: string, parameter: number): NodeId[];
    isEdgeAdditionValid(state: unknown, parameter: number, sourceNodeId: NodeId, targetNodeId: NodeId): boolean;
}

export interface ProblemDefinition {
    id: string;
    name: string;
    parameterLabel: string;
    parameterDescription: string;
    defaultParameter: number;
    minParameter: number;
    maxParameter: number;
    parameterStep: number;
    rules: ProblemRules;
}

export interface SerializedSubgraphNode {
    id: NodeId;
    x: number;
    y: number;
}

export interface SerializedSubgraph {
    version: 1;
    nodes: SerializedSubgraphNode[];
    links: GraphLinkInput[];
    tokens: TokenInput[];
}

export interface PFairnessAppConfig {
    svgSelector: string;
    parameterInputSelector: string;
    statusSelector: string;
    nodes: Array<NodeId | ScenarioNodeInput>;
    links: GraphLinkInput[];
    tokens: TokenInput[];
    initialParameter: number;
    problem: ProblemDefinition;
}

export interface PFairnessApp {
    setStatus(message: string): void;
    setInteractionMode(mode: InteractionMode): void;
    setColorsEnabled(enabled: boolean): void;
    setRepulsionEnabled(enabled: boolean): void;
    setNeighborhoodCountVisibility(enabled: boolean): void;
    setMoveDirectionVisibility(enabled: boolean): void;
    applyLayout(layout: LayoutMode): void;
    clearNodeSelection(): void;
    undo(): boolean;
    copySelection(): boolean;
    pasteSelection(): boolean;
    saveSelection(): boolean;
    deleteSelection(): boolean;
    importSelection(file: File): Promise<boolean>;
    destroy(): void;
}