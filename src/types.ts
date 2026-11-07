// Both imports are types only, which is what lets a board shape live here while
// the code that reads it lives with the search. Erased at compile time, so there
// is no import cycle at runtime to trip over.
import type { BoardReading, TokenMove } from "./configuration-board";
import type { Occupancy } from "./configuration-space";

export type NodeId = number | string;
export type LayoutMode = "circle" | "binaryTree" | "ternaryTree" | "grid" | "line" | "zigzag" | "spiral";

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
    // A mark the reader put there by hand, drawn as a square under the vertex.
    // Absent means unmarked rather than false, so a file or scenario that predates
    // it needs no mention of it. It carries no meaning for any problem's rules.
    highlighted?: boolean;
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

// `highlighted` is optional for the same reason `problem` is below: a file
// written before either existed is not wrong, it simply says nothing about them.
export interface SerializedSubgraphNode {
    id: NodeId;
    x: number;
    y: number;
    highlighted?: boolean;
}

// The problem a file was saved under. `id` is what a later load matches on, so
// it is the one field that has to be exact; `name` is there so a file stays
// legible to a person, and so an older build can still say what it came from.
export interface SerializedProblemContext {
    id: string;
    name: string;
    parameter: number;
}

// `version` stays at 1 and the newer fields are optional on purpose. A reader
// that only knows version 1 ignores an extra key, so new files still open in an
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

export interface TokenReconfigurationAppConfig {
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

// What changed on the board, as far as anything watching it is concerned. One
// distinction earns its keep: a token that MOVES lands on an arrangement that was
// already reachable from where it started, while every other change can alter the
// set of reachable arrangements outright. A watcher that re-derives its whole
// picture on a move would throw away seconds of work on every click.
export type BoardChangeReason =
    | "token-moved"
    | "token-added-or-removed"
    | "graph-changed"
    | "rules-changed"
    | "goals-changed";

export interface TokenReconfigurationApp {
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

    // A copy of what is on the board right now, in the shape the configuration
    // search reads. A copy on purpose: a search outlives the frame it started in,
    // and edits made while it runs must not reach into a picture half-drawn.
    readBoard(): BoardReading;
    // Puts the tokens on the given vertices, taking the board to an arrangement
    // found elsewhere rather than by a sequence of legal moves. Refused — leaving
    // the board alone — unless the arrangement is one the rules accept and this
    // board can hold: same number of tokens, every vertex still present. Records
    // one undo step, so a jump is always walkable back.
    applyOccupancy(occupancy: Occupancy): boolean;
    // Decorates the board with one hypothetical slide. Null removes the preview;
    // neither case changes a token, the rules, or the undo history.
    setMovePreview(move: TokenMove | null): void;
    // Hears about a change the moment the board makes it. Returns the way to stop
    // hearing. The reason is a hint about how much a listener needs to redo, not
    // a guarantee: a listener that must be exact re-reads the board regardless.
    onBoardChange(listener: (reason: BoardChangeReason) => void): () => void;

    destroy(): void;
}