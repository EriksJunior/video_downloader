const form = document.querySelector('#url-form');
const urlInput = document.querySelector('#video-url');
const analyzeButton = document.querySelector('#analyze-button');
const message = document.querySelector('#message');
const destinationPath = document.querySelector('#destination-path');
const changeDirectory = document.querySelector('#change-directory');
const manualDirectory = document.querySelector('#manual-directory');
const directoryForm = document.querySelector('#directory-form');
const directoryInput = document.querySelector('#directory-input');
const defaultDirectory = document.querySelector('#default-directory');
const cancelDirectory = document.querySelector('#cancel-directory');
const card = document.querySelector('#video-card');
const thumbnail = document.querySelector('#thumbnail');
const duration = document.querySelector('#duration');
const title = document.querySelector('#video-title');
const quality = document.querySelector('#quality');
const startTime = document.querySelector('#start-time');
const endTime = document.querySelector('#end-time');
const downloadButton = document.querySelector('#download-button');
const progressWrap = document.querySelector('#progress-wrap');
const progressStatus = document.querySelector('#progress-status');
const progressValue = document.querySelector('#progress-value');
const progressTrack = document.querySelector('.progress-track');
const progressBar = document.querySelector('#progress-bar');

let analyzedUrl = '';
let analyzedDuration = null;
let directoryConfigured = false;
let downloadInProgress = false;

function formatDuration(seconds) {
  if (!seconds) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.floor(seconds % 60);
  return [hours, minutes, remaining]
    .filter((_, index) => hours || index > 0)
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

function parseTimestamp(value) {
  if (!value.trim()) return null;
  const parts = value.trim().split(':');

  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error('Use MM:SS ou HH:MM:SS nos campos de corte.');
  }

  const numbers = parts.map(Number);
  if (numbers.at(-1) > 59 || (parts.length === 3 && numbers[1] > 59)) {
    throw new Error('Minutos e segundos de cada bloco devem estar entre 00 e 59.');
  }

  return parts.length === 3
    ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    : numbers[0] * 60 + numbers[1];
}

function maskTimestamp(value) {
  const digits = value.replace(/\D/g, '').slice(0, 6);
  const groups = [];

  for (let end = digits.length; end > 0; end -= 2) {
    groups.unshift(digits.slice(Math.max(0, end - 2), end));
  }

  return groups.join(':');
}

function normalizeTimestampInput(input) {
  if (!input.value) return;

  try {
    const seconds = parseTimestamp(input.value);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    input.value = [hours, minutes, remaining]
      .map((part) => String(part).padStart(2, '0'))
      .join(':');
    input.removeAttribute('aria-invalid');
  } catch {
    input.setAttribute('aria-invalid', 'true');
  }
}

function selectedClip() {
  const start = parseTimestamp(startTime.value);
  const end = parseTimestamp(endTime.value);

  if (start === null && end === null) return { startTime: null, endTime: null };
  if (start === null || end === null) throw new Error('Informe o inicio e o fim do trecho.');
  if (end <= start) throw new Error('O fim do trecho deve ser maior que o inicio.');
  if (analyzedDuration && end > analyzedDuration) {
    throw new Error(`O fim ultrapassa a duracao do video (${formatDuration(analyzedDuration)}).`);
  }

  return { startTime: start, endTime: end };
}

function disableDownloadControls(disabled) {
  downloadInProgress = disabled;
  downloadButton.disabled = disabled || !directoryConfigured;
  quality.disabled = disabled;
  startTime.disabled = disabled;
  endTime.disabled = disabled;
}

function updateDirectory(settings) {
  directoryConfigured = settings.configured;
  destinationPath.textContent = settings.downloadDirectory || 'Nenhuma pasta selecionada';
  directoryInput.value = settings.downloadDirectory || '';
  changeDirectory.textContent = settings.configured ? 'ALTERAR PASTA' : 'ESCOLHER PASTA';
  defaultDirectory.disabled = !settings.configured;
  defaultDirectory.hidden = !settings.configured;
  downloadButton.disabled = downloadInProgress || !settings.configured;
}

async function loadDirectory() {
  try {
    updateDirectory(await jsonRequest('/api/settings'));
  } catch (error) {
    destinationPath.textContent = 'Nao foi possivel carregar a pasta.';
    message.textContent = error.message;
  }
}

[startTime, endTime].forEach((input) => {
  input.addEventListener('input', () => {
    input.value = maskTimestamp(input.value);
    input.removeAttribute('aria-invalid');
  });
  input.addEventListener('blur', () => normalizeTimestampInput(input));
});

manualDirectory.addEventListener('click', () => {
  directoryForm.hidden = false;
  directoryInput.focus();
});

changeDirectory.addEventListener('click', async () => {
  changeDirectory.disabled = true;
  manualDirectory.disabled = true;
  message.style.color = 'var(--muted)';
  message.textContent = 'Abrindo o seletor de pastas do Windows...';

  try {
    const settings = await jsonRequest('/api/settings/select-download-directory', { method: 'POST' });
    if (settings.cancelled) {
      message.textContent = directoryConfigured
        ? 'Selecao cancelada. A pasta anterior foi mantida.'
        : 'Selecao cancelada. Escolha uma pasta antes de baixar.';
      return;
    }

    updateDirectory(settings);
    directoryForm.hidden = true;
    message.style.color = '#3e7710';
    message.textContent = 'Pasta de destino salva. Os proximos downloads usarao esse local.';
  } catch (error) {
    directoryForm.hidden = false;
    directoryInput.focus();
    message.style.color = '#a33225';
    message.textContent = error.message;
  } finally {
    changeDirectory.disabled = false;
    manualDirectory.disabled = false;
  }
});

cancelDirectory.addEventListener('click', () => {
  directoryForm.hidden = true;
  directoryInput.value = directoryConfigured ? destinationPath.textContent : '';
});

directoryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = directoryForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  message.style.color = 'var(--muted)';
  message.textContent = 'Validando pasta de destino...';

  try {
    const settings = await jsonRequest('/api/settings/download-directory', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadDirectory: directoryInput.value })
    });
    updateDirectory(settings);
    directoryForm.hidden = true;
    message.style.color = '#3e7710';
    message.textContent = 'Pasta de destino salva. Os proximos downloads usarao esse local.';
  } catch (error) {
    message.style.color = '#a33225';
    message.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

defaultDirectory.addEventListener('click', async () => {
  defaultDirectory.disabled = true;

  try {
    const settings = await jsonRequest('/api/settings/download-directory', { method: 'DELETE' });
    updateDirectory(settings);
    directoryForm.hidden = false;
    message.style.color = '#3e7710';
    message.textContent = 'Configuracao removida. Escolha uma pasta antes do proximo download.';
  } catch (error) {
    message.style.color = '#a33225';
    message.textContent = error.message;
    defaultDirectory.disabled = false;
  }
});

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ocorreu um erro inesperado.');
  return data;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  card.hidden = true;
  message.textContent = 'Analisando formatos disponiveis...';
  message.style.color = 'var(--muted)';
  analyzeButton.disabled = true;

  try {
    analyzedUrl = urlInput.value.trim();
    const data = await jsonRequest('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: analyzedUrl })
    });

    title.textContent = data.title;
    analyzedDuration = data.duration;
    thumbnail.src = data.thumbnail || '';
    thumbnail.hidden = !data.thumbnail;
    duration.textContent = formatDuration(data.duration);
    duration.hidden = !data.duration;
    quality.replaceChildren(...data.qualities.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    progressWrap.hidden = true;
    downloadButton.disabled = !directoryConfigured;
    downloadButton.textContent = 'BAIXAR VIDEO ↓';
    message.textContent = '';
    card.hidden = false;
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    message.style.color = '#a33225';
    message.textContent = error.message;
  } finally {
    analyzeButton.disabled = false;
  }
});

downloadButton.addEventListener('click', async () => {
  let clip;
  try {
    clip = selectedClip();
  } catch (error) {
    message.style.color = '#a33225';
    message.textContent = error.message;
    return;
  }

  disableDownloadControls(true);
  progressWrap.hidden = false;
  progressStatus.textContent = 'PREPARANDO';
  progressValue.textContent = '0%';
  progressBar.style.width = '0%';
  progressTrack.classList.add('is-indeterminate');
  message.textContent = '';

  try {
    const { id } = await jsonRequest('/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: analyzedUrl, quality: quality.value, ...clip })
    });

    const timer = setInterval(async () => {
      try {
        const job = await jsonRequest(`/api/downloads/${id}`);
        const percent = Math.round(job.progress || 0);
        progressValue.textContent = `${percent}%`;
        progressBar.style.width = `${percent}%`;
        progressTrack.classList.toggle('is-indeterminate', job.phase === 'locating' && percent === 0);
        progressStatus.textContent = {
          locating: 'LOCALIZANDO TRECHO',
          downloading: 'BAIXANDO',
          processing: 'FINALIZANDO CORTE',
          completed: 'CONCLUIDO'
        }[job.phase] || 'PREPARANDO';

        if (job.status === 'completed') {
          clearInterval(timer);
          progressTrack.classList.remove('is-indeterminate');
          progressStatus.textContent = 'CONCLUIDO';
          downloadButton.textContent = 'DOWNLOAD CONCLUIDO';
          message.style.color = '#3e7710';
          message.textContent = job.filename
            ? `Arquivo ${job.filename} salvo em ${job.directory}`
            : `Arquivo salvo em ${job.directory}.`;
          disableDownloadControls(false);
        }

        if (job.status === 'failed') {
          clearInterval(timer);
          throw new Error(job.error);
        }
      } catch (error) {
        clearInterval(timer);
        progressTrack.classList.remove('is-indeterminate');
        progressStatus.textContent = 'ERRO';
        message.style.color = '#a33225';
        message.textContent = error.message;
        disableDownloadControls(false);
      }
    }, 800);
  } catch (error) {
    progressTrack.classList.remove('is-indeterminate');
    message.style.color = '#a33225';
    message.textContent = error.message;
    disableDownloadControls(false);
  }
});

loadDirectory();
