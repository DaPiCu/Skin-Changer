// SkinSwitcher – Main-Prozess
// Microsoft-Login → Xbox Live → XSTS → Minecraft Services, Skin-/Cape-API, Dateisystem, Verlauf, Tray.

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

// ---------------------------------------------------------------- Konstanten
// Öffentliche Client-ID des Minecraft-Launchers (Live-Login-Flow, wie bei vielen
// Drittanbieter-Launchern). Eigene Azure-App-ID kann in den Einstellungen gesetzt werden.
const DEFAULT_CLIENT_ID = '00000000402b5328';
const LIVE_REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
const LIVE_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const MC_API = 'https://api.minecraftservices.com';
const HISTORY_MAX = 60;

const USER_DIR = () => app.getPath('userData');
const ACCOUNTS_FILE = () => path.join(USER_DIR(), 'accounts.json');
const SETTINGS_FILE = () => path.join(USER_DIR(), 'settings.json');
const HISTORY_FILE = () => path.join(USER_DIR(), 'history.json');
const ICON = path.join(__dirname, 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'assets', 'tray.png');

let win = null;
let trayWin = null;
let tray = null;
let watcher = null;
let quitting = false;
let trayHiddenAt = 0;

// ---------------------------------------------------------------- Persistenz
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const DEFAULT_SETTINGS = {
  rootFolder: null,
  activeAccount: null,
  clientId: DEFAULT_CLIENT_ID,
  variantOverrides: {},   // { "<skinKey>": "classic" | "slim" }
  favorites: [],          // Dateipfade
  capeMode: 'global',     // 'global' | 'perSkin'
  skinCapes: {},          // { "<skinKey>": "<capeId>" | "none" }  (fehlt = globaler Umhang)
  trayOnClose: true,
  iconMode: 'default',    // 'default' | 'custom' | 'skinHead'
  theme: {
    preset: 'Aurora',
    accent: '#7c5cff',
    accent2: '#22d3ee',
    bg: '#0d0f17',
    surface: '#161927',
    text: '#eef0ff',
    glass: 0.55,
    radius: 16,
    blobs: true
  }
};

function loadSettings() {
  const s = readJson(SETTINGS_FILE(), {});
  return { ...DEFAULT_SETTINGS, ...s, theme: { ...DEFAULT_SETTINGS.theme, ...(s.theme || {}) } };
}
function saveSettings(s) { writeJson(SETTINGS_FILE(), s); }

function enc(str) {
  if (!str) return null;
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(str).toString('base64');
  return 'raw:' + Buffer.from(str).toString('base64');
}
function dec(str) {
  if (!str) return null;
  const [kind, data] = [str.slice(0, 4), str.slice(4)];
  if (kind === 'enc:') return safeStorage.decryptString(Buffer.from(data, 'base64'));
  return Buffer.from(data, 'base64').toString('utf8');
}

function loadAccounts() { return readJson(ACCOUNTS_FILE(), []); }
function saveAccounts(a) { writeJson(ACCOUNTS_FILE(), a); }

function loadHistory() { return readJson(HISTORY_FILE(), []); }
function saveHistory(h) { writeJson(HISTORY_FILE(), h.slice(0, HISTORY_MAX)); }

// Inhalts-Schlüssel eines Skins (gleiche Datei = gleicher Schlüssel, egal wo sie liegt)
const keyOfBuf = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
const bufOfData = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');
const keyOfData = (dataUrl) => keyOfBuf(bufOfData(dataUrl));

function broadcast(channel, payload, except) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || (except && w.webContents === except)) continue;
    w.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------- App-Icon
const CUSTOM_ICON = () => path.join(USER_DIR(), 'icon-custom.png');
const HEAD_ICON = () => path.join(USER_DIR(), 'icon-head.png');

function iconImage() {
  const mode = loadSettings().iconMode;
  const file = mode === 'custom' ? CUSTOM_ICON() : mode === 'skinHead' ? HEAD_ICON() : null;
  if (file && fs.existsSync(file)) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createFromPath(ICON);
}

function applyIcon() {
  const img = iconImage();
  try { if (tray) tray.setImage(img.resize({ width: 32, height: 32, quality: 'best' })); } catch { /* egal */ }
  for (const w of [win, trayWin]) { try { if (w && !w.isDestroyed()) w.setIcon(img); } catch { /* egal */ } }
  broadcast('icon:changed', { mode: loadSettings().iconMode, data: img.resize({ width: 128, height: 128 }).toDataURL() });
}

// Bild quadratisch zuschneiden und als 256er PNG speichern
function saveSquarePng(img, file) {
  const { width: w, height: h } = img.getSize();
  const side = Math.min(w, h);
  const sq = img.crop({ x: Math.floor((w - side) / 2), y: Math.floor((h - side) / 2), width: side, height: side });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, sq.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
}

// ---------------------------------------------------------------- HTTP-Helfer
async function http(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error(explainHttpError(url, res.status, body));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function explainHttpError(url, status, body) {
  if (body && body.XErr) {
    const x = String(body.XErr);
    if (x === '2148916233') return 'Dieser Microsoft-Account hat kein Xbox-Profil. Einmal auf xbox.com anmelden und Profil anlegen.';
    if (x === '2148916235') return 'Xbox Live ist in deinem Land nicht verfügbar.';
    if (x === '2148916236' || x === '2148916237') return 'Account benötigt Altersverifizierung (Südkorea).';
    if (x === '2148916238') return 'Kinder-Account: muss von einem Erwachsenen zu einer Familie hinzugefügt werden.';
    return `Xbox-Fehler ${x}`;
  }
  if (status === 429) return 'Rate-Limit erreicht – Mojang erlaubt nur wenige Änderungen pro Minute. Kurz warten und erneut versuchen.';
  if (status === 401) return 'Sitzung abgelaufen – bitte Account neu anmelden.';
  if (status === 404 && url.includes('/minecraft/profile')) return 'Dieser Account besitzt kein Minecraft: Java Edition.';
  const msg = body && (body.errorMessage || body.error_description || body.error || body.message);
  return `HTTP ${status}${msg ? ': ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)) : ''}`;
}

const form = (obj) => new URLSearchParams(obj).toString();

// ---------------------------------------------------------------- Auth-Kette
function interactiveLogin(clientId) {
  return new Promise((resolve, reject) => {
    // Eigene, flüchtige Session pro Login → mehrere Accounts ohne Cookie-Konflikte
    const partition = 'login-' + crypto.randomUUID();
    const authWin = new BrowserWindow({
      width: 500, height: 680, parent: win, modal: true, autoHideMenuBar: true,
      title: 'Microsoft-Anmeldung', icon: ICON,
      backgroundColor: '#ffffff',
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false }
    });

    const url = 'https://login.live.com/oauth20_authorize.srf?' + form({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: LIVE_REDIRECT,
      scope: LIVE_SCOPE,
      prompt: 'select_account'
    });

    let done = false;
    const check = (target) => {
      if (done || !target.startsWith(LIVE_REDIRECT)) return;
      done = true;
      const u = new URL(target);
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');
      authWin.destroy();
      if (code) resolve(code);
      else reject(new Error(error === 'access_denied' ? 'Anmeldung abgebrochen.' : 'Anmeldung fehlgeschlagen: ' + (error || 'unbekannt')));
    };

    authWin.webContents.on('will-redirect', (_e, u) => check(u));
    authWin.webContents.on('will-navigate', (_e, u) => check(u));
    authWin.webContents.on('did-navigate', (_e, u) => check(u));
    authWin.on('closed', () => { if (!done) { done = true; reject(new Error('Anmeldung abgebrochen.')); } });
    authWin.loadURL(url);
  });
}

async function msToken(clientId, params) {
  return http('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: clientId, scope: LIVE_SCOPE, redirect_uri: LIVE_REDIRECT, ...params })
  });
}

async function xboxChain(msAccessToken) {
  // Live-Tokens werden je nach Client mit oder ohne Präfix akzeptiert → der Reihe nach probieren
  let xbl = null, lastErr = null;
  for (const ticket of [msAccessToken, 't=' + msAccessToken, 'd=' + msAccessToken]) {
    try {
      xbl = await http('https://user.auth.xboxlive.com/user/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-xbl-contract-version': '1' },
        body: JSON.stringify({
          Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: ticket },
          RelyingParty: 'http://auth.xboxlive.com',
          TokenType: 'JWT'
        })
      });
      break;
    } catch (e) { lastErr = e; }
  }
  if (!xbl) throw lastErr;

  const xsts = await http('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-xbl-contract-version': '1' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    })
  });
  const uhs = xsts.DisplayClaims.xui[0].uhs;

  const mc = await http(`${MC_API}/authentication/login_with_xbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xsts.Token}` })
  });
  return { token: mc.access_token, expires: Date.now() + (mc.expires_in - 60) * 1000 };
}

async function getProfile(mcToken) {
  return http(`${MC_API}/minecraft/profile`, { headers: { Authorization: `Bearer ${mcToken}` } });
}

// Gibt ein gültiges MC-Token für den Account zurück (erneuert bei Bedarf)
async function ensureToken(accountId, force = false) {
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.id === accountId);
  if (!acc) throw new Error('Account nicht gefunden.');
  const mcTok = dec(acc.mcToken);
  if (!force && mcTok && acc.mcExpires > Date.now()) return mcTok;

  const settings = loadSettings();
  const ms = await msToken(settings.clientId, { grant_type: 'refresh_token', refresh_token: dec(acc.refreshToken) });
  const mc = await xboxChain(ms.access_token);
  acc.refreshToken = enc(ms.refresh_token);
  acc.mcToken = enc(mc.token);
  acc.mcExpires = mc.expires;
  saveAccounts(accounts);
  return mc.token;
}

// API-Aufruf mit automatischem Retry bei abgelaufenem Token
async function withToken(accountId, fn) {
  try { return await fn(await ensureToken(accountId)); }
  catch (e) {
    if (e.status === 401) return fn(await ensureToken(accountId, true));
    throw e;
  }
}

// Texturen (textures.minecraft.net) als Data-URL laden → keine CORS-Probleme im Renderer
const textureCache = new Map();
async function textureDataUrl(url) {
  if (!url) return null;
  if (textureCache.has(url)) return textureCache.get(url);
  const res = await fetch(url.replace(/^http:/, 'https:'));
  if (!res.ok) return null;
  const data = 'data:image/png;base64,' + Buffer.from(await res.arrayBuffer()).toString('base64');
  textureCache.set(url, data);
  return data;
}

async function enrichProfile(p) {
  const skin = (p.skins || []).find(s => s.state === 'ACTIVE') || (p.skins || [])[0];
  const capes = await Promise.all((p.capes || []).map(async c => ({
    id: c.id, alias: c.alias, active: c.state === 'ACTIVE', texture: await textureDataUrl(c.url)
  })));
  return {
    uuid: p.id,
    name: p.name,
    skin: skin ? { url: skin.url, variant: (skin.variant || 'CLASSIC').toLowerCase(), texture: await textureDataUrl(skin.url) } : null,
    capes
  };
}

// ---------------------------------------------------------------- Skin / Cape setzen
async function putCape(accountId, capeId) {
  return withToken(accountId, (token) => capeId
    ? http(`${MC_API}/minecraft/profile/capes/active`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ capeId })
      })
    : http(`${MC_API}/minecraft/profile/capes/active`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
      }));
}

function pushHistory(entry) {
  const h = loadHistory().filter(e => e.key !== entry.key);
  h.unshift(entry);
  saveHistory(h);
  broadcast('history:changed');
  rebuildTrayTooltip();
}

// Zentrale Anwenden-Funktion (Hauptfenster + Tray nutzen sie)
async function applySkin(accountId, skin) {
  const settings = loadSettings();
  const buf = bufOfData(skin.data);
  const key = keyOfBuf(buf);
  const variant = skin.variant === 'slim' ? 'slim' : 'classic';

  // 1) Skin hochladen
  let raw = await withToken(accountId, async (token) => {
    const fd = new FormData();
    fd.append('variant', variant);
    fd.append('file', new Blob([buf], { type: 'image/png' }), 'skin.png');
    return http(`${MC_API}/minecraft/profile/skins`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd
    });
  });
  if (!raw || !raw.id) raw = await withToken(accountId, getProfile);

  // 2) Umhang pro Skin (nur im Modus "Pro Skin" und wenn zugewiesen)
  let capeNote = null;
  if (settings.capeMode === 'perSkin' && settings.skinCapes[key]) {
    const want = settings.skinCapes[key] === 'none' ? null : settings.skinCapes[key];
    const owned = (raw.capes || []);
    const current = (owned.find(c => c.state === 'ACTIVE') || {}).id || null;
    if (want && !owned.some(c => c.id === want)) {
      capeNote = 'Der zugewiesene Umhang gehört nicht zu diesem Account – Umhang unverändert.';
    } else if (want !== current) {
      raw = await putCape(accountId, want);
      if (!raw || !raw.id) raw = await withToken(accountId, getProfile);
    }
  }

  // 3) Verlauf
  const acc = loadAccounts().find(a => a.id === accountId);
  pushHistory({
    id: crypto.randomUUID(),
    key,
    name: skin.name || 'Skin',
    data: skin.data,
    variant,
    src: skin.path || null,
    accountId,
    accountName: acc ? acc.name : '',
    time: Date.now()
  });

  const profile = await enrichProfile(raw);
  broadcast('profile:updated', { accountId, profile });
  return { profile, capeNote };
}

// ---------------------------------------------------------------- Dateisystem
function pngInfo(buf) {
  // PNG-Signatur + IHDR-Breite/Höhe
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
const isSkinSize = (i) => i && i.w === 64 && (i.h === 64 || i.h === 32);

async function listDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const folders = [], skins = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue;
      // Vorschau: Anzahl + bis zu 4 Skins für das Ordner-Icon
      let count = 0, sub = 0; const previews = [];
      try {
        for (const s of await fsp.readdir(full, { withFileTypes: true })) {
          if (s.isDirectory()) { sub++; continue; }
          if (!/\.png$/i.test(s.name)) continue;
          count++;
          if (previews.length < 4) {
            const b = await fsp.readFile(path.join(full, s.name));
            if (isSkinSize(pngInfo(b))) previews.push('data:image/png;base64,' + b.toString('base64'));
          }
        }
      } catch { /* kein Zugriff */ }
      folders.push({ name: e.name, path: full, count, sub, previews });
    } else if (/\.png$/i.test(e.name)) {
      const buf = await fsp.readFile(full);
      const info = pngInfo(buf);
      if (!isSkinSize(info)) continue;
      const stat = await fsp.stat(full);
      skins.push({
        name: e.name.replace(/\.png$/i, ''),
        path: full,
        key: keyOfBuf(buf),
        legacy: info.h === 32,
        mtime: stat.mtimeMs,
        data: 'data:image/png;base64,' + buf.toString('base64')
      });
    }
  }
  const coll = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
  folders.sort((a, b) => coll.compare(a.name, b.name));
  skins.sort((a, b) => coll.compare(a.name, b.name));
  return { dir, folders, skins };
}

function watchDir(dir) {
  if (watcher) { watcher.close(); watcher = null; }
  let t = null;
  try {
    watcher = fs.watch(dir, () => {
      clearTimeout(t);
      t = setTimeout(() => win && !win.isDestroyed() && win.webContents.send('fs:changed', dir), 300);
    });
  } catch { /* ignorieren */ }
}

// ---------------------------------------------------------------- IPC
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    try { return { ok: true, data: await fn(...args, e) }; }
    catch (err) { console.error(channel, err); return { ok: false, error: err.message || String(err) }; }
  });
}

function registerIpc() {
  handle('settings:get', () => loadSettings());
  handle('settings:set', (patch) => {
    const s = { ...loadSettings(), ...patch };
    if (patch.theme) s.theme = { ...loadSettings().theme, ...patch.theme };
    saveSettings(s);
    return s;
  });

  handle('fs:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Skin-Ordner wählen' });
    if (r.canceled || !r.filePaths[0]) return null;
    const s = loadSettings(); s.rootFolder = r.filePaths[0]; saveSettings(s);
    return r.filePaths[0];
  });
  handle('fs:list', async (dir) => { const r = await listDir(dir); watchDir(dir); return r; });
  handle('fs:reveal', (p) => shell.showItemInFolder(p));
  handle('fs:exists', (p) => !!p && fs.existsSync(p));
  handle('fs:saveSkin', async (dir, name, dataUrl) => {
    const safe = name.replace(/[<>:"/\\|?*]/g, '_');
    let target = path.join(dir, safe + '.png'), i = 2;
    while (fs.existsSync(target)) target = path.join(dir, `${safe} (${i++}).png`);
    await fsp.writeFile(target, bufOfData(dataUrl));
    return target;
  });
  handle('fs:readPng', async (p) => {
    const buf = await fsp.readFile(p);
    if (!isSkinSize(pngInfo(buf))) throw new Error('Keine gültige Skin-Datei (64×64 oder 64×32 PNG).');
    return { data: 'data:image/png;base64,' + buf.toString('base64'), key: keyOfBuf(buf) };
  });

  handle('acc:list', () => loadAccounts().map(a => ({ id: a.id, name: a.name, uuid: a.uuid, head: a.head || null })));

  handle('acc:add', async () => {
    const settings = loadSettings();
    const code = await interactiveLogin(settings.clientId);
    const ms = await msToken(settings.clientId, { grant_type: 'authorization_code', code });
    const mc = await xboxChain(ms.access_token);
    const profile = await getProfile(mc.token);
    const accounts = loadAccounts();
    let acc = accounts.find(a => a.uuid === profile.id);
    if (!acc) { acc = { id: crypto.randomUUID(), uuid: profile.id }; accounts.push(acc); }
    Object.assign(acc, {
      name: profile.name,
      refreshToken: enc(ms.refresh_token),
      mcToken: enc(mc.token),
      mcExpires: mc.expires
    });
    saveAccounts(accounts);
    const s = loadSettings(); s.activeAccount = acc.id; saveSettings(s);
    broadcast('accounts:changed');
    return { id: acc.id, name: acc.name, uuid: acc.uuid };
  });

  handle('acc:remove', (id) => {
    saveAccounts(loadAccounts().filter(a => a.id !== id));
    const s = loadSettings();
    if (s.activeAccount === id) { s.activeAccount = null; saveSettings(s); }
    broadcast('accounts:changed');
    return true;
  });

  handle('acc:setActive', (id, e) => {
    const s = loadSettings(); s.activeAccount = id; saveSettings(s);
    broadcast('account:active', id, e.sender);
    rebuildTrayTooltip();
    return true;
  });

  handle('acc:setHead', (id, head) => {
    const accounts = loadAccounts();
    const a = accounts.find(x => x.id === id);
    if (a) { a.head = head; saveAccounts(accounts); }
    return true;
  });

  handle('acc:profile', async (id) => {
    const p = await withToken(id, getProfile);
    const accounts = loadAccounts();
    const a = accounts.find(x => x.id === id);
    if (a && a.name !== p.name) { a.name = p.name; saveAccounts(accounts); }
    return enrichProfile(p);
  });

  handle('skin:apply', (id, skin) => applySkin(id, skin));

  handle('skin:reset', async (id) => {
    await withToken(id, (token) => http(`${MC_API}/minecraft/profile/skins/active`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
    }));
    const profile = await enrichProfile(await withToken(id, getProfile));
    broadcast('profile:updated', { accountId: id, profile });
    return profile;
  });

  handle('cape:set', async (id, capeId) => {
    let raw = await putCape(id, capeId);
    if (!raw || !raw.id) raw = await withToken(id, getProfile);
    return enrichProfile(raw);
  });

  // Skin eines beliebigen Spielers per Name importieren
  handle('skin:byName', async (name) => {
    let u = null;
    try { u = await http(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`); } catch { /* 404 */ }
    if (!u || !u.id) throw new Error(`Spieler „${name}“ nicht gefunden.`);
    const p = await http(`https://sessionserver.mojang.com/session/minecraft/profile/${u.id}`);
    const tex = JSON.parse(Buffer.from(p.properties.find(x => x.name === 'textures').value, 'base64').toString());
    const skin = tex.textures.SKIN;
    if (!skin) throw new Error('Spieler hat keinen eigenen Skin.');
    const data = await textureDataUrl(skin.url);
    return {
      name: u.name,
      variant: skin.metadata && skin.metadata.model === 'slim' ? 'slim' : 'classic',
      data,
      key: keyOfData(data)
    };
  });

  // Verlauf
  handle('history:list', () => loadHistory());
  handle('history:remove', (id) => { saveHistory(loadHistory().filter(e => e.id !== id)); broadcast('history:changed'); return true; });
  handle('history:clear', () => { saveHistory([]); broadcast('history:changed'); return true; });

  // Tray-Popup
  handle('tray:openMain', () => { hideTrayPopup(); showMain(); return true; });
  handle('tray:hide', () => { hideTrayPopup(); return true; });
  handle('tray:resize', (h) => {
    if (!trayWin || trayWin.isDestroyed()) return false;
    const [w] = trayWin.getSize();
    const height = Math.max(160, Math.min(640, Math.round(h)));
    const b = trayWin.getBounds();
    const anchoredBottom = trayWin._anchorBottom;
    trayWin.setBounds({ x: b.x, y: anchoredBottom ? b.y + b.height - height : b.y, width: w, height });
    return true;
  });

  handle('app:openExternal', (url) => shell.openExternal(url));

  // App-Icon
  handle('icon:get', () => ({ mode: loadSettings().iconMode, data: iconImage().resize({ width: 128, height: 128 }).toDataURL() }));
  handle('icon:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'App-Icon wählen', properties: ['openFile'],
      filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'ico', 'bmp', 'gif', 'webp'] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    let img = nativeImage.createFromPath(r.filePaths[0]);
    if (img.isEmpty()) {                       // z. B. WebP → über Buffer versuchen
      img = nativeImage.createFromBuffer(await fsp.readFile(r.filePaths[0]));
    }
    if (img.isEmpty()) throw new Error('Bild konnte nicht gelesen werden.');
    saveSquarePng(img, CUSTOM_ICON());
    const s = loadSettings(); s.iconMode = 'custom'; saveSettings(s);
    applyIcon();
    return true;
  });
  handle('icon:mode', (mode) => {
    if (mode === 'custom' && !fs.existsSync(CUSTOM_ICON())) throw new Error('Noch kein eigenes Bild gewählt.');
    const s = loadSettings(); s.iconMode = mode; saveSettings(s);
    applyIcon();
    return true;
  });
  // Renderer liefert den Kopf des aktuellen Skins (256 px, pixelig skaliert)
  handle('icon:head', (dataUrl) => {
    fs.writeFileSync(HEAD_ICON(), bufOfData(dataUrl));
    if (loadSettings().iconMode === 'skinHead') applyIcon();
    return true;
  });
}

// ---------------------------------------------------------------- Fenster
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1040, minHeight: 640,
    backgroundColor: '#0d0f17',
    title: 'SkinSwitcher',
    icon: ICON,
    show: !process.argv.includes('--hidden'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#eef0ff', height: 52 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // Schließen → in den Tray (sofern aktiviert)
  win.on('close', (e) => {
    if (quitting || !tray || !loadSettings().trayOnClose) return;
    e.preventDefault();
    win.hide();
    if (!app._trayHintShown && process.platform === 'win32') {
      app._trayHintShown = true;
      try { tray.displayBalloon({ title: 'SkinSwitcher', content: 'Läuft im Hintergrund weiter. Klick aufs Tray-Icon für deine letzten Skins.', iconType: 'info' }); } catch { /* egal */ }
    }
  });
  win.on('closed', () => { win = null; });
}

function showMain() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

ipcMain.on('app:titlebar', (_e, color) => {
  try { win && win.setTitleBarOverlay({ color: '#00000000', symbolColor: color, height: 52 }); } catch { /* nicht-Windows */ }
});

// ---------------------------------------------------------------- Tray
const TRAY_W = 320;

function createTrayPopup() {
  trayWin = new BrowserWindow({
    width: TRAY_W, height: 420,
    show: false, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, transparent: true, hasShadow: false,
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  trayWin.loadFile(path.join(__dirname, 'src', 'tray.html'));
  trayWin.on('blur', hideTrayPopup);
  trayWin.on('closed', () => { trayWin = null; });
}

function hideTrayPopup() {
  if (trayWin && !trayWin.isDestroyed() && trayWin.isVisible()) {
    trayWin.hide();
    trayHiddenAt = Date.now();
  }
}

function toggleTrayPopup(bounds) {
  if (!trayWin || trayWin.isDestroyed()) createTrayPopup();
  if (trayWin.isVisible()) return hideTrayPopup();
  if (Date.now() - trayHiddenAt < 250) return; // Klick hat das Popup gerade per Blur geschlossen

  const b = bounds && bounds.width ? bounds : tray.getBounds();
  const point = b && b.width ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(point).workArea;
  const [w, h] = trayWin.getSize();

  let x = Math.round(point.x - w / 2);
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - w - 8));
  const bottom = point.y > wa.y + wa.height / 2;        // Taskleiste unten?
  const y = bottom ? wa.y + wa.height - h - 8 : wa.y + 8;
  trayWin._anchorBottom = bottom;
  trayWin.setBounds({ x, y, width: w, height: h });
  trayWin.webContents.send('tray:refresh');
  trayWin.show();
  trayWin.focus();
}

function rebuildTrayTooltip() {
  if (!tray) return;
  const s = loadSettings();
  const acc = loadAccounts().find(a => a.id === s.activeAccount);
  tray.setToolTip(acc ? `SkinSwitcher – ${acc.name}` : 'SkinSwitcher');
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(TRAY_ICON);
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  } catch (e) { console.error('Tray nicht verfügbar:', e.message); tray = null; return; }

  rebuildTrayTooltip();
  tray.on('click', (_e, bounds) => toggleTrayPopup(bounds));
  tray.on('right-click', () => {
    hideTrayPopup();
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: 'App öffnen (FULL)', click: showMain },
      { type: 'separator' },
      { label: 'App schließen', click: () => { quitting = true; app.quit(); } }
    ]));
  });
  tray.on('double-click', showMain);
}

// ---------------------------------------------------------------- Lebenszyklus
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('net.dapicu.skinswitcher');
    registerIpc();
    createWindow();
    createTray();
    createTrayPopup();
    applyIcon();
    app.on('activate', showMain);
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
}
