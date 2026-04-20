import type { IncomingMessage } from './types';

function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function extractRefCode(text: string): string | null {
  const match = text.match(/#([A-Za-z0-9_-]+)/);
  return match ? match[1].toUpperCase() : null;
}

export function matchesKeyword(text: string, keywords: string[]): boolean {
  const normalized = normalizeText(text);
  return keywords.some(keyword => {
    const normalizedKeyword = normalizeText(keyword);
    return normalized.startsWith(normalizedKeyword) || normalized.includes(` ${normalizedKeyword}`) || normalized === normalizedKeyword;
  });
}

export function normalizeIncomingMessage(raw: unknown): IncomingMessage | null {
  let source: Record<string, unknown> | null = null;

  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === 'object') {
    source = raw as Record<string, unknown>;
  }

  if (!source) {
    return null;
  }

  const from = String(source.from ?? source.chatId ?? source.sender ?? source.fromId ?? '').trim();
  const text = String(source.text ?? source.body ?? source.message ?? source.caption ?? '').trim();
  const timestampValue = source.timestamp ?? source.ts ?? Date.now();
  const timestamp = Number(timestampValue);
  const messageId = String(source.messageId ?? source.id ?? '').trim() || undefined;

  if (!from || !text) {
    return null;
  }

  return {
    from,
    text,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    messageId,
    raw: source,
  };
}

export function createMessageFingerprint(message: IncomingMessage): string {
  return message.messageId || `${message.from}|${message.text}|${message.timestamp}`;
}
