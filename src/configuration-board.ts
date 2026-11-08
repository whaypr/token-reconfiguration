import { createGraph } from "./graph-factory";
import type { GraphLinkInput, NodeId, ProblemDefinition } from "./types";
import type { ConfigurationKey, Occupancy } from "./configuration-space";

// Everything the configuration search needs to know about the canvas, read once.
// A copy rather than a live view: a search outlives the frame it started in, and
// a vertex added or a token dragged mid-search would otherwise change the graph
// under a picture that is half-drawn. The panel asks for a fresh reading whenever
// the board says it has changed.
export interface BoardReading {
    problem: ProblemDefinition;
    parameter: number;
    // Every vertex, including the ones with no edges. They are part of the rule
    // — a closed neighbourhood is counted around them too — so leaving them out
    // would answer the rules against a different graph than the one on screen.
    nodeIds: NodeId[];
    links: GraphLinkInput[];
    // The vertices carrying a token, in no particular order.
    occupancy: Occupancy;
    // The vertices the reader marked with a square: the goal a level asks the
    // tokens to be moved onto.
    goalNodeIds: NodeId[];
}

export interface TokenMove {
    from: NodeId;
    to: NodeId;
}

export interface ConfigurationProbe {
    compareIds(left: NodeId, right: NodeId): number;
    /** Every configuration one legal token slide away, as occupancies. */
    successorsOf(occupancy: Occupancy): Occupancy[];
    /** Whether the rules would accept this configuration at all. */
    isValid(occupancy: Occupancy): boolean;
    vertexCount: number;
    tokenCount: number;
}

/**
 * A question-and-answer stand for the board: a graph of its own holding the same
 * vertices and edges, whose tokens are replaced by the configuration being asked
 * about.
 *
 * This exists so the search can ask about configurations that are not on screen —
 * and so that it asks the REAL rules. `Graph` is itself the context the problems
 * read (every rule method is handed `this`), and each of them answers from the
 * graph's own `tokens`, so substituting the tokens on a throwaway graph is
 * enough to move the whole rule set onto a hypothetical board. Re-deriving the
 * rules here instead would give the demo a second, quieter definition of what is
 * legal, and the two would drift.
 */
export function createConfigurationProbe(reading: BoardReading): ConfigurationProbe {
    // Built through the factory the scenarios use, so a probe graph is assembled
    // exactly like a real one. The coordinates it seeds are meaningless here —
    // no rule reads a position — and an empty token list because every question
    // brings its own.
    const probe = createGraph(
        reading.nodeIds.map(id => ({ id })),
        reading.links.map(link => ({ ...link })),
        [],
        reading.parameter,
        reading.problem.rules,
        0,
        0,
    );

    // Tokens in a search are interchangeable: a configuration is the set of
    // vertices carrying one, so the ids only have to be distinct long enough to
    // name a token to the rules.
    function tokensFor(occupancy: Occupancy) {
        return occupancy.map((nodeId, index) => ({ id: `configuration-token-${index}`, nodeId }));
    }

    function compareIds(left: NodeId, right: NodeId): number {
        return probe.compareNodeIds(left, right);
    }

    function sorted(occupancy: Occupancy): Occupancy {
        return [...occupancy].sort(compareIds);
    }

    return {
        compareIds,
        successorsOf(occupancy: Occupancy): Occupancy[] {
            const tokens = tokensFor(occupancy);
            probe.tokens = tokens;

            const successors: Occupancy[] = [];

            for (const token of tokens) {
                // Asked with the parameter rather than left to the graph's own,
                // so the reading and the rules agree on the number even if the
                // board moved on after this probe was built.
                for (const targetNodeId of probe.getLegalMoveTargets(token.id, reading.parameter)) {
                    successors.push(sorted([
                        // The vertex the token leaves is out, the one it arrives
                        // at is in. Everything else is untouched, which is what
                        // makes this a slide rather than a reconfiguration.
                        ...occupancy.filter(nodeId => compareIds(nodeId, token.nodeId) !== 0),
                        targetNodeId,
                    ]));
                }
            }

            return successors;
        },
        isValid(occupancy: Occupancy): boolean {
            return probe.isConfigurationValid(tokensFor(occupancy), reading.parameter);
        },
        vertexCount: reading.nodeIds.length,
        tokenCount: occupancySize(reading),
    };
}

function occupancySize(reading: BoardReading): number {
    return reading.occupancy.length;
}

/**
 * A configuration's identity. JSON rather than a joined string so an id that
 * holds the separator cannot make two different configurations collide — `["1|2"]`
 * and `["1","2"]` have to be two dots, not one.
 *
 * Sorted first, because the configuration is a SET of occupied vertices: the same
 * tokens listed in another order are the same configuration, and an unsorted key
 * would spend a slot of the search's budget on every order it was seen in.
 */
export function makeOccupancyKey(occupancy: Occupancy, compareIds: (left: NodeId, right: NodeId) => number): ConfigurationKey {
    return JSON.stringify([...occupancy].sort(compareIds).map(id => (typeof id === "number" ? id : String(id))));
}

export function occupanciesCover(goals: NodeId[], occupancy: Occupancy, compareIds: (left: NodeId, right: NodeId) => number): boolean {
    return goals.every(goalNodeId => occupancy.some(nodeId => compareIds(nodeId, goalNodeId) === 0));
}

/** The one slide between two configurations, or null when they differ in any other way. */
export function moveBetweenOccupancies(before: Occupancy, after: Occupancy, compareIds: (left: NodeId, right: NodeId) => number): TokenMove | null {
    const left = [...before].sort(compareIds);
    const right = [...after].sort(compareIds);
    let from: NodeId | undefined;
    let to: NodeId | undefined;
    let leftIndex = 0;
    let rightIndex = 0;

    while (leftIndex < left.length || rightIndex < right.length) {
        if (leftIndex < left.length && rightIndex < right.length && compareIds(left[leftIndex], right[rightIndex]) === 0) {
            leftIndex += 1;
            rightIndex += 1;
            continue;
        }

        if (rightIndex >= right.length || (leftIndex < left.length && compareIds(left[leftIndex], right[rightIndex]) < 0)) {
            if (from !== undefined) return null;
            from = left[leftIndex++];
        } else {
            if (to !== undefined) return null;
            to = right[rightIndex++];
        }
    }

    return from !== undefined && to !== undefined ? { from, to } : null;
}
