import type { GraphNode, LayoutMode } from "./types";
import { Graph } from "./graph";

// One list for both ends of the control: the View panel builds its buttons from
// this, and applyGraphLayout below is the only other place a layout appears, so
// the two cannot drift apart.
export const LAYOUT_OPTIONS: Array<{ value: LayoutMode; label: string }> = [
    { value: "line", label: "Line" },
    { value: "zigzag", label: "Zig-zag" },
    { value: "grid", label: "Grid" },
    { value: "circle", label: "Circle" },
    { value: "binaryTree", label: "Binary tree" },
    { value: "ternaryTree", label: "Ternary tree" },
    { value: "spiral", label: "Spiral" },
];

interface LayoutContext {
    graph: Graph;
    width: number;
    height: number;
}

function setNodePosition(node: GraphNode, x: number, y: number, fixed: boolean): void {
    node.x = x;
    node.y = y;
    node.anchorX = x;
    node.anchorY = y;
    node.fx = fixed ? x : undefined;
    node.fy = fixed ? y : undefined;
}

function applyCircleLayout(context: LayoutContext): void {
    const orderedNodes = context.graph.getSortedNodes();

    if (orderedNodes.length === 0) {
        return;
    }

    const radius = Math.min(context.width, context.height) * 0.32;
    const centerX = context.width / 2;
    const centerY = context.height / 2;

    orderedNodes.forEach((node, index) => {
        const angle = (index / orderedNodes.length) * Math.PI * 2;
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius;
        setNodePosition(node, x, y, true);
    });
}

function applyGridLayout(context: LayoutContext): void {
    const orderedNodes = context.graph.getSortedNodes();

    if (orderedNodes.length === 0) {
        return;
    }

    const columns = Math.ceil(Math.sqrt(orderedNodes.length));
    const rows = Math.ceil(orderedNodes.length / columns);
    const xStep = context.width / (columns + 1);
    const yStep = context.height / (rows + 1);

    orderedNodes.forEach((node, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        const x = (column + 1) * xStep;
        const y = (row + 1) * yStep;
        setNodePosition(node, x, y, true);
    });
}

function applyLineLayout(context: LayoutContext): void {
    const orderedNodes = context.graph.getSortedNodes();

    if (orderedNodes.length === 0) {
        return;
    }

    const xStep = context.width / (orderedNodes.length + 1);
    const centerY = context.height / 2;

    orderedNodes.forEach((node, index) => {
        setNodePosition(node, (index + 1) * xStep, centerY, true);
    });
}

// The line above, with every other vertex lifted off it by the same distance,
// so the vertices alternate between two rows. Same x positions either way.
function applyZigzagLayout(context: LayoutContext): void {
    const orderedNodes = context.graph.getSortedNodes();

    if (orderedNodes.length === 0) {
        return;
    }

    const xStep = context.width / (orderedNodes.length + 1);
    const centerY = context.height / 2;

    orderedNodes.forEach((node, index) => {
        const y = centerY + (index % 2 === 0 ? -24 : 24);
        setNodePosition(node, (index + 1) * xStep, y, true);
    });
}

function applySpiralLayout(context: LayoutContext): void {
    const orderedNodes = context.graph.getSortedNodes();

    if (orderedNodes.length === 0) {
        return;
    }

    const centerX = context.width / 2;
    const centerY = context.height / 2;
    const angleStep = Math.PI * 0.75;
    const radiusStep = Math.min(context.width, context.height) * 0.035;

    orderedNodes.forEach((node, index) => {
        const angle = index * angleStep;
        const radius = 40 + index * radiusStep;
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius;
        setNodePosition(node, x, y, true);
    });
}

// The two k-ary layouts share one shape. Like every other layout here it is
// applied to the vertices in id order and reads no edges: a graph whose vertices
// have more than k neighbours could not be drawn as a k-ary tree at all, so the
// tree is the arrangement, not a claim about the connections. Vertices fill it
// the way a heap numbers them — vertex i at depth d, its children at k·i+1
// through k·i+k — which is how a complete k-ary tree is numbered, so a graph that
// is one lands on its own structure.
function applyKaryTreeLayout(context: LayoutContext, branching: number): void {
    const orderedNodes = context.graph.getSortedNodes();
    const nodeCount = orderedNodes.length;

    if (nodeCount === 0) {
        return;
    }

    const childrenOf = (index: number): number[] => {
        const children: number[] = [];

        for (let slot = 0; slot < branching; slot += 1) {
            const childIndex = branching * index + 1 + slot;

            if (childIndex < nodeCount) {
                children.push(childIndex);
            }
        }

        return children;
    };

    // Which depth each vertex sits at, walking the levels of a complete k-ary
    // tree until the vertices run out. The last level is usually partial.
    const levels: number[][] = [];

    for (let levelStart = 0, levelWidth = 1; levelStart < nodeCount; levelStart += levelWidth, levelWidth *= branching) {
        const count = Math.min(levelWidth, nodeCount - levelStart);
        levels.push(Array.from({ length: count }, (_unused, offset) => levelStart + offset));
    }

    // A leaf takes the next column, left to right, and every parent centres
    // itself over its own children. Columns are therefore not one per vertex:
    // a parent shares the middle of the span its children cover, which is what
    // makes the branches read as branches. Leaves are claimed in traversal
    // order rather than by id, because on a partial last level the leftmost
    // leaf can be the deepest vertex.
    const columnOf: number[] = [];
    let nextColumn = 0;

    const placeSubtree = (index: number): number => {
        const children = childrenOf(index);

        if (children.length === 0) {
            columnOf[index] = nextColumn;
            nextColumn += 1;
            return columnOf[index];
        }

        const childColumns = children.map(placeSubtree);
        columnOf[index] = (Math.min(...childColumns) + Math.max(...childColumns)) / 2;

        return columnOf[index];
    };

    placeSubtree(0);

    // Recursion depth is the tree's own depth, so it stays shallow however many
    // vertices there are; the loop above is the only thing that grows with them.
    const columnCount = Math.max(nextColumn, 1);
    const columnStep = context.width / (columnCount + 1);
    const levelStep = context.height / (levels.length + 1);

    levels.forEach((levelIndices, depth) => {
        const y = (depth + 1) * levelStep;

        levelIndices.forEach(index => {
            setNodePosition(orderedNodes[index], (columnOf[index] + 1) * columnStep, y, true);
        });
    });
}

export function applyGraphLayout(context: LayoutContext, layout: LayoutMode): void {
    if (layout === "circle") {
        applyCircleLayout(context);
    } else if (layout === "binaryTree") {
        applyKaryTreeLayout(context, 2);
    } else if (layout === "ternaryTree") {
        applyKaryTreeLayout(context, 3);
    } else if (layout === "grid") {
        applyGridLayout(context);
    } else if (layout === "line") {
        applyLineLayout(context);
    } else if (layout === "zigzag") {
        applyZigzagLayout(context);
    } else {
        applySpiralLayout(context);
    }
}