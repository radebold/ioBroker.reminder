"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractRefCode = extractRefCode;
exports.matchesKeyword = matchesKeyword;
exports.normalizeIncomingMessage = normalizeIncomingMessage;
exports.createMessageFingerprint = createMessageFingerprint;
function normalizeText(text) {
    return text
        .normalize('NFKC')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}
function normalizeTimestamp(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        return numeric;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return Date.now();
}
function extractRefCode(text) {
    const match = text.match(/#([A-Za-z0-9_-]+)/);
    return match ? match[1].toUpperCase() : null;
}
function matchesKeyword(text, keywords) {
    const normalized = normalizeText(text);
    return keywords.some(keyword => {
        const normalizedKeyword = normalizeText(keyword);
        return normalized.startsWith(normalizedKeyword) || normalized.includes(` ${normalizedKeyword}`) || normalized === normalizedKeyword;
    });
}
function normalizeIncomingMessage(raw) {
    let source = null;
    if (typeof raw === 'string') {
        try {
            source = JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    else if (raw && typeof raw === 'object') {
        source = raw;
    }
    if (!source) {
        return null;
    }
    const from = String(source.from ?? source.chatId ?? source.sender ?? source.fromId ?? '').trim();
    const text = String(source.text ?? source.body ?? source.message ?? source.caption ?? '').trim();
    const timestamp = normalizeTimestamp(source.timestamp ?? source.ts ?? Date.now());
    const messageId = String(source.messageId ?? source.id ?? '').trim() || undefined;
    if (!from || !text) {
        return null;
    }
    return {
        from,
        text,
        timestamp,
        messageId,
        raw: source,
    };
}
function createMessageFingerprint(message) {
    return message.messageId || `${message.from}|${message.text}|${message.timestamp}`;
}
//# sourceMappingURL=messageParser.js.map