"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const adapter_core_1 = require("@iobroker/adapter-core");
const config_1 = require("./lib/config");
const messageParser_1 = require("./lib/messageParser");
const runtimeStore_1 = require("./lib/runtimeStore");
class ReminderNAdapter extends adapter_core_1.Adapter {
    cfg;
    tasks = new Map();
    runs = new Map();
    taskMemory = new Map();
    history = [];
    lastMessageFingerprint = '';
    tickTimer;
    dataDir = '';
    constructor(options = {}) {
        super({
            ...options,
            name: 'reminder-n',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }
    async onReady() {
        this.cfg = (0, config_1.normalizeAdapterConfig)(this.config);
        this.dataDir = (0, adapter_core_1.getAbsoluteInstanceDataDir)(this);
        await this.setStateChangedAsync('info.connection', { val: true, ack: true });
        await this.writeLastAction('Adapter starting');
        await this.ensureStaticStates();
        await this.loadPersistedData();
        await this.loadTasksFromConfig();
        await this.subscribeStates('commands.processIncomingJson');
        await this.subscribeStates('tasks.*.commands.trigger');
        await this.subscribeStates('tasks.*.commands.reset');
        if (this.cfg.incomingStateId) {
            await this.subscribeForeignStates(this.cfg.incomingStateId);
            this.log.info(`Subscribed to incoming state ${this.cfg.incomingStateId}`);
        }
        else {
            this.log.warn('No incomingStateId configured. Outgoing messages work, but incoming WhatsApp replies must be sent via messagebox or commands.processIncomingJson.');
        }
        await this.syncOverviewStates();
        await this.syncAllTaskStates();
        this.tickTimer = setInterval(() => {
            void this.tick();
        }, 60_000);
        setTimeout(() => {
            void this.tick();
        }, 5_000);
        await this.writeLastAction('Adapter ready');
    }
    onUnload(callback) {
        try {
            if (this.tickTimer) {
                clearInterval(this.tickTimer);
            }
            void this.setStateChangedAsync('info.connection', { val: false, ack: true });
        }
        finally {
            callback();
        }
    }
    async onMessage(obj) {
        if (!obj) {
            return;
        }
        if (obj.command === 'incoming') {
            const incoming = (0, messageParser_1.normalizeIncomingMessage)(obj.message);
            if (!incoming) {
                this.log.warn('Received messagebox command "incoming" with invalid payload');
                return;
            }
            await this.processIncoming(incoming, 'messagebox');
            return;
        }
        if (obj.command === 'triggerTask') {
            const taskId = String(obj.message?.taskId ?? '').trim();
            const task = this.tasks.get(taskId);
            if (!task) {
                this.log.warn(`triggerTask failed: unknown task ${taskId}`);
                return;
            }
            await this.startRun(task, 'manual');
        }
    }
    async onStateChange(id, state) {
        if (!state) {
            return;
        }
        if (this.cfg.incomingStateId && id === this.cfg.incomingStateId) {
            const incoming = (0, messageParser_1.normalizeIncomingMessage)(state.val);
            if (!incoming) {
                this.log.debug(`Ignoring invalid incoming JSON from ${id}`);
                return;
            }
            await this.processIncoming(incoming, 'foreign-state');
            return;
        }
        if (!id.startsWith(this.namespace + '.')) {
            return;
        }
        const localId = id.slice(this.namespace.length + 1);
        if (localId === 'commands.processIncomingJson' && state.ack === false) {
            const incoming = (0, messageParser_1.normalizeIncomingMessage)(state.val);
            if (!incoming) {
                this.log.warn('commands.processIncomingJson received invalid JSON');
                await this.setStateChangedAsync(localId, { val: String(state.val ?? ''), ack: true });
                return;
            }
            await this.processIncoming(incoming, 'command-state');
            await this.setStateChangedAsync(localId, { val: JSON.stringify(incoming), ack: true });
            return;
        }
        const triggerMatch = localId.match(/^tasks\.([^.]+)\.commands\.(trigger|reset)$/);
        if (!triggerMatch || state.ack !== false) {
            return;
        }
        const [, taskId, command] = triggerMatch;
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log.warn(`Task ${taskId} no longer exists in config`);
            return;
        }
        if (command === 'trigger') {
            await this.startRun(task, 'manual');
            await this.setStateChangedAsync(localId, { val: false, ack: true });
            return;
        }
        if (command === 'reset') {
            await this.cancelOpenRun(taskId, 'manual reset command');
            await this.setStateChangedAsync(localId, { val: false, ack: true });
        }
    }
    async ensureStaticStates() {
        await this.extendObject('tasks', {
            type: 'channel',
            common: { name: 'Tasks' },
            native: {},
        });
    }
    async loadPersistedData() {
        const stored = await (0, runtimeStore_1.loadRuntimeStore)(this.dataDir);
        this.lastMessageFingerprint = stored.lastMessageFingerprint ?? '';
        this.history = Array.isArray(stored.history) ? stored.history : [];
        this.taskMemory.clear();
        for (const [taskId, memory] of Object.entries(stored.taskMemory ?? {})) {
            this.taskMemory.set(taskId, memory);
        }
        this.runs.clear();
        for (const [runId, run] of Object.entries(stored.runs ?? {})) {
            if (run.status === 'waiting_child' || run.status === 'waiting_parent') {
                this.runs.set(runId, run);
            }
        }
    }
    async persistData() {
        const store = {
            runs: Object.fromEntries(this.runs.entries()),
            taskMemory: Object.fromEntries(this.taskMemory.entries()),
            history: this.history.slice(-this.cfg.historyLimit),
            lastMessageFingerprint: this.lastMessageFingerprint,
        };
        await (0, runtimeStore_1.saveRuntimeStore)(this.dataDir, store);
    }
    async loadTasksFromConfig() {
        const normalizedTasks = (0, config_1.normalizeTasks)(this.cfg.tasks);
        this.tasks.clear();
        for (const task of normalizedTasks) {
            this.tasks.set(task.id, task);
            if (!this.taskMemory.has(task.id)) {
                this.taskMemory.set(task.id, {});
            }
            await this.ensureTaskObjects(task);
        }
    }
    async ensureTaskObjects(task) {
        const baseId = `tasks.${task.id}`;
        await this.extendObject(baseId, {
            type: 'channel',
            common: {
                name: task.title,
            },
            native: {},
        });
        await this.extendObject(`${baseId}.status`, {
            type: 'channel',
            common: { name: 'Status' },
            native: {},
        });
        await this.extendObject(`${baseId}.commands`, {
            type: 'channel',
            common: { name: 'Commands' },
            native: {},
        });
        const states = [
            {
                id: `${baseId}.status.state`,
                common: { name: 'Current status', type: 'string', role: 'text', read: true, write: false, def: 'idle' },
            },
            {
                id: `${baseId}.status.refCode`,
                common: { name: 'Reference code', type: 'string', role: 'text', read: true, write: false, def: '' },
            },
            {
                id: `${baseId}.status.startedAt`,
                common: { name: 'Started at', type: 'string', role: 'value.datetime', read: true, write: false, def: '' },
            },
            {
                id: `${baseId}.status.childDoneAt`,
                common: { name: 'Child done at', type: 'string', role: 'value.datetime', read: true, write: false, def: '' },
            },
            {
                id: `${baseId}.status.parentConfirmedAt`,
                common: { name: 'Parent confirmed at', type: 'string', role: 'value.datetime', read: true, write: false, def: '' },
            },
            {
                id: `${baseId}.status.childReminderCount`,
                common: { name: 'Child reminder count', type: 'number', role: 'value', read: true, write: false, def: 0 },
            },
            {
                id: `${baseId}.status.parentReminderCount`,
                common: { name: 'Parent reminder count', type: 'number', role: 'value', read: true, write: false, def: 0 },
            },
            {
                id: `${baseId}.status.lastScheduleDate`,
                common: { name: 'Last schedule date', type: 'string', role: 'text', read: true, write: false, def: '' },
            },
            {
                id: `${baseId}.status.summary`,
                common: { name: 'Summary', type: 'string', role: 'text', read: true, write: false, def: '' },
            },
            {
                id: `${baseId}.commands.trigger`,
                common: { name: 'Trigger task now', type: 'boolean', role: 'button', read: false, write: true, def: false },
            },
            {
                id: `${baseId}.commands.reset`,
                common: { name: 'Reset active run', type: 'boolean', role: 'button', read: false, write: true, def: false },
            },
        ];
        for (const entry of states) {
            await this.extendObject(entry.id, {
                type: 'state',
                common: entry.common,
                native: {},
            });
        }
    }
    async tick() {
        const now = new Date();
        for (const task of this.tasks.values()) {
            if (!task.enabled) {
                continue;
            }
            if (!task.childChatId || !task.parentChatId) {
                this.log.warn(`Task ${task.id} is enabled but childChatId or parentChatId is missing`);
                continue;
            }
            if (this.isDueNow(task, now)) {
                await this.startRun(task, 'schedule');
            }
        }
        for (const run of this.runs.values()) {
            const task = this.tasks.get(run.taskId);
            if (!task) {
                continue;
            }
            if (run.status === 'waiting_child' && this.shouldSendReminder(run.lastChildSendAt, task.childReminderHours, now)) {
                await this.sendChildReminder(task, run);
            }
            if (run.status === 'waiting_parent' && this.shouldSendReminder(run.lastParentSendAt, task.parentReminderHours, now)) {
                await this.sendParentReminder(task, run);
            }
        }
        await this.syncOverviewStates();
        await this.syncAllTaskStates();
    }
    isDueNow(task, now) {
        if (task.weekday !== now.getDay()) {
            return false;
        }
        const [hours, minutes] = task.time.split(':').map(value => Number(value));
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
            return false;
        }
        const scheduledToday = new Date(now);
        scheduledToday.setHours(hours, minutes, 0, 0);
        if (now < scheduledToday) {
            return false;
        }
        const today = this.toLocalDateKey(now);
        const memory = this.taskMemory.get(task.id) ?? {};
        if (memory.lastScheduleDate === today) {
            return false;
        }
        return !this.getOpenRunForTask(task.id);
    }
    shouldSendReminder(lastSendAt, intervalHours, now) {
        if (!lastSendAt) {
            return true;
        }
        const last = new Date(lastSendAt);
        return now.getTime() - last.getTime() >= intervalHours * 60 * 60 * 1000;
    }
    async startRun(task, reason) {
        const existing = this.getOpenRunForTask(task.id);
        if (existing) {
            this.log.warn(`Task ${task.id} already has an open run (${existing.refCode}), no new run started`);
            return;
        }
        const nowIso = new Date().toISOString();
        const today = this.toLocalDateKey(new Date());
        const run = {
            runId: `${task.id}-${Date.now()}`,
            taskId: task.id,
            refCode: this.createRefCode(task),
            status: 'waiting_child',
            reason,
            scheduledDate: today,
            startedAt: nowIso,
            lastChildSendAt: nowIso,
            childReminderCount: 0,
            parentReminderCount: 0,
        };
        this.runs.set(run.runId, run);
        this.taskMemory.set(task.id, { lastScheduleDate: today });
        await this.sendWhatsApp(task.childChatId, `${task.message}\n\nBitte antworte mit: erledigt #${run.refCode}`);
        await this.writeHistory({
            timestamp: nowIso,
            type: 'started',
            taskId: task.id,
            refCode: run.refCode,
            status: run.status,
            details: `${reason} | ${(0, config_1.weekdayLabel)(task.weekday)} ${task.time}`,
        });
        await this.writeLastAction(`Task ${task.id} started with ref ${run.refCode}`);
        await this.persistData();
        await this.syncOverviewStates();
        await this.syncTaskStates(task.id);
    }
    async processIncoming(message, source) {
        const fingerprint = (0, messageParser_1.createMessageFingerprint)(message);
        if (fingerprint === this.lastMessageFingerprint) {
            this.log.debug(`Duplicate incoming message ignored (${fingerprint})`);
            return;
        }
        this.lastMessageFingerprint = fingerprint;
        if (this.cfg.logIncomingMessages) {
            await this.setStateChangedAsync('info.lastIncoming', { val: JSON.stringify(message.raw ?? message), ack: true });
        }
        const run = this.findMatchingRun(message);
        if (!run) {
            this.log.info(`Incoming message from ${message.from} could not be matched to an open task`);
            await this.persistData();
            return;
        }
        const task = this.tasks.get(run.taskId);
        if (!task) {
            return;
        }
        if (run.status === 'waiting_child' && message.from === task.childChatId && (0, messageParser_1.matchesKeyword)(message.text, task.childKeywords)) {
            run.status = 'waiting_parent';
            run.childDoneAt = new Date(message.timestamp).toISOString();
            run.lastParentSendAt = new Date().toISOString();
            await this.sendWhatsApp(task.parentChatId, `${task.title} wurde als erledigt gemeldet.\nBitte bestätigen mit: ja #${run.refCode}`);
            await this.writeHistory({
                timestamp: new Date().toISOString(),
                type: 'child_done',
                taskId: task.id,
                refCode: run.refCode,
                status: run.status,
                details: source,
            });
            await this.writeLastAction(`Child confirmed task ${task.id} (${run.refCode})`);
            await this.persistData();
            await this.syncOverviewStates();
            await this.syncTaskStates(task.id);
            return;
        }
        if (run.status === 'waiting_parent' && message.from === task.parentChatId && (0, messageParser_1.matchesKeyword)(message.text, task.parentKeywords)) {
            run.status = 'confirmed';
            run.parentConfirmedAt = new Date(message.timestamp).toISOString();
            await this.sendWhatsApp(task.childChatId, `Super, die Aufgabe \"${task.title}\" wurde bestätigt. ✅`);
            await this.writeHistory({
                timestamp: new Date().toISOString(),
                type: 'parent_confirmed',
                taskId: task.id,
                refCode: run.refCode,
                status: run.status,
                details: source,
            });
            this.runs.delete(run.runId);
            await this.writeLastAction(`Parent confirmed task ${task.id} (${run.refCode})`);
            await this.persistData();
            await this.syncOverviewStates();
            await this.syncTaskStates(task.id, run);
            return;
        }
        this.log.info(`Incoming message matched run ${run.refCode} but did not change state`);
        await this.persistData();
    }
    findMatchingRun(message) {
        const refCode = (0, messageParser_1.extractRefCode)(message.text);
        if (refCode) {
            for (const run of this.runs.values()) {
                if (run.refCode === refCode) {
                    return run;
                }
            }
        }
        const childCandidates = Array.from(this.runs.values()).filter(run => {
            const task = this.tasks.get(run.taskId);
            return !!task && run.status === 'waiting_child' && task.childChatId === message.from;
        });
        if (childCandidates.length === 1) {
            return childCandidates[0];
        }
        const parentCandidates = Array.from(this.runs.values()).filter(run => {
            const task = this.tasks.get(run.taskId);
            return !!task && run.status === 'waiting_parent' && task.parentChatId === message.from;
        });
        if (parentCandidates.length === 1) {
            return parentCandidates[0];
        }
        return undefined;
    }
    async sendChildReminder(task, run) {
        await this.sendWhatsApp(task.childChatId, `Erinnerung: ${task.message}\n\nBitte antworte mit: erledigt #${run.refCode}`);
        run.lastChildSendAt = new Date().toISOString();
        run.childReminderCount += 1;
        await this.writeHistory({
            timestamp: new Date().toISOString(),
            type: 'child_reminder',
            taskId: task.id,
            refCode: run.refCode,
            status: run.status,
            details: `Count ${run.childReminderCount}`,
        });
        await this.writeLastAction(`Child reminder sent for task ${task.id} (${run.refCode})`);
        await this.persistData();
        await this.syncOverviewStates();
        await this.syncTaskStates(task.id);
    }
    async sendParentReminder(task, run) {
        await this.sendWhatsApp(task.parentChatId, `Bitte bestätigen: ${task.title}\nAntwort mit: ja #${run.refCode}`);
        run.lastParentSendAt = new Date().toISOString();
        run.parentReminderCount += 1;
        await this.writeHistory({
            timestamp: new Date().toISOString(),
            type: 'parent_reminder',
            taskId: task.id,
            refCode: run.refCode,
            status: run.status,
            details: `Count ${run.parentReminderCount}`,
        });
        await this.writeLastAction(`Parent reminder sent for task ${task.id} (${run.refCode})`);
        await this.persistData();
        await this.syncOverviewStates();
        await this.syncTaskStates(task.id);
    }
    async cancelOpenRun(taskId, reason) {
        const run = this.getOpenRunForTask(taskId);
        if (!run) {
            await this.syncTaskStates(taskId);
            return;
        }
        this.runs.delete(run.runId);
        await this.writeHistory({
            timestamp: new Date().toISOString(),
            type: 'cancelled',
            taskId,
            refCode: run.refCode,
            status: 'cancelled',
            details: reason,
        });
        await this.writeLastAction(`Open run ${run.refCode} cancelled for task ${taskId}`);
        await this.persistData();
        await this.syncOverviewStates();
        await this.syncTaskStates(taskId);
    }
    getOpenRunForTask(taskId) {
        return Array.from(this.runs.values()).find(run => run.taskId === taskId);
    }
    async syncOverviewStates() {
        const activeRuns = Array.from(this.runs.values()).map(run => ({
            ...run,
            taskTitle: this.tasks.get(run.taskId)?.title ?? run.taskId,
        }));
        await this.setStateChangedAsync('runs.activeJson', { val: JSON.stringify(activeRuns, null, 2), ack: true });
        await this.setStateChangedAsync('runs.historyJson', { val: JSON.stringify(this.history.slice(-this.cfg.historyLimit), null, 2), ack: true });
    }
    async syncAllTaskStates() {
        for (const task of this.tasks.values()) {
            await this.syncTaskStates(task.id);
        }
    }
    async syncTaskStates(taskId, completedRun) {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }
        const run = this.getOpenRunForTask(taskId);
        const baseId = `tasks.${taskId}.status`;
        const memory = this.taskMemory.get(taskId) ?? {};
        const displayedRun = run ?? completedRun;
        const status = run?.status ?? (completedRun?.status === 'confirmed' ? 'confirmed' : 'idle');
        await this.setStateChangedAsync(`${baseId}.state`, { val: status, ack: true });
        await this.setStateChangedAsync(`${baseId}.refCode`, { val: displayedRun?.refCode ?? '', ack: true });
        await this.setStateChangedAsync(`${baseId}.startedAt`, { val: displayedRun?.startedAt ?? '', ack: true });
        await this.setStateChangedAsync(`${baseId}.childDoneAt`, { val: displayedRun?.childDoneAt ?? '', ack: true });
        await this.setStateChangedAsync(`${baseId}.parentConfirmedAt`, { val: displayedRun?.parentConfirmedAt ?? '', ack: true });
        await this.setStateChangedAsync(`${baseId}.childReminderCount`, { val: displayedRun?.childReminderCount ?? 0, ack: true });
        await this.setStateChangedAsync(`${baseId}.parentReminderCount`, { val: displayedRun?.parentReminderCount ?? 0, ack: true });
        await this.setStateChangedAsync(`${baseId}.lastScheduleDate`, { val: memory.lastScheduleDate ?? '', ack: true });
        const summary = run
            ? `${task.title}: ${run.status} (${run.refCode})`
            : displayedRun?.status === 'confirmed'
                ? `${task.title}: confirmed (${displayedRun.refCode})`
                : `${task.title}: idle`;
        await this.setStateChangedAsync(`${baseId}.summary`, { val: summary, ack: true });
    }
    async sendWhatsApp(to, text) {
        if (!to) {
            throw new Error('No recipient provided');
        }
        await this.sendToAsync(this.cfg.openWaInstance, 'send', { to, text });
    }
    createRefCode(task) {
        const prefix = task.id.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 10) || 'TASK';
        const suffix = Math.floor(1000 + Math.random() * 9000);
        return `${prefix}-${suffix}`;
    }
    async writeHistory(entry) {
        this.history.push(entry);
        if (this.history.length > this.cfg.historyLimit) {
            this.history = this.history.slice(-this.cfg.historyLimit);
        }
    }
    async writeLastAction(message) {
        await this.setStateChangedAsync('info.lastAction', { val: `${new Date().toISOString()} | ${message}`, ack: true });
    }
    toLocalDateKey(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
}
if (require.main !== module) {
    module.exports = (options) => new ReminderNAdapter(options);
}
else {
    (() => new ReminderNAdapter())();
}
//# sourceMappingURL=main.js.map