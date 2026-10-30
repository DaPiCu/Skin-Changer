const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (ch, ...args) => {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('api', {
  settings: { get: () => call('settings:get'), set: (p) => call('settings:set', p) },
  fs: {
    pickFolder: () => call('fs:pickFolder'),
    list: (dir) => call('fs:list', dir),
    reveal: (p) => call('fs:reveal', p),
    exists: (p) => call('fs:exists', p),
    saveSkin: (dir, name, data) => call('fs:saveSkin', dir, name, data),
    readPng: (p) => call('fs:readPng', p),
    pathForFile: (file) => webUtils.getPathForFile(file),
    onChanged: on('fs:changed')
  },
  acc: {
    list: () => call('acc:list'),
    add: () => call('acc:add'),
    remove: (id) => call('acc:remove', id),
    profile: (id) => call('acc:profile', id),
    setHead: (id, head) => call('acc:setHead', id, head),
    setActive: (id) => call('acc:setActive', id),
    onActive: on('account:active'),
    onChanged: on('accounts:changed'),
    onProfile: on('profile:updated')
  },
  skin: {
    apply: (id, skin) => call('skin:apply', id, skin),
    reset: (id) => call('skin:reset', id),
    byName: (name) => call('skin:byName', name)
  },
  cape: { set: (id, capeId) => call('cape:set', id, capeId) },
  history: {
    list: () => call('history:list'),
    remove: (id) => call('history:remove', id),
    clear: () => call('history:clear'),
    onChanged: on('history:changed')
  },
  tray: {
    openMain: () => call('tray:openMain'),
    hide: () => call('tray:hide'),
    resize: (h) => call('tray:resize', h),
    onRefresh: on('tray:refresh')
  },
  icon: {
    get: () => call('icon:get'),
    pick: () => call('icon:pick'),
    mode: (m) => call('icon:mode', m),
    head: (data) => call('icon:head', data),
    onChanged: on('icon:changed')
  },
  titlebar: (color) => ipcRenderer.send('app:titlebar', color),
  openExternal: (url) => call('app:openExternal', url)
});
