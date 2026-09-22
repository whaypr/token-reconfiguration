import { createPFairnessApp } from "./core";
import { LAYOUT_OPTIONS } from "./layouts";
import { problems } from "./problems";
import { scenarios } from "./scenarios";
import { DEFAULT_COLOR_HINTS } from "./types";
import type { ColorHints, InteractionMode, PFairnessApp } from "./types";

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

    let currentApp: PFairnessApp | null = null;
    let currentProblem = problems[0];
    let interactionMode: InteractionMode = "tokens";

    function renderProblem(problem = currentProblem): void {
        parameterLabel.textContent = `${problem.parameterLabel}`;
        parameterDescription.textContent = problem.parameterDescription;
        const parameterInput = document.getElementById("parameterValue") as HTMLInputElement;
        parameterInput.min = String(problem.minParameter);
        parameterInput.max = String(problem.maxParameter);
        parameterInput.step = String(problem.parameterStep);
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

        currentApp = createPFairnessApp({
            svgSelector: "svg",
            parameterInputSelector: "#parameterValue",
            statusSelector: "#status",
            nodes: scenario.nodes,
            links: scenario.links,
            tokens: scenario.tokens,
            initialParameter: currentProblem.id === "p-fairness" ? scenario.initialP : currentProblem.defaultParameter,
            problem: currentProblem,
        });

        applyControlsToApp();
        currentApp.setStatus(scenario.description);
    }

    renderScenarioOptions();

    problems.forEach((problem, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = problem.name;
        problemSelect.appendChild(option);
    });

    problemSelect.addEventListener("change", event => {
        currentProblem = problems[Number.parseInt((event.target as HTMLSelectElement).value, 10)] || problems[0];
        renderProblem();
        loadScenario(Number.parseInt(scenarioSelect.value, 10));
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

        await currentApp.importSelection(file);
        selectionImportInput.value = "";
    });

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