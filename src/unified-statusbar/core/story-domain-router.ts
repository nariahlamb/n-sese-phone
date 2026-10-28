import type { AtomicCommitResult } from './atomic-envelope-store';

export type StoryDomain = 'story-core' | 'story-map';

export interface StoryFeaturePatch {
  updates: Record<string, unknown>;
  deletes: string[];
}

export interface StoryDomainAppendTarget {
  append(
    anchor: string,
    updates: Record<string, unknown>,
    deletes: string[],
  ): Promise<AtomicCommitResult>;
}

export function storyDomainForFeatureKey(key: string): StoryDomain {
  return key === 'map.index'
    || key.startsWith('map.node:')
    || key === 'map.scene-image.index'
    || key.startsWith('map.scene-image:')
    ? 'story-map'
    : 'story-core';
}

export function splitStoryFeaturePatch(
  updates: Record<string, unknown>,
  deletes: readonly string[] = [],
): Record<StoryDomain, StoryFeaturePatch> {
  const split: Record<StoryDomain, StoryFeaturePatch> = {
    'story-core': { updates: {}, deletes: [] },
    'story-map': { updates: {}, deletes: [] },
  };
  for (const [key, value] of Object.entries(updates || {})) {
    split[storyDomainForFeatureKey(key)].updates[key] = value;
  }
  for (const key of deletes || []) split[storyDomainForFeatureKey(key)].deletes.push(key);
  return split;
}

export async function appendStoryFeaturePatch(
  stores: Record<StoryDomain, StoryDomainAppendTarget>,
  anchor: string,
  updates: Record<string, unknown>,
  deletes: readonly string[] = [],
): Promise<Partial<Record<StoryDomain, AtomicCommitResult>>> {
  const split = splitStoryFeaturePatch(updates, deletes);
  const results: Partial<Record<StoryDomain, AtomicCommitResult>> = {};
  for (const domain of ['story-core', 'story-map'] as const) {
    const patch = split[domain];
    if (!Object.keys(patch.updates).length && !patch.deletes.length) continue;
    results[domain] = await stores[domain].append(anchor, patch.updates, patch.deletes);
  }
  return results;
}
