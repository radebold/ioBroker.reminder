import type { PersistedStore } from './types';
export declare function loadRuntimeStore(dataDir: string): Promise<PersistedStore>;
export declare function saveRuntimeStore(dataDir: string, store: PersistedStore): Promise<void>;
