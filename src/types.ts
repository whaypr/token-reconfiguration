export type NodeId = number | string;
export type LayoutMode = "circle" | "binaryTree" | "ternaryTree" | "grid" | "horizontal" | "spiral";

// Which verb a touch means on the canvas. The mouse never consults this:
// every desktop gesture works in both modes.
export type InteractionMode = "tokens" | "graph";

// Which of the three vertex hints are painted. Each one is independent: an off
// hint leaves that vertex the plain slot grey, and the movement rules behind it
// are untouched.
export interface ColorHints {
    movable: boolean;
    frozen: boolean;
    placeable: boolean;
}

// One source of truth for the starting hints: the app initialises from this and
// the switches mirror it, so the two cannot drift apart.
export const DEFAULT_COLOR_HINTS: ColorHints = { movable: true, frozen: false, placeable: true };

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
    nodes: Array<NodeId | ScenarioNodeInput>;
    links: GraphLinkInput[];
    tokens: TokenInput[];
    // The problem the scenario was drawn under, in the same shape a saved file
    // carries it. Selecting the scenario switches to it, which is why a scenario
    // can outlive the ordering of the problem list: it names an id rather than
    // an index. `parameter` is its own value for that problem, because a number
    // means something different under every problem.
    problem?: SerializedProblemContext;
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

// The problem a file was saved under. `id` is what a later load matches on, so
// it is the one field that has to be exact; `name` is there so a file stays
// legible to a person, and so an older build can still say what it came from.
export interface SerializedProblemContext {
    id: string;
    name: string;
    parameter: number;
}

// `version` stays at 1 and the context is optional on purpose. A reader that
// only knows version 1 ignores an extra key, so new files still open in an
// older build, and a file with no context is simply one whose problem is
// unknown — the same thing an old file is. Bumping the version would have made
// new files unreadable to the build that checks `version === 1`.
export interface SerializedSubgraph {
    version: 1;
    nodes: SerializedSubgraphNode[];
    links: GraphLinkInput[];
    tokens: TokenInput[];
    problem?: SerializedProblemContext;
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
    // Called whenever the problem in use changes from inside the app — which
    // includes undoing a switch, where no control was touched. The owner of the
    // problem dropdown needs to hear about it or it would show a problem the
    // rules are no longer applying.
    onProblemChange?(problem: ProblemDefinition): void;
}

export interface PFairnessApp {
    setStatus(message: string): void;
    setInteractionMode(mode: InteractionMode): void;
    setColorHints(hints: ColorHints): void;
    setRepulsionEnabled(enabled: boolean): void;
    setNeighborhoodCountVisibility(enabled: boolean): void;
    setMoveDirectionVisibility(enabled: boolean): void;
    applyLayout(layout: LayoutMode): void;
    // Applies a different problem to the graph that is already open. The
    // parameter is the new problem's own value, since a number means something
    // different under every problem.
    setProblem(problem: ProblemDefinition, parameter?: number): void;
    clearNodeSelection(): void;
    undo(): boolean;
    copySelection(): boolean;
    pasteSelection(): boolean;
    saveSelection(): boolean;
    deleteSelection(): boolean;
    // Resolves to null when the file could not be read. Otherwise it hands back
    // the problem the file was saved under, if it named one, so the caller that
    // owns the list of problems can switch to it.
    importSelection(file: File): Promise<SerializedProblemContext | null>;
    destroy(): void;
}