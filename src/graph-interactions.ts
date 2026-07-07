import * as d3 from "d3";
import type { D3DragEvent } from "d3-drag";
import type { SubjectPosition } from "d3-drag";
import type { Selection } from "d3-selection";
import type { Simulation, SimulationNodeDatum } from "d3-force";
import type { ZoomTransform } from "d3-zoom";
import type { GraphNode, GraphToken, NodeId } from "./types";

type ForceNodeDatum = GraphNode & SimulationNodeDatum;

type EdgeDragState = {
    source: ForceNodeDatum;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
} | null;

interface GraphInteractionContext {
    svg: Selection<SVGSVGElement, unknown, null, undefined>;
    backgroundNode: SVGRectElement;
    edgePreview: Selection<SVGLineElement, unknown, null, undefined>;
    simulation: Simulation<ForceNodeDatum, undefined>;
    getNodeById: (nodeId: NodeId) => ForceNodeDatum | null;
    positionGraphElements: () => void;
    setStatus: (message: string) => void;
    refreshGraphAfterMutation: (message?: string) => void;
    addNodeAtPoint: (x: number, y: number) => GraphNode;
    addEdge: (sourceNodeId: NodeId, targetNodeId: NodeId) => boolean;
    removeEdge: (sourceNodeId: NodeId, targetNodeId: NodeId) => boolean;
    removeNode: (nodeId: NodeId) => boolean;
    getNodeAtPoint: (x: number, y: number, ignoredNodeId?: NodeId | null) => GraphNode | null;
    currentTransform: () => ZoomTransform;
    isRepulsionEnabled: () => boolean;
}

export interface GraphInteractionController {
    nodeDrag: d3.DragBehavior<SVGCircleElement, ForceNodeDatum, ForceNodeDatum | SubjectPosition>;
    tokenDrag: d3.DragBehavior<SVGCircleElement, GraphToken, ForceNodeDatum>;
    handleNodeMouseDown(event: MouseEvent, nodeData: GraphNode): void;
    handleBackgroundMouseDown(event: MouseEvent): void;
    stopEdgeDrag(): void;
    handleWindowMouseMove(event: MouseEvent): void;
    handleWindowMouseUp(event: MouseEvent): void;
    destroy(): void;
}

function toGraphPoint(
    svg: Selection<SVGSVGElement, unknown, null, undefined>,
    currentTransform: () => ZoomTransform,
    event: MouseEvent | PointerEvent | D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>,
): [number, number] {
    const [x, y] = d3.pointer(event, svg.node());
    return currentTransform().invert([x, y]);
}

export function createGraphInteractions(context: GraphInteractionContext): GraphInteractionController {
    let edgeDragState: EdgeDragState = null;

    function startEdgeDrag(nodeData: ForceNodeDatum): void {
        const [x, y] = [nodeData.x, nodeData.y];
        edgeDragState = {
            source: nodeData,
            x1: x,
            y1: y,
            x2: x,
            y2: y,
        };

        context.edgePreview
            .style("display", null)
            .attr("x1", x)
            .attr("y1", y)
            .attr("x2", x)
            .attr("y2", y);

        window.addEventListener("mousemove", handleWindowMouseMove);
        window.addEventListener("mouseup", handleWindowMouseUp);
    }

    function stopEdgeDrag(): void {
        if (!edgeDragState) {
            return;
        }

        edgeDragState = null;
        context.edgePreview.style("display", "none");
        window.removeEventListener("mousemove", handleWindowMouseMove);
        window.removeEventListener("mouseup", handleWindowMouseUp);
    }

    function handleWindowMouseMove(event: MouseEvent): void {
        if (!edgeDragState) {
            return;
        }

        const [x, y] = toGraphPoint(context.svg, context.currentTransform, event);
        edgeDragState.x2 = x;
        edgeDragState.y2 = y;
        context.edgePreview
            .attr("x2", x)
            .attr("y2", y);
    }

    function handleWindowMouseUp(event: MouseEvent): void {
        if (!edgeDragState || event.button !== 2) {
            return;
        }

        event.preventDefault();
        const [x, y] = toGraphPoint(context.svg, context.currentTransform, event);
        const sourceNodeId = edgeDragState.source.id;
        const targetNode = context.getNodeAtPoint(x, y, sourceNodeId);

        if (targetNode) {
            if (context.removeEdge(sourceNodeId, targetNode.id)) {
                context.refreshGraphAfterMutation(`Edge between nodes ${sourceNodeId} and ${targetNode.id} removed.`);
            } else if (context.addEdge(sourceNodeId, targetNode.id)) {
                context.refreshGraphAfterMutation(`Edge added between nodes ${sourceNodeId} and ${targetNode.id}.`);
            } else {
                context.setStatus(`Edge between nodes ${sourceNodeId} and ${targetNode.id} would violate p-fairness, so it was blocked.`);
            }
            stopEdgeDrag();
            return;
        }

        const newNodeData = context.addNodeAtPoint(x, y);
        if (context.addEdge(sourceNodeId, newNodeData.id)) {
            context.refreshGraphAfterMutation(`Node ${newNodeData.id} added and connected to node ${sourceNodeId}.`);
        }

        stopEdgeDrag();
    }

    function handleNodeDragStart(event: D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>): void {
        if (!event.active) {
            context.simulation.alphaTarget(0.25).restart();
        }

        const nodeData = event.subject;
        nodeData.fx = nodeData.x;
        nodeData.fy = nodeData.y;
        context.setStatus(`Dragging node ${nodeData.id}.`);
    }

    function handleNodeDragged(event: D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>): void {
        const nodeData = event.subject;
        const [x, y] = toGraphPoint(context.svg, context.currentTransform, event.sourceEvent as MouseEvent | PointerEvent);
        nodeData.fx = x;
        nodeData.fy = y;
        nodeData.anchorX = x;
        nodeData.anchorY = y;
        context.positionGraphElements();
    }

    function handleNodeDragEnd(event: D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>): void {
        if (!event.active) {
            context.simulation.alphaTarget(0);
        }

        const nodeData = event.subject;
        if (context.isRepulsionEnabled()) {
            nodeData.fx = undefined;
            nodeData.fy = undefined;
        } else {
            nodeData.anchorX = nodeData.x;
            nodeData.anchorY = nodeData.y;
            nodeData.fx = nodeData.x;
            nodeData.fy = nodeData.y;
        }
        context.setStatus(`Node ${nodeData.id} moved.`);
    }

    function createVertexDrag<TDatum>(subjectAccessor: (event: D3DragEvent<SVGCircleElement, TDatum, ForceNodeDatum>, d: TDatum) => ForceNodeDatum): d3.DragBehavior<SVGCircleElement, TDatum, ForceNodeDatum> {
        return d3.drag<SVGCircleElement, TDatum, ForceNodeDatum>()
            .filter((event: MouseEvent) => event.button === 0)
            .subject(subjectAccessor)
            .on("start", handleNodeDragStart)
            .on("drag", handleNodeDragged)
            .on("end", handleNodeDragEnd);
    }

    const nodeDrag = createVertexDrag<ForceNodeDatum>((_event, nodeData) => nodeData);
    const tokenDrag = createVertexDrag<GraphToken>((_event, tokenData) => context.getNodeById(tokenData.nodeId) as ForceNodeDatum);

    function handleNodeMouseDown(event: MouseEvent, nodeData: GraphNode): void {
        if (event.button === 1) {
            event.preventDefault();
            event.stopPropagation();
            if (context.removeNode(nodeData.id)) {
                context.refreshGraphAfterMutation(`Node ${nodeData.id} removed.`);
            }
            return;
        }

        if (event.button === 2) {
            event.preventDefault();
            event.stopPropagation();
            startEdgeDrag(nodeData as ForceNodeDatum);
        }
    }

    function handleBackgroundMouseDown(event: MouseEvent): void {
        if (event.button !== 1 || event.target !== context.backgroundNode) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        const [x, y] = toGraphPoint(context.svg, context.currentTransform, event);
        const nodeData = context.addNodeAtPoint(x, y);
        context.refreshGraphAfterMutation(`Node ${nodeData.id} added.`);
    }

    function destroy(): void {
        stopEdgeDrag();
    }

    return {
        nodeDrag,
        tokenDrag,
        handleNodeMouseDown,
        handleBackgroundMouseDown,
        stopEdgeDrag,
        handleWindowMouseMove,
        handleWindowMouseUp,
        destroy,
    };
}