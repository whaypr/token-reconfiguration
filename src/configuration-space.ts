import type { NodeId } from "./types";

// One configuration of the tokens, written as the set of vertices carrying one.
// Which token sits where is deliberately not part of it: both problems the app
// knows answer their rules from positions alone — a closed-neighbourhood count,
// a shortest-path distance between two tokens — so two boards differing only by
// a swap of two tokens' names are the same configuration, and drawing them as
// two dots would double the picture and lie about the structure.
export type Occupancy = NodeId[];

export type ConfigurationKey = string;

// Why the search stopped where it did. "complete" is the only halt that lets
// anything be concluded about the graph; every other value says the search ran
// into a limit of OURS, and a limit reached is not a proof. Callers that answer
// "can the goal be reached?" have to check this before saying no.
export type SearchHalt = "complete" | "state-limit" | "depth-limit" | "time-limit" | "cancelled";

export interface ConfigurationRecord {
    key: ConfigurationKey;
    occupancy: Occupancy;
    // How many single token moves the start lies away. The move relation is
    // symmetric — a slide from an occupied u to an empty neighbour v leaves the
    // very same configuration of tokens that a slide back from v to u would
    // produce, and validity is read off that configuration — so this one number
    // is the distance to the start in both directions.
    depth: number;
    // One configuration that reaches this one in a single move. Enough to walk
    // a shortest path back to the start without storing every route.
    parentKey: ConfigurationKey | null;
}

export interface ConfigurationSpaceLimits {
    // How many configurations to hold. Bounds memory and, more than that, what
    // can be drawn: a picture of ten thousand dots says nothing to anyone.
    maxConfigurations: number;
    // How far from the start to look. A depth ceiling keeps a wide component
    // from being traded for a deep one, which would show up as one enormous
    // ring and nothing else.
    maxDepth: number;
    // Wall-clock ceiling for the whole search, counted across time slices. A
    // visitor who opens the panel on a big graph should get a partial picture in
    // a beat, not a frozen page while an honest search finishes.
    maxMilliseconds: number;
}

export const DEFAULT_SPACE_LIMITS: ConfigurationSpaceLimits = {
    maxConfigurations: 2500,
    maxDepth: 14,
    maxMilliseconds: 1500,
};

export interface ConfigurationSpaceOptions {
    start: Occupancy;
    // Every configuration one legal move away from the given one. Supplied from
    // outside so this file never has to know what a rule is — and so what the
    // picture shows is produced by the same rules the canvas enforces.
    successorsOf(occupancy: Occupancy): Occupancy[];
    makeKey(occupancy: Occupancy): ConfigurationKey;
    limits?: Partial<ConfigurationSpaceLimits>;
}

/**
 * The component of the reconfiguration graph around one starting configuration,
 * grown one move at a time from that start.
 *
 * Breadth-first, and kept in discovery order, so a configuration's depth is
 * settled the moment it is recorded and never revised. The whole component is
 * built from a single start on purpose: after the search, moving a token lands
 * on a configuration that is already here, which is what lets a move redraw a
 * marker instead of starting a new search.
 */
export class ConfigurationExplorer {
    readonly startKey: ConfigurationKey;

    // Kept as a flat list because it is what a renderer wants to draw, and in
    // discovery order so the lines do not shuffle between two redraws of the
    // same search.
    readonly edges: Array<{ from: ConfigurationKey; to: ConfigurationKey }> = [];

    private readonly byKey = new Map<ConfigurationKey, ConfigurationRecord>();
    private readonly neighbours = new Map<ConfigurationKey, ConfigurationKey[]>();
    // An edge found twice — from both ends — is one edge in the picture.
    private readonly seenEdges = new Set<string>();
    // Discovery order, and the reason a move costs nothing to follow: the queue
    // outlives each time slice, so the search resumes exactly where it stopped.
    private readonly queue: ConfigurationKey[] = [];
    private frontierCursor = 0;
    private deepest = 0;
    private halt: SearchHalt = "complete";
    private elapsedMilliseconds = 0;
    private readonly limits: ConfigurationSpaceLimits;
    private readonly successorsOf: (occupancy: Occupancy) => Occupancy[];
    private readonly makeKey: (occupancy: Occupancy) => ConfigurationKey;

    constructor({ start, successorsOf, makeKey, limits }: ConfigurationSpaceOptions) {
        this.limits = { ...DEFAULT_SPACE_LIMITS, ...limits };
        this.successorsOf = successorsOf;
        this.makeKey = makeKey;
        this.startKey = makeKey(start);
        this.record(this.startKey, start, 0, null);
        // The start is also the whole frontier until it has been expanded: seed
        // it here or the search has nothing to work on and reports a one-dot
        // component as if it were finished.
        this.queue.push(this.startKey);
    }

    get size(): number {
        return this.byKey.size;
    }

    get haltReason(): SearchHalt {
        return this.halt;
    }

    /** Nothing left to expand and no limit hit: what is here IS the component. */
    get conclusive(): boolean {
        return this.halt === "complete" && this.frontierCursor >= this.queue.length;
    }

    /** Configurations found but not yet expanded. */
    get pending(): number {
        return Math.max(0, this.queue.length - this.frontierCursor);
    }

    get maxDepthSeen(): number {
        return this.deepest;
    }

    get limitsInUse(): ConfigurationSpaceLimits {
        return this.limits;
    }

    millisecondsSpent(): number {
        return this.elapsedMilliseconds;
    }

    recordAt(key: ConfigurationKey): ConfigurationRecord | null {
        return this.byKey.get(key) ?? null;
    }

    configurations(): ConfigurationRecord[] {
        return [...this.byKey.values()];
    }

    neighboursOf(key: ConfigurationKey): ConfigurationKey[] {
        return this.neighbours.get(key) ?? [];
    }

    /**
     * Expands configurations until the slice's clock runs out, the component is
     * finished, or a limit is reached. Returns how many were expanded, which is
     * zero once the search is over — a caller driving this from an animation
     * frame can stop asking at that point.
     *
     * The clock is only checked between configurations. One configuration's
     * successors are produced in one go, because splitting a single
     * configuration's move list across frames would mean drawing half a ring;
     * the price is that a slice can overshoot its budget by one configuration.
     */
    expandWithin(sliceMilliseconds: number): number {
        // A search that stopped at a limit stays stopped. Without this the next
        // slice would expand another configuration only to be refused again when
        // it tried to record what it found.
        if (this.halt !== "complete") {
            return 0;
        }

        const deadline = Date.now() + sliceMilliseconds;
        let expanded = 0;

        while (this.frontierCursor < this.queue.length) {
            const now = Date.now();

            // Out of slice but not out of search: the frontier waits for the next
            // call, which is why this is not a halt.
            if (now >= deadline) {
                return expanded;
            }

            if (this.elapsedMilliseconds >= this.limits.maxMilliseconds) {
                this.noteHalt("time-limit");

                return expanded;
            }

            const key = this.queue[this.frontierCursor];
            const record = this.byKey.get(key)!;
            this.frontierCursor += 1;
            expanded += 1;

            if (record.depth >= this.limits.maxDepth) {
                // The queue is in discovery order, so every configuration after
                // this one sits at the same depth or deeper. Nothing further can
                // be expanded without passing the ceiling.
                this.noteHalt("depth-limit");

                return expanded;
            }

            for (const occupancy of this.successorsOf(record.occupancy)) {
                const neighbourKey = this.makeKey(occupancy);

                if (this.byKey.has(neighbourKey)) {
                    this.addEdge(record.key, neighbourKey);
                    continue;
                }

                if (this.byKey.size >= this.limits.maxConfigurations) {
                    this.noteHalt("state-limit");

                    return expanded;
                }

                this.record(neighbourKey, occupancy, record.depth + 1, record.key);
                this.addEdge(record.key, neighbourKey);
                this.queue.push(neighbourKey);
                this.deepest = Math.max(this.deepest, record.depth + 1);
            }

            // Counted per configuration. The slice's own bookkeeping stays out
            // of it: measuring the slice would charge the same milliseconds
            // twice, once here and once as part of the slice total.
            this.elapsedMilliseconds += Date.now() - now;
        }

        return expanded;
    }

    /** Stops a search that is still growing, so a stale picture cannot appear later. */
    cancel(): void {
        if (this.frontierCursor < this.queue.length) {
            this.noteHalt("cancelled");
            this.queue.length = 0;
        }
    }

    /**
     * Shortest distance to any of `seeds`, over the configurations already
     * recorded. Multi-source and run backwards from the goals, which is what
     * turns "how many moves are left from here" into one number per
     * configuration rather than one search per configuration.
     *
     * Only ever spans recorded configurations, so a truncated search gives a
     * distance for the part of the component it managed to reach and says
     * nothing about the rest.
     */
    distancesFrom(seeds: Iterable<ConfigurationKey>): Map<ConfigurationKey, number> {
        const distances = new Map<ConfigurationKey, number>();
        const queue: ConfigurationKey[] = [];

        for (const seed of seeds) {
            if (this.byKey.has(seed) && !distances.has(seed)) {
                distances.set(seed, 0);
                queue.push(seed);
            }
        }

        for (let cursor = 0; cursor < queue.length; cursor += 1) {
            const key = queue[cursor];
            const distance = distances.get(key)!;

            for (const neighbour of this.neighboursOf(key)) {
                if (distances.has(neighbour)) continue;
                distances.set(neighbour, distance + 1);
                queue.push(neighbour);
            }
        }

        return distances;
    }

    /**
     * The route the parents describe, start first. A shortest way to the start,
     * because each parent is one move closer to it.
     */
    pathToStart(key: ConfigurationKey): ConfigurationKey[] {
        const path: ConfigurationKey[] = [];
        let cursor: ConfigurationKey | null = key;

        // Guarded against a cycle by the depth strictly decreasing along a
        // parent chain: a broken link that pointed back would otherwise spin
        // here forever, and this runs on every redraw.
        while (cursor !== null && this.byKey.has(cursor)) {
            path.push(cursor);
            cursor = this.byKey.get(cursor)!.parentKey;
        }

        return path.reverse();
    }

    private record(key: ConfigurationKey, occupancy: Occupancy, depth: number, parentKey: ConfigurationKey | null): void {
        this.byKey.set(key, { key, occupancy, depth, parentKey });
        this.neighbours.set(key, this.neighbours.get(key) ?? []);
    }

    private addEdge(from: ConfigurationKey, to: ConfigurationKey): void {
        if (from === to) return;

        const edgeKey = from < to ? `${from}|${to}` : `${to}|${from}`;

        if (this.seenEdges.has(edgeKey)) return;

        this.seenEdges.add(edgeKey);
        this.edges.push({ from, to });
        this.neighbours.get(from)?.push(to);
        this.neighbours.get(to)?.push(from);
    }

    // The first limit hit is the one reported: a search that ran out of
    // configurations before it ran out of depth was stopped by the first, and
    // overwriting it with a later reason would describe the wrong thing.
    private noteHalt(reason: Exclude<SearchHalt, "complete">): void {
        if (this.halt === "complete") {
            this.halt = reason;
        }
    }
}

/**
 * A route between two configurations, searched from both ends. Each direction is
 * an ordinary BFS with its own records, so both parent chains are made of legal
 * slides and can be joined at a shared configuration. A meeting is a valid route,
 * not a proof that it is the shortest possible route: expanding by time rather
 * than by whole depth layers deliberately trades that guarantee for a route in
 * an interactive amount of time.
 */
export class SolutionRouteSearch {
    private route: ConfigurationKey[] | null = null;

    constructor(
        readonly fromStart: ConfigurationExplorer,
        readonly fromGoal: ConfigurationExplorer,
    ) {
        // One direction may already be fully explored when the visitor changes
        // the marked vertices. Check its existing records before using that
        // completion as an unreachability proof or expanding the other side.
        this.route = this.meetingRoute();
    }

    /** A start-to-goal sequence, or null while no meeting has been found. */
    get path(): readonly ConfigurationKey[] | null {
        return this.route;
    }

    /**
     * A completed component with no overlap proves that the two starts are
     * disjoint. This remains valid even if the other direction hit our limits.
     */
    get provesUnreachable(): boolean {
        return this.route === null && (this.fromStart.conclusive || this.fromGoal.conclusive);
    }

    get finished(): boolean {
        return this.route !== null
            || this.provesUnreachable
            || (this.stopped(this.fromStart) && this.stopped(this.fromGoal));
    }

    /** Advance each active direction, stopping as soon as they share a state. */
    expandWithin(sliceMilliseconds: number): readonly ConfigurationKey[] | null {
        if (this.route) return this.route;
        if (this.finished) return null;

        for (const [growing, other] of [[this.fromStart, this.fromGoal], [this.fromGoal, this.fromStart]] as const) {
            if (!this.stopped(growing)) {
                growing.expandWithin(sliceMilliseconds / 2);
            }

            this.route = this.meetingRoute();

            if (this.route || this.finished) {
                return this.route;
            }
        }

        return null;
    }

    private stopped(explorer: ConfigurationExplorer): boolean {
        return explorer.pending === 0 || explorer.haltReason !== "complete";
    }

    private meetingRoute(): ConfigurationKey[] | null {
        const [smaller, larger] = this.fromStart.size <= this.fromGoal.size
            ? [this.fromStart, this.fromGoal] as const
            : [this.fromGoal, this.fromStart] as const;
        let meeting: ConfigurationKey | null = null;
        let shortestSum = Infinity;

        for (const record of smaller.configurations()) {
            const other = larger.recordAt(record.key);
            const total = other ? record.depth + other.depth : Infinity;

            if (total < shortestSum) {
                meeting = record.key;
                shortestSum = total;
            }
        }

        if (meeting === null) return null;

        // fromStart: initial configuration -> meeting.
        // fromGoal: goal -> meeting; reversing supplies meeting -> goal.
        // The meeting is in both chains, so remove its duplicate at the seam.
        return [
            ...this.fromStart.pathToStart(meeting),
            ...this.fromGoal.pathToStart(meeting).reverse().slice(1),
        ];
    }
}
