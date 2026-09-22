import * as d3 from "d3";
import type { ZoomTransform } from "d3-zoom";
import type { GraphNode } from "./types";

// How far the canvas may be pulled in and out. One place for both ends, so a
// framing computed to fit can never ask for a scale the zoom gesture would
// refuse and then land somewhere else than it promised. The low end is far
// below any framing these drawings need — the widest of them still fits a phone
// at about a quarter size.
export const ZOOM_SCALE_RANGE: [number, number] = [0.15, 3];

const VIEW_MARGIN = 0.06;

// The transform that brings a drawing into the middle of the window at the
// largest scale that still shows all of it.
//
// The drawing is NOT moved to do this. Positions are what a saved file carries
// and what the vertex handles report, so moving them would quietly rewrite the
// graph the user is looking at; the viewport transform is already the thing
// that says where graph units land on screen, and one pan or wheel turn is all
// it takes the user to undo this.
export function fitGraphToCanvas(
    nodes: Array<Pick<GraphNode, "x" | "y">>,
    width: number,
    height: number,
): ZoomTransform {
    if (nodes.length === 0 || width <= 0 || height <= 0) {
        return d3.zoomIdentity;
    }

    const xs = nodes.map(node => node.x);
    const ys = nodes.map(node => node.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const boundsWidth = maxX - minX;
    const boundsHeight = maxY - minY;
    const [minScale, maxScale] = ZOOM_SCALE_RANGE;
    // A drawing spanning one point in a direction (a lone vertex, a vertical
    // row) has no extent to squeeze there, and dividing by it would give the
    // upper limit of the zoom range for no reason. It is placed at its natural
    // size, and the other direction still decides.
    const availableWidth = width * (1 - VIEW_MARGIN * 2);
    const availableHeight = height * (1 - VIEW_MARGIN * 2);
    const scaleX = boundsWidth > 0 ? availableWidth / boundsWidth : 1;
    const scaleY = boundsHeight > 0 ? availableHeight / boundsHeight : 1;
    const scale = Math.min(maxScale, Math.max(minScale, Math.min(scaleX, scaleY)));
    const centerX = minX + boundsWidth / 2;
    const centerY = minY + boundsHeight / 2;

    return d3.zoomIdentity.translate(width / 2 - centerX * scale, height / 2 - centerY * scale).scale(scale);
}
