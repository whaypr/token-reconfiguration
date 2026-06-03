function createPFairnessApp({
    svgSelector,
    pInputSelector,
    statusSelector,
    nodes,
    links,
    tokens: initialTokens,
    initialP,
}) {
    const svg = d3.select(svgSelector);
    const width = +svg.attr("width");
    const height = +svg.attr("height");
    const pInput = document.querySelector(pInputSelector);
    const statusElement = document.querySelector(statusSelector);

    const graphNodes = nodes.map(node => ({ ...node }));
    const graphLinks = links.map(link => ({ ...link }));
    const nodeById = new Map(graphNodes.map(node => [node.id, node]));

    let tokens = initialTokens.map(token => ({ ...token }));
    let selectedTokenId = null;
    let legalMoveTargets = new Set();
    let p = initialP;

    const simulation = d3.forceSimulation(graphNodes)
        .force("link", d3.forceLink(graphLinks).id(d => d.id).distance(100))
        .force("charge", d3.forceManyBody().strength(-400))
        .force("center", d3.forceCenter(width / 2, height / 2));

    const link = svg.append("g").selectAll(".link")
        .data(graphLinks).enter().append("line").attr("class", "link");

    const node = svg.append("g").selectAll(".node")
        .data(graphNodes).enter().append("circle")
        .attr("class", "node empty")
        .attr("r", 20)
        .on("click", (event, d) => handleNodeClick(d.id))
        .on("dblclick", (event, d) => {
            event.preventDefault();
            event.stopPropagation();
            toggleTokenAtNode(d.id);
        });

    const tokenGroup = svg.append("g");

    function getLinkEndpoint(endpoint) {
        return typeof endpoint === "object" ? endpoint.id : endpoint;
    }

    function getClosedNeighborhood(nodeId) {
        const neighborhood = new Set([nodeId]);

        graphLinks.forEach(link => {
            const sourceId = getLinkEndpoint(link.source);
            const targetId = getLinkEndpoint(link.target);

            if (sourceId === nodeId) neighborhood.add(targetId);
            if (targetId === nodeId) neighborhood.add(sourceId);
        });

        return neighborhood;
    }

    function getTokenAtNode(nodeId, ignoredTokenId = null) {
        return tokens.find(token => token.nodeId === nodeId && token.id !== ignoredTokenId) || null;
    }

    function countTokensInNeighborhood(neighborhood, candidateTokens = tokens) {
        return candidateTokens.filter(token => neighborhood.has(token.nodeId)).length;
    }

    function isConfigurationValid(candidateTokens = tokens, candidateP = p) {
        return graphNodes.every(nodeData => {
            const neighborhood = getClosedNeighborhood(nodeData.id);
            return countTokensInNeighborhood(neighborhood, candidateTokens) <= candidateP;
        });
    }

    function canPlaceTokenAtNode(nodeId, candidateTokens = tokens, candidateP = p) {
        if (getTokenAtNode(nodeId)) {
            return false;
        }

        const proposedTokens = [...candidateTokens, { id: "__proposed__", nodeId }];
        return isConfigurationValid(proposedTokens, candidateP);
    }

    function areNeighbors(sourceNodeId, targetNodeId) {
        return graphLinks.some(link => {
            const sourceId = getLinkEndpoint(link.source);
            const targetId = getLinkEndpoint(link.target);
            return (sourceId === sourceNodeId && targetId === targetNodeId) ||
                (sourceId === targetNodeId && targetId === sourceNodeId);
        });
    }

    function canMoveToken(tokenId, targetNodeId, candidateP = p) {
        const token = tokens.find(item => item.id === tokenId);
        if (!token) {
            return false;
        }

        if (token.nodeId === targetNodeId) {
            return false;
        }

        if (!areNeighbors(token.nodeId, targetNodeId)) {
            return false;
        }

        if (getTokenAtNode(targetNodeId, tokenId)) {
            return false;
        }

        const proposedTokens = tokens.map(item => item.id === tokenId
            ? { ...item, nodeId: targetNodeId }
            : item);

        return isConfigurationValid(proposedTokens, candidateP);
    }

    function getLegalMoveTargets(tokenId) {
        const token = tokens.find(item => item.id === tokenId);
        if (!token) {
            return [];
        }

        return graphLinks
            .map(link => {
                const sourceId = getLinkEndpoint(link.source);
                const targetId = getLinkEndpoint(link.target);
                if (sourceId === token.nodeId) return targetId;
                if (targetId === token.nodeId) return sourceId;
                return null;
            })
            .filter(nodeId => nodeId !== null && canMoveToken(tokenId, nodeId));
    }

    function isTokenFrozen(tokenId) {
        return getLegalMoveTargets(tokenId).length === 0;
    }

    function setStatus(message) {
        statusElement.textContent = message;
    }

    function updateNodeClasses() {
        svg.selectAll(".node")
            .attr("class", d => {
                const token = getTokenAtNode(d.id);
                const classes = ["node"];

                if (!token) {
                    classes.push("empty");
                    if (canPlaceTokenAtNode(d.id)) {
                        classes.push("placeable");
                    }
                } else if (isTokenFrozen(token.id)) {
                    classes.push("frozen");
                } else {
                    classes.push("mobile");
                }

                if (selectedTokenId && token && token.id === selectedTokenId) {
                    classes.push("selected");
                }

                if (legalMoveTargets.has(d.id)) {
                    classes.push("selectable");
                }

                return classes.join(" ");
            });
    }

    function updateTokenClasses() {
        tokenGroup.selectAll(".token")
            .attr("class", d => {
                const classes = ["token"];
                if (d.id === selectedTokenId) {
                    classes.push("selected");
                }
                return classes.join(" ");
            });
    }

    function positionTokens() {
        tokenGroup.selectAll(".token")
            .attr("cx", d => {
                const nodeData = nodeById.get(d.nodeId);
                return nodeData ? nodeData.x : 0;
            })
            .attr("cy", d => {
                const nodeData = nodeById.get(d.nodeId);
                return nodeData ? nodeData.y : 0;
            });
    }

    function renderTokens() {
        const tokenElements = tokenGroup.selectAll(".token").data(tokens, d => d.id);

        tokenElements.exit().remove();

        const enterTokens = tokenElements.enter().append("circle")
            .attr("class", "token")
            .attr("r", 10)
            .on("click", (event, d) => {
                event.stopPropagation();
                selectToken(d.id);
            })
            .on("dblclick", (event, d) => {
                event.preventDefault();
                event.stopPropagation();
                deleteTokenAtNode(d.nodeId);
            });

        enterTokens.merge(tokenElements);
        positionTokens();
        updateTokenClasses();
    }

    function clearSelection() {
        selectedTokenId = null;
        legalMoveTargets = new Set();
        updateNodeClasses();
        updateTokenClasses();
        setStatus('Select a token to see legal moves.');
    }

    function selectToken(tokenId) {
        if (selectedTokenId === tokenId) {
            clearSelection();
            return;
        }

        selectedTokenId = tokenId;
        legalMoveTargets = new Set(getLegalMoveTargets(tokenId));
        updateNodeClasses();
        updateTokenClasses();

        if (legalMoveTargets.size === 0) {
            setStatus(`Token ${tokenId} is frozen and cannot move.`);
        } else {
            setStatus(`Token ${tokenId} selected. Click one of the highlighted neighbors.`);
        }
    }

    function moveToken(tokenId, targetNodeId) {
        if (!canMoveToken(tokenId, targetNodeId)) {
            setStatus('That move would violate the p-fairness rule, so it was blocked.');
            return false;
        }

        const token = tokens.find(item => item.id === tokenId);
        if (!token) {
            clearSelection();
            return false;
        }

        token.nodeId = targetNodeId;
        legalMoveTargets = new Set(getLegalMoveTargets(tokenId));
        renderTokens();
        updateNodeClasses();

        if (legalMoveTargets.size === 0) {
            setStatus(`Token ${tokenId} moved to node ${targetNodeId}. It is now frozen.`);
        } else {
            setStatus(`Token ${tokenId} moved to node ${targetNodeId}.`);
        }

        return true;
    }

    function addTokenAtNode(nodeId) {
        if (getTokenAtNode(nodeId)) {
            return false;
        }

        const tokenId = `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
        const proposedTokens = [...tokens, { id: tokenId, nodeId }];

        if (!isConfigurationValid(proposedTokens, p)) {
            setStatus(`Cannot add a token at node ${nodeId}; it would violate p-fairness.`);
            return false;
        }

        tokens.push({ id: tokenId, nodeId });
        renderTokens();
        updateNodeClasses();
        setStatus(`Token added at node ${nodeId}.`);
        return true;
    }

    function deleteTokenAtNode(nodeId) {
        const token = getTokenAtNode(nodeId);
        if (!token) {
            return false;
        }

        tokens = tokens.filter(item => item.id !== token.id);

        if (selectedTokenId === token.id) {
            clearSelection();
        } else {
            updateNodeClasses();
            updateTokenClasses();
        }

        renderTokens();
        setStatus(`Token removed from node ${nodeId}.`);
        return true;
    }

    function toggleTokenAtNode(nodeId) {
        if (getTokenAtNode(nodeId)) {
            deleteTokenAtNode(nodeId);
            return;
        }

        addTokenAtNode(nodeId);
    }

    function handleNodeClick(nodeId) {
        if (!selectedTokenId) {
            return;
        }

        if (legalMoveTargets.has(nodeId)) {
            moveToken(selectedTokenId, nodeId);
            return;
        }

        const selectedToken = tokens.find(token => token.id === selectedTokenId);
        if (selectedToken && selectedToken.nodeId === nodeId) {
            clearSelection();
            return;
        }

        setStatus('Click one of the highlighted neighbors to move the selected token.');
    }

    function applyPValue(nextP) {
        if (Number.isNaN(nextP)) {
            pInput.value = String(p);
            return;
        }

        if (!isConfigurationValid(tokens, nextP)) {
            pInput.value = String(p);
            setStatus(`p = ${nextP} would make the current configuration invalid, so it was rejected.`);
            return;
        }

        p = nextP;
        legalMoveTargets = selectedTokenId ? new Set(getLegalMoveTargets(selectedTokenId)) : new Set();
        updateNodeClasses();
        updateTokenClasses();
        setStatus(`p updated to ${p}.`);
    }

    function updateFairness() {
        updateNodeClasses();
        updateTokenClasses();
    }

    function handlePChange(event) {
        applyPValue(parseInt(event.target.value, 10));
    }

    pInput.value = String(p);
    pInput.addEventListener('change', handlePChange);

    simulation.on("tick", () => {
        link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
        node.attr("cx", d => d.x).attr("cy", d => d.y);
        positionTokens();
    });

    renderTokens();
    updateFairness();
    clearSelection();

    return {
        setStatus,
        destroy() {
            simulation.stop();
            pInput.removeEventListener('change', handlePChange);
            svg.selectAll('*').remove();
        },
    };
}

window.createPFairnessApp = createPFairnessApp;