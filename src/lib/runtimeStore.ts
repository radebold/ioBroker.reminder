import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PersistedStore } from './types';

const DEFAULT_STORE: PersistedStore = {
  runs: {},
  taskMemory: {},
  history: [],
  lastMessageFingerprint: undefined,
};

export async function loadRuntimeStore(dataDir: string): Promise<PersistedStore> {
  const fileName = path.join(dataDir, 'runtime-store.json');
  try {
    const content = await readFile(fileName, 'utf-8');
    const parsed = JSON.parse(content) as PersistedStore;
    return {
      runs: parsed.runs ?? {},
      taskMemory: parsed.taskMemory ?? {},
      history: Array.isArray(parsed.history) ? parsed.history : [],
      lastMessageFingerprint: parsed.lastMessageFingerprint,
    };
  } catch {
    return { ...DEFAULT_STORE };
  }
}

export async function saveRuntimeStore(dataDir: string, store: PersistedStore): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const fileName = path.join(dataDir, 'runtime-store.json');
  await writeFile(fileName, JSON.stringify(store, null, 2), 'utf-8');
}
