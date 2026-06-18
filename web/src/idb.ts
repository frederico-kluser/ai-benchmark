// Cache local (IndexedDB) das runs e sessões do usuário, para o histórico voltar
// ao fechar/reabrir o navegador — e para visualizar runs/sessões mesmo se o
// servidor não as tiver mais. Degrada para no-op se o IndexedDB estiver indisponível.

const DB_NAME = 'benchmark-arena';
const DB_VERSION = 1;
export const STORES = ['runs', 'sessions', 'runSummaries', 'sessionSummaries'] as const;
export type Store = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB indisponível'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqProm<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(store: Store, value: { id: string }): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    /* idb indisponível — segue só com o servidor */
  }
}

export async function idbPutMany(store: Store, values: { id: string }[]): Promise<void> {
  if (!values.length) return;
  try {
    const db = await openDb();
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

export async function idbGet<T>(store: Store, key: string): Promise<T | undefined> {
  try {
    const db = await openDb();
    const tx = db.transaction(store, 'readonly');
    return await reqProm<T>(tx.objectStore(store).get(key) as IDBRequest<T>);
  } catch {
    return undefined;
  }
}

export async function idbGetAll<T>(store: Store): Promise<T[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(store, 'readonly');
    return (await reqProm<T[]>(tx.objectStore(store).getAll() as IDBRequest<T[]>)) ?? [];
  } catch {
    return [];
  }
}
