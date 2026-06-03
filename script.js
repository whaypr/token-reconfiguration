// 1. Setup Graph Data (A Petersen-like graph for demonstration)
const nodes = Array.from({ length: 10 }, (_, i) => ({ id: i }));
const links = [
    { source: 0, target: 1 }, { source: 1, target: 2 }, { source: 2, target: 3 },
    { source: 3, target: 4 }, { source: 4, target: 0 }, { source: 0, target: 5 },
    { source: 1, target: 6 }, { source: 2, target: 7 }, { source: 3, target: 8 },
    { source: 4, target: 9 }, { source: 5, target: 7 }, { source: 7, target: 9 },
    { source: 9, target: 6 }, { source: 6, target: 8 }, { source: 8, target: 5 }
];

// 2. Setup Tokens (Assigned to node IDs)
let tokens = [
    { id: 't1', nodeId: 0 },
    { id: 't2', nodeId: 3 },
    { id: 't3', nodeId: 6 }
];

let selectedTokenId = null;
let legalMoveTargets = new Set();

let p = parseInt(document.getElementById('pValue').value);
document.getElementById('pValue').addEventListener('change', (e) => {
    const nextP = parseInt(e.target.value);
    applyPValue(nextP);
});

const svg = d3.select("svg"), width = +svg.attr("width"), height = +svg.attr("height");

// 3. Force Simulation for Graph Layout
const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(100))
    .force("charge", d3.forceManyBody().strength(-400))
    .force("center", d3.forceCenter(width / 2, height / 2));

const link = svg.append("g").selectAll(".link")
    .data(links).enter().append("line").attr("class", "link");

const node = svg.append("g").selectAll(".node")
    .data(nodes).enter().append("circle")
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

    links.forEach(link => {
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

function canPlaceTokenAtNode(nodeId, candidateTokens = tokens, candidateP = p) {
    if (getTokenAtNode(nodeId)) {
        return false;
    }

    const proposedTokens = [...candidateTokens, { id: "__proposed__", nodeId }];
    return isConfigurationValid(proposedTokens, candidateP);
}

function isConfigurationValid(candidateTokens = tokens, candidateP = p) {
    return nodes.every(nodeData => {
        const neighborhood = getClosedNeighborhood(nodeData.id);
        return countTokensInNeighborhood(neighborhood, candidateTokens) <= candidateP;
    });
}

function areNeighbors(sourceNodeId, targetNodeId) {
    return links.some(link => {
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

    return links
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
    document.getElementById('status').textContent = message;
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

function positionTokens() {
    tokenGroup.selectAll(".token")
        .attr("cx", d => nodes[d.nodeId].x)
        .attr("cy", d => nodes[d.nodeId].y);
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
        document.getElementById('pValue').value = String(p);
        return;
    }

    if (!isConfigurationValid(tokens, nextP)) {
        document.getElementById('pValue').value = String(p);
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

// Run simulation ticks
simulation.on("tick", () => {
    link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    node.attr("cx", d => d.x).attr("cy", d => d.y);
    positionTokens();
});

// Initialize
renderTokens();
updateFairness();
setStatus('Select a token to see legal moves.');