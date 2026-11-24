/**
 * Cliente Pantalla - Solo muestra el ranking y los participantes conectados.
 * Recibe las novedades únicamente por Server-Sent Events (EventSource) y nunca envía nada al servidor.
 */
(() => {
  const sseBadge = document.getElementById('sse-badge');
  const screenParticipantsCount = document.getElementById('screen-participants-count');
  const sidebarParticipantsCount = document.getElementById('sidebar-participants-count');
  const screenRoomCode = document.getElementById('screen-room-code');
  const screenParticipantsList = document.getElementById('screen-participants-list');
  const screenProductsCount = document.getElementById('screen-products-count');
  const screenProductsContainer = document.getElementById('screen-products-container');
  const lastEventText = document.getElementById('last-event-text');
  const lastUpdatedTime = document.getElementById('last-updated-time');

  const urlParams = new URLSearchParams(window.location.search);
  const room = (urlParams.get('room') || 'general').trim().toLowerCase();
  screenRoomCode.textContent = room;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function describeReason(reason, actor) {
    const who = actor ? ` (${actor})` : '';
    switch (reason) {
      case 'PARTICIPANT_JOINED':
        return `Entró un participante a la lista${who}`;
      case 'PARTICIPANT_LEFT':
        return `Se desconectó un participante${who}`;
      case 'PRODUCTS_ADDED':
        return `Se agregaron nuevos productos${who}`;
      case 'VOTE_CHANGED':
        return `Actualización de votos en el ranking${who}`;
      case 'PRODUCT_REMOVED':
        return `Se quitó un producto de la lista${who}`;
      default:
        return 'Estado inicial cargado';
    }
  }

  function renderState(state, reasonLabel) {
    screenParticipantsCount.textContent = String(state.participantCount);
    sidebarParticipantsCount.textContent = String(state.participantCount);
    screenProductsCount.textContent = String(state.products.length);

    if (reasonLabel) {
      lastEventText.textContent = reasonLabel;
    }
    lastUpdatedTime.textContent = `Actualizado: ${new Date(state.updatedAt).toLocaleTimeString()}`;

    if (state.participants.length === 0) {
      screenParticipantsList.innerHTML = `<li class="help-text">Sin participantes conectados</li>`;
    } else {
      screenParticipantsList.innerHTML = state.participants
        .map(
          (name) => `<li><span><span class="dot"></span>${escapeHtml(name)}</span></li>`
        )
        .join('');
    }

    if (state.products.length === 0) {
      screenProductsContainer.innerHTML = `
        <div class="empty-state">
          Todavía no hay productos propuestos en la sala <strong>${escapeHtml(state.roomCode)}</strong>.
        </div>
      `;
      return;
    }

    screenProductsContainer.innerHTML = state.products
      .map((product, index) => {
        const votersHtml =
          product.votes.length > 0
            ? `<div class="voter-pills">${product.votes
                .map((v) => `<span class="voter-pill">👍 ${escapeHtml(v)}</span>`)
                .join('')}</div>`
            : `<div class="help-text">0 votos</div>`;

        return `
          <article class="product-card">
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
              <div class="vote-counter">
                👍 ${product.voteCount} ${product.voteCount === 1 ? 'voto' : 'votos'}
              </div>
            </div>
          </article>
        `;
      })
      .join('');
  }

  const sseUrl = `/events?room=${encodeURIComponent(room)}`;
  const eventSource = new EventSource(sseUrl);

  eventSource.addEventListener('open', () => {
    sseBadge.textContent = 'SSE En Vivo';
    sseBadge.className = 'badge online';
  });

  eventSource.addEventListener('initial_state', (event) => {
    const state = JSON.parse(event.data);
    renderState(state, 'Estado inicial recibido al conectar la pantalla');
  });

  eventSource.addEventListener('state_update', (event) => {
    const payload = JSON.parse(event.data);
    renderState(payload.state, describeReason(payload.reason, payload.actor));
  });

  eventSource.addEventListener('error', () => {
    sseBadge.textContent = 'Reconectando SSE...';
    sseBadge.className = 'badge offline';
  });
})();
