import type { Graph } from "./graph";
import type { GraphNode, NodeId, SerializedSubgraph } from "./types";
import { pasteSerializedSubgraph, serializeSelectedSubgraph } from "./subgraph";

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
    ) {}

    getSelectedNodeIds(): NodeId[] {
        return [...this.selectedNodeIds];
    }

    isNodeSelected(nodeId: NodeId): boolean {
        return this.selectedNodeIds.has(nodeId);
    }

    clearNodeSelection(statusMessage: string | null = null): void {
        this.selectedNodeIds = new Set<NodeId>();
        this.updateNodeClasses();

        if (statusMessage !== null) {
            this.setStatus(statusMessage);
        }
    }

    replaceSelectedNodeIds(nodeIds: Set<NodeId>): void {
        this.selectedNodeIds = new Set(nodeIds);
        this.updateNodeClasses();
        this.updateTokenClasses();
    }

    copySelection(): boolean {
        this.clipboardSelection = serializeSelectedSubgraph(this.graph, new Set(this.selectedNodeIds));

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

        const offset = 40 * (this.clipboardPasteCount + 1);
        const pastedNodeIds = pasteSerializedSubgraph(this.graph, this.clipboardSelection, offset, offset);
        this.applyPastedSelection(pastedNodeIds);
        this.setStatus(`${pastedNodeIds.size} vertices pasted.`);
        return pastedNodeIds;
    }

    saveSelection(): boolean {
        const selectionData = serializeSelectedSubgraph(this.graph, new Set(this.selectedNodeIds));
        if (!selectionData) {
            this.setStatus("Select at least one vertex before saving.");
            return false;
        }

        const blob = new Blob([JSON.stringify(selectionData, null, 2)], { type: "application/json" });
        const downloadUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = downloadUrl;
        anchor.download = "p-fairness-selection.json";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
        this.setStatus(`Saved ${selectionData.nodes.length} vertices.`);
        return true;
    }

    async importSelection(file: File): Promise<Set<NodeId> | null> {
        try {
            const text = await file.text();
            const data = JSON.parse(text) as SerializedSubgraph;

            if (!data || data.version !== 1 || !Array.isArray(data.nodes) || !Array.isArray(data.links) || !Array.isArray(data.tokens)) {
                this.setStatus("That file is not a valid p-Fairness selection export.");
                return null;
            }

            const pastedNodeIds = pasteSerializedSubgraph(this.graph, data, 40 * (this.clipboardPasteCount + 1), 40 * (this.clipboardPasteCount + 1));
            this.applyPastedSelection(pastedNodeIds);
            this.setStatus(`Imported ${data.nodes.length} vertices.`);
            return pastedNodeIds;
        } catch {
            this.setStatus("Could not read that selection file.");
            return null;
        }
    }

    private applyPastedSelection(pastedNodeIds: Set<NodeId>): void {
        this.selectedNodeIds = new Set(pastedNodeIds);
        this.clipboardPasteCount += 1;
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
}
