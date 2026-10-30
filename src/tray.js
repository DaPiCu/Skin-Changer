/* SkinSwitcher – Tray-Popup */
(() => {
  const $ = (s) => document.querySelector(s);
  const R = window.SkinRender;
  const api = window.api;
  const MAX = 8;

  let settings = null, accounts = [], activeId = null, currentHash = null, busy = false;

  function theme(t) {
    const r = document.documentElement.style;
    for (const [k, v] of Object.entries({ accent: t.accent, accent2: t.accent2, bg: t.bg, surface: t.surface, text: t.text })) r.setProperty('--' + k, v);
    r.setProperty('--radius', t.radius + 'px');
  }

  function drawHead(canvas, src) {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    if (src) R.loadImg(src).then(img => R.head(img, canvas.width, canvas)).catch(() => {});
  }

  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'gerade eben';
    if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
    if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
    const d = Math.floor(s / 86400);
    return d === 1 ? 'gestern' : `vor ${d} Tagen`;
  }

  const fit = () => requestAnimationFrame(() => api.tray.resize($('.pop').offsetHeight));

  function renderHeader() {
    const acc = accounts.find(a => a.id === activeId);
    $('#name').textContent = acc ? acc.name : 'Kein Account';
    drawHead($('#head'), acc && acc.head);
    const box = $('#accs');
    box.innerHTML = '';
    if (accounts.length < 2) return;
    for (const a of accounts) {
      const b = document.createElement('button');
      b.className = a.id === activeId ? 'on' : '';
      b.title = a.name;
      const c = document.createElement('canvas'); c.width = 24; c.height = 24;
      b.appendChild(c); drawHead(c, a.head);
      b.onclick = () => {
        if (a.id === activeId) return;
        activeId = a.id;
        currentHash = null;
        api.acc.setActive(a.id).catch(() => {});
        renderHeader();
        refresh(false);
      };
      box.appendChild(b);
    }
  }

  async function renderList(history) {
    const list = $('#list');
    list.innerHTML = '';
    const items = history.slice(0, MAX);
    $('#count').textContent = history.length ? `${items.length}/${history.length}` : '';
    if (!items.length) {
      list.innerHTML = '<div class="empty-row">Noch kein Verlauf.<br>Wende in der App einen Skin an.</div>';
      return fit();
    }
    for (const h of items) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<canvas width="36" height="36"></canvas><div class="txt"><div class="n"></div><div class="s"></div></div><span class="state"></span>`;
      row.querySelector('.n').textContent = h.name;
      row.querySelector('.s').textContent = `${ago(h.time)}${h.accountName ? ' · ' + h.accountName : ''}${h.variant === 'slim' ? ' · Slim' : ''}`;
      drawHead(row.querySelector('canvas'), h.data);
      R.loadImg(h.data).then(img => { row._hash = R.hash(img); mark(row); }).catch(() => {});
      row.onclick = () => apply(h, row);
      list.appendChild(row);
    }
    fit();
  }

  function mark(row) {
    const st = row.querySelector('.state');
    if (row.classList.contains('busy')) return;
    st.innerHTML = row._hash && row._hash === currentHash ? '<span class="act">AKTIV</span>' : '<span class="go">➜</span>';
  }
  const markAll = () => document.querySelectorAll('.row').forEach(mark);

  async function apply(h, row) {
    if (busy) return;
    if (!activeId) { showMsg('Kein Account – öffne die App und melde dich an.'); return; }
    busy = true;
    row.classList.add('busy');
    row.querySelector('.state').innerHTML = '<span class="spin"></span>';
    try {
      const r = await api.skin.apply(activeId, { name: h.name, data: h.data, variant: h.variant, path: h.src });
      row.classList.remove('busy');
      row.classList.add('ok');
      row.querySelector('.state').innerHTML = '<span class="act">✓</span>';
      if (r.capeNote) showMsg(r.capeNote);
      setTimeout(() => api.tray.hide(), r.capeNote ? 2500 : 900);
    } catch (e) {
      row.classList.remove('busy');
      row.classList.add('bad');
      row.querySelector('.state').textContent = '✕';
      showMsg(e.message);
    }
    busy = false;
  }

  function showMsg(text) {
    let m = document.querySelector('.msg');
    if (!m) { m = document.createElement('div'); m.className = 'msg'; $('#list').after(m); }
    m.textContent = text;
    fit();
  }

  async function refresh(full = true) {
    document.querySelector('.msg')?.remove();
    if (full) {
      settings = await api.settings.get();
      theme(settings.theme);
      accounts = await api.acc.list();
      activeId = accounts.find(a => a.id === settings.activeAccount) ? settings.activeAccount : accounts[0]?.id || null;
      renderHeader();
    }
    renderList(await api.history.list());

    // Aktiven Skin im Hintergrund ermitteln (für "AKTIV"-Markierung)
    if (activeId) {
      const id = activeId;
      api.acc.profile(id).then(async p => {
        if (id !== activeId || !p.skin || !p.skin.texture) return;
        currentHash = R.hash(await R.loadImg(p.skin.texture));
        markAll();
      }).catch(() => {});
    }
  }

  $('#open').onclick = () => api.tray.openMain();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.tray.hide(); });
  api.tray.onRefresh(() => refresh());
  api.history.onChanged(() => refresh(false));
  api.acc.onActive(() => refresh());
  api.acc.onChanged(() => refresh());
  api.acc.onProfile(async ({ accountId, profile }) => {
    if (accountId !== activeId || !profile.skin || !profile.skin.texture) return;
    currentHash = R.hash(await R.loadImg(profile.skin.texture));
    markAll();
  });

  refresh();
})();
