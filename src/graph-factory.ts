import { Graph } from "./graph";
import type { GraphNode, NodeId, ProblemRules, ScenarioNodeInput } from "./types";

function normalizeNodeInput(node: NodeId | ScenarioNodeInput): ScenarioNodeInput {
    return typeof node === "object" && node !== null ? node : { id: node };
}

export function createGraphNode(
    node: NodeId | ScenarioNodeInput,
    index: number,
    totalNodes: number,
    width: number,
    height: number,
): GraphNode {
    const normalized = normalizeNodeInput(node);
    const hasPosition = Number.isFinite(normalized.x) && Number.isFinite(normalized.y);
    const fallbackRadius = Math.min(width, height) * 0.32;
    const angle = totalNodes > 0 ? (index / totalNodes) * Math.PI * 2 : 0;
    const x = hasPosition ? normalized.x! : width / 2 + Math.cos(angle) * fallbackRadius;
    const y = hasPosition ? normalized.y! : height / 2 + Math.sin(angle) * fallbackRadius;

    return {
        id: normalized.id,
        x,
        y,
        vx: 0,
        vy: 0,
        fx: x,
        fy: y,
        anchorX: x,
        anchorY: y,
        // Written only when set, so a vertex that was never marked stays exactly
        // the object it was before the mark existed. This is the one place a
        // scenario's marks are picked up: the node is assembled field by field
        // here rather than copied from the input.
        ...(normalized.highlighted ? { highlighted: true } : {}),
    };
}

function getNextNodeId(nodes: Array<NodeId | ScenarioNodeInput>): number {
    return nodes.reduce<number>((maxId, node) => {
        const normalizedNode = typeof node === "object" ? node : { id: node };
        const numericId = typeof normalizedNode.id === "number" ? normalizedNode.id : Number(normalizedNode.id);
        return Number.isFinite(numericId) ? Math.max(maxId, numericId) : maxId;
    }, -1) + 1;
}

export function createGraph(
    nodes: Array<NodeId | ScenarioNodeInput>,
    links: Array<{ source: NodeId; target: NodeId }>,
    tokens: Array<{ id: string; nodeId: NodeId }>,
    initialParameter: number,
    rules: ProblemRules,
    width: number,
    height: number,
): Graph {
    return new Graph({
        nodes: nodes.map((node, index) => createGraphNode(node, index, nodes.length, width, height)),
        links: links.map(link => ({ ...link })),
        tokens: tokens.map(token => ({ ...token })),
        parameter: initialParameter,
        rules,
        nextNodeId: getNextNodeId(nodes),
    });
}