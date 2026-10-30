// 2D-Rendering von Skins/Capes für Karten, Köpfe und Erkennung (Slim/Classic, Hash)
(() => {
  const imgCache = new Map();

  function loadImg(src) {
    if (imgCache.has(src)) return imgCache.get(src);
    const p = new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = src;
    });
    imgCache.set(src, p);
    if (imgCache.size > 600) imgCache.delete(imgCache.keys().next().value);
    return p;
  }

  function pixels(img) {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    return x.getImageData(0, 0, img.width, img.height);
  }

  // Slim-Erkennung: Spalten 54–55 im Arm-Bereich (y 20–31) komplett transparent → Alex-Modell
  function detectSlim(img) {
    if (img.height !== 64) return false;
    const d = pixels(img).data;
    for (let y = 20; y < 32; y++) for (let x = 54; x < 56; x++) {
      if (d[(y * 64 + x) * 4 + 3] !== 0) return false;
    }
    return true;
  }

  // Pixel-Hash (Transparenz normalisiert), um den aktiven Skin in der Bibliothek zu erkennen
  function hash(img) {
    const d = pixels(img).data;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      const v = a === 0 ? 0 : ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | a) >>> 0;
      h ^= v; h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16) + ':' + img.height;
  }

  // Frontansicht (16×32 Einheiten) inkl. Overlay-Layer
  function front(img, slim, scale = 8) {
    const c = document.createElement('canvas');
    c.width = 16 * scale; c.height = 32 * scale;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    const legacy = img.height === 32;
    const aw = slim ? 3 : 4;
    const d = (sx, sy, sw, sh, dx, dy, flip = false) => {
      if (flip) {
        x.save(); x.translate((dx + sw) * scale, dy * scale); x.scale(-1, 1);
        x.drawImage(img, sx, sy, sw, sh, 0, 0, sw * scale, sh * scale);
        x.restore();
      } else x.drawImage(img, sx, sy, sw, sh, dx * scale, dy * scale, sw * scale, sh * scale);
    };
    // Basis
    d(8, 8, 8, 8, 4, 0);                               // Kopf
    d(20, 20, 8, 12, 4, 8);                            // Körper
    d(44, 20, aw, 12, 4 - aw, 8);                      // rechter Arm
    d(4, 20, 4, 12, 4, 20);                            // rechtes Bein
    if (legacy) {
      d(44, 20, 4, 12, 12, 8, true);                   // linker Arm (gespiegelt)
      d(4, 20, 4, 12, 8, 20, true);                    // linkes Bein (gespiegelt)
    } else {
      d(36, 52, aw, 12, 12, 8);                        // linker Arm
      d(20, 52, 4, 12, 8, 20);                         // linkes Bein
      // Overlays
      d(20, 36, 8, 12, 4, 8);
      d(44, 36, aw, 12, 4 - aw, 8);
      d(52, 52, aw, 12, 12, 8);
      d(4, 36, 4, 12, 4, 20);
      d(4, 52, 4, 12, 8, 20);
    }
    d(40, 8, 8, 8, 4, 0);                              // Hut
    return c;
  }

  function head(img, size = 32, target) {
    const c = target || document.createElement('canvas');
    if (!target) { c.width = size; c.height = size; }
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    x.clearRect(0, 0, c.width, c.height);
    const s = c.width;
    x.drawImage(img, 8, 8, 8, 8, s * 0.06, s * 0.06, s * 0.88, s * 0.88);
    x.drawImage(img, 40, 8, 8, 8, 0, 0, s, s);
    return c;
  }

  function capeFront(img, scale = 6) {
    const k = img.width / 64;
    const c = document.createElement('canvas');
    c.width = 10 * scale; c.height = 16 * scale;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    x.drawImage(img, 1 * k, 1 * k, 10 * k, 16 * k, 0, 0, c.width, c.height);
    return c;
  }

  // Legacy 64×32 → 64×64 (für Vorschau-Konsistenz)
  function toModern(img) {
    if (img.height !== 32) return img;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    return c;
  }

  // ---------------------------------------------------------------- 3D (nur Hauptfenster)
  // Gemeinsame Kamera-/Posen-Einstellung für Karten-Render und Hover-Animation,
  // damit der Wechsel von Standbild zu Animation nahtlos aussieht.
  const CARD_W = 300, CARD_H = 360;
  function stagePlayer(v) {
    v.fov = 32;
    v.zoom = 1.0;
    v.globalLight.intensity = 2.6;
    v.cameraLight.intensity = 0.9;
    v.playerWrapper.rotation.set(0.1, -0.52, 0);   // leicht von oben, nach links gedreht
    v.playerWrapper.position.y = 0;
  }
  function neutralPose(v) {
    const s = v.playerObject.skin;
    s.leftArm.rotation.set(0, 0, 0.06);
    s.rightArm.rotation.set(0, 0, -0.06);
    s.leftLeg.rotation.set(0, 0, 0.015);
    s.rightLeg.rotation.set(0, 0, -0.015);
    s.head.rotation.set(0, 0, 0);
    v.playerObject.rotation.set(0, 0, 0);
    v.playerObject.position.set(0, 0, 0);
  }

  let off = null;
  let queue = Promise.resolve();
  const cache3d = new Map();

  function offViewer() {
    if (off) return off;
    off = new skinview3d.SkinViewer({
      canvas: document.createElement('canvas'),
      width: CARD_W, height: CARD_H,
      preserveDrawingBuffer: true, enableControls: false, pixelRatio: 1
    });
    off.renderPaused = true;
    off.animation = null;
    stagePlayer(off);
    return off;
  }

  // Rendert einen Skin als 3D-Standbild (beide Layer) → Data-URL, seriell + gecacht
  function render3d(key, data, slim) {
    const ck = `${key}:${slim ? 's' : 'c'}`;
    if (cache3d.has(ck)) return cache3d.get(ck);
    const job = queue.then(async () => {
      const v = offViewer();
      await v.loadSkin(data, { model: slim ? 'slim' : 'default' });
      v.playerObject.skin.setInnerLayerVisible(true);
      v.playerObject.skin.setOuterLayerVisible(true);
      neutralPose(v);
      v.render();
      return v.canvas.toDataURL('image/png');
    });
    queue = job.catch(() => {});
    cache3d.set(ck, job);
    if (cache3d.size > 800) cache3d.delete(cache3d.keys().next().value);
    return job;
  }

  // Ein einziger animierter Viewer, der in die Karte unter der Maus "springt"
  let hover = null, hoverHost = null, hoverToken = 0;
  function hoverViewer() {
    if (hover) return hover;
    const c = document.createElement('canvas');
    c.className = 'hover3d';
    hover = new skinview3d.SkinViewer({ canvas: c, width: CARD_W, height: CARD_H, enableControls: false });
    stagePlayer(hover);
    hover.animation = new skinview3d.WalkingAnimation();
    hover.animation.speed = 0.85;
    hover.renderPaused = true;
    return hover;
  }
  async function hoverStart(host, data, slim) {
    const v = hoverViewer();
    const my = ++hoverToken;
    await v.loadSkin(data, { model: slim ? 'slim' : 'default' });
    if (my !== hoverToken) return;
    const r = host.getBoundingClientRect();
    v.setSize(Math.max(40, r.width), Math.max(40, r.height));
    hoverHost = host;
    host.appendChild(v.canvas);
    host.classList.add('animating');
    v.animation.progress = 0;
    v.renderPaused = false;
  }
  function hoverStop(host) {
    if (!hover || (host && host !== hoverHost)) { hoverToken++; return; }
    hoverToken++;
    hover.renderPaused = true;
    if (hoverHost) hoverHost.classList.remove('animating');
    hover.canvas.remove();
    hoverHost = null;
  }

  window.SkinRender = { loadImg, detectSlim, hash, front, head, capeFront, toModern, render3d, hoverStart, hoverStop };
})();
