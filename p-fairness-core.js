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

    svg.style("touch-action", "none");

    const graphNodes = nodes.map((node, index) => createGraphNode(node, index));
    let graphLinks = links.map(link => ({ ...link }));
    let nodeById = new Map(graphNodes.map(node => [node.id, node]));

    let tokens = initialTokens.map(token => ({ ...token }));
    let selectedTokenId = null;
    let legalMoveTargets = new Set();
    let p = initialP;
    let edgeDragState = null;
    let currentTransform = d3.zoomIdentity;

    let nextNodeId = graphNodes.reduce((maxId, node) => {
        const numericId = typeof node.id === "number" ? node.id : Number(node.id);
        return Number.isFinite(numericId) ? Math.max(maxId, numericId) : maxId;
    }, -1) + 1;

    const defaultStatusMessage = 'Select a token to see legal moves. Middle-click empty space to add a node, middle-click a node to remove it, right-drag from a vertex to create an edge, and left-drag the background to pan.';

    const background = svg.append("rect")
        .attr("class", "graph-background")
        .attr("width", width)
        .attr("height", height);

    const graphViewport = svg.append("g").attr("class", "graph-viewport");
    const linkLayer = graphViewport.append("g").attr("class", "link-layer");
    const nodeLayer = graphViewport.append("g").attr("class", "node-layer");
    const tokenLayer = graphViewport.append("g").attr("class", "token-layer");
    const interactionLayer = graphViewport.append("g").attr("class", "interaction-layer");
    const edgePreview = interactionLayer.append("line")
        .attr("class", "edge-preview")
        .style("display", "none");

    const simulation = d3.forceSimulation(graphNodes)
        .velocityDecay(0.78)
        .force("link", d3.forceLink(graphLinks).id(d => d.id).distance(120).strength(0.75))
        .force("charge", d3.forceManyBody().strength(-35))
        .force("collide", d3.forceCollide(26))
        .force("x", d3.forceX(d => d.anchorX).strength(0.4))
        .force("y", d3.forceY(d => d.anchorY).strength(0.4));

    const zoomBehavior = d3.zoom()
        .scaleExtent([0.5, 3])
        .filter(event => event.type === "wheel" || (event.type === "mousedown" && event.button === 0) || event.type === "dblclick")
        .on("zoom", event => {
            currentTransform = event.transform;
            graphViewport.attr("transform", currentTransform);
        });

    const nodeDrag = d3.drag()
        .filter(event => event.button === 0)
        .on("start", handleNodeDragStart)
        .on("drag", handleNodeDragged)
        .on("end", handleNodeDragEnd);

    function createGraphNode(node, index) {
        const hasPosition = Number.isFinite(node.x) && Number.isFinite(node.y);
        const fallbackRadius = Math.min(width, height) * 0.32;
        const angle = nodes.length > 0 ? (index / nodes.length) * Math.PI * 2 : 0;
        const x = hasPosition ? node.x : width / 2 + Math.cos(angle) * fallbackRadius;
        const y = hasPosition ? node.y : height / 2 + Math.sin(angle) * fallbackRadius;

        return {
            ...node,
            x,
            y,
            vx: 0,
            vy: 0,
            fx: x,
            fy: y,
            anchorX: x,
            anchorY: y,
        };
    }

    function toGraphPoint(event) {
        const [x, y] = d3.pointer(event, svg.node());
        return currentTransform.invert([x, y]);
    }

    function getLinkEndpoint(endpoint) {
        return typeof endpoint === "object" ? endpoint.id : endpoint;
    }

    function getLinkKey(linkData) {
        const sourceId = getLinkEndpoint(linkData.source);
        const targetId = getLinkEndpoint(linkData.target);
        return String(sourceId) < String(targetId)
            ? `${sourceId}--${targetId}`
            : `${targetId}--${sourceId}`;
    }

    function refreshNodeIndex() {
        nodeById = new Map(graphNodes.map(node => [node.id, node]));
    }

    function syncSimulation() {
        refreshNodeIndex();
        simulation.nodes(graphNodes);
        simulation.force("link").links(graphLinks);
        simulation.alpha(0.6).restart();
    }

    function positionGraphElements() {
        linkLayer.selectAll(".link")
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        nodeLayer.selectAll(".node")
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);

        if (edgeDragState) {
            edgePreview
                .style("display", null)
                .attr("x1", edgeDragState.x1)
                .attr("y1", edgeDragState.y1)
                .attr("x2", edgeDragState.x2)
                .attr("y2", edgeDragState.y2);
        } else {
            edgePreview.style("display", "none");
        }

        positionTokens();
    }

    function setStatus(message) {
        statusElement.textContent = message;
    }

    function getClosedNeighborhood(nodeId) {
        const neighborhood = new Set([nodeId]);

        graphLinks.forEach(linkData => {
            const sourceId = getLinkEndpoint(linkData.source);
            const targetId = getLinkEndpoint(linkData.target);

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
        return graphLinks.some(linkData => {
            const sourceId = getLinkEndpoint(linkData.source);
            const targetId = getLinkEndpoint(linkData.target);
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
            .map(linkData => {
                const sourceId = getLinkEndpoint(linkData.source);
                const targetId = getLinkEndpoint(linkData.target);
                if (sourceId === token.nodeId) return targetId;
                if (targetId === token.nodeId) return sourceId;
                return null;
            })
            .filter(nodeId => nodeId !== null && canMoveToken(tokenId, nodeId));
    }

    function isTokenFrozen(tokenId) {
        return getLegalMoveTargets(tokenId).length === 0;
    }

    function updateNodeClasses() {
        nodeLayer.selectAll(".node")
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
        tokenLayer.selectAll(".token")
            .attr("class", d => {
                const classes = ["token"];
                if (d.id === selectedTokenId) {
                    classes.push("selected");
                }
                return classes.join(" ");
            });
    }

    function positionTokens() {
        tokenLayer.selectAll(".token")
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
        const tokenElements = tokenLayer.selectAll(".token").data(tokens, d => d.id);

        tokenElements.exit().remove();

        tokenElements.enter().append("circle")
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

        positionTokens();
        updateTokenClasses();
    }

    function clearSelection() {
        selectedTokenId = null;
        legalMoveTargets = new Set();
        updateNodeClasses();
        updateTokenClasses();
        setStatus(defaultStatusMessage);
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
        legalMoveTargets = selectedTokenId ? new Set(getLegalMoveTargets(selectedTokenId)) : new Set();
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

    function getNodeAtPoint(x, y, ignoredNodeId = null) {
        const matchRadius = 22;
        let closestNode = null;
        let closestDistance = Infinity;

        graphNodes.forEach(nodeData => {
            if (nodeData.id === ignoredNodeId || !Number.isFinite(nodeData.x) || !Number.isFinite(nodeData.y)) {
                return;
            }

            const dx = nodeData.x - x;
            const dy = nodeData.y - y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < closestDistance) {
                closestDistance = distance;
                closestNode = nodeData;
            }
        });

        return closestDistance <= matchRadius ? closestNode : null;
    }

    function hasEdge(sourceNodeId, targetNodeId) {
        return graphLinks.some(linkData => {
            const sourceId = getLinkEndpoint(linkData.source);
            const targetId = getLinkEndpoint(linkData.target);
            return (sourceId === sourceNodeId && targetId === targetNodeId) ||
                (sourceId === targetNodeId && targetId === sourceNodeId);
        });
    }

    function addNodeAtPoint(x, y) {
        const nodeData = {
            id: nextNodeId,
            x,
            y,
            vx: 0,
            vy: 0,
            fx: x,
            fy: y,
            anchorX: x,
            anchorY: y,
        };

        nextNodeId += 1;
        graphNodes.push(nodeData);
        return nodeData;
    }

    function addEdge(sourceNodeId, targetNodeId) {
        if (sourceNodeId === targetNodeId || hasEdge(sourceNodeId, targetNodeId)) {
            return false;
        }

        graphLinks.push({ source: sourceNodeId, target: targetNodeId });
        return true;
    }

    function removeNode(nodeId) {
        const nodeIndex = graphNodes.findIndex(nodeData => nodeData.id === nodeId);
        if (nodeIndex === -1) {
            return false;
        }

        const tokenOnNode = getTokenAtNode(nodeId);
        if (tokenOnNode) {
            tokens = tokens.filter(token => token.id !== tokenOnNode.id);
            if (selectedTokenId === tokenOnNode.id) {
                selectedTokenId = null;
                legalMoveTargets = new Set();
            }
        }

        if (edgeDragState && edgeDragState.source.id === nodeId) {
            stopEdgeDrag();
        }

        graphNodes.splice(nodeIndex, 1);
        graphLinks = graphLinks.filter(linkData => {
            const sourceId = getLinkEndpoint(linkData.source);
            const targetId = getLinkEndpoint(linkData.target);
            return sourceId !== nodeId && targetId !== nodeId;
        });

        refreshNodeIndex();
        refreshSelectionState();
        return true;
    }

    function refreshSelectionState() {
        legalMoveTargets = selectedTokenId ? new Set(getLegalMoveTargets(selectedTokenId)) : new Set();
    }

    function renderGraph() {
        linkLayer.selectAll(".link")
            .data(graphLinks, getLinkKey)
            .join(
                enter => enter.append("line").attr("class", "link"),
                update => update,
                exit => exit.remove()
            );

        const nodeSelection = nodeLayer.selectAll(".node")
            .data(graphNodes, d => d.id)
            .join(
                enter => enter.append("circle")
                    .attr("class", "node")
                    .attr("r", 20),
                update => update,
                exit => exit.remove()
            );

        nodeSelection
            .call(nodeDrag)
            .on("click", (event, d) => handleNodeClick(d.id))
            .on("dblclick", (event, d) => {
                event.preventDefault();
                event.stopPropagation();
                toggleTokenAtNode(d.id);
            })
            .on("mousedown", (event, d) => handleNodeMouseDown(event, d))
            .on("contextmenu", event => event.preventDefault());

        background
            .on("mousedown", handleBackgroundMouseDown)
            .on("contextmenu", event => event.preventDefault());

        refreshNodeIndex();
        updateNodeClasses();
        positionGraphElements();
    }

    function refreshGraphAfterMutation(message) {
        syncSimulation();
        renderGraph();
        renderTokens();
        refreshSelectionState();
        updateNodeClasses();
        updateTokenClasses();
        positionGraphElements();

        if (message) {
            setStatus(message);
        }
    }

    function handleNodeMouseDown(event, nodeData) {
        if (event.button === 1) {
            event.preventDefault();
            event.stopPropagation();
            if (removeNode(nodeData.id)) {
                refreshGraphAfterMutation(`Node ${nodeData.id} removed.`);
            }
            return;
        }

        if (event.button === 2) {
            event.preventDefault();
            event.stopPropagation();
            startEdgeDrag(nodeData);
        }
    }

    function handleBackgroundMouseDown(event) {
        if (event.button !== 1 || event.target !== background.node()) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        const [x, y] = toGraphPoint(event);
        const nodeData = addNodeAtPoint(x, y);
        refreshGraphAfterMutation(`Node ${nodeData.id} added.`);
    }

    function startEdgeDrag(nodeData) {
        const [x, y] = [nodeData.x, nodeData.y];
        edgeDragState = {
            source: nodeData,
            x1: x,
            y1: y,
            x2: x,
            y2: y,
        };

        edgePreview
            .style("display", null)
            .attr("x1", x)
            .attr("y1", y)
            .attr("x2", x)
            .attr("y2", y);

        window.addEventListener("mousemove", handleWindowMouseMove);
        window.addEventListener("mouseup", handleWindowMouseUp);
    }

    function stopEdgeDrag() {
        if (!edgeDragState) {
            return;
        }

        edgeDragState = null;
        edgePreview.style("display", "none");
        window.removeEventListener("mousemove", handleWindowMouseMove);
        window.removeEventListener("mouseup", handleWindowMouseUp);
    }

    function handleWindowMouseMove(event) {
        if (!edgeDragState) {
            return;
        }

        const [x, y] = toGraphPoint(event);
        edgeDragState.x2 = x;
        edgeDragState.y2 = y;
        edgePreview
            .attr("x2", x)
            .attr("y2", y);
    }

    function handleWindowMouseUp(event) {
        if (!edgeDragState || event.button !== 2) {
            return;
        }

        event.preventDefault();
        const [x, y] = toGraphPoint(event);
        const sourceNodeId = edgeDragState.source.id;
        const targetNode = getNodeAtPoint(x, y, sourceNodeId);

        if (targetNode) {
            if (addEdge(sourceNodeId, targetNode.id)) {
                refreshGraphAfterMutation(`Edge added between nodes ${sourceNodeId} and ${targetNode.id}.`);
            } else {
                setStatus(`Nodes ${sourceNodeId} and ${targetNode.id} are already connected.`);
            }
            stopEdgeDrag();
            return;
        }

        const newNodeData = addNodeAtPoint(x, y);
        if (addEdge(sourceNodeId, newNodeData.id)) {
            refreshGraphAfterMutation(`Node ${newNodeData.id} added and connected to node ${sourceNodeId}.`);
        }

        stopEdgeDrag();
    }

    function handleNodeDragStart(event, d) {
        if (!event.active) {
            simulation.alphaTarget(0.25).restart();
        }

        d.fx = d.x;
        d.fy = d.y;
        setStatus(`Dragging node ${d.id}.`);
    }

    function handleNodeDragged(event, d) {
        const [x, y] = toGraphPoint(event.sourceEvent);
        d.fx = x;
        d.fy = y;
        positionGraphElements();
    }

    function handleNodeDragEnd(event, d) {
        if (!event.active) {
            simulation.alphaTarget(0);
        }

        d.anchorX = d.x;
        d.anchorY = d.y;
        d.fx = d.x;
        d.fy = d.y;
        setStatus(`Node ${d.id} moved.`);
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
        refreshSelectionState();
        updateNodeClasses();
        updateTokenClasses();
        setStatus(`p updated to ${p}.`);
    }

    function updateFairness() {
        refreshSelectionState();
        updateNodeClasses();
        updateTokenClasses();
    }

    function handlePChange(event) {
        applyPValue(parseInt(event.target.value, 10));
    }

    function handleZoom(event) {
        currentTransform = event.transform;
        graphViewport.attr("transform", currentTransform);
    }

    pInput.value = String(p);
    pInput.addEventListener('change', handlePChange);
    svg.call(zoomBehavior);
    svg.on('contextmenu', event => event.preventDefault());

    simulation.on("tick", positionGraphElements);

    refreshGraphAfterMutation();
    updateFairness();
    clearSelection();

    return {
        setStatus,
        destroy() {
            simulation.stop();
            pInput.removeEventListener('change', handlePChange);
            svg.on('.zoom', null);
            svg.on('contextmenu', null);
            background.on('mousedown', null);
            background.on('contextmenu', null);
            window.removeEventListener('mousemove', handleWindowMouseMove);
            window.removeEventListener('mouseup', handleWindowMouseUp);
            svg.selectAll('*').remove();
        },
    };
}

window.createPFairnessApp = createPFairnessApp;
