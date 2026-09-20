import * as d3 from "d3";
import type { D3DragEvent } from "d3-drag";
import type { Selection } from "d3-selection";
import type { SimulationNodeDatum } from "d3-force";
import type { ZoomTransform } from "d3-zoom";
import type { GraphNode, NodeId } from "./types";

type ForceNodeDatum = GraphNode & SimulationNodeDatum;

// d3-drag exposes a DragEvent whose underlying source event is the raw event
// it observed. On touch devices that is a TouchEvent (no direct clientX/Y),
// while the per-touch coordinates live on each Touch. d3.pointer expects an
// event (or Touch) that carries coordinates directly, so we resolve the
// active Touch before converting a position.
export function resolvePointerEvent(event: MouseEvent | TouchEvent): MouseEvent | Touch {
    if (!("changedTouches" in event) || event.changedTouches.length === 0) {
        return event as MouseEvent;
    }

    return event.changedTouches[0];
}

type SelectionBoxState = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
} | null;

type SelectionDragMode = "move" | "rotate";

type SelectionDragState = {
    mode: SelectionDragMode;
    selectedNodeIds: NodeId[];
    startPointer: { x: number; y: number };
    centerX: number;
    centerY: number;
    startPositions: Map<NodeId, { x: number; y: number }>;
} | null;

export interface SelectionGesturesContext {
    svg: Selection<SVGSVGElement, unknown, null, undefined>;
    selectionPreview: Selection<SVGRectElement, unknown, null, undefined>;
    getNodeById: (nodeId: NodeId) => ForceNodeDatum | null;
    getSelectedNodeIds: () => NodeId[];
    isRepulsionEnabled: () => boolean;
    positionGraphElements: () => void;
    selectNodesInRectangle: (x1: number, y1: number, x2: number, y2: number) => void;
    clearNodeSelection: () => void;
    recordUndoState: () => void;
    setStatus: (message: string) => void;
    currentTransform: () => ZoomTransform;
}

export class SelectionGestureManager {
    private selectionBoxState: SelectionBoxState = null;
    private selectionDragState: SelectionDragState = null;

    constructor(private readonly context: SelectionGesturesContext) {}

    isSelectionDragActive(): boolean {
        return this.selectionDragState !== null;
    }

    reflectSelectionAcrossYAxis(): boolean {
        return this.reflectSelection("y");
    }

    reflectSelectionAcrossXAxis(): boolean {
        return this.reflectSelection("x");
    }

    handleNodeDragStart(event: D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>, nodeData: ForceNodeDatum): void {
        this.context.recordUndoState();
        const selectedNodeIds = this.context.getSelectedNodeIds();

        if (selectedNodeIds.length > 1 && selectedNodeIds.includes(nodeData.id)) {
            const [pointerX, pointerY] = this.toGraphPoint(resolvePointerEvent(event.sourceEvent as MouseEvent | TouchEvent));
            this.beginSelectionDrag(event.sourceEvent.shiftKey ? "rotate" : "move", pointerX, pointerY);
            return;
        }

        nodeData.fx = nodeData.x;
        nodeData.fy = nodeData.y;
        this.context.setStatus(`Dragging node ${nodeData.id}.`);
    }

    handleNodeDragged(event: D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>, nodeData: ForceNodeDatum): void {
        if (this.selectionDragState) {
            const [pointerX, pointerY] = this.toGraphPoint(resolvePointerEvent(event.sourceEvent as MouseEvent | TouchEvent));
            this.updateSelectionDrag(pointerX, pointerY);
            return;
        }

        const [x, y] = this.toGraphPoint(resolvePointerEvent(event.sourceEvent as MouseEvent | TouchEvent));
        nodeData.fx = x;
        nodeData.fy = y;
        nodeData.anchorX = x;
        nodeData.anchorY = y;
        this.context.positionGraphElements();
    }

    handleNodeDragEnd(event: D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>, nodeData: ForceNodeDatum): void {
        if (this.selectionDragState) {
            this.finishSelectionDrag();
            return;
        }

        if (this.context.isRepulsionEnabled()) {
            nodeData.fx = undefined;
            nodeData.fy = undefined;
        } else {
            nodeData.anchorX = nodeData.x;
            nodeData.anchorY = nodeData.y;
            nodeData.fx = nodeData.x;
            nodeData.fy = nodeData.y;
        }

        this.context.setStatus(`Node ${nodeData.id} moved.`);
    }

    startSelectionBox(nodeX: number, nodeY: number): void {
        this.selectionBoxState = { x1: nodeX, y1: nodeY, x2: nodeX, y2: nodeY };
        this.renderSelectionBox();
        window.addEventListener("mousemove", this.handleWindowMouseMove);
        window.addEventListener("mouseup", this.handleWindowMouseUp);
    }

    stopSelectionBox(): void {
        if (!this.selectionBoxState) {
            return;
        }

        this.selectionBoxState = null;
        this.context.selectionPreview.style("display", "none");
        window.removeEventListener("mousemove", this.handleWindowMouseMove);
        window.removeEventListener("mouseup", this.handleWindowMouseUp);
    }

    destroy(): void {
        this.stopSelectionBox();
        this.selectionDragState = null;
    }

    private toGraphPoint(event: MouseEvent | Touch | D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>): [number, number] {
        const sourceEvent = "sourceEvent" in event ? (event as D3DragEvent<SVGCircleElement, unknown, ForceNodeDatum>).sourceEvent : event;
        const [x, y] = d3.pointer(resolvePointerEvent(sourceEvent as MouseEvent | TouchEvent), this.context.svg.node());
        return this.context.currentTransform().invert([x, y]);
    }

    private snapshotSelectedNodePositions(selectedNodeIds: NodeId[]): Map<NodeId, { x: number; y: number }> {
        const positions = new Map<NodeId, { x: number; y: number }>();

        selectedNodeIds.forEach(nodeId => {
            const nodeData = this.context.getNodeById(nodeId);
            if (nodeData) {
                positions.set(nodeId, { x: nodeData.x, y: nodeData.y });
            }
        });

        return positions;
    }

    private computeSelectionCenter(positions: Map<NodeId, { x: number; y: number }>): { x: number; y: number } | null {
        const values = [...positions.values()];

        if (values.length === 0) {
            return null;
        }

        const sum = values.reduce((accumulator, position) => ({
            x: accumulator.x + position.x,
            y: accumulator.y + position.y,
        }), { x: 0, y: 0 });

        return {
            x: sum.x / values.length,
            y: sum.y / values.length,
        };
    }

    private renderSelectionBox(): void {
        if (!this.selectionBoxState) {
            this.context.selectionPreview.style("display", "none");
            return;
        }

        const x = Math.min(this.selectionBoxState.x1, this.selectionBoxState.x2);
        const y = Math.min(this.selectionBoxState.y1, this.selectionBoxState.y2);
        const width = Math.abs(this.selectionBoxState.x2 - this.selectionBoxState.x1);
        const height = Math.abs(this.selectionBoxState.y2 - this.selectionBoxState.y1);

        this.context.selectionPreview
            .style("display", null)
            .attr("x", x)
            .attr("y", y)
            .attr("width", width)
            .attr("height", height);
    }

    private beginSelectionDrag(mode: SelectionDragMode, pointerX: number, pointerY: number): void {
        const selectedNodeIds = this.context.getSelectedNodeIds();
        const positions = this.snapshotSelectedNodePositions(selectedNodeIds);
        const center = this.computeSelectionCenter(positions);

        if (!center) {
            return;
        }

        this.selectionDragState = {
            mode,
            selectedNodeIds,
            startPointer: { x: pointerX, y: pointerY },
            centerX: center.x,
            centerY: center.y,
            startPositions: positions,
        };

        if (!this.context.isRepulsionEnabled()) {
            selectedNodeIds.forEach(nodeId => {
                const node = this.context.getNodeById(nodeId);
                if (node) {
                    node.fx = node.x;
                    node.fy = node.y;
                }
            });
        }

        this.context.setStatus(mode === "rotate" ? `Rotating ${selectedNodeIds.length} selected vertices.` : `Moving ${selectedNodeIds.length} selected vertices.`);
    }

    private updateSelectionDrag(pointerX: number, pointerY: number): void {
        if (!this.selectionDragState) {
            return;
        }

        const { mode, startPointer, centerX, centerY, selectedNodeIds, startPositions } = this.selectionDragState;

        if (mode === "move") {
            const dx = pointerX - startPointer.x;
            const dy = pointerY - startPointer.y;

            selectedNodeIds.forEach(nodeId => {
                const startPosition = startPositions.get(nodeId);
                const nodeData = this.context.getNodeById(nodeId);

                if (!startPosition || !nodeData) {
                    return;
                }

                const nextX = startPosition.x + dx;
                const nextY = startPosition.y + dy;
                nodeData.x = nextX;
                nodeData.y = nextY;
                nodeData.anchorX = nextX;
                nodeData.anchorY = nextY;
                nodeData.fx = nextX;
                nodeData.fy = nextY;
            });
        } else {
            const startAngle = Math.atan2(startPointer.y - centerY, startPointer.x - centerX);
            const currentAngle = Math.atan2(pointerY - centerY, pointerX - centerX);
            const rotation = currentAngle - startAngle;
            const cosine = Math.cos(rotation);
            const sine = Math.sin(rotation);

            selectedNodeIds.forEach(nodeId => {
                const startPosition = startPositions.get(nodeId);
                const nodeData = this.context.getNodeById(nodeId);

                if (!startPosition || !nodeData) {
                    return;
                }

                const relativeX = startPosition.x - centerX;
                const relativeY = startPosition.y - centerY;
                const nextX = centerX + relativeX * cosine - relativeY * sine;
                const nextY = centerY + relativeX * sine + relativeY * cosine;
                nodeData.x = nextX;
                nodeData.y = nextY;
                nodeData.anchorX = nextX;
                nodeData.anchorY = nextY;
                nodeData.fx = nextX;
                nodeData.fy = nextY;
            });
        }

        this.context.positionGraphElements();
    }

    private finishSelectionDrag(): void {
        if (!this.selectionDragState) {
            return;
        }

        if (this.context.isRepulsionEnabled()) {
            this.selectionDragState.selectedNodeIds.forEach(nodeId => {
                const nodeData = this.context.getNodeById(nodeId);
                if (nodeData) {
                    nodeData.fx = undefined;
                    nodeData.fy = undefined;
                }
            });
        }

        this.selectionDragState = null;
        this.context.positionGraphElements();
    }

    private reflectSelection(axis: "x" | "y"): boolean {
        const selectedNodeIds = this.context.getSelectedNodeIds();

        if (selectedNodeIds.length === 0) {
            this.context.setStatus("Select at least one vertex before reflecting.");
            return false;
        }

        const positions = this.snapshotSelectedNodePositions(selectedNodeIds);
        const center = this.computeSelectionCenter(positions);

        if (!center) {
            return false;
        }

        selectedNodeIds.forEach(nodeId => {
            const startPosition = positions.get(nodeId);
            const nodeData = this.context.getNodeById(nodeId);

            if (!startPosition || !nodeData) {
                return;
            }

            const nextX = axis === "y" ? (2 * center.x) - startPosition.x : startPosition.x;
            const nextY = axis === "x" ? (2 * center.y) - startPosition.y : startPosition.y;

            nodeData.x = nextX;
            nodeData.y = nextY;
            nodeData.anchorX = nextX;
            nodeData.anchorY = nextY;

            if (this.context.isRepulsionEnabled()) {
                nodeData.fx = undefined;
                nodeData.fy = undefined;
            } else {
                nodeData.fx = nextX;
                nodeData.fy = nextY;
            }
        });

        this.context.positionGraphElements();
        this.context.setStatus(
            axis === "y"
                ? `Reflected ${selectedNodeIds.length} selected vertices across the selection y-axis.`
                : `Reflected ${selectedNodeIds.length} selected vertices across the selection x-axis.`,
        );
        return true;
    }

    private handleWindowMouseMove = (event: MouseEvent): void => {
        const pointer = this.toGraphPoint(event);

        if (this.selectionBoxState) {
            this.selectionBoxState.x2 = pointer[0];
            this.selectionBoxState.y2 = pointer[1];
            this.renderSelectionBox();
        }

        if (this.selectionDragState) {
            this.updateSelectionDrag(pointer[0], pointer[1]);
        }
    };

    private handleWindowMouseUp = (event: MouseEvent): void => {
        if (this.selectionBoxState && event.button === 2) {
            event.preventDefault();
            const [x, y] = this.toGraphPoint(event);
            this.selectionBoxState.x2 = x;
            this.selectionBoxState.y2 = y;
            this.renderSelectionBox();
            this.context.selectNodesInRectangle(this.selectionBoxState.x1, this.selectionBoxState.y1, this.selectionBoxState.x2, this.selectionBoxState.y2);
            this.stopSelectionBox();
        }
    };
}
