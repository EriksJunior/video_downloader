const path = require('node:path');
const { statSync } = require('node:fs');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('Gere o instalador em um Windows x64 (ou use o workflow do GitHub Actions).');
  process.exit(1);
}

const binaries = [
  ['yt-dlp', 'youtube-dl-exec', 'bin', 'yt-dlp.exe'],
  ['FFmpeg', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'],
  ['FFprobe', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe']
];

for (const [label, ...parts] of binaries) {
  const file = path.join(__dirname, '..', 'node_modules', ...parts);
  try {
    if (statSync(file).size < 100_000) throw new Error('arquivo incompleto');
    execFileSync(file, [label === 'yt-dlp' ? '--version' : '-version'], {
      stdio: 'ignore', windowsHide: true, timeout: 15_000
    });
  } catch (error) {
    console.error(`${label} indisponivel em ${file}. Rode npm ci no Windows x64 antes de gerar o instalador.`);
    process.exit(1);
  }
}

console.log('Executaveis Windows verificados: yt-dlp, FFmpeg e FFprobe.');
