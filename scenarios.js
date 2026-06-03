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
    {
        id: 'grid4',
        name: '4x4 Grid',
        description: 'A 4x4 grid; useful to observe local neighborhood packing.',
        initialP: 2,
        nodes: Array.from({ length: 16 }, (_, i) => ({ id: i })),
        links: (() => {
            const L = [];
            const cols = 4;
            for (let r = 0; r < 4; r++) {
                for (let c = 0; c < cols; c++) {
                    const id = r * cols + c;
                    if (c < cols - 1) L.push({ source: id, target: id + 1 });
                    if (r < 3) L.push({ source: id, target: id + cols });
                }
            }
            return L;
        })(),
        tokens: [{ id: 't1', nodeId: 0 }, { id: 't2', nodeId: 5 }, { id: 't3', nodeId: 10 }],
    },
    {
        id: 'two_cliques',
        name: 'Two Cliques',
        description: 'Two 5-node cliques connected by a bridge edge; shows highly connected regions.',
        initialP: 3,
        nodes: Array.from({ length: 10 }, (_, i) => ({ id: i })),
        links: (() => {
            const L = [];
            for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) L.push({ source: a, target: b });
            for (let a = 5; a < 10; a++) for (let b = a + 1; b < 10; b++) L.push({ source: a, target: b });
            L.push({ source: 4, target: 5 });
            return L;
        })(),
        tokens: [{ id: 't1', nodeId: 0 }, { id: 't2', nodeId: 2 }, { id: 't3', nodeId: 7 }, { id: 't4', nodeId: 9 }],
    },
    {
        id: 'binary_tree',
        name: 'Balanced Tree',
        description: 'A small binary tree (depth 3) to illustrate hierarchical neighborhoods.',
        initialP: 2,
        nodes: Array.from({ length: 15 }, (_, i) => ({ id: i })),
        links: (() => {
            const L = [];
            for (let i = 0; i < 7; i++) {
                L.push({ source: i, target: 2 * i + 1 });
                L.push({ source: i, target: 2 * i + 2 });
            }
            return L;
        })(),
        tokens: [{ id: 't1', nodeId: 0 }, { id: 't2', nodeId: 3 }, { id: 't3', nodeId: 6 }],
    },
    {
        id: 'sparse_random',
        name: 'Sparse Random',
        description: 'A small random sparse graph to explore varied local degrees.',
        initialP: 1,
        nodes: Array.from({ length: 14 }, (_, i) => ({ id: i })),
        links: (() => {
            const L = [];
            const edges = [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [5, 6], [4, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13]];
            edges.forEach(e => L.push({ source: e[0], target: e[1] }));
            // add a couple extra chords
            L.push({ source: 2, target: 6 });
            L.push({ source: 4, target: 9 });
            return L;
        })(),
        tokens: [{ id: 't1', nodeId: 1 }, { id: 't2', nodeId: 6 }, { id: 't3', nodeId: 11 }],
    }
];

window.pFairnessScenarios = scenarios;