export type NodeId = number | string;
export type LayoutMode = "circular" | "tree" | "grid" | "horizontal" | "vertical" | "spiral";

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
    pInputSelector: string;
    statusSelector: string;
    nodes: Array<NodeId | ScenarioNodeInput>;
    links: GraphLinkInput[];
    tokens: TokenInput[];
    initialP: number;
}

export interface PFairnessApp {
    setStatus(message: string): void;
    setRepulsionEnabled(enabled: boolean): void;
    applyLayout(layout: LayoutMode): void;
    clearNodeSelection(): void;
    copySelection(): boolean;
    pasteSelection(): boolean;
    saveSelection(): boolean;
    deleteSelection(): boolean;
    importSelection(file: File): Promise<boolean>;
    destroy(): void;
}