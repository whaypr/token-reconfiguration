import { createPFairnessApp } from "./p-fairness-core";
import { scenarios } from "./scenarios";

function bootstrap(): void {
    const scenarioSelect = document.getElementById("scenarioSelect") as HTMLSelectElement;
    const scenarioDescription = document.getElementById("scenarioDescription") as HTMLElement;

    if (!scenarioSelect || !scenarioDescription || scenarios.length === 0) {
        window.setTimeout(bootstrap, 0);
        return;
    }

    let currentApp: ReturnType<typeof createPFairnessApp> | null = null;

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

        scenarioDescription.textContent = scenario.description;
        currentApp = createPFairnessApp({
            svgSelector: "svg",
            pInputSelector: "#pValue",
            statusSelector: "#status",
            nodes: scenario.nodes,
            links: scenario.links,
            tokens: scenario.tokens,
            initialP: scenario.initialP,
        });
    }

    renderScenarioOptions();

    scenarioSelect.addEventListener("change", event => {
        const target = event.target as HTMLSelectElement;
        loadScenario(Number.parseInt(target.value, 10));
    });

    scenarioSelect.value = "0";
    loadScenario(0);
}

if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
    bootstrap();
}