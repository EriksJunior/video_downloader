const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');

let window = null;
let server = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      if (app.isPackaged) {
        const bin = path.join(process.resourcesPath, 'bin');
        process.env.FRAMEGRAB_YT_DLP_PATH = path.join(bin, 'yt-dlp.exe');
        process.env.PATH = `${bin}${path.delimiter}${process.env.PATH || ''}`;
      }

      const { startServer } = require('../server');
      server = await startServer({
        port: 0,
        settingsPath: path.join(app.getPath('userData'), 'settings.json'),
        selectDirectory: async () => {
          const result = await dialog.showOpenDialog(window, {
            title: 'Escolha onde salvar os videos',
            properties: ['openDirectory', 'createDirectory']
          });
          return result.canceled ? null : result.filePaths[0];
        }
      });

      const address = `http://127.0.0.1:${server.address().port}`;
      window = new BrowserWindow({
        width: 1120,
        height: 800,
        minWidth: 760,
        minHeight: 600,
        show: false,
        title: 'Framegrab',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => {
        if (new URL(url).origin !== address) event.preventDefault();
      });
      await window.loadURL(address);
      window.show();
    } catch (error) {
      dialog.showErrorBox('Framegrab', `Nao foi possivel iniciar o aplicativo:\n${error.message}`);
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => server?.close());
}
