/**
 * Cliente Participante - Comunicación bidireccional con el servidor mediante WebSocket estándar.
 * Incluye reconexión automática que recupera el nombre y el estado de la lista (Opcional implementado).
 * También expone `window.ws` para poder enviar mensajes de prueba desde la consola del navegador.
 */
(() => {
  const urlSearch = new URLSearchParams(window.location.search);
  const demoSlot = urlSearch.get('demo') || 'default';
  const STORAGE_KEY_NAME = `tp4_participant_name_${demoSlot}`;
  const STORAGE_KEY_ROOM = `tp4_participant_room_${demoSlot}`;

  let ws = null;
  let currentName = null;
  let currentRoom = 'general';
  let currentState = null;
  let reconnectTimer = null;
  let manualDisconnect = false;

  // Referencias del DOM
  const connBadge = document.getElementById('conn-badge');
  const userBadge = document.getElementById('user-badge');
  const joinSection = document.getElementById('join-section');
  const joinForm = document.getElementById('join-form');
  const nameInput = document.getElementById('participant-name');
  const roomInput = document.getElementById('room-code');
  const joinError = document.getElementById('join-error');

  const appSection = document.getElementById('app-section');
  const serverErrorBanner = document.getElementById('server-error-banner');
  const participantsCount = document.getElementById('participants-count');
  const participantsList = document.getElementById('participants-list');
  const activeRoomLabel = document.getElementById('active-room-label');
  const changeUserBtn = document.getElementById('change-user-btn');

  const proposeForm = document.getElementById('propose-form');
  const productIdsInput = document.getElementById('product-ids-input');
  const proposeBtn = document.getElementById('propose-btn');
  const proposalLoading = document.getElementById('proposal-loading');
  const proposalFeedback = document.getElementById('proposal-feedback');

  const productsCount = document.getElementById('products-count');
  const policyHint = document.getElementById('policy-hint');
  const productsContainer = document.getElementById('products-container');

  // Botones de prueba de validación del servidor
  const testInvalidJsonBtn = document.getElementById('test-invalid-json-btn');
  const testUnknownTypeBtn = document.getElementById('test-unknown-type-btn');
  const testOutOfRangeBtn = document.getElementById('test-out-of-range-btn');

  function setConnectionStatus(isOnline, label) {
    connBadge.textContent = label;
    connBadge.className = `badge ${isOnline ? 'online' : 'offline'}`;
  }

  function showServerError(code, message) {
    if (!currentName) {
      joinError.textContent = `[${code}] ${message}`;
      joinError.classList.remove('hidden');
      return;
    }
    serverErrorBanner.innerHTML = `<strong>Error del servidor (${escapeHtml(code)}):</strong> ${escapeHtml(message)}`;
    serverErrorBanner.classList.remove('hidden');
  }

  function clearErrors() {
    joinError.classList.add('hidden');
    serverErrorBanner.classList.add('hidden');
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function connectWebSocket(onOpenCallback) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      if (ws.readyState === WebSocket.OPEN && onOpenCallback) {
        onOpenCallback();
      }
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    ws = new WebSocket(wsUrl);
    // Exponer en window para pruebas desde la consola del navegador (Requisito: "un mensaje inválido enviado desde la consola del navegador recibe un error y el servidor sigue funcionando")
    window.ws = ws;

    ws.addEventListener('open', () => {
      setConnectionStatus(true, 'WebSocket Conectado');
      if (onOpenCallback) {
        onOpenCallback();
      } else if (currentName) {
        // Reconexión automática: recuperar nombre y estado de la lista
        sendJson({ type: 'JOIN', name: currentName, roomCode: currentRoom });
      }
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleServerMessage(msg);
    });

    ws.addEventListener('close', () => {
      setConnectionStatus(false, 'Desconectado (Reconectando...)');
      proposalLoading.classList.add('hidden');
      proposeBtn.disabled = false;

      if (!manualDisconnect) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          connectWebSocket();
        }, 2000);
      }
    });
  }

  function sendJson(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showServerError('CONNECTION_CLOSED', 'La conexión WebSocket no está abierta.');
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'WELCOME': {
        currentName = msg.name;
        currentRoom = msg.roomCode;
        sessionStorage.setItem(STORAGE_KEY_NAME, currentName);
        sessionStorage.setItem(STORAGE_KEY_ROOM, currentRoom);

        clearErrors();
        joinSection.classList.add('hidden');
        appSection.classList.remove('hidden');

        userBadge.textContent = `👤 ${currentName}`;
        userBadge.classList.remove('hidden');
        activeRoomLabel.textContent = currentRoom;

        if (msg.config && msg.config.removePolicy) {
          policyHint.textContent = `ℹ️ Regla para quitar: ${msg.config.removePolicy} (Timeout catálogo: ${msg.config.catalogTimeoutMs} ms)`;
        }

        renderRoomState(msg.state);
        break;
      }

      case 'STATE_UPDATED': {
        renderRoomState(msg.state);
        break;
      }

      case 'PROPOSAL_RESULT': {
        proposalLoading.classList.add('hidden');
        proposeBtn.disabled = false;
        renderProposalFeedback(msg.result);
        break;
      }

      case 'ERROR': {
        proposalLoading.classList.add('hidden');
        proposeBtn.disabled = false;
        showServerError(msg.code, msg.message);
        break;
      }

      case 'PONG':
        break;
    }
  }

  function renderProposalFeedback(result) {
    const added = result.added || [];
    const failed = result.failed || [];

    const parts = [];

    if (added.length > 0) {
      const titles = added.map((p) => `#${p.id} "${escapeHtml(p.title)}"`).join(', ');
      parts.push(
        `<div class="alert-box success">✅ <strong>Agregados (${added.length}):</strong> ${titles}</div>`
      );
    }

    if (failed.length > 0) {
      const itemsHtml = failed
        .map(
          (f) =>
            `<li><strong>Producto #${escapeHtml(f.productId)}</strong> [${escapeHtml(
              translateReason(f.reason)
            )}]: ${escapeHtml(f.message)}</li>`
        )
        .join('');
      parts.push(
        `<div class="alert-box warning">
          ⚠️ <strong>No se pudieron agregar (${failed.length}) — Solo vos ves este detalle:</strong>
          <ul style="margin-top: 6px; padding-left: 20px;">${itemsHtml}</ul>
        </div>`
      );
    }

    proposalFeedback.innerHTML = parts.join('');
    proposalFeedback.classList.remove('hidden');
  }

  function translateReason(reason) {
    switch (reason) {
      case 'NOT_FOUND':
        return 'Producto inexistente';
      case 'TIMEOUT':
        return 'Catálogo no respondió a tiempo';
      case 'ALREADY_IN_LIST':
        return 'Ya estaba en la lista';
      default:
        return 'Error del catálogo';
    }
  }

  function renderRoomState(state) {
    currentState = state;
    participantsCount.textContent = String(state.participantCount);

    participantsList.innerHTML = state.participants
      .map((name) => {
        const isMe =
          currentName && name.trim().toLowerCase() === currentName.trim().toLowerCase();
        return `<li>
          <span><span class="dot"></span>${escapeHtml(name)}</span>
          ${isMe ? '<span class="badge">Vos</span>' : ''}
        </li>`;
      })
      .join('');

    productsCount.textContent = String(state.products.length);

    if (state.products.length === 0) {
      productsContainer.innerHTML = `
        <div class="empty-state">
          Aún no hay productos en la lista. ¡Proponé el primero ingresando sus IDs del catálogo!
        </div>
      `;
      return;
    }

    productsContainer.innerHTML = state.products
      .map((product, index) => {
        const hasVoted =
          currentName &&
          product.votes.some(
            (voter) => voter.trim().toLowerCase() === currentName.trim().toLowerCase()
          );
        const isProposer =
          currentName &&
          product.proposedBy.trim().toLowerCase() === currentName.trim().toLowerCase();
        const canRemove = isProposer || product.voteCount === 0;

        const votersHtml =
          product.votes.length > 0
            ? `<div class="voter-pills">${product.votes
                .map((v) => `<span class="voter-pill">👍 ${escapeHtml(v)}</span>`)
                .join('')}</div>`
            : `<div class="help-text">Sin votos aún</div>`;

        return `
          <article class="product-card" data-product-id="${product.id}">
            <div class="rank-number ${index === 0 && product.voteCount > 0 ? 'top-1' : ''}">
              #${index + 1}
            </div>
            <img
              class="product-thumb"
              src="${escapeHtml(product.thumbnail)}"
              alt="${escapeHtml(product.title)}"
              loading="lazy"
            />
            <div class="product-info">
              <h3>${escapeHtml(product.title)} <span class="help-text">(ID #${product.id})</span></h3>
              <div class="product-meta">
                <span class="product-price">$${Number(product.price).toFixed(2)}</span>
                <span>Propuesto por: <strong>${escapeHtml(product.proposedBy)}</strong></span>
              </div>
              ${votersHtml}
            </div>
            <div class="product-actions">
              <div class="vote-counter" title="Cantidad de votos">
                👍 ${product.voteCount}
              </div>
              <button
                type="button"
                class="vote-toggle-btn ${hasVoted ? 'voted' : ''}"
                data-action="${hasVoted ? 'unvote' : 'vote'}"
                data-id="${product.id}"
              >
                ${hasVoted ? '✓ Votado (Quitar voto)' : 'Votar'}
              </button>
              <button
                type="button"
                class="danger remove-product-btn"
                data-id="${product.id}"
                ${canRemove ? '' : 'title="Solo quien lo propuso puede quitarlo cuando tiene votos"'}
              >
                🗑️ Quitar
              </button>
            </div>
          </article>
        `;
      })
      .join('');
  }

  // Eventos de formulario
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors();
    const desiredName = nameInput.value.trim();
    const desiredRoom = (roomInput.value.trim() || 'general').toLowerCase();

    manualDisconnect = false;
    connectWebSocket(() => {
      sendJson({
        type: 'JOIN',
        name: desiredName,
        roomCode: desiredRoom,
      });
    });
  });

  changeUserBtn.addEventListener('click', () => {
    manualDisconnect = true;
    sessionStorage.removeItem(STORAGE_KEY_NAME);
    currentName = null;
    if (ws) {
      ws.close();
    }
    appSection.classList.add('hidden');
    userBadge.classList.add('hidden');
    joinSection.classList.remove('hidden');
    nameInput.focus();
  });

  function parseProductIdsInput(rawText) {
    const tokens = rawText
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    return tokens.map((token) => {
      const n = Number(token);
      return Number.isNaN(n) ? token : n;
    });
  }

  proposeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors();
    proposalFeedback.classList.add('hidden');

    const raw = productIdsInput.value.trim();
    const parsedIds = parseProductIdsInput(raw);

    proposalLoading.classList.remove('hidden');
    proposeBtn.disabled = true;

    sendJson({
      type: 'PROPOSE_PRODUCTS',
      productIds: parsedIds,
      requestId: `req-${Date.now()}`,
    });
  });

  // Botones de ejemplo rápido
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ids = btn.getAttribute('data-ids') || '';
      productIdsInput.value = ids;
      productIdsInput.focus();
    });
  });

  // Delegación de eventos para Votar / Retirar voto / Quitar producto
  productsContainer.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    const voteBtn = target.closest('.vote-toggle-btn');
    if (voteBtn) {
      clearErrors();
      const productId = Number(voteBtn.getAttribute('data-id'));
      const action = voteBtn.getAttribute('data-action');
      sendJson({
        type: action === 'unvote' ? 'UNVOTE_PRODUCT' : 'VOTE_PRODUCT',
        productId,
      });
      return;
    }

    const removeBtn = target.closest('.remove-product-btn');
    if (removeBtn) {
      clearErrors();
      const productId = Number(removeBtn.getAttribute('data-id'));
      sendJson({
        type: 'REMOVE_PRODUCT',
        productId,
      });
    }
  });

  // Botones para demostrar la validación del servidor ante mensajes inválidos
  testInvalidJsonBtn.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('{ esto_no_es_json_valido ');
    }
  });

  testUnknownTypeBtn.addEventListener('click', () => {
    sendJson({ type: 'HACK_SERVER', payload: 123 });
  });

  testOutOfRangeBtn.addEventListener('click', () => {
    sendJson({
      type: 'PROPOSE_PRODUCTS',
      productIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    });
  });

  // Inicialización y auto-reconexión si había sesión guardada en esta pestaña
  const savedName = sessionStorage.getItem(STORAGE_KEY_NAME);
  const savedRoom = sessionStorage.getItem(STORAGE_KEY_ROOM) || 'general';
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('room')) {
    roomInput.value = urlParams.get('room');
  } else if (savedRoom) {
    roomInput.value = savedRoom;
  }

  connectWebSocket(() => {
    if (savedName) {
      nameInput.value = savedName;
      currentRoom = roomInput.value || 'general';
      sendJson({
        type: 'JOIN',
        name: savedName,
        roomCode: currentRoom,
      });
    }
  });
})();
