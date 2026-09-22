// Service worker: cria o item do menu de contexto, injeta o seletor de área
// na aba, captura a tela e repassa a imagem para o documento offscreen,
// onde o OCR (Tesseract.js) roda e o texto é copiado.

const MENU_ID = 'copiar-texto-area';
const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const DEFAULT_TITLE = 'Copiar texto de uma área da tela';

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: DEFAULT_TITLE,
    contexts: ['page', 'selection', 'link', 'image', 'video', 'frame', 'editable']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) startSelection(tab);
});

chrome.action.onClicked.addListener((tab) => startSelection(tab));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'start-selection') startSelection(tab);
});

async function startSelection(tab) {
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/selector.js']
    });
  } catch (err) {
    // Páginas internas (chrome://, Chrome Web Store etc.) não aceitam scripts.
    console.warn('Não foi possível iniciar a seleção nesta página:', err);
    await flashBadge(tab.id);
    return;
  }
  // Carrega o OCR enquanto o usuário ainda está selecionando a área.
  warmUp();
}

async function flashBadge(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({ tabId, title: 'Esta página não permite capturar texto' });
    setTimeout(async () => {
      try {
        await chrome.action.setBadgeText({ tabId, text: '' });
        await chrome.action.setTitle({ tabId, title: DEFAULT_TITLE });
      } catch {
        // A aba pode ter sido fechada.
      }
    }, 3000);
  } catch (err) {
    console.warn(err);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background') return false;

  switch (message.type) {
    case 'recognize-region':
      respond(recognizeRegion(message, sender), sendResponse);
      return true;
    case 'copy-text':
      respond(sendToOffscreen({ type: 'copy', text: message.text }), sendResponse);
      return true;
    case 'offscreen-idle':
      closeOffscreen();
      return false;
    default:
      return false;
  }
});

async function respond(promise, sendResponse) {
  try {
    sendResponse({ ok: true, ...(await promise) });
  } catch (err) {
    console.error(err);
    sendResponse({ ok: false, error: String(err?.message ?? err) });
  }
}

async function recognizeRegion({ rect, viewport }, sender) {
  const tab = sender.tab;
  const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

  // A captura já foi feita: agora a página pode mostrar o aviso de "lendo texto".
  chrome.tabs.sendMessage(tab.id, { type: 'ocr-status', status: 'processing' }, { frameId: sender.frameId })
    .catch(() => {});

  return sendToOffscreen({ type: 'recognize', image, rect, viewport });
}

async function sendToOffscreen(payload) {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({ target: 'offscreen', ...payload });
  if (!result) throw new Error('O leitor de texto não respondeu.');
  if (result.error) throw new Error(result.error);
  return result;
}

function warmUp() {
  sendToOffscreen({ type: 'warmup' }).catch((err) => console.warn('Falha ao pré-carregar o OCR:', err));
}

// Só pode existir um documento offscreen por vez; a promise evita criar dois
// se duas chamadas chegarem juntas.
let creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });
  if (contexts.length > 0) return;

  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WORKERS', 'CLIPBOARD'],
    justification: 'Reconhecer o texto da área selecionada e copiá-lo para a área de transferência.'
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

// Chamado quando o OCR fica ocioso por alguns minutos, para liberar memória.
async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Já estava fechado.
  }
}
