function bootstrap() {
    const scenarioSelect = document.getElementById('scenarioSelect');
    const scenarioDescription = document.getElementById('scenarioDescription');
    const scenarios = window.pFairnessScenarios || [];
    const createPFairnessApp = window.createPFairnessApp;

    if (!scenarioSelect || !scenarioDescription || !createPFairnessApp || scenarios.length === 0) {
        window.setTimeout(bootstrap, 0);
        return;
    }

    let currentApp = null;

    function renderScenarioOptions() {
        scenarioSelect.innerHTML = '';

        scenarios.forEach((scenario, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = scenario.name;
            scenarioSelect.appendChild(option);
        });
    }

    function loadScenario(index) {
        const scenario = scenarios[index] || scenarios[0];

        if (currentApp) {
            currentApp.destroy();
        }

        scenarioDescription.textContent = scenario.description;
        currentApp = createPFairnessApp({
            svgSelector: 'svg',
            pInputSelector: '#pValue',
            statusSelector: '#status',
            nodes: scenario.nodes,
            links: scenario.links,
            tokens: scenario.tokens,
            initialP: scenario.initialP,
        });
    }

    renderScenarioOptions();

    scenarioSelect.addEventListener('change', event => {
        loadScenario(parseInt(event.target.value, 10));
    });

    scenarioSelect.value = '0';
    loadScenario(0);
}

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
    bootstrap();
}