import { createAtomicEnvelopeStore } from './atomic-envelope-store';
import { chatStorageHash, type ChatOwner } from './chat-storage-identity';
import { cloneJson } from './external-storage-codec';
import type { ServerFileStore } from './server-file-store';
import type { ExternalStoreStatus } from './external-storage-types';

export interface PortraitPersistentStoreDeps {
  files: ServerFileStore;
  storageId: string;
  owner: ChatOwner;
  domainCreated: boolean;
  now: () => number;
  onDomainCreated: () => Promise<boolean>;
}

export interface PortraitPersistentStore {
  load(): Promise<ExternalStoreStatus>;
  read<T>(key: string, fallback: T): T;
  readAll(): Record<string, unknown>;
  /** 工作信封 revision（读缓存失效信号，见 portrait-system readAllPortraits 缓存）。 */
  revision(): number;
  write(updates: Record<string, unknown>, deletes?: string[]): Promise<boolean>;
  replaceAll(value: Record<string, unknown>): Promise<boolean>;
  sync(): Promise<boolean>;
  flush(): Promise<void>;
  status(): ExternalStoreStatus;
}

export function createPortraitPersistentStore(
  deps: PortraitPersistentStoreDeps,
): PortraitPersistentStore {
  const atomic = createAtomicEnvelopeStore<Record<string, unknown>>({
    files: deps.files,
    filename: `usb_portraits_${chatStorageHash(deps.storageId)}.json`,
    kind: 'portraits',
    scopeId: deps.storageId,
    owner: deps.owner,
    domainCreated: deps.domainCreated,
    emptyValue: {},
    now: deps.now,
    onFirstVerifiedCreate: deps.onDomainCreated,
  });

  return {
    load: () => atomic.load(),
    read<T>(key: string, fallback: T): T {
      const all = atomic.readAll();
      return Object.prototype.hasOwnProperty.call(all, key)
        ? cloneJson(all[key] as T)
        : cloneJson(fallback);
    },
    readAll: () => atomic.readAll(),
    revision: () => atomic.revision(),
    async write(updates: Record<string, unknown>, deletes: string[] = []): Promise<boolean> {
      const result = await atomic.patch(updates, deletes);
      return result.ok && result.confirmed;
    },
    async replaceAll(value: Record<string, unknown>): Promise<boolean> {
      const result = await atomic.replaceAll(cloneJson(value || {}));
      return result.ok && result.confirmed;
    },
    async sync(): Promise<boolean> {
      const before = atomic.exportEnvelope().checksum;
      const status = await atomic.load();
      return status.state === 'ready' && atomic.exportEnvelope().checksum !== before;
    },
    flush: () => atomic.flush(),
    status: () => atomic.status(),
  };
}
