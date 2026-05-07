"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadRuntimeStore = loadRuntimeStore;
exports.saveRuntimeStore = saveRuntimeStore;
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const DEFAULT_STORE = {
    runs: {},
    taskMemory: {},
    history: [],
    knownParticipants: {},
    lastMessageFingerprint: undefined,
};
async function loadRuntimeStore(dataDir) {
    const fileName = node_path_1.default.join(dataDir, 'runtime-store.json');
    try {
        const content = await (0, promises_1.readFile)(fileName, 'utf-8');
        const parsed = JSON.parse(content);
        return {
            runs: parsed.runs ?? {},
            taskMemory: parsed.taskMemory ?? {},
            history: Array.isArray(parsed.history) ? parsed.history : [],
            knownParticipants: parsed.knownParticipants ?? {},
            lastMessageFingerprint: parsed.lastMessageFingerprint,
        };
    }
    catch {
        return { ...DEFAULT_STORE };
    }
}
async function saveRuntimeStore(dataDir, store) {
    await (0, promises_1.mkdir)(dataDir, { recursive: true });
    const fileName = node_path_1.default.join(dataDir, 'runtime-store.json');
    await (0, promises_1.writeFile)(fileName, JSON.stringify(store, null, 2), 'utf-8');
}
