import {
  createAtomicEnvelopeStore,
  type AtomicCommitResult,
  type AtomicEnvelopeStore,
} from './atomic-envelope-store';
import { cloneJson, sha256Hex } from './external-storage-codec';
import type { ExternalStoreStatus } from './external-storage-types';
import type { ServerFileStore } from './server-file-store';

export interface GlobalCommitResult extends AtomicCommitResult {}

export interface ExternalObjectStoreDeps {
  files: ServerFileStore;
  namespace: string;
  writerId: string;
  now: () => number;
  makeId: (prefix: string) => string;
}

export interface ExternalObjectStore {
  load(): Promise<ExternalStoreStatus>;
  sync(): Promise<boolean>;
  read<T>(key: string, fallback: T): T;
  readAll(): Record<string, unknown>;
  patch(updates: Record<string, unknown>, deletes?: string[]): Promise<boolean>;
  replaceAll(value: Record<string, unknown>): Promise<boolean>;
  patchCommit(updates: Record<string, unknown>, deletes?: string[]): Promise<GlobalCommitResult>;
  replaceCommit(value: Record<string, unknown>): Promise<GlobalCommitResult>;
  flush(): Promise<void>;
  status(): ExternalStoreStatus;
  _internal: {
    mainFile: string;
    atomic: AtomicEnvelopeStore<Record<string, unknown>>;
  };
}

function token(value: string): string {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'x';
}

function patchValue(
  current: Record<string, unknown>,
  updates: Record<string, unknown>,
  deletes: readonly string[],
): Record<string, unknown> {
  const next = cloneJson(current);
  for (const [key, value] of Object.entries(updates)) next[key] = cloneJson(value);
  for (const key of deletes) delete next[key];
  return next;
}

export function createExternalObjectStore(deps: ExternalObjectStoreDeps): ExternalObjectStore {
  const namespace = token(deps.namespace);
  const scopeId = `global:${namespace}`;
  const scopeHash = sha256Hex(scopeId).slice(0, 24);
  const mainFile = `usb_global_${namespace}_${scopeHash}.json`;
  const atomic = createAtomicEnvelopeStore<Record<string, unknown>>({
    files: deps.files,
    filename: mainFile,
    kind: `global-${namespace}`,
    scopeId,
    domainCreated: false,
    emptyValue: {},
    now: deps.now,
  });
  let cache: Record<string, unknown> = {};

  return {
    async load(): Promise<ExternalStoreStatus> {
      const status = await atomic.load();
      if (status.state === 'ready' || status.state === 'uninitialized') cache = atomic.readAll();
      return status;
    },
    async sync(): Promise<boolean> {
      // Single-device runtime does not re-read global state after bootstrap.
      return false;
    },
    read<T>(key: string, fallback: T): T {
      return Object.prototype.hasOwnProperty.call(cache, key) ? cloneJson(cache[key] as T) : cloneJson(fallback);
    },
    readAll: () => cloneJson(cache),
    async patch(updates, deletes = []): Promise<boolean> {
      const next = patchValue(cache, updates, deletes);
      const result = await atomic.replaceAll(next);
      if (result.ok && result.confirmed) cache = next;
      return result.ok && result.confirmed;
    },
    async replaceAll(value): Promise<boolean> {
      const result = await atomic.replaceAll(value);
      if (result.ok && result.confirmed) cache = cloneJson(value);
      return result.ok && result.confirmed;
    },
    async patchCommit(updates, deletes = []): Promise<GlobalCommitResult> {
      const next = patchValue(cache, updates, deletes);
      const result = await atomic.replaceAll(next);
      if (result.ok && result.confirmed) cache = next;
      return result;
    },
    async replaceCommit(value): Promise<GlobalCommitResult> {
      const result = await atomic.replaceAll(value);
      if (result.ok && result.confirmed) cache = cloneJson(value);
      return result;
    },
    flush: () => atomic.flush(),
    status: () => atomic.status(),
    _internal: { mainFile, atomic },
  };
}
