// Where the control panel is, and what the reader left open inside it.
//
// The panel is drawn in two shapes from one piece of markup: docked beside the
// canvases while there is room for both, and a drawer over them below that. The
// geometry belongs to the media queries in style.css, so nothing here measures or
// moves anything — it puts one state class on the panel, keeps the buttons that
// open and close it in step with it, and remembers the choices a reload would
// otherwise flatten. No control value passes through this file: what a checkbox is
// set to stays main.ts's and the app's business, exactly as before.

const STORAGE_KEY = "klikatko.controls-panel";

// The width at which the panel docks, matching the @media in style.css that
// docks it. The two cannot read each other — a media query cannot see a custom
// property — so a change to either has to be made in both places.
const DOCK_MIN_WIDTH = 1100;

interface PanelLayoutOptions {
    shellSelector: string;
    toggleSelector: string;
    fabSelector: string;
    backdropSelector: string;
    groupSelector: string;
}

interface StoredLayout {
    collapsed?: boolean;
    groups?: Record<string, boolean>;
}

// A blocked or full storage area is not worth a message: the panel simply starts
// in its defaults again, which is what happened on every visit before there was a
// memory to lose.
function readStoredLayout(): StoredLayout {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return {};
        }

        const parsed = JSON.parse(raw) as StoredLayout | null;

        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeStoredLayout(layout: StoredLayout): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
        // Private browsing, a full quota or a policy that refuses storage: the
        // panel works, it just will not remember.
    }
}

export function createPanelLayout({
    shellSelector,
    toggleSelector,
    fabSelector,
    backdropSelector,
    groupSelector,
}: PanelLayoutOptions): void {
    const shell = document.querySelector(shellSelector) as HTMLElement;
    const toggle = document.querySelector(toggleSelector) as HTMLButtonElement;
    const toggleIcon = toggle.querySelector(".panel-toggle-icon") as HTMLElement;
    const toggleLabel = toggle.querySelector(".panel-toggle-label") as HTMLElement;
    const fab = document.querySelector(fabSelector) as HTMLButtonElement;
    const backdrop = document.querySelector(backdropSelector) as HTMLElement;
    const groups = Array.from(document.querySelectorAll(groupSelector)) as HTMLDetailsElement[];

    const stored = readStoredLayout();
    const dockedQuery = window.matchMedia(`(min-width: ${DOCK_MIN_WIDTH}px)`);

    // Docked, whether the panel keeps its width or hands it to the canvas. Read
    // once and then kept, so a reader who collapsed the panel to draw is still
    // without it after a reload.
    let collapsed = stored.collapsed === true;
    // Drawer, whether the panel is standing open over the canvas. Never stored: an
    // open drawer is a thing being used right now, and there is no right now to
    // come back to.
    let drawerOpen = false;

    function readGroupState(): Record<string, boolean> {
        const opened: Record<string, boolean> = {};

        for (const group of groups) {
            const key = group.dataset.group;

            if (key) {
                opened[key] = group.open;
            }
        }

        return opened;
    }

    function persist(): void {
        writeStoredLayout({ collapsed, groups: readGroupState() });
    }

    // restoreFocus is asked for by the two ways a panel closes because the reader
    // meant it, and withheld when the shape merely changed under them: crossing
    // the docked width while dragging a window should not move their keyboard
    // somewhere else.
    function applyState(restoreFocus = false): void {
        const docked = dockedQuery.matches;
        const closed = docked ? collapsed : !drawerOpen;
        // Read before the class lands: a control that is about to be hidden takes
        // the reader's place in the page with it, and the keyboard ends up
        // somewhere off screen.
        const focusWasInside = shell.contains(document.activeElement);

        shell.classList.toggle("is-closed", closed);
        toggle.setAttribute("aria-expanded", String(!closed));
        toggle.setAttribute(
            "aria-label",
            docked
                ? (collapsed ? "Show the controls panel" : "Hide the controls panel")
                : "Close the controls panel",
        );
        // Sideways when the panel is a rail, so the word and its arrow read as one
        // vertical line; a cross when it is a drawer, where "hide" would describe a
        // button that is about to disappear.
        toggleIcon.textContent = docked ? (collapsed ? "»" : "«") : "×";
        toggleLabel.textContent = docked ? (collapsed ? "Controls" : "Hide") : "Close";
        // The pill is the drawer's way in, so it exists only where there is a
        // drawer and only while it is shut — an open drawer carries its own Close.
        fab.hidden = docked || !closed;
        fab.setAttribute("aria-expanded", String(!closed));
        backdrop.classList.toggle("is-visible", !docked && !closed);

        // Hand the keyboard to the control that survives the close and opens the
        // panel again — the rail where the panel is docked, the pill where it is a
        // drawer, because the rail's button is on its way out of sight with the
        // drawer and focus parked in a hidden subtree tabulates from nowhere.
        if (restoreFocus && closed && focusWasInside) {
            (docked ? toggle : fab).focus();
        }
    }

    function togglePanel(): void {
        if (dockedQuery.matches) {
            collapsed = !collapsed;
            persist();
        } else {
            drawerOpen = !drawerOpen;
        }

        applyState(true);
    }

    function closeDrawer(): void {
        if (!drawerOpen) {
            return;
        }

        drawerOpen = false;
        applyState(true);
    }

    toggle.addEventListener("click", togglePanel);
    fab.addEventListener("click", togglePanel);
    // Not a document listener: the canvas under the drawer edits the graph on a
    // background tap, so a press that only meant to dismiss the panel would also
    // add a vertex (the layout picker inside the panel has the same problem, and
    // the same answer).
    backdrop.addEventListener("click", closeDrawer);

    for (const group of groups) {
        const key = group.dataset.group;
        const remembered = key ? stored.groups?.[key] : undefined;

        // Only a real yes or no is obeyed; anything an older or hand-edited entry
        // left behind leaves the section as the page declares it.
        if (remembered === true || remembered === false) {
            group.open = remembered;
        }

        group.addEventListener("toggle", persist);
    }

    // Crossing the docked width — a window dragged, a phone turned — leaves the
    // open shape meaningless: a drawer standing open over a canvas that no longer
    // needs covering would hide half a screen, and a collapsed rail has nothing to
    // be in a drawer. The collapse itself is kept, because it describes the docked
    // panel and will be true again the moment the width comes back.
    const handleModeChange = (): void => {
        drawerOpen = false;
        applyState();
    };

    if (typeof dockedQuery.addEventListener === "function") {
        dockedQuery.addEventListener("change", handleModeChange);
    } else {
        dockedQuery.addListener(handleModeChange);
    }

    window.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeDrawer();
            return;
        }

        // H hides the panel and brings it back — the one action here that is worth
        // a key, because it is asked for in the middle of something else: hands on
        // the canvas, one setting wanted at the edge of the screen.
        if (event.key.toLowerCase() !== "h" || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }

        const target = event.target as HTMLElement | null;
        const isTyping = target
            && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA"
                || target.isContentEditable);

        if (isTyping) {
            return;
        }

        event.preventDefault();
        togglePanel();
    });

    applyState();
}
