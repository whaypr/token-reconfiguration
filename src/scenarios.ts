import d3is_reconfigure from "./scenarios/d3is_reconfigure.json";
import _2lp_reconfigure from "./scenarios/2lp_reconfigure.json";
import _2lp_blockAccess from "./scenarios/2lp_blockAccess.json";
import type { Scenario } from "./types";

// The two drawn scenarios live as JSON rather than as TypeScript literals: they
// are the very files the Selection panel's Save writes, so one can be exported
// from a running app, tweaked, and dropped back in here unchanged. The `version`
// each carries is that format's own field and is simply left behind here; every
// other field is checked against `Scenario` by the annotation below, which is why
// these are spread into a new object rather than cast — a cast would wave through
// a misspelt `nodeId` just as happily as a correct one, and a misread token is
// invisible: the graph opens, with fewer tokens than the file says.
const drawnScenarios: Scenario[] = [
    {
        ...d3is_reconfigure,
        id: "d3is_reconfigure",
        name: "Distance-3 Independent Set | Move tokens",
        description: "Goal: Move the yellow tokens to the vertices marked with a blue square.",
    },
    {
        ..._2lp_reconfigure,
        id: "2lp_reconfigure",
        name: "2-Limited Packing | Move tokens",
        description: "Goal: Move the yellow tokens to the vertices marked with a blue square.",
    },
    {
        ..._2lp_blockAccess,
        id: "2lp_blockAccess",
        name: "2-Limited Packing | Block access",
        description: "Goal: Prevent the yellow tokens from reaching the vertices marked with a blue square. You are not allowed to delete anything in the given graph.",
    },
];

export const scenarios: Scenario[] = [
    {
        id: "empty",
        name: "Empty plane",
        description: "Just an empty plane.",
        nodes: [],
        links: [],
        tokens: [],
    },
    ...drawnScenarios,
];
