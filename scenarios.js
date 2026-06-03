const scenarios = [
    {
        id: "petersen",
        name: "Petersen",
        description: "The petersen graph example with three tokens and p = 2.",
        initialP: 2,
        nodes: Array.from({ length: 10 }, (_, i) => ({ id: i })),
        links: [
            { source: 0, target: 1 }, { source: 1, target: 2 }, { source: 2, target: 3 },
            { source: 3, target: 4 }, { source: 4, target: 0 }, { source: 0, target: 5 },
            { source: 1, target: 6 }, { source: 2, target: 7 }, { source: 3, target: 8 },
            { source: 4, target: 9 }, { source: 5, target: 7 }, { source: 7, target: 9 },
            { source: 9, target: 6 }, { source: 6, target: 8 }, { source: 8, target: 5 },
        ],
        tokens: [
            { id: 't1', nodeId: 0 },
            { id: 't2', nodeId: 3 },
            { id: 't3', nodeId: 6 },
        ],
    },
    {
        id: "ring",
        name: "Ring with chords",
        description: "A larger cycle with cross-links, useful for exploring mobile and frozen tokens.",
        initialP: 2,
        nodes: Array.from({ length: 12 }, (_, i) => ({ id: i })),
        links: [
            { source: 0, target: 1 }, { source: 1, target: 2 }, { source: 2, target: 3 },
            { source: 3, target: 4 }, { source: 4, target: 5 }, { source: 5, target: 6 },
            { source: 6, target: 7 }, { source: 7, target: 8 }, { source: 8, target: 9 },
            { source: 9, target: 10 }, { source: 10, target: 11 }, { source: 11, target: 0 },
            { source: 0, target: 6 }, { source: 2, target: 8 }, { source: 4, target: 10 },
            { source: 1, target: 7 }, { source: 3, target: 9 }, { source: 5, target: 11 },
        ],
        tokens: [
            { id: 't1', nodeId: 1 },
            { id: 't2', nodeId: 4 },
            { id: 't3', nodeId: 7 },
            { id: 't4', nodeId: 10 },
        ],
    },
    {
        id: "hub",
        name: "Hub and spokes",
        description: "A center-heavy graph that makes p = 1 vs p = 2 behavior easy to compare.",
        initialP: 1,
        nodes: Array.from({ length: 9 }, (_, i) => ({ id: i })),
        links: [
            { source: 0, target: 1 }, { source: 0, target: 2 }, { source: 0, target: 3 },
            { source: 0, target: 4 }, { source: 0, target: 5 }, { source: 0, target: 6 },
            { source: 0, target: 7 }, { source: 0, target: 8 },
            { source: 1, target: 2 }, { source: 2, target: 3 }, { source: 3, target: 4 },
        ],
        tokens: [
            { id: 't1', nodeId: 0 },
            { id: 't2', nodeId: 2 },
            { id: 't3', nodeId: 5 },
        ],
    },
];

window.pFairnessScenarios = scenarios;