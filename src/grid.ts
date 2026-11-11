import type { Selection, ZoomTransform } from "d3";

// ---------------------------------------------------------------------------
// The snap grid: the lines drawn on the pane, and the one place that knows what
// position a released vertex should land on.
//
// The grid belongs to the GRAPH, not to the pane. Its lines sit at multiples of
// one spacing in graph units, inside the transformed viewport, so they pan and
// zoom with the drawing and the line a vertex was dropped on is still under it
// at the next zoom level. A grid pinned to the screen would agree with where the
// vertices are only in the instant they were released, and zooming would undo
// every alignment the reader just made.
// ---------------------------------------------------------------------------

// Spacing bounds, in graph units. The floor is a vertex's own diameter (r=20):
// a grid finer than the thing being aimed at cannot be aimed at. The ceiling is
// past the height of a tall pane, where the grid would be one or two lines and
// would stop being a grid.
export const MIN_GRID_SPACING = 10;
export const MAX_GRID_SPACING = 400;
export const DEFAULT_GRID_SPACING = 40;
// What the spinner moves by. A multiple of the floor, so a value stepped to from
// the bounds is always inside them.
export const GRID_SPACING_STEP = 5;

// Below this many SCREEN pixels between neighbouring lines, a field of parallel
// strokes reads as a grey wash rather than as a grid, so far out the drawn lines
// thin out to every nth multiple of the spacing. Every line still drawn is a
// line a vertex can land on, so the picture never shows a grid the snap does not
// use — it just omits some of it until the reader comes closer.
const MIN_LINE_GAP_PX = 7;

export function clampGridSpacing(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_GRID_SPACING;
    }

    return Math.min(MAX_GRID_SPACING, Math.max(MIN_GRID_SPACING, value));
}

// A grid coordinate, free of binary drift: 3 * 0.1 is 0.30000000000000004, and
// those numbers end up in saved files and in the coordinates a scenario names.
// Six decimals is far finer than a graph unit is ever read to.
function gridCoordinate(steps: number, spacing: number): number {
    return Number((steps * spacing).toFixed(6));
}

interface GridOverlayContext {
    layer: Selection<SVGGElement, unknown, null, undefined>;
    currentTransform: () => ZoomTransform;
    canvasSize: () => { width: number; height: number };
}

export interface GridOverlayController {
    setEnabled(enabled: boolean): void;
    setSpacing(spacing: number): void;
    // Where a point being dragged should actually go: on the nearest grid
    // intersection while the grid is on, exactly itself while it is off.
    snap(x: number, y: number): [number, number];
    render(): void;
}

type GridLineDatum = {
    key: string;
    at: number;
};

// Multiples of `step` lying inside [from, to], as the intersections between two
// edges of the visible region. Walked by index rather than by addition so the
// last line does not drift a fraction away from where the snap would put a
// vertex on it.
function multiplesIn(from: number, to: number, step: number): number[] {
    const values: number[] = [];

    if (!(step > 0) || !(to >= from)) {
        return values;
    }

    const firstIndex = Math.ceil(from / step);
    const lastIndex = Math.floor(to / step);

    for (let index = firstIndex; index <= lastIndex; index += 1) {
        values.push(gridCoordinate(index, step));
    }

    return values;
}

function toLineData(prefix: string, values: number[]): GridLineDatum[] {
    return values.map(at => ({ key: `${prefix}${String(at)}`, at }));
}

export function createGridOverlay(context: GridOverlayContext): GridOverlayController {
    let enabled = false;
    let spacing = DEFAULT_GRID_SPACING;

    // Two groups, because every line in one of them shares its two cross
    // coordinates: the run of a vertical line is the visible height, of a
    // horizontal one the visible width, so each join sets those once.
    const verticals = context.layer.append("g").attr("class", "grid-verticals");
    const horizontals = context.layer.append("g").attr("class", "grid-horizontals");

    // The spacing actually drawn: the reader's own, or the first multiple of it
    // that is far enough apart on screen to see (see MIN_LINE_GAP_PX).
    function drawnSpacing(scale: number): number {
        const gapOnScreen = spacing * scale;

        if (gapOnScreen >= MIN_LINE_GAP_PX) {
            return spacing;
        }

        return spacing * Math.ceil(MIN_LINE_GAP_PX / gapOnScreen);
    }

    function clear(): void {
        verticals.selectAll(".grid-line").remove();
        horizontals.selectAll(".grid-line").remove();
    }

    function render(): void {
        const { width, height } = context.canvasSize();

        if (!enabled || width <= 0 || height <= 0) {
            clear();
            return;
        }

        const transform = context.currentTransform();
        // The pane's four corners in graph units — the region the reader can
        // actually see, which is all the grid there is any point in drawing.
        const [left, top] = transform.invert([0, 0]);
        const [right, bottom] = transform.invert([width, height]);
        const step = drawnSpacing(transform.k);

        verticals.selectAll<SVGLineElement, GridLineDatum>(".grid-line")
            .data(toLineData("v", multiplesIn(left, right, step)), d => d.key)
            .join(
                enter => enter.append("line").attr("class", "grid-line"),
                update => update,
                exit => exit.remove(),
            )
            // The graph's own axes, so the point every line is measured from is
            // visible rather than implied.
            .classed("grid-axis", d => d.at === 0)
            .attr("x1", d => d.at)
            .attr("x2", d => d.at)
            .attr("y1", top)
            .attr("y2", bottom);

        horizontals.selectAll<SVGLineElement, GridLineDatum>(".grid-line")
            .data(toLineData("h", multiplesIn(top, bottom, step)), d => d.key)
            .join(
                enter => enter.append("line").attr("class", "grid-line"),
                update => update,
                exit => exit.remove(),
            )
            .classed("grid-axis", d => d.at === 0)
            .attr("y1", d => d.at)
            .attr("y2", d => d.at)
            .attr("x1", left)
            .attr("x2", right);
    }

    return {
        setEnabled(nextEnabled: boolean) {
            enabled = nextEnabled;
            render();
        },
        setSpacing(nextSpacing: number) {
            spacing = clampGridSpacing(nextSpacing);
            render();
        },
        snap(x: number, y: number): [number, number] {
            if (!enabled) {
                return [x, y];
            }

            return [
                gridCoordinate(Math.round(x / spacing), spacing),
                gridCoordinate(Math.round(y / spacing), spacing),
            ];
        },
        render,
    };
}
