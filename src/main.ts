import { createTokenReconfigurationApp } from "./core";
import { LAYOUT_OPTIONS } from "./layouts";
import { problems } from "./problems";
import { scenarios } from "./scenarios";
import { DEFAULT_COLOR_HINTS } from "./types";
import type { ColorHints, InteractionMode, TokenReconfigurationApp, ProblemDefinition, SerializedProblemContext } from "./types";

function bootstrap(): void {
    const scenarioSelect = document.getElementById("scenarioSelect") as HTMLSelectElement;
    const problemSelect = document.getElementById("problemSelect") as HTMLSelectElement;
    const parameterLabel = document.getElementById("parameterLabel") as HTMLElement;
    const parameterDescription = document.getElementById("parameterDescription") as HTMLElement;
    const layoutPicker = document.getElementById("layoutPicker") as HTMLDetailsElement;
    const layoutPickerBackdrop = document.getElementById("layoutPickerBackdrop") as HTMLDivElement;
    const layoutOptions = document.getElementById("layoutOptions") as HTMLDivElement;
    const repulsionToggle = document.getElementById("repulsionToggle") as HTMLInputElement;
    const neighborhoodCountToggle = document.getElementById("neighborhoodCountToggle") as HTMLInputElement;
    const moveDirectionToggle = document.getElementById("moveDirectionToggle") as HTMLInputElement;
    const colorMovableToggle = document.getElementById("colorMovableToggle") as HTMLInputElement;
    const colorFrozenToggle = document.getElementById("colorFrozenToggle") as HTMLInputElement;
    const colorPlaceableToggle = document.getElementById("colorPlaceableToggle") as HTMLInputElement;
    const modeTokensButton = document.getElementById("modeTokensButton") as HTMLButtonElement;
    const modeGraphButton = document.getElementById("modeGraphButton") as HTMLButtonElement;
    const copySelectionButton = document.getElementById("copySelectionButton") as HTMLButtonElement;
    const pasteSelectionButton = document.getElementById("pasteSelectionButton") as HTMLButtonElement;
    const saveSelectionButton = document.getElementById("saveSelectionButton") as HTMLButtonElement;
    const importSelectionButton = document.getElementById("importSelectionButton") as HTMLButtonElement;
    const clearSelectionButton = document.getElementById("clearSelectionButton") as HTMLButtonElement;
    const deleteSelectionButton = document.getElementById("deleteSelectionButton") as HTMLButtonElement;
    const selectionImportInput = document.getElementById("selectionImportInput") as HTMLInputElement;

    if (!scenarioSelect || !problemSelect || !parameterLabel || !parameterDescription || !layoutPicker || !layoutPickerBackdrop || !layoutOptions || !repulsionToggle || !neighborhoodCountToggle || !moveDirectionToggle || !colorMovableToggle || !colorFrozenToggle || !colorPlaceableToggle || !modeTokensButton || !modeGraphButton || !copySelectionButton || !pasteSelectionButton || !saveSelectionButton || !importSelectionButton || !clearSelectionButton || !deleteSelectionButton || !selectionImportInput || scenarios.length === 0 || problems.length === 0) {
        window.setTimeout(bootstrap, 0);
        return;
    }

    let currentApp: TokenReconfigurationApp | null = null;
    let currentProblem = problems[0];
    let interactionMode: InteractionMode = "tokens";

    // Only the words here. The number box — its bounds, step and value — is the
    // app's to keep in step with the rules it is enforcing, because undo can
    // move the problem without asking this file first.
    function renderProblem(problem = currentProblem): void {
        parameterLabel.textContent = `${problem.parameterLabel}`;
        parameterDescription.textContent = problem.parameterDescription;
    }

    function applyInteractionMode(mode: InteractionMode): void {
        interactionMode = mode;
        modeTokensButton.classList.toggle("active", mode === "tokens");
        modeGraphButton.classList.toggle("active", mode === "graph");
        modeTokensButton.setAttribute("aria-pressed", String(mode === "tokens"));
        modeGraphButton.setAttribute("aria-pressed", String(mode === "graph"));
        currentApp?.setInteractionMode(mode);
    }

    function readColorHints(): ColorHints {
        return {
            movable: colorMovableToggle.checked,
            frozen: colorFrozenToggle.checked,
            placeable: colorPlaceableToggle.checked,
        };
    }

    function applyControlsToApp(): void {
        if (!currentApp) {
            return;
        }

        currentApp.setRepulsionEnabled(repulsionToggle.checked);
        currentApp.setNeighborhoodCountVisibility(neighborhoodCountToggle.checked);
        currentApp.setMoveDirectionVisibility(moveDirectionToggle.checked);
        currentApp.setInteractionMode(interactionMode);
        currentApp.setColorHints(readColorHints());
    }

    // A layout is an action, not a setting: picking one rearranges the graph
    // once and leaves no control behind in a "selected" state, because the
    // arrangement is free to change again the moment a vertex is dragged.
    function renderLayoutOptions(): void {
        LAYOUT_OPTIONS.forEach(({ value, label }) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "layout-option";
            button.textContent = label;
            button.addEventListener("click", () => {
                if (!currentApp) {
                    return;
                }

                currentApp.applyLayout(value);
                // Worth saying out loud: the menu closes and no control is left
                // showing a chosen layout, so the status line is the only thing
                // confirming the arrangement really changed.
                currentApp.setStatus(`${label} layout applied.`);
                layoutPicker.removeAttribute("open");
            });
            layoutOptions.appendChild(button);
        });
    }

    // The backdrop is what a press meant to dismiss the menu lands on, so
    // closing here is all it takes — and the canvas below never sees the click,
    // which matters because a background click there edits the graph.
    layoutPickerBackdrop.addEventListener("click", () => {
        layoutPicker.removeAttribute("open");
    });

    function renderScenarioOptions(): void {
        scenarioSelect.innerHTML = "";

        scenarios.forEach((scenario, index) => {
            const option = document.createElement("option");
            option.value = String(index);
            option.textContent = scenario.name;
            scenarioSelect.appendChild(option);
        });
    }

    function loadScenario(index: number): void {
        const scenario = scenarios[index] || scenarios[0];

        if (currentApp) {
            currentApp.destroy();
        }

        // A scenario drawn under one problem is meaningless under another, so
        // its own problem wins over whatever the dropdown happened to show — and
        // the dropdown then says what the rules are actually applying.
        const scenarioProblem = findProblemById(scenario.problem?.id) || currentProblem;
        currentProblem = scenarioProblem;
        problemSelect.value = String(problems.indexOf(scenarioProblem));

        currentApp = createTokenReconfigurationApp({
            svgSelector: "svg",
            parameterInputSelector: "#parameterValue",
            statusSelector: "#status",
            nodes: scenario.nodes,
            links: scenario.links,
            tokens: scenario.tokens,
            initialParameter: clampParameter(
                scenario.problem?.parameter ?? scenarioProblem.defaultParameter,
                scenarioProblem,
            ),
            problem: scenarioProblem,
            // Undo can put a different problem back on the graph, and the
            // dropdown plus its two labels have to follow without being told.
            onProblemChange: problem => {
                currentProblem = problem;
                problemSelect.value = String(problems.indexOf(problem));
                renderProblem(problem);
            },
        });

        applyControlsToApp();
        renderProblem(scenarioProblem);
        currentApp.setStatus(scenario.description);
    }

    // Saved files name a problem by id rather than by position, so a reordered
    // problem list still opens them under the problem they were saved with. The
    // scenario picker leans on the same match for the same reason.
    function findProblemById(problemId: string | undefined): ProblemDefinition | null {
        if (!problemId) {
            return null;
        }

        return problems.find(problem => problem.id === problemId) || null;
    }

    renderScenarioOptions();

    problems.forEach((problem, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = problem.name;
        problemSelect.appendChild(option);
    });

    // The graph in the canvas is the user's work, so changing the problem does
    // not reload it. Only when no graph exists yet does the choice decide which
    // scenario to build.
    problemSelect.addEventListener("change", event => {
        currentProblem = problems[Number.parseInt((event.target as HTMLSelectElement).value, 10)] || problems[0];
        renderProblem();

        if (currentApp) {
            currentApp.setProblem(currentProblem);
        } else {
            loadScenario(Number.parseInt(scenarioSelect.value, 10));
        }
    });

    scenarioSelect.addEventListener("change", event => {
        const target = event.target as HTMLSelectElement;
        loadScenario(Number.parseInt(target.value, 10));
    });

    repulsionToggle.addEventListener("change", () => {
        if (currentApp) {
            currentApp.setRepulsionEnabled(repulsionToggle.checked);
        }
    });

    neighborhoodCountToggle.addEventListener("change", () => {
        if (currentApp) {
            currentApp.setNeighborhoodCountVisibility(neighborhoodCountToggle.checked);
        }
    });

    moveDirectionToggle.addEventListener("change", () => {
        if (currentApp) {
            currentApp.setMoveDirectionVisibility(moveDirectionToggle.checked);
        }
    });

    // Three switches, one value object: whichever changes, the app is handed
    // the whole set, so it can never see a half-applied group of hints.
    for (const hintToggle of [colorMovableToggle, colorFrozenToggle, colorPlaceableToggle]) {
        hintToggle.addEventListener("change", () => {
            currentApp?.setColorHints(readColorHints());
        });
    }

    modeTokensButton.addEventListener("click", () => {
        applyInteractionMode("tokens");
    });

    modeGraphButton.addEventListener("click", () => {
        applyInteractionMode("graph");
    });

    copySelectionButton.addEventListener("click", () => {
        currentApp?.copySelection();
    });

    pasteSelectionButton.addEventListener("click", () => {
        currentApp?.pasteSelection();
    });

    saveSelectionButton.addEventListener("click", () => {
        currentApp?.saveSelection();
    });

    importSelectionButton.addEventListener("click", () => {
        selectionImportInput.click();
    });

    deleteSelectionButton.addEventListener("click", () => {
        currentApp?.deleteSelection();
    });

    clearSelectionButton.addEventListener("click", () => {
        if (!currentApp) {
            return;
        }

        currentApp.clearNodeSelection();
        currentApp.setStatus("Selection cleared.");
    });

    selectionImportInput.addEventListener("change", async () => {
        const file = selectionImportInput.files?.[0];

        if (!currentApp || !file) {
            selectionImportInput.value = "";
            return;
        }

        const savedProblem = await currentApp.importSelection(file);

        if (savedProblem) {
            adoptSavedProblem(savedProblem);
        }

        selectionImportInput.value = "";
    });

    // A file names its problem by id, which is the only stable handle on it —
    // names are display text and ids survive a rename. An id this build does not
    // know is ignored: the vertices are still good geometry, so they stay pasted
    // and the graph simply keeps the problem it was already using.
    function adoptSavedProblem(savedProblem: SerializedProblemContext): void {
        const matchIndex = problems.findIndex(problem => problem.id === savedProblem.id);

        if (matchIndex === -1) {
            currentApp?.setStatus(`Imported under ${savedProblem.name}, which this build does not have — kept the current problem.`);
            return;
        }

        // setProblem announces through onProblemChange when the problem really
        // changes; a same-problem import leaves only the parameter to report,
        // which setProblem's own message already covers.
        currentApp?.setProblem(problems[matchIndex], clampParameter(savedProblem.parameter, problems[matchIndex]));
    }

    // A file could carry a value the current problem's own bounds reject, so it
    // is pulled inside them rather than handed over to be silently refused.
    function clampParameter(value: number, problem: ProblemDefinition): number {
        return Math.min(problem.maxParameter, Math.max(problem.minParameter, value));
    }

    window.addEventListener("keydown", event => {
        if (!currentApp || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") {
            return;
        }

        const target = event.target as HTMLElement | null;
        const isTextInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

        if (isTextInput) {
            return;
        }

        event.preventDefault();
        currentApp.undo();
    });

    scenarioSelect.value = "0";
    problemSelect.value = "0";
    renderProblem();
    renderLayoutOptions();
    repulsionToggle.checked = false;
    neighborhoodCountToggle.checked = false;
    moveDirectionToggle.checked = false;
    // Assigned rather than left to the HTML `checked` attribute: browsers
    // restore a form control's previous state across a reload, so the attribute
    // alone is only an initial value and would not be the default the second
    // time the page loads.
    colorMovableToggle.checked = DEFAULT_COLOR_HINTS.movable;
    colorFrozenToggle.checked = DEFAULT_COLOR_HINTS.frozen;
    colorPlaceableToggle.checked = DEFAULT_COLOR_HINTS.placeable;
    loadScenario(0);
}

if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
    bootstrap();
}