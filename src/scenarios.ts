import d3is_puzzle from "./scenarios/d3is_puzzle.json";
import _2lp_puzzle from "./scenarios/2lp_puzzle.json";
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
        ...d3is_puzzle,
        id: "d3is_puzzle",
        name: "D3IS Puzzle",
        description: "",
    },
    {
        ..._2lp_puzzle,
        id: "2lp_puzzle",
        name: "2-limited Packing Puzzle",
        description: "",
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
