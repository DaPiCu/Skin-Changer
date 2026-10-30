/* SkinSwitcher – Renderer (Hauptfenster) */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const R = window.SkinRender;
  const api = window.api;

  const PRESETS = {
    Aurora:  { accent: '#7c5cff', accent2: '#22d3ee', bg: '#0d0f17', surface: '#161927', text: '#eef0ff' },
    Sunset:  { accent: '#ff5e7e', accent2: '#ffb347', bg: '#140d12', surface: '#22161d', text: '#fff1ee' },
    Mint:    { accent: '#10b981', accent2: '#a3e635', bg: '#0b1311', surface: '#13201c', text: '#eafff6' },
    Ocean:   { accent: '#3b82f6', accent2: '#06b6d4', bg: '#0a1020', surface: '#121b30', text: '#e8f1ff' },
    Crimson: { accent: '#e11d48', accent2: '#a855f7', bg: '#100a0d', surface: '#1d1217', text: '#ffeef2' },
    Hell:    { accent: '#6d5dfc', accent2: '#0ea5e9', bg: '#eef0f6', surface: '#ffffff', text: '#1b1d29' }
  };

  const state = {
    settings: null,
    accounts: [],
    activeId: null,
    profile: null,
    currentHash: null,
    view: 'folder',       // 'folder' | 'history'
    dir: null,
    listing: null,
    history: [],
    selected: null,       // { name, data, key, path|null, variant? }
    seg: 'auto',
    search: '',
    favOnly: false,
    meta: new Map(),      // key -> { slim, hash }
    busy: false
  };

  // ================================================================ Utils
  function toast(msg, type = 'info', ms = 3800) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="dot"></span><span></span>`;
    el.lastChild.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
  }
  const err = (e) => toast(e.message || String(e), 'err', 6000);
  const sep = () => (state.settings.rootFolder || '').includes('\\') ? '\\' : '/';
  let saveTimer = null;
  function saveSettings(patch, delay = 0) {
    Object.assign(state.settings, patch);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api.settings.set(patch).catch(err), delay);
  }
  function timeAgo(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'gerade eben';
    if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
    if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
    const d = Math.floor(s / 86400);
    return d === 1 ? 'gestern' : `vor ${d} Tagen`;
  }
  function dayLabel(t) {
    const d = new Date(t), today = new Date();
    const diff = Math.floor((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
    if (diff === 0) return 'Heute';
    if (diff === 1) return 'Gestern';
    if (diff < 7) return 'Diese Woche';
    return d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  }

  async function ensureMeta(s) {
    let m = state.meta.get(s.key);
    if (!m) {
      const img = await R.loadImg(s.data);
      m = { slim: R.detectSlim(img), hash: R.hash(img) };
      state.meta.set(s.key, m);
    }
    return m;
  }

  // ================================================================ Theme
  function applyTheme(t) {
    const r = document.documentElement.style;
    r.setProperty('--accent', t.accent);
    r.setProperty('--accent2', t.accent2);
    r.setProperty('--bg', t.bg);
    r.setProperty('--surface', t.surface);
    r.setProperty('--text', t.text);
    r.setProperty('--glass', t.glass);
    r.setProperty('--radius', t.radius + 'px');
    document.body.classList.toggle('no-blobs', !t.blobs);
    api.titlebar(t.text);
  }

  function renderSettings() {
    const t = state.settings.theme;
    $('#presets').innerHTML = '';
    for (const [name, p] of Object.entries(PRESETS)) {
      const b = document.createElement('button');
      b.className = 'preset' + (t.preset === name ? ' active' : '');
      b.innerHTML = `<i style="background:linear-gradient(135deg,${p.accent},${p.accent2})"></i>${name}`;
      b.onclick = () => { updateTheme({ ...p, preset: name }); renderSettings(); };
      $('#presets').appendChild(b);
    }
    $$('#settingsModal [data-key]').forEach(inp => {
      const v = t[inp.dataset.key];
      if (inp.type === 'checkbox') inp.checked = !!v; else inp.value = v;
    });
    $('#clientId').value = state.settings.clientId;
    $('#trayOnClose').checked = !!state.settings.trayOnClose;
    api.icon.get().then(renderIcon).catch(() => {});
  }

  function renderIcon(info) {
    $('#iconPreview').src = info.data;
    $$('[data-icon]').forEach(b => b.classList.toggle('active', b.dataset.icon === info.mode));
  }

  function updateTheme(patch) {
    const theme = { ...state.settings.theme, ...patch };
    state.settings.theme = theme;
    applyTheme(theme);
    saveSettings({ theme }, 250);
  }

  // ================================================================ 3D-Viewer
  let viewer = null, animIdx = 2;   // Standard: Laufen
  const ANIMS = () => [null, new skinview3d.IdleAnimation(), new skinview3d.WalkingAnimation(), new skinview3d.RunningAnimation(), new skinview3d.WaveAnimation()];

  function initViewer() {
    const canvas = $('#viewer');
    const wrap = $('.viewer-wrap');
    viewer = new skinview3d.SkinViewer({ canvas, width: wrap.clientWidth, height: wrap.clientHeight });
    viewer.fov = 40;
    viewer.zoom = 0.85;
    viewer.autoRotate = true;
    viewer.autoRotateSpeed = 0.5;
    viewer.animation = ANIMS()[animIdx];
    canvas.addEventListener('pointerdown', () => { viewer.autoRotate = false; });
    new ResizeObserver(() => viewer.setSize(wrap.clientWidth, wrap.clientHeight)).observe(wrap);
    $('#animBtn').onclick = () => {
      const a = ANIMS(); animIdx = (animIdx + 1) % a.length;
      viewer.animation = a[animIdx];
      viewer.autoRotate = true;
    };
  }

  const activeCape = () => state.profile ? state.profile.capes.find(c => c.active) : null;
  const perSkin = () => state.settings.capeMode === 'perSkin';
  const capeAssign = (key) => key ? state.settings.skinCapes[key] : undefined;   // undefined = global

  // Welcher Umhang soll in der Vorschau zu sehen sein?
  function previewCape() {
    if (perSkin() && state.selected) {
      const a = capeAssign(state.selected.key);
      if (a === 'none') return null;
      if (a) return state.profile ? state.profile.capes.find(c => c.id === a) || null : null;
    }
    return activeCape();
  }

  let viewerToken = 0;
  async function showInViewer(data, variant) {
    if (!viewer) return;
    const my = ++viewerToken;
    if (!data) { viewer.loadSkin(null); viewer.loadCape(null); return; }
    await viewer.loadSkin(data, { model: variant === 'slim' ? 'slim' : 'default' });
    if (my !== viewerToken) return;
    const cape = previewCape();
    if (cape && cape.texture) await viewer.loadCape(cape.texture); else viewer.loadCape(null);
  }
  function refreshViewer() {
    if (state.selected) showInViewer(state.selected.data, effectiveVariant());
    else if (state.profile && state.profile.skin) showInViewer(state.profile.skin.texture, state.profile.skin.variant);
  }

  // ================================================================ Accounts
  async function loadAccounts() {
    state.accounts = await api.acc.list();
    if (!state.accounts.find(a => a.id === state.activeId)) state.activeId = state.accounts[0]?.id || null;
    renderAccMenu();
  }

  function drawHeadInto(canvas, src) {
    const x = canvas.getContext('2d');
    x.clearRect(0, 0, canvas.width, canvas.height);
    if (!src) return;
    R.loadImg(src).then(img => R.head(img, canvas.width, canvas)).catch(() => {});
  }

  function renderAccMenu() {
    const acc = state.accounts.find(a => a.id === state.activeId);
    $('#accName').textContent = acc ? acc.name : 'Account hinzufügen';
    drawHeadInto($('#accHead'), acc && acc.head);

    const list = $('#accList');
    list.innerHTML = '';
    for (const a of state.accounts) {
      const row = document.createElement('div');
      row.className = 'menu-item' + (a.id === state.activeId ? ' active' : '');
      row.innerHTML = `<canvas width="26" height="26"></canvas><span class="grow"></span><button class="del" title="Account entfernen">✕</button>`;
      row.querySelector('.grow').textContent = a.name;
      drawHeadInto(row.querySelector('canvas'), a.head);
      row.onclick = (e) => {
        if (e.target.closest('.del')) return;
        closeMenus();
        switchAccount(a.id);
      };
      row.querySelector('.del').onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Account „${a.name}“ entfernen?`)) return;
        await api.acc.remove(a.id).catch(err);
        if (state.activeId === a.id) { state.activeId = null; state.profile = null; }
        await loadAccounts();
        if (state.activeId) switchAccount(state.activeId); else renderProfile();
      };
      list.appendChild(row);
    }
  }

  async function addAccount() {
    closeMenus();
    try {
      toast('Microsoft-Anmeldefenster geöffnet …');
      const acc = await api.acc.add();
      toast(`Angemeldet als ${acc.name}`, 'ok');
      state.activeId = acc.id;
      await loadAccounts();
      await switchAccount(acc.id);
    } catch (e) { err(e); }
  }

  async function switchAccount(id, fromOutside = false) {
    state.activeId = id;
    state.settings.activeAccount = id;
    if (!fromOutside) api.acc.setActive(id).catch(() => {});
    renderAccMenu();
    state.profile = null;
    renderProfile(true);
    try {
      state.profile = await api.acc.profile(id);
      onProfileUpdated();
    } catch (e) { err(e); renderProfile(); }
  }

  async function onProfileUpdated() {
    const p = state.profile;
    state.currentHash = null;
    if (p && p.skin && p.skin.texture) {
      try {
        const img = await R.loadImg(p.skin.texture);
        state.currentHash = R.hash(img);
        const head = R.head(img, 64).toDataURL();
        const big = document.createElement('canvas'); big.width = big.height = 256;
        R.head(img, 256, big);
        api.icon.head(big.toDataURL()).catch(() => {});
        const acc = state.accounts.find(a => a.id === state.activeId);
        if (acc && acc.head !== head) { acc.head = head; api.acc.setHead(acc.id, head); }
      } catch { /* egal */ }
    }
    const acc = state.accounts.find(a => a.id === state.activeId);
    if (acc && p) acc.name = p.name;
    renderAccMenu();
    renderProfile();
    markActiveCards();
  }

  function renderProfile(loading = false) {
    const p = state.profile;
    $('#viewerOverlay').classList.toggle('hidden', !!(p || state.selected) || loading);
    $('#viewerOverlay').textContent = state.activeId ? 'Profil konnte nicht geladen werden' : 'Kein Account angemeldet';
    if (!state.selected) {
      $('#previewLabel').textContent = 'Aktueller Skin';
      $('#previewName').textContent = p ? p.name : (loading ? 'Lädt …' : '–');
      if (p && p.skin) showInViewer(p.skin.texture, p.skin.variant);
      else if (!loading) showInViewer(null);
    } else {
      showInViewer(state.selected.data, effectiveVariant());
    }
    renderCapes();
    updateApply();
  }

  // ================================================================ Umhänge
  function renderCapes() {
    const box = $('#capes');
    const hint = $('#capeHint');
    box.innerHTML = '';
    $$('#capeModeSeg button').forEach(b => b.classList.toggle('active', b.dataset.m === state.settings.capeMode));
    const p = state.profile;
    if (!p) {
      $('#capeCount').textContent = '';
      hint.textContent = '';
      box.innerHTML = `<div class="cape-tip">Melde dich an, um deine Umhänge zu sehen.</div>`;
      return;
    }
    $('#capeCount').textContent = `· ${p.capes.length}`;

    const perSkinEdit = perSkin() && !!state.selected;
    const assign = perSkinEdit ? capeAssign(state.selected.key) : undefined;

    // Hinweistext
    if (!perSkin()) hint.innerHTML = 'Ein Umhang für alle Skins – Klick ändert ihn sofort.';
    else if (perSkinEdit) { hint.innerHTML = 'Umhang für <b></b> – wird beim Anwenden gesetzt.'; hint.querySelector('b').textContent = state.selected.name; }
    else hint.innerHTML = 'Kein Skin gewählt – Klick ändert den <b>globalen</b> Umhang.';

    const tile = (cls, title, inner, active, onClick) => {
      const b = document.createElement('button');
      b.className = `cape ${cls}${active ? ' active' : ''}`;
      b.title = title;
      b.innerHTML = inner;
      b.onclick = onClick;
      box.appendChild(b);
      return b;
    };

    if (perSkinEdit) {
      const g = activeCape();
      tile('global', `Globaler Umhang${g ? ' (' + g.alias + ')' : ''}`, '<span class="none">🌐</span><span class="tag">Global</span>',
        assign === undefined, () => assignCape(undefined));
    }
    tile('', 'Kein Umhang', '<span class="none">⦸</span>' + (perSkinEdit ? '<span class="tag">Keiner</span>' : ''),
      perSkinEdit ? assign === 'none' : !activeCape(), () => perSkinEdit ? assignCape('none') : setCape(null));

    for (const c of p.capes) {
      const isActive = perSkinEdit ? assign === c.id : c.active;
      const b = tile('', c.alias, '', isActive, () => perSkinEdit ? assignCape(c.id) : setCape(c.id));
      if (c.texture) R.loadImg(c.texture).then(img => b.prepend(R.capeFront(img))).catch(() => {});
    }
    if (!p.capes.length) {
      const tip = document.createElement('div');
      tip.className = 'cape-tip';
      tip.textContent = 'Dieser Account besitzt keine Umhänge.';
      box.appendChild(tip);
    }
  }

  // Pro-Skin-Zuweisung
  async function assignCape(value) {
    const s = state.selected;
    if (!s) return;
    const map = { ...state.settings.skinCapes };
    if (value === undefined) delete map[s.key]; else map[s.key] = value;
    saveSettings({ skinCapes: map });
    renderCapes();
    refreshViewer();
    updateCardCapeBadges();

    // Ist der gewählte Skin gerade aktiv? → Umhang direkt mitsetzen
    const m = await ensureMeta(s);
    if (state.activeId && m.hash === state.currentHash && value !== undefined) {
      const want = value === 'none' ? null : value;
      const cur = activeCape();
      if ((cur ? cur.id : null) !== want) setCape(want, true);
    }
  }

  async function setCape(capeId, silent = false) {
    if (!state.activeId || state.busy) return;
    const cur = activeCape();
    if ((cur ? cur.id : null) === capeId) return;
    state.busy = true;
    try {
      state.profile = await api.cape.set(state.activeId, capeId);
      const c = activeCape();
      toast(c ? `Umhang „${c.alias}“ aktiviert` : 'Umhang ausgeblendet', 'ok');
      onProfileUpdated();
    } catch (e) { err(e); }
    state.busy = false;
  }

  function capeBadge(el, key) {
    el.querySelector('.cape-b')?.remove();
    if (!perSkin() || !state.profile) return;
    const a = capeAssign(key);
    if (!a) return;
    const b = document.createElement('span');
    if (a === 'none') { b.className = 'badge cape-b none'; b.textContent = '⦸'; b.title = 'Kein Umhang'; }
    else {
      const c = state.profile.capes.find(x => x.id === a);
      b.className = 'badge cape-b';
      b.title = c ? `Umhang: ${c.alias}` : 'Umhang (anderer Account)';
      if (c && c.texture) R.loadImg(c.texture).then(img => b.appendChild(R.capeFront(img, 1))).catch(() => {});
      else b.textContent = '?';
    }
    el.appendChild(b);
  }
  const updateCardCapeBadges = () => $$('.card.skin').forEach(el => capeBadge(el, el.dataset.key));

  // ================================================================ Ansicht wechseln
  function setView(v) {
    state.view = v;
    document.body.dataset.view = v;
    $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    const btn = $(`.rail-btn[data-view="${v}"]`);
    $('.rail').style.setProperty('--rail-y', btn.offsetTop + 'px');
    $('#search').value = ''; state.search = '';
    if (v === 'history') { $('#empty').classList.add('hidden'); loadHistory(); }
    else { $('#empty').classList.toggle('hidden', !!state.dir); renderGrid(); }
  }

  // ================================================================ Verlauf
  async function loadHistory() {
    try { state.history = await api.history.list(); } catch (e) { err(e); }
    const n = state.history.length;
    $('#histCount').textContent = n > 99 ? '99+' : n;
    $('#histCount').classList.toggle('hidden', !n);
    $('#histSub').textContent = n ? `· ${n}` : '';
    if (state.view === 'history') renderGrid();
  }

  // ================================================================ Ordner
  async function openDir(dir, keepScroll = false) {
    const scroll = $('#grid').scrollTop;
    try {
      state.listing = await api.fs.list(dir);
      state.dir = dir;
    } catch (e) {
      err(e);
      if (dir !== state.settings.rootFolder && state.settings.rootFolder) return openDir(state.settings.rootFolder);
      state.listing = null; state.dir = null;
    }
    if (state.view !== 'folder') return;
    $('#empty').classList.toggle('hidden', !!state.dir);
    $('#upBtn').disabled = !state.dir || state.dir === state.settings.rootFolder;
    renderCrumbs();
    renderGrid();
    $('#grid').scrollTop = keepScroll ? scroll : 0;
  }

  function renderCrumbs() {
    const nav = $('#crumbs');
    nav.innerHTML = '';
    const root = state.settings.rootFolder;
    if (!root || !state.dir) return;
    const s = sep();
    const rootName = root.split(/[\\/]/).filter(Boolean).pop() || root;
    const rel = state.dir.slice(root.length).split(/[\\/]/).filter(Boolean);
    const parts = [{ name: rootName, path: root }];
    let acc = root;
    for (const r of rel) { acc = acc.replace(/[\\/]$/, '') + s + r; parts.push({ name: r, path: acc }); }
    parts.forEach((p, i) => {
      if (i) { const sp = document.createElement('span'); sp.className = 'sep'; sp.textContent = '›'; nav.appendChild(sp); }
      const b = document.createElement('button');
      b.textContent = p.name;
      b.onclick = () => openDir(p.path);
      nav.appendChild(b);
    });
  }

  function goUp() {
    if (state.view !== 'folder' || !state.dir || state.dir === state.settings.rootFolder) return;
    const parent = state.dir.replace(/[\\/][^\\/]+[\\/]?$/, '');
    openDir(parent.length >= state.settings.rootFolder.length ? parent : state.settings.rootFolder);
  }

  // ================================================================ Grid
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      e.target._render && e.target._render();
    }
  }, { root: null, rootMargin: '300px' });

  function gridMsg(text) {
    const m = document.createElement('div');
    m.className = 'grid-msg';
    m.textContent = text;
    $('#grid').appendChild(m);
  }

  function renderGrid() {
    const grid = $('#grid');
    grid.innerHTML = '';
    const q = state.search.trim().toLowerCase();

    if (state.view === 'history') {
      const items = state.history.filter(h => !q || h.name.toLowerCase().includes(q) || (h.accountName || '').toLowerCase().includes(q));
      let lastDay = null;
      for (const h of items) {
        const day = dayLabel(h.time);
        if (day !== lastDay) {
          const d = document.createElement('div'); d.className = 'day-head'; d.textContent = day;
          grid.appendChild(d); lastDay = day;
        }
        grid.appendChild(skinCard({ name: h.name, data: h.data, key: h.key, path: h.src, variant: h.variant, hist: h }));
      }
      if (!items.length) gridMsg(q ? 'Keine Treffer.' : 'Noch kein Verlauf – jeder angewendete Skin landet hier.');
      return;
    }

    if (!state.listing) return;
    const favs = new Set(state.settings.favorites);
    const folders = state.listing.folders.filter(f => !state.favOnly && (!q || f.name.toLowerCase().includes(q)));
    const skins = state.listing.skins.filter(s => (!q || s.name.toLowerCase().includes(q)) && (!state.favOnly || favs.has(s.path)));

    for (const f of folders) grid.appendChild(folderCard(f));
    for (const s of skins) grid.appendChild(skinCard(s, favs.has(s.path)));
    if (!folders.length && !skins.length) gridMsg(q || state.favOnly ? 'Keine Treffer.' : 'Dieser Ordner enthält keine Skins (64×64 / 64×32 PNG).');
  }

  function folderCard(f) {
    const el = document.createElement('div');
    el.className = 'card folder';
    el.innerHTML = `<div class="art"><div class="folder-icon"></div><div class="heads"></div></div><div class="name"></div><div class="meta"></div>`;
    el.querySelector('.name').textContent = f.name;
    el.querySelector('.meta').textContent = [f.count ? `${f.count} Skins` : null, f.sub ? `${f.sub} Ordner` : null].filter(Boolean).join(' · ') || 'leer';
    const heads = el.querySelector('.heads');
    if (f.previews.length === 1) heads.classList.add('single');
    el._render = () => f.previews.forEach(src => {
      const c = document.createElement('canvas'); c.width = 32; c.height = 32;
      heads.appendChild(c);
      drawHeadInto(c, src);
    });
    io.observe(el);
    el.onclick = () => openDir(f.path);
    el.oncontextmenu = (e) => showCtx(e, [
      ['📂 Öffnen', () => openDir(f.path)],
      ['🗂 Im Explorer zeigen', () => api.fs.reveal(f.path)]
    ]);
    return el;
  }

  function skinCard(s, fav = false) {
    const el = document.createElement('div');
    el.className = 'card skin' + (state.selected && state.selected.key === s.key ? ' selected' : '');
    el.dataset.key = s.key;
    el._skin = s;
    el.innerHTML = `<div class="art"></div><div class="name"></div>` + (s.hist
      ? `<div class="when"></div>`
      : `<button class="fav ${fav ? 'on' : ''}" title="Favorit"><svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg></button>`);
    el.querySelector('.name').textContent = s.name;
    el.title = s.name;
    if (s.hist) {
      el.querySelector('.when').textContent = `${timeAgo(s.hist.time)}${s.hist.accountName ? ' · ' + s.hist.accountName : ''}`;
      el.title = `${s.name}\n${new Date(s.hist.time).toLocaleString('de-DE')}${s.hist.accountName ? '\nAccount: ' + s.hist.accountName : ''}`;
    }
    el._render = async () => {
      try {
        const m = await ensureMeta(s);
        const ov = state.settings.variantOverrides[s.key] || (s.hist ? s.variant : null);
        const slim = ov ? ov === 'slim' : m.slim;
        el._slim = slim;
        await paintCard(el, s, slim);
        if (slim) addBadge(el, 'SLIM', 'var');
        if (m.hash === state.currentHash) addBadge(el, 'AKTIV');
        capeBadge(el, s.key);
      } catch { el.querySelector('.art').textContent = '⚠'; }
    };
    io.observe(el);

    // Animation beim Hovern (ein geteilter WebGL-Viewer)
    const art = el.querySelector('.art');
    el.addEventListener('mouseenter', () => { if (el._painted) R.hoverStart(art, s.data, el._slim); });
    el.addEventListener('mouseleave', () => R.hoverStop(art));

    el.onclick = (e) => { if (!e.target.closest('.fav')) selectSkin(s); };
    el.ondblclick = (e) => { if (!e.target.closest('.fav')) { selectSkin(s); applySkin(); } };
    const favBtn = el.querySelector('.fav');
    if (favBtn) favBtn.onclick = () => toggleFav(s.path);

    el.oncontextmenu = async (e) => {
      selectSkin(s);
      const items = [
        ['✔ Anwenden', () => applySkin()],
        ['🧍 Als Classic anwenden', () => applySkin('classic')],
        ['🧍‍♀️ Als Slim anwenden', () => applySkin('slim')],
        null
      ];
      if (s.hist) {
        items.push(['💾 In Ordner speichern', () => saveToFolder(s)]);
        if (s.path && await api.fs.exists(s.path).catch(() => false)) items.push(['🗂 Original im Explorer zeigen', () => api.fs.reveal(s.path)]);
        items.push(['✕ Aus Verlauf entfernen', async () => { await api.history.remove(s.hist.id).catch(err); }]);
      } else {
        items.push([state.settings.favorites.includes(s.path) ? '☆ Favorit entfernen' : '★ Als Favorit', () => toggleFav(s.path)]);
        items.push(['🗂 Im Explorer zeigen', () => api.fs.reveal(s.path)]);
      }
      showCtx(e, items);
    };
    return el;
  }

  // 3D-Standbild (beide Layer) in die Karte setzen; Fallback 2D
  async function paintCard(el, s, slim) {
    const art = el.querySelector('.art');
    let node;
    try {
      const url = await R.render3d(s.key, s.data, slim);
      node = new Image();
      node.src = url;
      node.draggable = false;
      node.className = 'still';
      await node.decode().catch(() => {});
    } catch {
      node = R.front(await R.loadImg(s.data), slim, 6);
      node.classList.add('still', 'flat');
    }
    art.querySelector('.still')?.remove();
    art.prepend(node);
    el._painted = true;
  }

  // Nach Classic/Slim-Wechsel betroffene Karten neu zeichnen
  function repaintKey(key) {
    $$(`.card.skin[data-key="${CSS.escape(key)}"]`).forEach(async el => {
      const s = el._skin; if (!s) return;
      const m = await ensureMeta(s);
      const ov = state.settings.variantOverrides[key] || (s.hist ? s.variant : null);
      const slim = ov ? ov === 'slim' : m.slim;
      el._slim = slim;
      R.hoverStop();
      el.querySelector('.badge.var')?.remove();
      if (slim) addBadge(el, 'SLIM', 'var');
      paintCard(el, s, slim);
    });
  }

  function addBadge(el, text, cls = '') {
    const b = document.createElement('span');
    b.className = 'badge ' + cls;
    b.textContent = text;
    el.appendChild(b);
  }

  function markActiveCards() {
    $$('.card.skin').forEach(el => {
      const m = state.meta.get(el.dataset.key);
      const has = el.querySelector('.badge:not(.var):not(.cape-b)');
      const should = m && m.hash === state.currentHash;
      if (should && !has) addBadge(el, 'AKTIV');
      if (!should && has) has.remove();
    });
    updateCardCapeBadges();
  }

  function toggleFav(p) {
    const favs = new Set(state.settings.favorites);
    favs.has(p) ? favs.delete(p) : favs.add(p);
    saveSettings({ favorites: [...favs] });
    renderGrid();
  }

  // ================================================================ Auswahl & Anwenden
  function effectiveVariant() {
    const s = state.selected;
    if (!s) return state.profile?.skin?.variant || 'classic';
    if (state.seg !== 'auto') return state.seg;
    if (s.variant) return s.variant;
    const m = state.meta.get(s.key);
    return m && m.slim ? 'slim' : 'classic';
  }

  async function selectSkin(s) {
    state.selected = s;
    $$('.card.selected').forEach(c => c.classList.remove('selected'));
    const el = $(`.card.skin[data-key="${CSS.escape(s.key)}"]`);
    el && el.classList.add('selected');
    await ensureMeta(s).catch(() => {});
    state.seg = state.settings.variantOverrides[s.key] || 'auto';
    renderSeg();
    $('#previewLabel').textContent = s.hist ? 'Aus dem Verlauf' : 'Vorschau';
    $('#previewName').textContent = s.name;
    $('#backCurrent').classList.remove('hidden');
    $('#viewerOverlay').classList.add('hidden');
    showInViewer(s.data, effectiveVariant());
    renderCapes();
    updateApply();
  }

  function clearSelection() {
    state.selected = null;
    $$('.card.selected').forEach(c => c.classList.remove('selected'));
    $('#backCurrent').classList.add('hidden');
    state.seg = 'auto';
    renderSeg();
    renderProfile();
  }

  function renderSeg() {
    $$('#variantSeg button').forEach(b => b.classList.toggle('active', b.dataset.v === state.seg));
    const auto = $('#variantSeg [data-v=auto]');
    auto.textContent = state.selected && state.seg === 'auto' ? `Auto (${effectiveVariant() === 'slim' ? 'Slim' : 'Classic'})` : 'Auto';
  }

  function updateApply() {
    const btn = $('#applyBtn');
    btn.disabled = !state.activeId || !state.selected || state.busy;
    $('.apply-text').textContent = !state.activeId ? 'Erst Account hinzufügen' : state.selected ? 'Skin anwenden' : 'Skin auswählen';
  }

  async function applySkin(forceVariant) {
    const s = state.selected;
    if (!s || !state.activeId || state.busy) return;
    const variant = forceVariant || effectiveVariant();
    const btn = $('#applyBtn');
    state.busy = true; btn.classList.add('loading'); updateApply();
    try {
      const t0 = performance.now();
      const r = await api.skin.apply(state.activeId, { name: s.name, data: s.data, variant, path: s.path || null });
      state.profile = r.profile;
      const ms = Math.round(performance.now() - t0);
      toast(`„${s.name}“ ist jetzt dein Skin (${ms} ms) – ingame nach Rejoin sichtbar`, 'ok', 5000);
      if (r.capeNote) toast(r.capeNote, 'err', 6000);
      state.selected = null;
      $('#backCurrent').classList.add('hidden');
      $$('.card.selected').forEach(c => c.classList.remove('selected'));
      await onProfileUpdated();
    } catch (e) { err(e); }
    state.busy = false; btn.classList.remove('loading'); updateApply();
  }

  async function saveToFolder(src) {
    if (!state.dir) return toast('Erst einen Skin-Ordner wählen.', 'err');
    const name = await prompt('Skin speichern als …', src.name);
    if (!name) return;
    try { await api.fs.saveSkin(state.dir, name, src.data); toast(`Gespeichert in „${state.dir.split(/[\\/]/).pop()}“: ${name}.png`, 'ok'); if (state.view === 'folder') openDir(state.dir, true); }
    catch (e) { err(e); }
  }

  // ================================================================ Kontextmenü / Menüs
  function showCtx(e, items) {
    e.preventDefault();
    const m = $('#ctx');
    m.innerHTML = '';
    for (const it of items) {
      if (!it) { const s = document.createElement('div'); s.className = 'menu-sep'; m.appendChild(s); continue; }
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.textContent = it[0];
      b.onclick = () => { closeMenus(); it[1](); };
      m.appendChild(b);
    }
    m.classList.remove('hidden');
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
  }
  function closeMenus() { $('#ctx').classList.add('hidden'); $('#accMenu').classList.add('hidden'); }

  function prompt(title, placeholder = '') {
    return new Promise(res => {
      const m = $('#promptModal');
      $('#promptTitle').textContent = title;
      const inp = $('#promptInput');
      inp.value = placeholder; inp.placeholder = placeholder;
      m.classList.remove('hidden');
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
      const done = (v) => { m.classList.add('hidden'); cleanup(); res(v); };
      const ok = () => done(inp.value.trim() || null);
      const key = (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') done(null); };
      const close = (e) => { if (e.target === m || e.target.closest('[data-close]')) done(null); };
      $('#promptOk').addEventListener('click', ok);
      inp.addEventListener('keydown', key);
      m.addEventListener('click', close);
      function cleanup() {
        $('#promptOk').removeEventListener('click', ok);
        inp.removeEventListener('keydown', key);
        m.removeEventListener('click', close);
      }
    });
  }

  // ================================================================ Events
  function bind() {
    $('#accBtn').onclick = (e) => {
      e.stopPropagation();
      if (!state.accounts.length) return addAccount();
      $('#accMenu').classList.toggle('hidden');
    };
    $('#accAdd').onclick = addAccount;
    document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });

    $$('.rail-btn').forEach(b => b.onclick = () => setView(b.dataset.view));

    const pick = async () => {
      try {
        const dir = await api.fs.pickFolder();
        if (dir) { state.settings.rootFolder = dir; openDir(dir); }
      } catch (e) { err(e); }
    };
    $('#folderBtn').onclick = pick;
    $('#emptyPick').onclick = pick;
    $('#upBtn').onclick = goUp;
    $('#refreshBtn').onclick = () => state.dir && openDir(state.dir, true);
    $('#histClear').onclick = async () => {
      if (!state.history.length || !confirm('Gesamten Verlauf löschen?')) return;
      await api.history.clear().catch(err);
    };

    $('#search').oninput = (e) => { state.search = e.target.value; renderGrid(); };
    $('#favFilter').onclick = () => {
      state.favOnly = !state.favOnly;
      $('#favFilter').classList.toggle('on', state.favOnly);
      renderGrid();
    };
    $('#zoom').oninput = (e) => {
      document.documentElement.style.setProperty('--card', e.target.value + 'px');
      saveSettings({ cardSize: +e.target.value }, 400);
    };

    $$('#variantSeg button').forEach(b => b.onclick = () => {
      if (!state.selected) return;
      state.seg = b.dataset.v;
      const ov = { ...state.settings.variantOverrides };
      if (state.seg === 'auto') delete ov[state.selected.key]; else ov[state.selected.key] = state.seg;
      saveSettings({ variantOverrides: ov });
      renderSeg();
      showInViewer(state.selected.data, effectiveVariant());
      repaintKey(state.selected.key);
    });

    $$('#capeModeSeg button').forEach(b => b.onclick = () => {
      saveSettings({ capeMode: b.dataset.m });
      toast(b.dataset.m === 'perSkin'
        ? 'Pro Skin: Skin auswählen und Umhang zuweisen. Ohne Zuweisung bleibt der globale Umhang.'
        : 'Global: ein Umhang für alle Skins. Zuweisungen bleiben gespeichert.');
      renderCapes();
      refreshViewer();
      updateCardCapeBadges();
    });

    $('#applyBtn').onclick = () => applySkin();
    $('#backCurrent').onclick = clearSelection;

    $('#saveCurrent').onclick = () => {
      const src = state.selected || (state.profile && state.profile.skin && { name: state.profile.name, data: state.profile.skin.texture });
      if (!src) return toast('Nichts zum Speichern.');
      saveToFolder(src);
    };

    $('#importName').onclick = async () => {
      const name = await prompt('Skin von Spieler laden', '');
      if (!name) return;
      try {
        const s = await api.skin.byName(name);
        selectSkin({ name: s.name, data: s.data, key: s.key, variant: s.variant, path: null });
        toast(`Skin von ${s.name} geladen – „Anwenden“ oder „Speichern“`);
      } catch (e) { err(e); }
    };

    $('#resetSkin').onclick = async () => {
      if (!state.activeId || !confirm('Skin auf Standard (Steve/Alex) zurücksetzen?')) return;
      try { state.profile = await api.skin.reset(state.activeId); toast('Skin zurückgesetzt', 'ok'); clearSelection(); onProfileUpdated(); }
      catch (e) { err(e); }
    };

    // Einstellungen
    const sm = $('#settingsModal');
    $('#settingsBtn').onclick = () => { renderSettings(); sm.classList.remove('hidden'); };
    sm.addEventListener('click', (e) => { if (e.target === sm || e.target.closest('[data-close]')) sm.classList.add('hidden'); });
    $$('#settingsModal [data-key]').forEach(inp => inp.addEventListener('input', () => {
      const k = inp.dataset.key;
      const v = inp.type === 'checkbox' ? inp.checked : inp.type === 'range' ? +inp.value : inp.value;
      updateTheme({ [k]: v, ...(inp.type === 'color' ? { preset: null } : {}) });
      if (inp.type === 'color') $$('.preset').forEach(p => p.classList.remove('active'));
    }));
    $('#clientId').addEventListener('change', (e) => saveSettings({ clientId: e.target.value.trim() || '00000000402b5328' }));
    $$('[data-icon]').forEach(b => b.onclick = async () => {
      try {
        if (b.dataset.icon === 'custom') { if (await api.icon.pick()) toast('Eigenes Icon gesetzt', 'ok'); }
        else {
          if (b.dataset.icon === 'skinHead' && !state.profile) return toast('Erst einen Account anmelden.', 'err');
          await api.icon.mode(b.dataset.icon);
        }
      } catch (e) { err(e); }
    });
    api.icon.onChanged(renderIcon);
    $('#trayOnClose').addEventListener('change', (e) => saveSettings({ trayOnClose: e.target.checked }));
    $('#themeReset').onclick = () => { updateTheme({ ...PRESETS.Aurora, preset: 'Aurora', glass: 0.55, radius: 16, blobs: true }); renderSettings(); };

    // Glas-Highlight folgt der Maus
    document.addEventListener('pointermove', (e) => {
      const b = e.target.closest && e.target.closest('.glass-btn');
      if (!b) return;
      const r = b.getBoundingClientRect();
      b.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
      b.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
    });

    // Drag & Drop
    const lib = $('.library');
    let dragDepth = 0;
    lib.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) $('#dropHint').classList.remove('hidden'); });
    lib.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').classList.add('hidden'); } });
    lib.addEventListener('dragover', (e) => e.preventDefault());
    lib.addEventListener('drop', async (e) => {
      e.preventDefault(); dragDepth = 0; $('#dropHint').classList.add('hidden');
      const f = e.dataTransfer.files[0];
      if (!f) return;
      try {
        const p = api.fs.pathForFile(f);
        const { data, key } = await api.fs.readPng(p);
        selectSkin({ name: f.name.replace(/\.png$/i, ''), data, key, path: p });
      } catch (x) { err(x); }
    });

    // Tastatur
    document.addEventListener('keydown', (e) => {
      const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); }
      else if (e.ctrlKey && e.key === ',') { e.preventDefault(); $('#settingsBtn').click(); }
      else if (e.ctrlKey && e.key === '1') { e.preventDefault(); setView('folder'); }
      else if (e.ctrlKey && e.key === '2') { e.preventDefault(); setView('history'); }
      else if (e.key === 'F5') { e.preventDefault(); state.view === 'folder' ? $('#refreshBtn').click() : loadHistory(); }
      else if (e.key === 'Escape') {
        closeMenus();
        if (!$('#settingsModal').classList.contains('hidden')) $('#settingsModal').classList.add('hidden');
        else if (typing) document.activeElement.blur();
        else if (state.selected) clearSelection();
      }
      else if (typing) return;
      else if (e.key === 'Backspace') goUp();
      else if (e.key === 'Enter') applySkin();
    });

    // Events aus dem Main-Prozess (z. B. Tray-Popup)
    api.fs.onChanged((dir) => { if (dir === state.dir && state.view === 'folder') openDir(dir, true); });
    api.history.onChanged(() => loadHistory());
    api.acc.onProfile(({ accountId, profile }) => {
      if (accountId !== state.activeId) return;
      state.profile = profile;
      onProfileUpdated();
    });
    api.acc.onActive((id) => { if (id !== state.activeId) switchAccount(id, true); });
    api.acc.onChanged(() => loadAccounts());

    // Zeitangaben im Verlauf aktuell halten
    setInterval(() => { if (state.view === 'history' && !state.selected) renderGrid(); }, 60000);
  }

  // ================================================================ Start
  async function init() {
    state.settings = await api.settings.get();
    applyTheme(state.settings.theme);
    if (state.settings.cardSize) {
      $('#zoom').value = state.settings.cardSize;
      document.documentElement.style.setProperty('--card', state.settings.cardSize + 'px');
    }
    document.body.dataset.view = 'folder';
    bind();
    initViewer();
    state.activeId = state.settings.activeAccount;
    await loadAccounts();
    renderProfile();
    loadHistory();
    if (state.settings.rootFolder) openDir(state.settings.rootFolder);
    else $('#empty').classList.remove('hidden');
    if (state.activeId) switchAccount(state.activeId, true);
  }

  init().catch(err);
})();
