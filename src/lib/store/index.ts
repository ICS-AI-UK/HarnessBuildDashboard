/**
 * Document store.
 *
 * The app keeps aggregates, not per-event rows, so the whole dataset is a small
 * set of JSON documents plus the raw transcripts kept for evidence. That needs
 * a key/value store rather than a database, which is what lets it run on a free
 * Netlify account and on a laptop with nothing installed.
 *
 *   Netlify  -> Netlify Blobs
 *   Local    -> .data/ on disk
 *
 * The two drivers are behind one interface, so nothing above this file knows
 * which is in use.
 */

export interface DocumentStore {
  readonly driver: 'netlify-blobs' | 'filesystem';
  getText(key: string): Promise<string | null>;
  setText(key: string, value: string): Promise<void>;
  getJSON<T>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys under a prefix, without the prefix stripped. */
  list(prefix: string): Promise<string[]>;
}

let cached: DocumentStore | null = null;

function onNetlify(): boolean {
  if (process.env.STORAGE_DRIVER === 'filesystem') return false;
  if (process.env.STORAGE_DRIVER === 'netlify-blobs') return true;
  // Netlify sets NETLIFY=true in builds and functions.
  return process.env.NETLIFY === 'true' || Boolean(process.env.NETLIFY_BLOBS_CONTEXT);
}

export async function getStore(): Promise<DocumentStore> {
  if (cached) return cached;
  cached = onNetlify() ? await createNetlifyStore() : await createFileStore();
  return cached;
}

/** Test seam: force a driver, or reset between tests. */
export function __setStore(store: DocumentStore | null): void {
  cached = store;
}

// --- Netlify Blobs --------------------------------------------------------

async function createNetlifyStore(): Promise<DocumentStore> {
  const { getStore: getBlobStore } = await import('@netlify/blobs');
  // Strong consistency: an import writes a day document and the dashboard reads
  // it immediately afterwards. Eventual consistency would show a stale day.
  const store = getBlobStore({ name: 'harness-dashboard', consistency: 'strong' });

  return {
    driver: 'netlify-blobs',
    async getText(key) {
      return (await store.get(key, { type: 'text' })) ?? null;
    },
    async setText(key, value) {
      await store.set(key, value);
    },
    async getJSON<T>(key: string) {
      return ((await store.get(key, { type: 'json' })) as T | null) ?? null;
    },
    async setJSON(key, value) {
      await store.setJSON(key, value);
    },
    async delete(key) {
      await store.delete(key);
    },
    async list(prefix) {
      const { blobs } = await store.list({ prefix });
      return blobs.map((b) => b.key);
    },
  };
}

// --- Local filesystem -----------------------------------------------------

async function createFileStore(): Promise<DocumentStore> {
  const { mkdir, readFile, writeFile, rm, readdir } = await import('node:fs/promises');
  const { dirname, join, sep } = await import('node:path');

  const root = process.env.STORAGE_DIR ?? join(process.cwd(), '.data');

  // Keys are slash-separated and may contain characters Windows rejects in
  // filenames, so they are encoded per segment rather than used raw.
  const toPath = (key: string) =>
    join(root, ...key.split('/').map((s) => encodeURIComponent(s)));
  const toKey = (path: string) =>
    path
      .slice(root.length + 1)
      .split(sep)
      .map((s) => decodeURIComponent(s))
      .join('/');

  const walk = async (dir: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else out.push(full);
    }
    return out;
  };

  const read = async (key: string): Promise<string | null> => {
    try {
      return await readFile(toPath(key), 'utf8');
    } catch {
      return null;
    }
  };

  return {
    driver: 'filesystem',
    getText: read,
    async setText(key, value) {
      const path = toPath(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, value, 'utf8');
    },
    async getJSON<T>(key: string) {
      const raw = await read(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async setJSON(key, value) {
      const path = toPath(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(value), 'utf8');
    },
    async delete(key) {
      await rm(toPath(key), { force: true, recursive: true });
    },
    async list(prefix) {
      const files = await walk(root);
      return files.map(toKey).filter((k) => k.startsWith(prefix));
    },
  };
}

// --- Key layout -----------------------------------------------------------

export const keys = {
  project: (slug: string) => `projects/${slug}.json`,
  projectPrefix: () => 'projects/',

  /** Raw transcript text, kept so event-level evidence can be rebuilt. */
  raw: (slug: string, sha: string) => `raw/${slug}/${sha}.md`,
  transcript: (slug: string, sha: string) => `transcripts/${slug}/${sha}.json`,
  transcriptPrefix: (slug: string) => `transcripts/${slug}/`,

  day: (slug: string, day: string) => `days/${slug}/${day}.json`,
  dayPrefix: (slug: string) => `days/${slug}/`,

  /** Staging for chunked uploads, deleted once the import resolves. */
  chunk: (uploadId: string, index: number) => `uploads/${uploadId}/${String(index).padStart(5, '0')}`,
  uploadPrefix: (uploadId: string) => `uploads/${uploadId}/`,
};
