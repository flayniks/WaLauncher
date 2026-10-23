// IndexedDB storage for projects and imported media. Every call fails soft: if storage is blocked the editor
// still works, it just won't remember anything after a reload.

const DB_NAME = 'clipwave';
const VERSION = 2;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('luts')) db.createObjectStore('luts', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbp;
}

function run(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const tx = db.transaction(store, mode);
          const req = fn(tx.objectStore(store));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = () => resolve(undefined);
          tx.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

export const db = {
  put: (store, value, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
};
