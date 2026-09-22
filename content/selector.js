// Injetado na aba sob demanda: mostra a camada para selecionar a área, pede
// o reconhecimento ao service worker e exibe o resultado num aviso flutuante.
// Pode ser injetado várias vezes na mesma página, por isso o IIFE e a checagem.
(() => {
  if (globalThis.__copiarTextoDaTela) {
    globalThis.__copiarTextoDaTela.start();
    return;
  }

  const MIN_SIZE = 6;
  const AUTO_HIDE_MS = 8000;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .overlay {
      position: fixed; inset: 0;
      cursor: crosshair; pointer-events: auto;
      user-select: none; touch-action: none;
    }
    .shade { position: absolute; inset: 0; background: rgb(0 0 0 / .35); }
    .selection {
      position: absolute; display: none;
      border: 1px solid #fff; outline: 1px dashed rgb(0 0 0 / .6);
      box-shadow: 0 0 0 100vmax rgb(0 0 0 / .35);
    }
    .overlay.dragging .shade { display: none; }
    .overlay.dragging .selection { display: block; }
    .hint {
      position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
      padding: 8px 14px; border-radius: 999px;
      background: rgb(32 33 36 / .92); color: #fff;
      font: 13px/1.4 system-ui, "Segoe UI", sans-serif;
      white-space: nowrap; pointer-events: none;
    }
    .overlay.dragging .hint { display: none; }

    .toast {
      position: fixed; right: 16px; bottom: 16px;
      width: 380px; max-width: calc(100vw - 32px);
      display: grid; gap: 8px; padding: 12px;
      pointer-events: auto;
      background: #fff; color: #202124;
      border-radius: 12px; box-shadow: 0 8px 28px rgb(0 0 0 / .28);
      font: 13px/1.45 system-ui, "Segoe UI", sans-serif;
    }
    .header { display: flex; align-items: center; gap: 8px; }
    .title { flex: 1; font-weight: 600; }
    .icon { width: 18px; text-align: center; font-weight: 700; }
    .icon.ok { color: #188038; }
    .icon.error { color: #d93025; }
    .spinner {
      width: 16px; height: 16px; border-radius: 50%;
      border: 2px solid #c6dafc; border-top-color: #1a73e8;
      animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .detail { margin: 0; color: #5f6368; overflow-wrap: anywhere; }
    textarea {
      width: 100%; max-height: 220px; resize: vertical;
      padding: 8px; border: 1px solid #dadce0; border-radius: 8px;
      background: #f8f9fa; color: inherit;
      font: 13px/1.45 system-ui, "Segoe UI", sans-serif;
    }
    .actions { display: flex; justify-content: flex-end; }
    button {
      font: inherit; cursor: pointer; border: 0; border-radius: 8px; color: inherit;
    }
    .copy { padding: 6px 16px; font-weight: 600; background: #1a73e8; color: #fff; }
    .copy:hover { background: #1765cc; }
    .close {
      width: 28px; height: 28px; font-size: 18px; line-height: 1;
      background: transparent;
    }
    .close:hover { background: rgb(0 0 0 / .08); }

    @media (prefers-color-scheme: dark) {
      .toast { background: #292a2d; color: #e8eaed; }
      .detail { color: #9aa0a6; }
      textarea { background: #202124; border-color: #5f6368; }
      .copy { background: #8ab4f8; color: #202124; }
      .copy:hover { background: #aecbfa; }
      .close:hover { background: rgb(255 255 255 / .1); }
      .icon.ok { color: #81c995; }
      .icon.error { color: #f28b82; }
    }
  `;

  let host = null;
  let root = null;
  let overlay = null;
  let toast = null;
  let hideTimer = null;
  let pending = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ensureRoot() {
    if (host?.isConnected) return;
    host = document.createElement('copiar-texto-da-tela');
    host.style.cssText = [
      'all: initial', 'display: block', 'position: fixed', 'inset: 0',
      'width: 100vw', 'height: 100vh', 'margin: 0', 'padding: 0', 'border: 0',
      'background: transparent', 'overflow: visible',
      'z-index: 2147483647', 'pointer-events: none'
    ].map((rule) => `${rule} !important`).join(';');

    root = host.attachShadow({ mode: 'closed' });
    const style = el('style');
    style.textContent = CSS;
    root.append(style);
    document.documentElement.append(host);

    // Como popover, fica acima até de diálogos modais e elementos em tela cheia.
    try {
      host.popover = 'manual';
      host.showPopover();
    } catch {
      // Sem suporte a popover: o z-index máximo resolve na maioria das páginas.
    }
  }

  function removeRootIfEmpty() {
    if (overlay || toast) return;
    host?.remove();
    host = null;
    root = null;
  }

  // ---------- Seleção da área ----------

  function start() {
    if (overlay) return;
    closeToast();
    ensureRoot();

    overlay = el('div', 'overlay');
    const selection = el('div', 'selection');
    overlay.append(
      el('div', 'shade'),
      selection,
      el('div', 'hint', 'Arraste para selecionar o texto  ·  Esc para cancelar')
    );
    root.append(overlay);

    let origin = null;
    let rect = null;

    const draw = () => {
      Object.assign(selection.style, {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`
      });
    };

    overlay.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      overlay.setPointerCapture(event.pointerId);
      origin = { x: event.clientX, y: event.clientY };
      rect = { x: origin.x, y: origin.y, width: 0, height: 0 };
      overlay.classList.add('dragging');
      draw();
    });

    overlay.addEventListener('pointermove', (event) => {
      if (!origin) return;
      rect = {
        x: Math.min(origin.x, event.clientX),
        y: Math.min(origin.y, event.clientY),
        width: Math.abs(event.clientX - origin.x),
        height: Math.abs(event.clientY - origin.y)
      };
      draw();
    });

    overlay.addEventListener('pointerup', () => {
      if (!origin) return;
      finish(rect);
    });

    overlay.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      cancel();
    });

    // Evita que a página reaja aos cliques feitos sobre a camada de seleção.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      overlay.addEventListener(type, (event) => event.stopPropagation());
    }

    window.addEventListener('keydown', onSelectionKeydown, true);
  }

  function onSelectionKeydown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }

  function removeOverlay() {
    window.removeEventListener('keydown', onSelectionKeydown, true);
    overlay?.remove();
    overlay = null;
  }

  function cancel() {
    removeOverlay();
    removeRootIfEmpty();
  }

  async function finish(rect) {
    removeOverlay();
    removeRootIfEmpty();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return;

    // Espera a camada sumir da tela antes de o service worker tirar o print.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    pending = true;
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'recognize-region',
        rect,
        viewport: { width: window.innerWidth, height: window.innerHeight }
      });
    } catch (err) {
      response = { ok: false, error: err?.message ?? String(err) };
    }
    pending = false;

    if (response?.ok) showResult(response);
    else showError(response?.error ?? 'Sem resposta da extensão.');
  }

  // ---------- Aviso com o resultado ----------

  function renderToast(children, autoHideMs) {
    clearTimeout(hideTimer);
    toast?.remove();
    ensureRoot();
    toast = el('div', 'toast');
    toast.setAttribute('role', 'status');
    toast.append(...children);
    toast.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeToast();
    });
    root.append(toast);
    if (autoHideMs) scheduleHide(autoHideMs);
  }

  function header(icon, title) {
    const row = el('div', 'header');
    const close = el('button', 'close', '×');
    close.title = 'Fechar';
    close.addEventListener('click', closeToast);
    row.append(icon, typeof title === 'string' ? el('span', 'title', title) : title, close);
    return row;
  }

  function showProcessing() {
    renderToast([header(el('div', 'spinner'), 'Lendo o texto…')]);
  }

  function showResult({ text, copied }) {
    if (!text) {
      renderToast([
        header(el('span', 'icon error', '!'), 'Nenhum texto encontrado'),
        el('p', 'detail', 'Tente selecionar uma área maior ou com o texto mais nítido.')
      ], AUTO_HIDE_MS / 2);
      return;
    }

    const title = el('span', 'title', copied ? 'Texto copiado' : 'Texto reconhecido');
    const row = header(el('span', 'icon ok', '✓'), title);

    const area = el('textarea');
    area.value = text;
    area.spellcheck = false;
    area.rows = Math.min(8, text.split('\n').length + 1);

    const copyButton = el('button', 'copy', 'Copiar');
    copyButton.addEventListener('click', async () => {
      const result = await copyText(area.value);
      title.textContent = result ? 'Texto copiado' : 'Não foi possível copiar';
      copyButton.textContent = result ? 'Copiado!' : 'Copiar';
      setTimeout(() => { copyButton.textContent = 'Copiar'; }, 1500);
    });
    const actions = el('div', 'actions');
    actions.append(copyButton);

    renderToast([row, area, actions], AUTO_HIDE_MS);
  }

  function showError(message) {
    renderToast([
      header(el('span', 'icon error', '!'), 'Não foi possível ler o texto'),
      el('p', 'detail', message)
    ], AUTO_HIDE_MS);
  }

  async function copyText(text) {
    try {
      const response = await chrome.runtime.sendMessage({ target: 'background', type: 'copy-text', text });
      return Boolean(response?.ok && response.copied);
    } catch {
      return false;
    }
  }

  // Some sozinho, a não ser que o mouse esteja em cima ou o usuário esteja editando.
  function scheduleHide(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!toast) return;
      if (toast.matches(':hover') || toast.contains(root.activeElement)) {
        scheduleHide(1500);
        return;
      }
      closeToast();
    }, ms);
  }

  function closeToast() {
    clearTimeout(hideTimer);
    toast?.remove();
    toast = null;
    removeRootIfEmpty();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'ocr-status' && message.status === 'processing' && pending) {
      showProcessing();
    }
  });

  globalThis.__copiarTextoDaTela = { start };
  start();
})();
