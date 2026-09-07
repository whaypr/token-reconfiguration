import { createPFairnessApp } from "./core";
import { problems } from "./problems";
import { scenarios } from "./scenarios";
import type { LayoutMode, PFairnessApp } from "./types";

function bootstrap(): void {
    const scenarioSelect = document.getElementById("scenarioSelect") as HTMLSelectElement;
    const problemSelect = document.getElementById("problemSelect") as HTMLSelectElement;
    const parameterLabel = document.getElementById("parameterLabel") as HTMLElement;
    const parameterDescription = document.getElementById("parameterDescription") as HTMLElement;
    const layoutSelect = document.getElementById("layoutSelect") as HTMLSelectElement;
    const repulsionToggle = document.getElementById("repulsionToggle") as HTMLInputElement;
    const neighborhoodCountToggle = document.getElementById("neighborhoodCountToggle") as HTMLInputElement;
    const moveDirectionToggle = document.getElementById("moveDirectionToggle") as HTMLInputElement;
    const copySelectionButton = document.getElementById("copySelectionButton") as HTMLButtonElement;
    const pasteSelectionButton = document.getElementById("pasteSelectionButton") as HTMLButtonElement;
    const saveSelectionButton = document.getElementById("saveSelectionButton") as HTMLButtonElement;
    const importSelectionButton = document.getElementById("importSelectionButton") as HTMLButtonElement;
    const clearSelectionButton = document.getElementById("clearSelectionButton") as HTMLButtonElement;
    const deleteSelectionButton = document.getElementById("deleteSelectionButton") as HTMLButtonElement;
    const selectionImportInput = document.getElementById("selectionImportInput") as HTMLInputElement;

    if (!scenarioSelect || !problemSelect || !parameterLabel || !parameterDescription || !layoutSelect || !repulsionToggle || !neighborhoodCountToggle || !moveDirectionToggle || !copySelectionButton || !pasteSelectionButton || !saveSelectionButton || !importSelectionButton || !clearSelectionButton || !deleteSelectionButton || !selectionImportInput || scenarios.length === 0 || problems.length === 0) {
        window.setTimeout(bootstrap, 0);
        return;
    }

    let currentApp: PFairnessApp | null = null;
    let currentProblem = problems[0];

    function renderProblem(problem = currentProblem): void {
        parameterLabel.textContent = `${problem.parameterLabel}`;
        parameterDescription.textContent = problem.parameterDescription;
        const parameterInput = document.getElementById("parameterValue") as HTMLInputElement;
        parameterInput.min = String(problem.minParameter);
        parameterInput.max = String(problem.maxParameter);
        parameterInput.step = String(problem.parameterStep);
    }

    function applyControlsToApp(): void {
        if (!currentApp) {
            return;
        }

        currentApp.applyLayout(layoutSelect.value as LayoutMode);
        currentApp.setRepulsionEnabled(repulsionToggle.checked);
        currentApp.setNeighborhoodCountVisibility(neighborhoodCountToggle.checked);
        currentApp.setMoveDirectionVisibility(moveDirectionToggle.checked);
    }

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

    layoutSelect.addEventListener("change", () => {
        applyControlsToApp();
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
    layoutSelect.value = "circular";
    repulsionToggle.checked = false;
    neighborhoodCountToggle.checked = false;
    moveDirectionToggle.checked = false;
    loadScenario(0);
}

if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
    bootstrap();
}