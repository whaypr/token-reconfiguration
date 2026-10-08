import { distanceDRules } from "./distance-d-rules";
import { pFairnessRules } from "./p-fairness-rules";
import type { ProblemDefinition } from "./types";

export const problems: ProblemDefinition[] = [
    {
        id: "k-limited-packing",
        name: "k-Limited Packing",
        parameterLabel: "k",
        parameterDescription: "Maximum tokens in every closed neighborhood",
        defaultParameter: 2,
        minParameter: 0,
        maxParameter: 10,
        parameterStep: 1,
        rules: pFairnessRules,
    },
    {
        id: "distance-d-independent-set",
        name: "Distance-d Independent Set",
        parameterLabel: "d",
        parameterDescription: "Minimum shortest-path distance between every two tokens",
        defaultParameter: 2,
        minParameter: 1,
        maxParameter: 10,
        parameterStep: 1,
        rules: distanceDRules,
    },
];