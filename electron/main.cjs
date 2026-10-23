// Clipwave desktop app: a window around dist/clipwave.html. The page is served from clipwave://app so its saved
// projects and settings keep one origin, and downloads, saving and links go through the main process.

const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, session, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const ORIGIN = 'clipwave://app';
const PAGE = path.join(__dirname, '..', 'dist', 'clipwave.html');
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const MAX_DOWNLOAD = 1024 * 1024 * 1024;
const ALLOWED_PERMISSIONS = new Set(['media', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read', 'notifications']);

protocol.registerSchemesAsPrivileged([
  { scheme: 'clipwave', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
const savedPaths = new Set();

const fromApp = (event) => {
  const url = (event.senderFrame && event.senderFrame.url) || '';
  return url.startsWith(ORIGIN + '/');
};

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1114',
    title: 'Clipwave',
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // Some graphics drivers never report ready; show the window anyway.
  setTimeout(() => win && !win.isVisible() && win.show(), 4000);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Dropping a file outside the drop zone would navigate away from the editor.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN + '/')) e.preventDefault();
  });
  win.on('closed', () => (win = null));
  win.loadURL(ORIGIN + '/');
}

function registerIpc() {
  // Downloads from hosts that don't allow cross-origin requests from a web page.
  ipcMain.handle('net:fetch', async (event, url, opts = {}) => {
    if (!fromApp(event)) return { ok: false, status: 0, error: 'blocked' };
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return { ok: false, status: 0, error: 'blocked' };
    const headers = opts && typeof opts.headers === 'object' ? opts.headers : {};
    const timeoutMs = Math.min(Math.max(+opts.timeoutMs || 300000, 1000), 30 * 60 * 1000);
    try {
      const res = await net.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (+res.headers.get('content-length') > MAX_DOWNLOAD) return { ok: false, status: 413, error: 'too-large' };
      const data = res.ok ? await res.arrayBuffer() : new ArrayBuffer(0);
      return { ok: res.ok, status: res.status, type: res.headers.get('content-type') || '', data };
    } catch (e) {
      return { ok: false, status: 0, error: e && e.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
  });

  ipcMain.handle('file:save', async (event, name, data) => {
    if (!fromApp(event) || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) return null;
    const safe = String(name || 'Clipwave export').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Clipwave export';
    const ext = path.extname(safe).slice(1).toLowerCase();
    const folder = ['mp4', 'webm', 'mov'].includes(ext) ? app.getPath('videos') : ['png', 'jpg', 'jpeg'].includes(ext) ? app.getPath('pictures') : app.getPath('downloads');
    const res = await dialog.showSaveDialog(win, {
      defaultPath: path.join(folder, safe),
      filters: ext ? [{ name: ext.toUpperCase() + ' file', extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : [],
    });
    if (res.canceled || !res.filePath) return null;
    await fs.writeFile(res.filePath, Buffer.from(data instanceof ArrayBuffer ? data : data.buffer));
    savedPaths.add(res.filePath);
    return res.filePath;
  });

  ipcMain.handle('file:show', (event, filePath) => {
    if (fromApp(event) && savedPaths.has(filePath)) shell.showItemInFolder(filePath);
  });

  ipcMain.handle('shell:open', (event, url) => {
    if (fromApp(event) && typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.flayniks.clipwave');
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  protocol.handle('clipwave', async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname !== '/' && pathname !== '/index.html') return new Response('Not found', { status: 404 });
    const html = await fs.readFile(PAGE);
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });

  const fromOrigin = (url) => typeof url === 'string' && url.startsWith(ORIGIN + '/');
  session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => done(ALLOWED_PERMISSIONS.has(permission) && fromOrigin(details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && fromOrigin(origin + '/'));

  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
