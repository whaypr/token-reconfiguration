import * as d3 from "d3";
import type {
    D3DragEvent,
    Selection,
    Simulation,
    SimulationNodeDatum,
    ZoomTransform,
} from "d3";
import type { GraphNode, GraphToken, NodeId } from "./types";
import { resolvePointerEvent, SelectionGestureManager } from "./selection-gestures";

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
    edgePreview: Selection<SVGLineElement, unknown, null, undefined>;
    selectionPreview: Selection<SVGRectElement, unknown, null, undefined>;
    simulation: Simulation<ForceNodeDatum, undefined>;
    getNodeById: (nodeId: NodeId) => ForceNodeDatum | null;
    getSelectedNodeIds: () => NodeId[];
    isNodeSelected: (nodeId: NodeId) => boolean;
    selectNodesInRectangle: (x1: number, y1: number, x2: number, y2: number) => void;
    clearNodeSelection: () => void;
    recordUndoState: () => void;
    beginUndoGroup: () => void;
    endUndoGroup: () => void;
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
    setOverlayRefreshPaused: (paused: boolean) => void;
}

export interface GraphInteractionController {
    nodeDrag: d3.DragBehavior<SVGCircleElement, ForceNodeDatum, ForceNodeDatum>;
    tokenDrag: d3.DragBehavior<SVGCircleElement, GraphToken, ForceNodeDatum>;
    reflectSelectionAcrossYAxis(): boolean;
    reflectSelectionAcrossXAxis(): boolean;
    handleNodeMouseDown(event: MouseEvent, nodeData: GraphNode): void;
    handleBackgroundMouseDown(event: MouseEvent): void;
    stopEdgeDrag(): void;
    destroy(): void;
}

function toGraphPoint(
    svg: Selection<SVGSVGElement, unknown, null, undefined>,
    currentTransform: () => ZoomTransform,
    event: MouseEvent | D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>,
): [number, number] {
    const sourceEvent = "sourceEvent" in event ? (event as D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>).sourceEvent : event;
    const [x, y] = d3.pointer(resolvePointerEvent(sourceEvent as MouseEvent | TouchEvent), svg.node());
    return currentTransform().invert([x, y]);
}

export function createGraphInteractions(context: GraphInteractionContext): GraphInteractionController {
    let edgeDragState: EdgeDragState = null;
    const selectionGestures = new SelectionGestureManager({
        svg: context.svg,
        selectionPreview: context.selectionPreview,
        getNodeById: context.getNodeById,
        getSelectedNodeIds: context.getSelectedNodeIds,
        isRepulsionEnabled: context.isRepulsionEnabled,
        positionGraphElements: context.positionGraphElements,
        selectNodesInRectangle: context.selectNodesInRectangle,
        clearNodeSelection: context.clearNodeSelection,
        recordUndoState: context.recordUndoState,
        setStatus: context.setStatus,
        currentTransform: context.currentTransform,
    });

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
        context.edgePreview.attr("x2", x).attr("y2", y);
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
                context.setStatus(`Edge between nodes ${sourceNodeId} and ${targetNode.id} would violate the current problem constraints, so it was blocked.`);
            }
            stopEdgeDrag();
            return;
        }

        // Dropped on empty space -> new connected vertex.
        const newNodeData = context.addNodeAtPoint(x, y);
        context.beginUndoGroup();
        try {
            if (context.addEdge(sourceNodeId, newNodeData.id)) {
                context.refreshGraphAfterMutation(`Node ${newNodeData.id} added and connected to node ${sourceNodeId}.`);
            } else {
                context.removeNode(newNodeData.id);
                context.setStatus("The new edge would violate the current problem constraints, so the new vertex was not added.");
            }
        } finally {
            context.endUndoGroup();
        }

        stopEdgeDrag();
    }

    function handleNodeDragStart(event: D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>, _datum: unknown): void {
        const nodeData = event.subject;

        if (!event.active) {
            context.simulation.alphaTarget(0.25).restart();
        }

        if (context.getSelectedNodeIds().length > 1 && context.isNodeSelected(nodeData.id)) {
            selectionGestures.handleNodeDragStart(event, nodeData);
            return;
        }

        selectionGestures.handleNodeDragStart(event, nodeData);
    }

    function handleNodeDragged(event: D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>, _datum: unknown): void {
        const nodeData = event.subject;

        if (Math.abs(event.dx) > 0 || Math.abs(event.dy) > 0) {
            context.setOverlayRefreshPaused(true);
        }

        if (selectionGestures.isSelectionDragActive()) {
            selectionGestures.handleNodeDragged(event, nodeData);
            return;
        }

        selectionGestures.handleNodeDragged(event, nodeData);
    }

    function handleNodeDragEnd(event: D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>, _datum: unknown): void {
        const nodeData = event.subject;

        if (!event.active) {
            context.simulation.alphaTarget(0);
        }

        selectionGestures.handleNodeDragEnd(event, nodeData);
        context.setOverlayRefreshPaused(false);
    }

    function createDragBehavior<TDatum>(subjectAccessor: (event: D3DragEvent<SVGCircleElement, TDatum, ForceNodeDatum>, datum: TDatum) => ForceNodeDatum): d3.DragBehavior<SVGCircleElement, TDatum, ForceNodeDatum> {
        return d3.drag<SVGCircleElement, TDatum, ForceNodeDatum>()
            // Alt is refused alongside Ctrl for the same reason: a press holding
            // either is not a drag. d3-drag runs its own listeners in the capture
            // phase and swallows the click that follows, so letting Alt through
            // here would eat the Alt+click that marks a vertex — and record an
            // undo step for a vertex that never moved.
            .filter((event: MouseEvent) => event.button === 0 && !event.ctrlKey && !event.altKey)
            .subject(subjectAccessor)
            .on("start", handleNodeDragStart)
            .on("drag", handleNodeDragged)
            .on("end", handleNodeDragEnd);
    }

    const nodeDrag = createDragBehavior<ForceNodeDatum>((_event, nodeData) => nodeData);
    const tokenDrag = createDragBehavior<GraphToken>((_event, tokenData) => {
        const node = context.getNodeById(tokenData.nodeId);
        if (!node) {
            throw new Error(`Token ${tokenData.id} points to a missing node.`);
        }

        return node;
    });

    // Touch never drives these behaviours (touch gestures live entirely in
    // touch-gestures.ts), so d3-drag must not install its per-circle touchstart
    // listeners at all. Note d3 evaluates .touchable() when the behaviour is
    // APPLIED to the circles, which happens after this factory runs, so the
    // per-event filter alone is not enough.
    nodeDrag.touchable(() => false);
    tokenDrag.touchable(() => false);

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
            if (event.ctrlKey) {
                event.preventDefault();
                event.stopPropagation();
                selectionGestures.reflectSelectionAcrossXAxis();
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            startEdgeDrag(nodeData as ForceNodeDatum);
        }
    }

    function handleBackgroundMouseDown(event: MouseEvent): void {
        if (event.button === 1) {
            event.preventDefault();
            event.stopPropagation();
            const [x, y] = toGraphPoint(context.svg, context.currentTransform, event);
            const nodeData = context.addNodeAtPoint(x, y);
            context.refreshGraphAfterMutation(`Node ${nodeData.id} added.`);
            return;
        }

        if (event.button === 2) {
            event.preventDefault();
            event.stopPropagation();
            const [x, y] = toGraphPoint(context.svg, context.currentTransform, event);
            selectionGestures.startSelectionBox(x, y);
        }
    }

    function destroy(): void {
        stopEdgeDrag();
        selectionGestures.destroy();
    }

    return {
        nodeDrag,
        tokenDrag,
        reflectSelectionAcrossYAxis: () => selectionGestures.reflectSelectionAcrossYAxis(),
        reflectSelectionAcrossXAxis: () => selectionGestures.reflectSelectionAcrossXAxis(),
        handleNodeMouseDown,
        handleBackgroundMouseDown,
        stopEdgeDrag,
        destroy,
    };
}