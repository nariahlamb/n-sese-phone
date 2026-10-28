import { isRecord } from './type-guards';
import { type RecoveryStorage, defaultRecoveryStorage, parseRecoveryEnvelope, persistRecoveryEnvelope } from './recovery-log';
import {
  deleteStoredImage,
  isOwnedMapSceneImagePath,
  type DeleteStoredImageResult,
} from './image-storage';

export const MAP_IMAGE_CLEANUP_RECOVERY_KEY = 'unified-statusbar:map-image-cleanup:v3';
const RECOVERY_SCHEMA = 3;
const MAX_PENDING_PATHS = 100;
const MAX_RECOVERY_BYTES = 64 * 1024;


interface CleanupRecoveryRecord {
  storageId: string;
  paths: string[];
}

export interface MapImageReferenceSources {
  journal?: unknown;
  currentState?: unknown;
  backups?: unknown[];
}

export interface RunMapImageReferenceGcDeps {
  storageId: string;
  candidates: readonly string[];
  sources: readonly unknown[];
  deleteImage?: (path: string) => Promise<DeleteStoredImageResult>;
  recoveryStorage?: RecoveryStorage;
}

export interface MapImageCleanupResult {
  deletedPaths: string[];
  failedPaths: string[];
  protectedPaths: string[];
  rejectedPaths: string[];
}

export interface MapImageReferenceGcServiceDeps {
  getStorageId: () => string;
  getSources: () => readonly unknown[] | Promise<readonly unknown[]>;
  deleteImage?: (path: string) => Promise<DeleteStoredImageResult>;
  recoveryStorage?: RecoveryStorage;
}

function collectFromValue(value: unknown, output: Set<string>, seen: Set<object>): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const item of value) collectFromValue(item, output, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.schema === 'map_scene_image' && typeof record.imagePath === 'string' && record.imagePath) {
    output.add(record.imagePath);
  }
  for (const nested of Object.values(record)) collectFromValue(nested, output, seen);
}

export function collectReferencedMapImages(input: MapImageReferenceSources): Set<string> {
  const output = new Set<string>();
  const seen = new Set<object>();
  collectFromValue(input.journal, output, seen);
  collectFromValue(input.currentState, output, seen);
  collectFromValue(input.backups || [], output, seen);
  return output;
}

export function planMapImageCleanup(
  candidates: readonly string[],
  referenced: ReadonlySet<string>,
): string[] {
  return [...new Set(candidates)].filter(path => isOwnedMapSceneImagePath(path) && !referenced.has(path));
}

function parseRecovery(storage?: RecoveryStorage): CleanupRecoveryRecord[] {
  if (!storage) return [];
  // U36：信封解析收编（flatMap 逐条校验/路径过滤裁剪是本模块专属口径，保留在调用方）
  const records = parseRecoveryEnvelope<unknown>(storage.getItem(MAP_IMAGE_CLEANUP_RECOVERY_KEY), RECOVERY_SCHEMA);
  if (!records) return [];
  return records.flatMap(value => {
    if (!isRecord(value) || typeof value.storageId !== 'string' || !Array.isArray(value.paths)) return [];
    const paths = value.paths.filter(isOwnedMapSceneImagePath).slice(0, MAX_PENDING_PATHS);
    return [{ storageId: value.storageId, paths }];
  });
}

function persistRecovery(storage: RecoveryStorage | undefined, records: CleanupRecoveryRecord[]): void {
  // U36：信封写入收编（返回值忽略=原 best-effort 语义：超限静默跳过、失败不回滚）
  persistRecoveryEnvelope(storage, MAP_IMAGE_CLEANUP_RECOVERY_KEY, records, {
    schema: RECOVERY_SCHEMA, maxBytes: MAX_RECOVERY_BYTES,
  });
}

export async function runMapImageReferenceGc(
  deps: RunMapImageReferenceGcDeps,
): Promise<MapImageCleanupResult> {
  const recoveryStorage = deps.recoveryStorage || defaultRecoveryStorage();
  const records = parseRecovery(recoveryStorage);
  const previousPending = records.find(record => record.storageId === deps.storageId)?.paths || [];
  const allCandidates = [...new Set([...previousPending, ...deps.candidates])];
  const referenced = collectReferencedMapImages({ currentState: deps.sources });
  const protectedPaths = allCandidates.filter(path => isOwnedMapSceneImagePath(path) && referenced.has(path));
  const rejectedPaths = allCandidates.filter(path => !isOwnedMapSceneImagePath(path));
  const planned = planMapImageCleanup(allCandidates, referenced);
  const deletedPaths: string[] = [];
  const failedPaths: string[] = [];
  const remove = deps.deleteImage || deleteStoredImage;
  for (const path of planned) {
    try {
      const result = await remove(path);
      if (result.ok) deletedPaths.push(path);
      else failedPaths.push(path);
    } catch {
      failedPaths.push(path);
    }
  }

  const foreign = records.filter(record => record.storageId !== deps.storageId);
  if (failedPaths.length) foreign.push({
    storageId: deps.storageId,
    paths: [...new Set(failedPaths)].slice(0, MAX_PENDING_PATHS),
  });
  persistRecovery(recoveryStorage, foreign);
  return { deletedPaths, failedPaths, protectedPaths, rejectedPaths };
}

let serviceDeps: MapImageReferenceGcServiceDeps | null = null;

export function configureMapImageReferenceGc(deps: MapImageReferenceGcServiceDeps | null): void {
  serviceDeps = deps;
}

export async function requestMapImageCleanup(candidates: readonly string[]): Promise<MapImageCleanupResult> {
  if (!serviceDeps) {
    return { deletedPaths: [], failedPaths: [], protectedPaths: [], rejectedPaths: [...candidates] };
  }
  const storageId = serviceDeps.getStorageId();
  if (!storageId) {
    return { deletedPaths: [], failedPaths: [], protectedPaths: [], rejectedPaths: [...candidates] };
  }
  return runMapImageReferenceGc({
    storageId,
    candidates,
    sources: await serviceDeps.getSources(),
    deleteImage: serviceDeps.deleteImage,
    recoveryStorage: serviceDeps.recoveryStorage,
  });
}
