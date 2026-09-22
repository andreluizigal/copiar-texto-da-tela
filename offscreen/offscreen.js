// Documento offscreen: recorta a captura de tela, roda o Tesseract.js (em um
// Web Worker) e copia o resultado para a área de transferência.

const LANGUAGES = 'por+eng';
// Depois desse tempo sem uso o OCR é descarregado para liberar memória.
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
// O Tesseract erra muito com letras pequenas; texto de tela costuma ter poucos
// pixels de altura, então a área é ampliada até ~2,5 px por pixel CSS.
const TARGET_SCALE = 2.5;
const MAX_ZOOM = 4;
const MAX_PIXELS = 10_000_000;
// Margem branca ao redor do recorte: o Tesseract lê melhor texto que não
// encosta na borda da imagem.
const PADDING = 16;
// Texto inclinado: a imagem é reduzida para este tamanho para estimar o
// ângulo das linhas (mais que isso só deixa a estimativa lenta).
const ANGLE_SAMPLE_SIZE = 400;
// A estimativa só é usada se as linhas nessa direção forem bem mais nítidas
// que na perpendicular; senão (ex.: uma palavra curta) começa pelo normal.
const ANGLE_RELIABILITY = 1.5;
// Inclinações menores que isso o próprio Tesseract corrige.
const MIN_ROTATION = 1;
// Confiança média (0–100) a partir da qual não vale testar outras orientações.
const GOOD_CONFIDENCE = 70;

let workerPromise = null;
let idleTimer = null;
let busy = 0;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  (async () => {
    busy++;
    clearTimeout(idleTimer);
    try {
      sendResponse(await handle(message));
    } catch (err) {
      console.error(err);
      sendResponse({ error: String(err?.message ?? err) });
    } finally {
      busy--;
      if (busy === 0) idleTimer = setTimeout(releaseMemory, IDLE_TIMEOUT_MS);
    }
  })();
  return true;
});

async function handle(message) {
  switch (message.type) {
    case 'warmup':
      await getWorker();
      return {};
    case 'recognize':
      return recognize(message);
    case 'copy':
      return { copied: copyToClipboard(message.text) };
    default:
      throw new Error(`Mensagem desconhecida: ${message.type}`);
  }
}

function getWorker() {
  workerPromise ??= createOcrWorker();
  return workerPromise;
}

async function createOcrWorker() {
  try {
    return await Tesseract.createWorker(LANGUAGES, Tesseract.OEM.LSTM_ONLY, {
      workerPath: chrome.runtime.getURL('lib/worker.min.js'),
      corePath: chrome.runtime.getURL('lib/core'),
      langPath: chrome.runtime.getURL('lib/lang'),
      // Extensões não podem criar workers a partir de blob: com importScripts.
      workerBlobURL: false,
      // Os idiomas já estão dentro da extensão; não precisa duplicá-los no IndexedDB.
      cacheMethod: 'none'
    });
  } catch (err) {
    workerPromise = null;
    throw err;
  }
}

async function releaseMemory() {
  if (busy > 0) return;
  const pending = workerPromise;
  workerPromise = null;
  try {
    await (await pending)?.terminate();
  } catch {
    // O worker já tinha falhado; nada a liberar.
  }
  try {
    await chrome.runtime.sendMessage({ target: 'background', type: 'offscreen-idle' });
  } catch {
    // Service worker indisponível; o documento continua aberto, mas vazio.
  }
}

async function recognize({ image, rect, viewport }) {
  const canvas = await prepareImage(image, rect, viewport);
  const worker = await getWorker();
  const angles = orientationCandidates(canvas);

  // Tenta primeiro o ângulo mais provável e só testa os outros se a leitura
  // sair com pouca confiança (ex.: texto de cabeça para baixo).
  // "Bloco único" acerta mais em trechos de texto corrido.
  let best = { text: '', confidence: -1 };
  for (const angle of angles) {
    const result = await readText(worker, straighten(canvas, angle), Tesseract.PSM.SINGLE_BLOCK);
    if (result.text && result.confidence > best.confidence) best = result;
    if (best.confidence >= GOOD_CONFIDENCE) break;
  }
  // Nada encontrado: tenta o modo de texto esparso (palavras soltas espalhadas).
  if (!best.text) {
    best = await readText(worker, straighten(canvas, angles[0]), Tesseract.PSM.SPARSE_TEXT);
  }

  const copied = best.text ? copyToClipboard(best.text) : false;
  return { text: best.text, copied };
}

async function readText(worker, canvas, pageSegMode) {
  await worker.setParameters({ tessedit_pageseg_mode: pageSegMode });
  const { data } = await worker.recognize(canvas);
  return { text: cleanText(data.text ?? ''), confidence: data.confidence ?? 0 };
}

// Ângulos (direção das linhas de texto, em graus) a testar, do mais provável
// ao menos provável.
function orientationCandidates(canvas) {
  const { angle, reliable } = estimateTextAngle(canvas);
  const base = reliable && Math.abs(angle) >= MIN_ROTATION ? angle : 0;
  const candidates = [base, base + 180, base + 90, base - 90];
  if (base !== 0) candidates.push(0);
  return candidates;
}

// Estima a direção das linhas de texto pelo perfil de projeção: projetando os
// pixels escuros na perpendicular de cada direção, as linhas de texto formam
// picos bem concentrados quando a direção coincide com a delas.
// Retorna um ângulo entre -90° e 90° (sentido horário, como no CSS rotate).
function estimateTextAngle(source) {
  const scale = Math.min(1, ANGLE_SAMPLE_SIZE / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const sample = new OffscreenCanvas(width, height);
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  const threshold = otsuThreshold(data);
  const xs = new Float32Array(width * height);
  const ys = new Float32Array(width * height);
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4] <= threshold) {
        xs[count] = x - width / 2;
        ys[count] = y - height / 2;
        count++;
      }
    }
  }
  if (count < 30 || count > width * height * 0.5) return { angle: 0, reliable: false };

  const radius = Math.ceil(Math.hypot(width, height) / 2);
  const bins = new Uint32Array(radius * 2 + 2);
  const score = (degrees) => {
    const radians = (degrees * Math.PI) / 180;
    const sin = Math.sin(radians);
    const cos = Math.cos(radians);
    bins.fill(0);
    for (let i = 0; i < count; i++) {
      bins[Math.round(ys[i] * cos - xs[i] * sin) + radius]++;
    }
    let sum = 0;
    for (const value of bins) sum += value * value;
    return sum;
  };

  let bestAngle = 0;
  let bestScore = -1;
  const search = (from, to, step) => {
    for (let degrees = from; degrees <= to; degrees += step) {
      const value = score(degrees);
      if (value > bestScore) {
        bestScore = value;
        bestAngle = degrees;
      }
    }
  };
  search(-90, 89, 1);
  search(bestAngle - 1, bestAngle + 1, 0.1);

  const angle = bestAngle >= 90 ? bestAngle - 180 : bestAngle < -90 ? bestAngle + 180 : bestAngle;
  return { angle, reliable: bestScore > score(angle + 90) * ANGLE_RELIABILITY };
}

function otsuThreshold(data) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) histogram[data[i]]++;
  const total = data.length / 4;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * histogram[t];

  let sumBack = 0;
  let weightBack = 0;
  let best = 0;
  let bestVariance = 0;
  for (let t = 0; t < 256; t++) {
    weightBack += histogram[t];
    if (weightBack === 0) continue;
    const weightFore = total - weightBack;
    if (weightFore === 0) break;
    sumBack += t * histogram[t];
    const meanBack = sumBack / weightBack;
    const meanFore = (sumAll - sumBack) / weightFore;
    const variance = weightBack * weightFore * (meanBack - meanFore) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

// Gira a imagem para deixar na horizontal um texto cujas linhas estão em
// `textAngle` graus. O fundo que aparece nos cantos é preenchido de branco.
function straighten(source, textAngle) {
  const normalized = ((textAngle % 360) + 360) % 360;
  if (normalized < MIN_ROTATION || normalized > 360 - MIN_ROTATION) return source;

  const radians = (textAngle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const width = Math.round(source.width * cos + source.height * sin);
  const height = Math.round(source.width * sin + source.height * cos);

  const output = new OffscreenCanvas(width, height);
  const ctx = output.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-radians);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return output;
}

function cleanText(text) {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function prepareImage(dataUrl, rect, viewport) {
  const shot = await createImageBitmap(await (await fetch(dataUrl)).blob());

  // A captura vem em pixels do dispositivo; a seleção, em pixels CSS.
  const scaleX = shot.width / viewport.width;
  const scaleY = shot.height / viewport.height;
  const sx = clamp(Math.round(rect.x * scaleX), 0, shot.width - 1);
  const sy = clamp(Math.round(rect.y * scaleY), 0, shot.height - 1);
  const sw = clamp(Math.round(rect.width * scaleX), 1, shot.width - sx);
  const sh = clamp(Math.round(rect.height * scaleY), 1, shot.height - sy);

  let zoom = clamp(TARGET_SCALE / ((scaleX + scaleY) / 2), 1, MAX_ZOOM);
  zoom = Math.min(zoom, Math.max(1, Math.sqrt(MAX_PIXELS / (sw * sh))));
  const width = Math.round(sw * zoom);
  const height = Math.round(sh * zoom);

  const scaled = new OffscreenCanvas(width, height);
  const ctx = scaled.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(shot, sx, sy, sw, sh, 0, 0, width, height);
  shot.close();

  const pixels = ctx.getImageData(0, 0, width, height);
  toDarkOnLightGrayscale(pixels);

  const output = new OffscreenCanvas(width + PADDING * 2, height + PADDING * 2);
  const outCtx = output.getContext('2d');
  outCtx.fillStyle = '#fff';
  outCtx.fillRect(0, 0, output.width, output.height);
  outCtx.putImageData(pixels, PADDING, PADDING);
  return output;
}

// Converte para tons de cinza e, se o fundo for escuro (modo escuro, legendas
// etc.), inverte para texto escuro sobre fundo claro, que o Tesseract lê melhor.
function toDarkOnLightGrayscale(imageData) {
  const data = imageData.data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = luma;
    sum += luma;
  }
  const invert = sum / (data.length / 4) < 128;
  for (let i = 0; i < data.length; i += 4) {
    const value = invert ? 255 - data[i] : data[i];
    data[i] = data[i + 1] = data[i + 2] = value;
    data[i + 3] = 255;
  }
}

function copyToClipboard(text) {
  const area = document.getElementById('clipboard');
  area.value = text;
  area.select();
  const copied = document.execCommand('copy');
  area.value = '';
  return copied;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
