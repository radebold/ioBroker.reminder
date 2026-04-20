import type { AdapterConfig, TaskConfig } from './types';
export declare function normalizeAdapterConfig(raw: Record<string, unknown>): AdapterConfig;
export declare function normalizeTasks(rawTasks: Array<Record<string, unknown>>): TaskConfig[];
export declare function weekdayLabel(weekday: number): string;
