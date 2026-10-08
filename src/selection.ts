import type { Graph } from "./graph";
import type { GraphNode, NodeId, ProblemDefinition, SerializedProblemContext, SerializedSubgraph } from "./types";
import { pasteSerializedSubgraph, readProblemContext, serializeSelectedSubgraph } from "./subgraph";

// A file's graph plus the problem it was drawn under, which is optional because
// files written before that field existed simply have none.
export interface ImportedSelection {
    nodeIds: Set<NodeId>;
    problem?: SerializedProblemContext;
}

export interface SelectionStateSnapshot {
    selectedNodeIds: NodeId[];
    clipboardSelection: SerializedSubgraph | null;
    clipboardPasteCount: number;
}

export class SelectionManager {
    private selectedNodeIds = new Set<NodeId>();
    private clipboardSelection: SerializedSubgraph | null = null;
    private clipboardPasteCount = 0;

    constructor(
        private graph: Graph,
        private getNodes: () => GraphNode[],
        private setStatus: (message: string) => void,
        private updateNodeClasses: () => void,
        private updateTokenClasses: () => void,
        private recordUndoState: () => void,
        // Read when a selection is written out, not captured at construction:
        // the problem can change underneath a graph that outlives the change.
        private getProblem: () => ProblemDefinition,
    ) {}

    createSnapshot(): SelectionStateSnapshot {
        return {
            selectedNodeIds: [...this.selectedNodeIds],
            clipboardSelection: this.cloneSelection(this.clipboardSelection),
            clipboardPasteCount: this.clipboardPasteCount,
        };
    }

    restoreSnapshot(snapshot: SelectionStateSnapshot): void {
        this.selectedNodeIds = new Set(snapshot.selectedNodeIds);
        this.clipboardSelection = this.cloneSelection(snapshot.clipboardSelection);
        this.clipboardPasteCount = snapshot.clipboardPasteCount;
        this.updateNodeClasses();
        this.updateTokenClasses();
    }

    getSelectedNodeIds(): NodeId[] {
        return [...this.selectedNodeIds];
    }

    isNodeSelected(nodeId: NodeId): boolean {
        return this.selectedNodeIds.has(nodeId);
    }

    replaceSelectedNodeIds(nodeIds: Set<NodeId>): void {
        this.selectedNodeIds = new Set(nodeIds);
        this.updateNodeClasses();
        this.updateTokenClasses();
    }

    selectNodesInRectangle(x1: number, y1: number, x2: number, y2: number): void {
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);

        this.selectedNodeIds = new Set(
            this.getNodes()
                .filter((nodeData: GraphNode) => nodeData.x >= minX && nodeData.x <= maxX && nodeData.y >= minY && nodeData.y <= maxY)
                .map((nodeData: GraphNode) => nodeData.id),
        );

        if (this.selectedNodeIds.size === 0) {
            this.setStatus("No vertices were inside the selection.");
        } else {
            this.setStatus(`${this.selectedNodeIds.size} vertices selected.`);
        }

        this.updateNodeClasses();
        this.updateTokenClasses();
    }

    clearNodeSelection(statusMessage: string | null = null): void {
        this.selectedNodeIds = new Set<NodeId>();
        this.updateNodeClasses();

        if (statusMessage !== null) {
            this.setStatus(statusMessage);
        }
    }

    copySelection(): boolean {
        this.clipboardSelection = serializeSelectedSubgraph(this.graph, new Set(this.selectedNodeIds), this.getProblem());

        if (!this.clipboardSelection) {
            this.setStatus("Select at least one vertex before copying.");
            return false;
        }

        this.clipboardPasteCount = 0;
        this.setStatus(`${this.clipboardSelection.nodes.length} vertices copied.`);
        return true;
    }

    pasteSelection(): Set<NodeId> | null {
        if (!this.clipboardSelection) {
            this.setStatus("Nothing has been copied yet.");
            return null;
        }

        this.recordUndoState();
        const offset = 40 * (this.clipboardPasteCount + 1);
        const pastedNodeIds = pasteSerializedSubgraph(this.graph, this.clipboardSelection, offset, offset);
        this.applyPastedSelection(pastedNodeIds);
        this.setStatus(`${pastedNodeIds.size} vertices pasted.`);
        return pastedNodeIds;
    }

    saveSelection(): boolean {
        const selectionData = serializeSelectedSubgraph(this.graph, new Set(this.selectedNodeIds), this.getProblem());
        if (!selectionData) {
            this.setStatus("Select at least one vertex before saving.");
            return false;
        }

        const blob = new Blob([JSON.stringify(selectionData, null, 2)], { type: "application/json" });
        const downloadUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = downloadUrl;
        anchor.download = "k-limited-packing-selection.json";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
        this.setStatus(`Saved ${selectionData.nodes.length} vertices.`);
        return true;
    }

    async importSelection(file: File, targetCenter: { x: number; y: number } | null = null): Promise<ImportedSelection | null> {
        try {
            const text = await file.text();
            const data = JSON.parse(text) as SerializedSubgraph;

            if (!data || data.version !== 1 || !Array.isArray(data.nodes) || !Array.isArray(data.links) || !Array.isArray(data.tokens)) {
                this.setStatus("That file is not a valid k-Limited Packing selection export.");
                return null;
            }

            let offsetX = 40 * (this.clipboardPasteCount + 1);
            let offsetY = 40 * (this.clipboardPasteCount + 1);

            if (targetCenter !== null && data.nodes.length > 0) {
                const xs = data.nodes.map(node => node.x);
                const ys = data.nodes.map(node => node.y);
                const minX = Math.min(...xs);
                const maxX = Math.max(...xs);
                const minY = Math.min(...ys);
                const maxY = Math.max(...ys);
                const centerX = (minX + maxX) / 2;
                const centerY = (minY + maxY) / 2;

                offsetX = targetCenter.x - centerX;
                offsetY = targetCenter.y - centerY;
            }

            const pastedNodeIds = pasteSerializedSubgraph(this.graph, data, offsetX, offsetY);
            this.applyPastedSelection(pastedNodeIds);
            this.setStatus(`Imported ${data.nodes.length} vertices.`);
            return { nodeIds: pastedNodeIds, problem: readProblemContext(data) };
        } catch {
            this.setStatus("Could not read that selection file.");
            return null;
        }
    }

    deleteSelection(): boolean {
        if (this.selectedNodeIds.size === 0) {
            this.setStatus("Select at least one vertex before deleting.");
            return false;
        }

        this.recordUndoState();
        const deletedCount = this.selectedNodeIds.size;

        for (const nodeId of this.selectedNodeIds) {
            this.graph.removeNode(nodeId);
        }

        this.clearNodeSelection(`Deleted ${deletedCount} vertices.`);
        return true;
    }

    private applyPastedSelection(pastedNodeIds: Set<NodeId>): void {
        this.selectedNodeIds = new Set(pastedNodeIds);
        this.clipboardPasteCount += 1;
        this.updateNodeClasses();
        this.updateTokenClasses();
    }

    private cloneSelection(selectionData: SerializedSubgraph | null): SerializedSubgraph | null {
        if (!selectionData) {
            return null;
        }

        return {
            version: selectionData.version,
            nodes: selectionData.nodes.map(node => ({ ...node })),
            links: selectionData.links.map(link => ({ ...link })),
            tokens: selectionData.tokens.map(token => ({ ...token })),
            // Carried through so an undo step does not quietly drop the problem
            // a copied selection came from.
            ...(selectionData.problem ? { problem: { ...selectionData.problem } } : {}),
        };
    }
}
