"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeAdapterConfig = normalizeAdapterConfig;
exports.normalizeTasks = normalizeTasks;
exports.weekdayLabel = weekdayLabel;
function toNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}
function toStringValue(value, fallback = '') {
    if (value === null || value === undefined) {
        return fallback;
    }
    return String(value).trim();
}
function slugify(input) {
    return input
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}
function normalizeKeywords(value, fallback) {
    const text = toStringValue(value);
    const list = (text ? text.split(',') : fallback)
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean);
    return Array.from(new Set(list));
}
function normalizeWeekday(value) {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : value;
    const named = {
        sunday: 0,
        sonntag: 0,
        monday: 1,
        montag: 1,
        tuesday: 2,
        dienstag: 2,
        wednesday: 3,
        mittwoch: 3,
        thursday: 4,
        donnerstag: 4,
        friday: 5,
        freitag: 5,
        saturday: 6,
        samstag: 6,
    };
    if (typeof raw === 'string' && raw in named) {
        return named[raw];
    }
    const num = Number(raw);
    if (!Number.isInteger(num) || num < 0 || num > 6) {
        return 1;
    }
    return num;
}
function normalizeTime(value) {
    const text = toStringValue(value, '17:00');
    const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
        return '17:00';
    }
    const hours = Math.min(23, Math.max(0, Number(match[1])));
    const minutes = Math.min(59, Math.max(0, Number(match[2])));
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}
function normalizeAdapterConfig(raw) {
    return {
        openWaInstance: toStringValue(raw.openWaInstance, 'open-wa.0') || 'open-wa.0',
        incomingStateId: toStringValue(raw.incomingStateId),
        historyLimit: Math.max(10, toNumber(raw.historyLimit, 100)),
        logIncomingMessages: raw.logIncomingMessages !== false,
        tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    };
}
function normalizeTasks(rawTasks) {
    const result = [];
    const usedIds = new Set();
    for (let index = 0; index < rawTasks.length; index++) {
        const raw = rawTasks[index] ?? {};
        const baseId = slugify(toStringValue(raw.id) || toStringValue(raw.title) || `task-${index + 1}`) || `task-${index + 1}`;
        let uniqueId = baseId;
        let duplicateCounter = 2;
        while (usedIds.has(uniqueId)) {
            uniqueId = `${baseId}-${duplicateCounter++}`;
        }
        usedIds.add(uniqueId);
        result.push({
            enabled: raw.enabled !== false,
            id: uniqueId,
            title: toStringValue(raw.title, `Task ${index + 1}`) || `Task ${index + 1}`,
            message: toStringValue(raw.message, `Please complete task ${index + 1}.`) || `Please complete task ${index + 1}.`,
            weekday: normalizeWeekday(raw.weekday),
            time: normalizeTime(raw.time),
            childChatId: toStringValue(raw.childChatId),
            parentChatId: toStringValue(raw.parentChatId),
            childReminderHours: Math.max(1, toNumber(raw.childReminderHours, 3)),
            parentReminderHours: Math.max(1, toNumber(raw.parentReminderHours, 3)),
            childKeywords: normalizeKeywords(raw.childKeywords, ['erledigt', 'fertig', 'done']),
            parentKeywords: normalizeKeywords(raw.parentKeywords, ['ja', 'bestätigt', 'bestaetigt', 'ok']),
        });
    }
    return result;
}
function weekdayLabel(weekday) {
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekday] ?? 'Monday';
}
//# sourceMappingURL=config.js.map