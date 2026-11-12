const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

async function createServer(info, audioCodec = 'aac', filename = 'video.mp4') {
  const routes = new Map();
  const downloads = [];
  const commands = [];
  const fileOperations = [];
  const app = {
    use() {},
    post(route, handler) { routes.set(`POST ${route}`, handler); },
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    put() {},
    delete() {},
    listen() {}
  };
  const express = () => app;
  express.json = () => () => {};
  express.static = () => () => {};

  const analyses = [];
  const youtubedl = async (url, options, spawnOptions) => {
    analyses.push({ url, options, spawnOptions });
    if (info instanceof Error) throw info;
    return info;
  };
  youtubedl.exec = (url, options, spawnOptions) => {
    downloads.push({ url, options, spawnOptions });
    const stdout = new EventEmitter();
    const result = new Promise((resolve) => process.nextTick(() => {
      stdout.emit('data', `__FILE__:/tmp/opencode/${filename}\n`);
      resolve();
    }));
    result.stdout = stdout;
    result.stderr = new EventEmitter();
    return result;
  };

  const source = readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  vm.runInNewContext(source, {
    require(module) {
      if (module === 'express') return express;
      if (module === 'youtube-dl-exec') return youtubedl;
      if (module === 'fs') return { ...require('fs'), existsSync: () => true };
      if (module === 'fs/promises') return {
        readFile: async () => JSON.stringify({ downloadDirectory: '/tmp/opencode', configured: true }),
        writeFile: async () => {},
        mkdir: async () => {},
        access: async () => {},
        rename: async (...args) => { fileOperations.push(['rename', ...args]); },
        copyFile: async (...args) => { fileOperations.push(['copyFile', ...args]); },
        unlink: async (...args) => { fileOperations.push(['unlink', ...args]); }
      };
      if (module === 'child_process') return {
        execFile(command, args, callback) {
          commands.push({ command, args });
          const done = typeof callback === 'function' ? callback : arguments[3];
          if (audioCodec === 'probe-error' && command === 'ffprobe') {
            done(new Error('ffprobe indisponivel'));
            return;
          }
          done(null, {
            stdout: command === 'ffprobe'
              ? JSON.stringify({ streams: [{ codec_name: audioCodec }] }) : '',
            stderr: ''
          });
        }
      };
      return require(module);
    },
    __dirname,
    URL,
    process,
    console,
    setTimeout
  }, { filename: 'server.js' });
  await new Promise(setImmediate);

  async function request(route, body) {
    let status = 200;
    let response;
      await routes.get(route)({ body, params: { id: body?.id } }, {
      status(code) { status = code; return this; },
      json(data) { response = data; return this; }
    });
    return { status, response };
  }

  return { request, analyses, downloads, commands, fileOperations };
}

test('TikTok oferece melhor qualidade quando nao informa resolucao', async () => {
  const server = await createServer({ title: 'Video TikTok', formats: [{ vcodec: 'h264', acodec: 'aac' }] });
  const url = 'https://vm.tiktok.com/abc123/';
  const info = await server.request('POST /api/info', { url });
  assert.equal(info.status, 200);
  assert.equal(info.response.qualities[0].value, 'best');
  assert.match(server.analyses[0].spawnOptions.env.PATH, /^.*video-downloader\/\.venv\/bin:/);

  const download = await server.request('POST /api/downloads', { url, quality: 'best' });
  assert.equal(download.status, 202);
  assert.equal(server.downloads[0].options.format, 'bestvideo+bestaudio/best');
  assert.equal(server.downloads[0].spawnOptions.env.PATH, server.analyses[0].spawnOptions.env.PATH);
});

test('TikTok usa formato completo na resolucao escolhida, inclusive para recortes', async () => {
  const server = await createServer({ formats: [{ vcodec: 'h264', acodec: 'aac', height: 720 }] });
  const url = 'https://www.tiktok.com/@usuario/video/123456';
  const info = await server.request('POST /api/info', { url });
  assert.equal(info.response.qualities[0].value, 720);

  await server.request('POST /api/downloads', { url, quality: '720' });
  assert.equal(server.downloads[0].options.format, 'best[height<=720]/bestvideo[height<=720]+bestaudio/best');

  await server.request('POST /api/downloads', { url, quality: '720', startTime: 1, endTime: 5 });
  assert.match(server.downloads[1].options.format, /^best\[height<=720\]\[protocol=https\]/);
  assert.equal(server.downloads[1].options.downloadSections, '*1-5');
});

test('YouTube prioriza audio AAC e verifica o arquivo final', async () => {
  const server = await createServer({ formats: [{ vcodec: 'avc1', height: 1080 }] });
  const url = 'https://www.youtube.com/watch?v=abc123';
  const info = await server.request('POST /api/info', { url });
  assert.equal(info.response.qualities[0].value, 1080);

  const download = await server.request('POST /api/downloads', { url, quality: '1080' });
  assert.equal(server.downloads[0].options.format,
    'bestvideo[height<=1080]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]');
  assert.equal(server.commands[0].command, 'ffprobe');
  assert.equal(server.commands.some(({ command }) => command === 'ffmpeg'), false);
  assert.equal((await server.request('GET /api/downloads/:id', { id: download.response.id })).response.status,
    'completed');

  await server.request('POST /api/downloads', { url, quality: '1080', startTime: 1, endTime: 5 });
  assert.match(server.downloads[1].options.format, /bestaudio\[protocol=https\]\[ext=m4a\]/);

  const invalid = await server.request('POST /api/downloads', { url, quality: 'best' });
  assert.equal(invalid.status, 400);
});

test('YouTube converte Opus para AAC sem recodificar o video', async () => {
  const server = await createServer({ formats: [{ vcodec: 'avc1', height: 720 }] }, 'opus');
  const result = await server.request('POST /api/downloads', {
    url: 'https://youtu.be/abc123', quality: '720'
  });

  assert.equal(result.status, 202);
  const conversion = server.commands.find(({ command }) => command === 'ffmpeg');
  assert.ok(conversion, JSON.stringify(server.commands));
  assert.deepEqual(Array.from(conversion.args.slice(conversion.args.indexOf('-c:v'), conversion.args.indexOf('-b:a'))),
    ['-c:v', 'copy', '-c:a', 'aac']);
  assert.equal(server.fileOperations[0][0], 'rename');
  assert.equal(server.fileOperations[0][2], '/tmp/opencode/video.mp4');
  assert.equal((await server.request('GET /api/downloads/:id', { id: result.response.id })).response.status,
    'completed');
});

test('YouTube converte arquivo WebM sem sobrescrever um MP4 existente', async () => {
  const server = await createServer({}, 'opus', 'video.webm');
  const result = await server.request('POST /api/downloads', {
    url: 'https://www.youtube.com/watch?v=abc123', quality: '720'
  });
  assert.equal(server.fileOperations[0][0], 'copyFile');
  assert.equal(server.fileOperations[0][2], '/tmp/opencode/video [AAC].mp4');
  assert.equal((await server.request('GET /api/downloads/:id', { id: result.response.id })).response.filename,
    'video [AAC].mp4');
});

test('falha com mensagem util quando nao e possivel verificar o audio do YouTube', async () => {
  const server = await createServer({}, 'probe-error');
  const result = await server.request('POST /api/downloads', {
    url: 'https://www.youtube.com/watch?v=abc123', quality: '720'
  });
  const job = await server.request('GET /api/downloads/:id', { id: result.response.id });
  assert.equal(job.response.status, 'failed');
  assert.match(job.response.error, /FFmpeg e FFprobe/);
});

test('informa quando o TikTok bloqueia o acesso ao video pela rede', async () => {
  const server = await createServer(new Error(
    'ERROR: [TikTok] Your IP address is blocked from accessing this post'
  ));
  const result = await server.request('POST /api/info', {
    url: 'https://www.tiktok.com/@usuario/video/123456'
  });
  assert.equal(result.status, 400);
  assert.match(result.response.error, /bloqueou o acesso.*pela sua rede/);
});
