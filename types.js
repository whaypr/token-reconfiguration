export type NodeId = number | string;

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
    fx: number;
    fy: number;
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

export interface PFairnessAppConfig {
    svgSelector: string;
    pInputSelector: string;
    statusSelector: string;
    nodes: Array<NodeId | ScenarioNodeInput>;
    links: GraphLinkInput[];
    tokens: TokenInput[];
    initialP: number;
}

export interface PFairnessApp {
    setStatus(message: string): void;
    destroy(): void;
}