const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { mkdir, readFile, writeFile, access } = require('fs/promises');
const { constants, existsSync } = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const youtubedl = require('youtube-dl-exec');

const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const LEGACY_DEFAULT_DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const SETTINGS_FILE = path.join(__dirname, '.framegrab-settings.json');
const PYTHON_ENV_BIN = path.join(__dirname, '.venv', 'bin');
const ytDlpEnv = existsSync(path.join(PYTHON_ENV_BIN, 'python3'))
  ? { ...process.env, PATH: `${PYTHON_ENV_BIN}${path.delimiter}${process.env.PATH || ''}` }
  : undefined;
const jobs = new Map();
let downloadDirectory = null;
let downloadDirectoryLabel = null;
let directoryDialogOpen = false;

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function toDisplayPath(directory) {
  const wslPath = directory.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (!wslPath) return directory;
  return `${wslPath[1].toUpperCase()}:\\${wslPath[2].replaceAll('/', '\\')}`;
}

function resolveDownloadDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) {
    throw new Error('Informe uma pasta de destino valida.');
  }

  const input = value.trim().replace(/^"|"$/g, '');
  const windowsPath = input.match(/^([a-z]):[\\/](.*)$/i);

  if (windowsPath && process.platform !== 'win32') {
    return path.posix.join('/mnt', windowsPath[1].toLowerCase(), ...windowsPath[2].split(/[\\/]+/));
  }

  const pathApi = process.platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(input)) {
    throw new Error('Informe o caminho completo da pasta.');
  }

  return pathApi.normalize(input);
}

async function validateDownloadDirectory(directory) {
  await mkdir(directory, { recursive: true });
  await access(directory, constants.W_OK);
}

async function saveDownloadDirectory(value) {
  const resolved = resolveDownloadDirectory(value);
  await validateDownloadDirectory(resolved);
  await writeFile(SETTINGS_FILE, `${JSON.stringify({ downloadDirectory: value.trim(), configured: true }, null, 2)}\n`, 'utf8');
  downloadDirectory = resolved;
  downloadDirectoryLabel = toDisplayPath(resolved);
}

async function clearDownloadDirectory() {
  await writeFile(SETTINGS_FILE, `${JSON.stringify({ downloadDirectory: null, configured: false }, null, 2)}\n`, 'utf8');
  downloadDirectory = null;
  downloadDirectoryLabel = null;
}

async function selectWindowsDirectory() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = 'Escolha onde salvar os videos'",
    '$dialog.ShowNewFolderButton = $true',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  Write-Output $dialog.SelectedPath',
    '}',
    '$dialog.Dispose()'
  ].join('; ');

  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-STA',
    '-Command',
    script
  ], {
    encoding: 'utf8',
    windowsHide: false,
    maxBuffer: 1024 * 1024
  });

  return stdout.trim() || null;
}

async function loadSettings() {
  try {
    const settings = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    if (!settings.downloadDirectory) return clearDownloadDirectory();

    const resolved = resolveDownloadDirectory(settings.downloadDirectory);
    const isGeneratedLegacyDefault = settings.configured !== true
      && resolved === LEGACY_DEFAULT_DOWNLOAD_DIR;

    if (isGeneratedLegacyDefault) return clearDownloadDirectory();
    await saveDownloadDirectory(settings.downloadDirectory);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Configuracao de pasta ignorada: ${error.message}`);
    }
    await clearDownloadDirectory();
  }
}

function parseVideoUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Informe uma URL valida.');
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Informe uma URL valida.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('A URL deve usar HTTP ou HTTPS.');
  }

  if (url.username || url.password || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Esse endereco nao e permitido.');
  }

  return url.toString();
}

function isTikTokUrl(value) {
  return /(^|\.)tiktok\.com$/i.test(new URL(value).hostname);
}

function errorMessage(error) {
  const output = `${error.stderr || ''}\n${error.message || ''}`;

  if (/URL valida|URL deve|endereco nao e permitido/i.test(error.message || '')) return error.message;
  if (/unsupported url/i.test(output)) return 'Esse site ou endereco nao e suportado.';
  if (/private|sign in|login|cookies/i.test(output)) return 'O video exige acesso ou nao esta publico.';
  if (/not available|unavailable|removed/i.test(output)) return 'O video nao esta disponivel.';
  if (/Your IP address is blocked from accessing this post/i.test(output)) {
    return 'O TikTok bloqueou o acesso a este video pela sua rede. Tente outro video ou outra rede.';
  }
  if (/\[TikTok\].*Unexpected response from webpage request/is.test(output)) {
    return 'O TikTok recusou o acesso. Configure o ambiente .venv com curl-cffi conforme o README ou tente novamente mais tarde.';
  }
  return 'Nao foi possivel processar o video. Verifique a URL e tente novamente.';
}

function parseClipRange(startValue, endValue) {
  const hasStart = startValue !== null && startValue !== undefined && startValue !== '';
  const hasEnd = endValue !== null && endValue !== undefined && endValue !== '';

  if (!hasStart && !hasEnd) return null;
  if (!hasStart || !hasEnd) throw new Error('Informe o inicio e o fim do trecho.');

  const start = Number(startValue);
  const end = Number(endValue);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    throw new Error('O fim do trecho deve ser maior que o inicio.');
  }

  return { start, end };
}

app.post('/api/info', async (req, res) => {
  try {
    const url = parseVideoUrl(req.body.url);
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      noWarnings: true,
      skipDownload: true
    }, { timeout: 60_000, ...(ytDlpEnv && { env: ytDlpEnv }) });

    const videoFormats = (info.formats || [])
      .filter((format) => format.vcodec && format.vcodec !== 'none');
    const heights = [...new Set(videoFormats
      .filter((format) => Number(format.height) > 0)
      .map((format) => Number(format.height)))]
      .sort((a, b) => b - a);

    if (!heights.length && !(isTikTokUrl(url) && videoFormats.length)) {
      return res.status(422).json({ error: 'Nenhuma qualidade de video foi encontrada.' });
    }

    res.json({
      title: info.title || 'Video sem titulo',
      thumbnail: info.thumbnail || null,
      duration: Number(info.duration) || null,
      qualities: heights.map((height) => ({
        value: height,
        label: `${height}p${height >= 2160 ? ' 4K' : height >= 1440 ? ' QHD' : height >= 1080 ? ' Full HD' : height >= 720 ? ' HD' : ''}`
      })).concat(heights.length ? [] : [{ value: 'best', label: 'Melhor qualidade disponivel' }])
    });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.get('/api/settings', (req, res) => {
  res.json({
    downloadDirectory: downloadDirectoryLabel,
    configured: Boolean(downloadDirectory)
  });
});

app.put('/api/settings/download-directory', async (req, res) => {
  try {
    await saveDownloadDirectory(req.body.downloadDirectory);
    res.json({
      downloadDirectory: downloadDirectoryLabel,
      configured: true
    });
  } catch (error) {
    res.status(400).json({ error: `Nao foi possivel usar essa pasta. ${error.message}` });
  }
});

app.post('/api/settings/select-download-directory', async (req, res) => {
  if (directoryDialogOpen) {
    return res.status(409).json({ error: 'O seletor de pastas ja esta aberto.' });
  }

  directoryDialogOpen = true;
  try {
    const selectedDirectory = await selectWindowsDirectory();
    if (!selectedDirectory) return res.json({ cancelled: true });

    await saveDownloadDirectory(selectedDirectory);
    res.json({
      cancelled: false,
      downloadDirectory: downloadDirectoryLabel,
      configured: true
    });
  } catch (error) {
    const unavailable = error.code === 'ENOENT';
    res.status(unavailable ? 501 : 500).json({
      error: unavailable
        ? 'O seletor do Windows nao esta disponivel. Digite o caminho manualmente.'
        : 'Nao foi possivel abrir o seletor de pastas. Digite o caminho manualmente.'
    });
  } finally {
    directoryDialogOpen = false;
  }
});

app.delete('/api/settings/download-directory', async (req, res) => {
  try {
    await clearDownloadDirectory();
    res.json({ downloadDirectory: null, configured: false });
  } catch (error) {
    res.status(500).json({ error: 'Nao foi possivel remover a configuracao.' });
  }
});

app.post('/api/downloads', async (req, res) => {
  if (!downloadDirectory) {
    return res.status(409).json({ error: 'Escolha uma pasta de destino antes de iniciar o download.' });
  }

  let url;
  let clip;
  try {
    url = parseVideoUrl(req.body.url);
    clip = parseClipRange(req.body.startTime, req.body.endTime);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const tiktok = isTikTokUrl(url);
  const quality = req.body.quality;
  if (!(tiktok && quality === 'best')
    && (!Number.isInteger(Number(quality)) || Number(quality) < 144 || Number(quality) > 4320)) {
    return res.status(400).json({ error: 'Selecione uma qualidade valida.' });
  }

  const id = crypto.randomUUID();
  const destinationDirectory = downloadDirectory;
  const job = {
    id,
    status: 'starting',
    phase: clip ? 'locating' : 'downloading',
    progress: 0,
    filename: null,
    directory: downloadDirectoryLabel,
    error: null
  };
  jobs.set(id, job);
  res.status(202).json({ id });

  try {
    await validateDownloadDirectory(destinationDirectory);
    const suffix = clip ? ` [trecho ${clip.start}s-${clip.end}s]` : '';
    const regularFormat = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`;
    const directFormat = [
      `bestvideo[height<=${quality}][protocol=https][ext=mp4][vcodec^=avc1]+bestaudio[protocol=https][ext=m4a]`,
      `bestvideo[height<=${quality}][protocol=https][ext=mp4]+bestaudio[protocol=https][ext=m4a]`,
      `bestvideo[height<=${quality}][protocol=https]+bestaudio[protocol=https]`,
      `best[height<=${quality}][protocol=https]`,
      regularFormat
    ].join('/');
    const tiktokFormat = tiktok && (quality === 'best'
      ? (clip ? 'best[protocol=https]/best' : 'bestvideo+bestaudio/best')
      : (clip
        ? `best[height<=${quality}][protocol=https]/best[height<=${quality}]/best[protocol=https]/best`
        : `best[height<=${quality}]/bestvideo[height<=${quality}]+bestaudio/best`));
    const options = {
      noPlaylist: true,
      newline: true,
      progress: true,
      format: tiktok ? tiktokFormat : (clip ? directFormat : regularFormat),
      mergeOutputFormat: 'mp4',
      output: path.join(destinationDirectory, `%(title).160B [%(id)s]${suffix}.%(ext)s`),
      print: 'after_move:__FILE__:%(filepath)s'
    };

    if (clip) {
      options.downloadSections = `*${clip.start}-${clip.end}`;
      options.forceKeyframesAtCuts = true;
      options.downloaderArgs = 'ffmpeg:-progress pipe:2 -nostats';
    }

    const downloadProcess = youtubedl.exec(url, options, ytDlpEnv ? { env: ytDlpEnv } : {});

    job.status = 'downloading';
    const clipDuration = clip ? clip.end - clip.start : null;
    const processLine = (line) => {
      const percentage = line.match(/\[download\]\s+([\d.]+)%/);
      if (percentage) {
        job.phase = 'downloading';
        job.progress = Math.min(95, Number(percentage[1]));
      }

      const ffmpegTime = line.match(/^out_time=(\d+):(\d+):([\d.]+)/);
      if (ffmpegTime && clipDuration) {
        const currentTime = Number(ffmpegTime[1]) * 3600
          + Number(ffmpegTime[2]) * 60
          + Number(ffmpegTime[3]);
        const elapsed = currentTime > clipDuration + 1 ? currentTime - clip.start : currentTime;
        job.phase = 'downloading';
        job.progress = Math.max(job.progress, Math.min(95, (elapsed / clipDuration) * 95));
      }

      if (/^progress=end/.test(line) || /\[(Merger|VideoConvertor|Fixup)/.test(line)) {
        job.phase = 'processing';
        job.progress = Math.max(job.progress, 95);
      }

      const fileMatch = line.match(/__FILE__:(.+)$/);
      if (fileMatch) job.filename = path.basename(fileMatch[1].trim());
    };

    const outputReader = () => {
      let buffer = '';
      return (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        lines.forEach(processLine);
      };
    };

    downloadProcess.stdout?.on('data', outputReader());
    downloadProcess.stderr?.on('data', outputReader());
    await downloadProcess;

    job.status = 'completed';
    job.phase = 'completed';
    job.progress = 100;
  } catch (error) {
    job.status = 'failed';
    job.error = errorMessage(error);
  } finally {
    setTimeout(() => jobs.delete(id), 60 * 60 * 1000).unref();
  }
});

app.get('/api/downloads/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Download nao encontrado.' });
  res.json(job);
});

app.use((req, res) => res.status(404).json({ error: 'Rota nao encontrada.' }));

loadSettings().then(() => {
  app.listen(PORT, HOST, () => {
    console.log(`Video Downloader disponivel em http://${HOST}:${PORT}`);
    console.log(downloadDirectoryLabel
      ? `Os arquivos serao salvos em ${downloadDirectoryLabel}`
      : 'Escolha a pasta de destino na interface antes do primeiro download.');
  });
}).catch((error) => {
  console.error(`Nao foi possivel iniciar: ${error.message}`);
  process.exitCode = 1;
});
