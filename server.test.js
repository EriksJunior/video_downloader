const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

async function createServer(info) {
  const routes = new Map();
  const downloads = [];
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
    const result = Promise.resolve();
    result.stdout = new EventEmitter();
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
        access: async () => {}
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
    await routes.get(route)({ body }, {
      status(code) { status = code; return this; },
      json(data) { response = data; return this; }
    });
    return { status, response };
  }

  return { request, analyses, downloads };
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

test('YouTube mantem a selecao de formatos anterior', async () => {
  const server = await createServer({ formats: [{ vcodec: 'avc1', height: 1080 }] });
  const url = 'https://www.youtube.com/watch?v=abc123';
  const info = await server.request('POST /api/info', { url });
  assert.equal(info.response.qualities[0].value, 1080);

  await server.request('POST /api/downloads', { url, quality: '1080' });
  assert.equal(server.downloads[0].options.format, 'bestvideo[height<=1080]+bestaudio/best[height<=1080]');

  const invalid = await server.request('POST /api/downloads', { url, quality: 'best' });
  assert.equal(invalid.status, 400);
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
