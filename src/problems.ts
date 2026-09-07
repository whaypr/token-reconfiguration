import { distanceDRules } from "./distance-d-rules";
import { pFairnessRules } from "./p-fairness-rules";
import type { ProblemDefinition } from "./types";

export const problems: ProblemDefinition[] = [
    {
        id: "p-fairness",
        name: "p-Fairness",
        parameterLabel: "p",
        parameterDescription: "Maximum tokens in every closed neighborhood",
        defaultParameter: 2,
        minParameter: 0,
        maxParameter: 10,
        parameterStep: 1,
        rules: pFairnessRules,
    },
    {
        id: "distance-d-independent-set",
        name: "Distance-d independent set",
        parameterLabel: "d",
        parameterDescription: "Minimum shortest-path distance between every two tokens",
        defaultParameter: 2,
        minParameter: 1,
        maxParameter: 10,
        parameterStep: 1,
        rules: distanceDRules,
    },
];