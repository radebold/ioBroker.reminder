import type { IncomingMessage } from './types';
export declare function extractRefCode(text: string): string | null;
export declare function matchesKeyword(text: string, keywords: string[]): boolean;
export declare function normalizeIncomingMessage(raw: unknown): IncomingMessage | null;
export declare function createMessageFingerprint(message: IncomingMessage): string;
