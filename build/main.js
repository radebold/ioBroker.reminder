"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const adapter_core_1 = require("@iobroker/adapter-core");
const config_1 = require("./lib/config");
const messageParser_1 = require("./lib/messageParser");
const runtimeStore_1 = require("./lib/runtimeStore");
class ReminderAdapter extends adapter_core_1.Adapter {
    constructor(options = {}) {
        super({ ...options, name: "reminder" });
        this.tasks = new Map();
        this.runs = new Map();
        this.taskMemory = new Map();
        this.knownParticipants = new Map();
        this.history = [];
        this.lastMessageFingerprint = "";
        this.dataDir = "";
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }
    async onReady() {
        this.cfg = (0, config_1.normalizeAdapterConfig)(this.config);
        this.dataDir = (0, adapter_core_1.getAbsoluteInstanceDataDir)(this);
        await this.setStateChangedAsync("info.connection", { val: true, ack: true });
        await this.writeLastAction("Adapter starting");
        await this.ensureStaticStates();
        await this.loadPersistedData();
        await this.loadTasksFromConfig();
        await this.reconcileRuntimeWithConfig();
        await this.subscribeStates("commands.processIncomingJson");
        await this.subscribeStates("commands.resetAllRuns");
        await this.subscribeStates("commands.reloadConfig");
        await this.subscribeStates("tasks.*.commands.trigger");
        await this.subscribeStates("tasks.*.commands.reset");
        if (this.cfg.incomingStateId) {
            await this.subscribeForeignStates(this.cfg.incomingStateId);
            this.log.info(`Subscribed to incoming state ${this.cfg.incomingStateId}`);
        }
        else {
            this.log.warn("No incomingStateId configured. Outgoing messages work, but incoming WhatsApp replies must be sent via messagebox or commands.processIncomingJson.");
        }
        await this.syncOverviewStates();
        await this.syncAllTaskStates();
        this.tickTimer = setInterval(() => void this.tick(), 60000);
        setTimeout(() => void this.tick(), 5000);
        await this.writeLastAction("Adapter ready");
    }
    onUnload(callback) {
        try {
            if (this.tickTimer) {
                clearInterval(this.tickTimer);
            }
            void this.setStateChangedAsync("info.connection", { val: false, ack: true });
        }
        finally {
            callback();
        }
    }
    async onMessage(obj) {
        if (!obj) {
            return;
        }
        if (obj.command === "incoming") {
            const incoming = (0, messageParser_1.normalizeIncomingMessage)(obj.message);
            if (!incoming) {
                this.log.warn('Received messagebox command "incoming" with invalid payload');
                return;
            }
            await this.processIncoming(incoming, "messagebox");
            return;
        }
        if (obj.command === "triggerTask") {
            const taskId = String((obj.message && obj.message.taskId) || "").trim();
            const task = this.tasks.get(taskId);
            if (!task) {
                this.log.warn(`triggerTask failed: unknown task ${taskId}`);
                return;
            }
            await this.startRun(task, "manual");
            return;
        }
        if (obj.command === "resetAllRuns") {
            await this.resetAllRuns("messagebox command");
            return;
        }
        if (obj.command === "participantOptions") {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, this.getKnownParticipantOptions(), obj.callback);
            }
            return;
        }
        if (obj.command === "participantSummary") {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, this.getKnownParticipantsSummary(), obj.callback);
            }
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
            await this.processIncoming(incoming, "foreign-state");
            return;
        }
        if (!id.startsWith(this.namespace + ".")) {
            return;
        }
        const localId = id.slice(this.namespace.length + 1);
        if (localId === "commands.processIncomingJson" && state.ack === false) {
            const incoming = (0, messageParser_1.normalizeIncomingMessage)(state.val);
            if (!incoming) {
                this.log.warn("commands.processIncomingJson received invalid JSON");
                await this.setStateChangedAsync(localId, { val: String(state.val ?? ""), ack: true });
                return;
            }
            await this.processIncoming(incoming, "command-state");
            await this.setStateChangedAsync(localId, { val: JSON.stringify(incoming), ack: true });
            return;
        }
        if (localId === "commands.resetAllRuns" && state.ack === false) {
            await this.resetAllRuns("manual resetAllRuns command");
            await this.setStateChangedAsync(localId, { val: false, ack: true });
            return;
        }
        if (localId === "commands.reloadConfig" && state.ack === false) {
            await this.reloadConfiguration();
            await this.setStateChangedAsync(localId, { val: false, ack: true });
            return;
        }
        const triggerMatch = localId.match(/^tasks\.([^.]+)\.commands\.(trigger|reset)$/);
        if (!triggerMatch || state.ack !== false) {
            return;
        }
        const taskId = triggerMatch[1];
        const command = triggerMatch[2];
        const task = this.tasks.get(taskId);
        if (!task) {
            this.log.warn(`Task ${taskId} no longer exists in config`);
            return;
        }
        if (command === "trigger") {
            await this.startRun(task, "manual");
            await this.setStateChangedAsync(localId, { val: false, ack: true });
            return;
        }
        if (command === "reset") {
            await this.cancelOpenRun(taskId, "manual reset command");
            await this.setStateChangedAsync(localId, { val: false, ack: true });
        }
    }
    async ensureStaticStates() {
        for (const [id, name] of [["info", "Information"], ["runs", "Run overview"], ["commands", "Commands"], ["tasks", "Tasks"]]) {
            await this.extendObject(id, { type: "channel", common: { name }, native: {} });
        }
        const states = [
            { id: "commands.processIncomingJson", common: { name: "Process incoming WhatsApp JSON", type: "string", role: "json", read: true, write: true, def: "" } },
            { id: "commands.resetAllRuns", common: { name: "Reset all active runs", type: "boolean", role: "button", read: false, write: true, def: false } },
            { id: "commands.reloadConfig", common: { name: "Reload configuration", type: "boolean", role: "button", read: false, write: true, def: false } },
            { id: "runs.activeJson", common: { name: "Active runs as JSON", type: "string", role: "json", read: true, write: false, def: "[]" } },
            { id: "runs.historyJson", common: { name: "History as JSON", type: "string", role: "json", read: true, write: false, def: "[]" } },
            { id: "info.knownParticipantsJson", common: { name: "Known participants as JSON", type: "string", role: "json", read: true, write: false, def: "[]" } },
        ];
        for (const entry of states) {
            await this.extendObject(entry.id, { type: "state", common: entry.common, native: {} });
        }
    }
    async loadPersistedData() {
        const stored = await (0, runtimeStore_1.loadRuntimeStore)(this.dataDir);
        this.lastMessageFingerprint = stored.lastMessageFingerprint || "";
        this.history = Array.isArray(stored.history) ? stored.history : [];
        this.taskMemory.clear();
        for (const [taskId, memory] of Object.entries(stored.taskMemory || {})) {
            this.taskMemory.set(taskId, memory);
        }
        this.knownParticipants.clear();
        for (const [participantId, participant] of Object.entries(stored.knownParticipants || {})) {
            this.knownParticipants.set(participantId, participant);
        }
        this.runs.clear();
        for (const [runId, run] of Object.entries(stored.runs || {})) {
            if (run.status === "waiting_child" || run.status === "waiting_parent") {
                this.runs.set(runId, run);
            }
        }
    }
    async persistData() {
        const store = {
            runs: Object.fromEntries(this.runs.entries()),
            taskMemory: Object.fromEntries(this.taskMemory.entries()),
            history: this.history.slice(-this.cfg.historyLimit),
            knownParticipants: Object.fromEntries(this.knownParticipants.entries()),
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
    async reloadConfiguration() {
        this.cfg = (0, config_1.normalizeAdapterConfig)(this.config);
        await this.loadTasksFromConfig();
        await this.reconcileRuntimeWithConfig();
        await this.syncOverviewStates();
        await this.syncAllTaskStates();
        await this.writeLastAction("Configuration reloaded");
    }
    async reconcileRuntimeWithConfig() {
        const validTaskIds = new Set(this.tasks.keys());
        let removedRuns = 0;
        for (const [runId, run] of Array.from(this.runs.entries())) {
            if (!validTaskIds.has(run.taskId)) {
                this.runs.delete(runId);
                removedRuns += 1;
            }
        }
        for (const taskId of Array.from(this.taskMemory.keys())) {
            if (!validTaskIds.has(taskId)) {
                this.taskMemory.delete(taskId);
            }
        }
        for (const taskId of validTaskIds) {
            if (!this.taskMemory.has(taskId)) {
                this.taskMemory.set(taskId, {});
            }
        }
        if (removedRuns > 0) {
            await this.writeHistory({
                timestamp: new Date().toISOString(),
                type: "cancelled",
                taskId: "*",
                refCode: "STALE-RUNS",
                status: "cancelled",
                details: `Removed ${removedRuns} stale run(s) after config reconciliation`,
            });
            await this.persistData();
        }
    }
    async ensureTaskObjects(task) {
        const baseId = `tasks.${task.id}`;
        await this.extendObject(baseId, { type: "channel", common: { name: task.title }, native: {} });
        await this.extendObject(`${baseId}.status`, { type: "channel", common: { name: "Status" }, native: {} });
        await this.extendObject(`${baseId}.commands`, { type: "channel", common: { name: "Commands" }, native: {} });
        const states = [
            { id: `${baseId}.status.state`, common: { name: "Current status", type: "string", role: "text", read: true, write: false, def: "idle" } },
            { id: `${baseId}.status.refCode`, common: { name: "Reference code", type: "string", role: "text", read: true, write: false, def: "" } },
            { id: `${baseId}.status.startedAt`, common: { name: "Started at", type: "string", role: "value.datetime", read: true, write: false, def: "" } },
            { id: `${baseId}.status.childDoneAt`, common: { name: "Child done at", type: "string", role: "value.datetime", read: true, write: false, def: "" } },
            { id: `${baseId}.status.parentConfirmedAt`, common: { name: "Parent confirmed at", type: "string", role: "value.datetime", read: true, write: false, def: "" } },
            { id: `${baseId}.status.childReminderCount`, common: { name: "Child reminder count", type: "number", role: "value", read: true, write: false, def: 0 } },
            { id: `${baseId}.status.parentReminderCount`, common: { name: "Parent reminder count", type: "number", role: "value", read: true, write: false, def: 0 } },
            { id: `${baseId}.status.lastScheduleDate`, common: { name: "Last schedule date", type: "string", role: "text", read: true, write: false, def: "" } },
            { id: `${baseId}.status.summary`, common: { name: "Summary", type: "string", role: "text", read: true, write: false, def: "" } },
            { id: `${baseId}.commands.trigger`, common: { name: "Trigger task now", type: "boolean", role: "button", read: false, write: true, def: false } },
            { id: `${baseId}.commands.reset`, common: { name: "Reset active run", type: "boolean", role: "button", read: false, write: true, def: false } },
        ];
        for (const entry of states) {
            await this.extendObject(entry.id, { type: "state", common: entry.common, native: {} });
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
                await this.startRun(task, "schedule");
            }
        }
        for (const run of this.runs.values()) {
            const task = this.tasks.get(run.taskId);
            if (!task) {
                continue;
            }
            if (run.status === "waiting_child" && this.shouldSendReminder(run.lastChildSendAt, task.childReminderHours, now)) {
                await this.sendChildReminder(task, run);
            }
            if (run.status === "waiting_parent" && this.shouldSendReminder(run.lastParentSendAt, task.parentReminderHours, now)) {
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
        const [hours, minutes] = task.time.split(":").map(value => Number(value));
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
            return false;
        }
        const scheduledToday = new Date(now);
        scheduledToday.setHours(hours, minutes, 0, 0);
        if (now < scheduledToday) {
            return false;
        }
        const today = this.toLocalDateKey(now);
        const memory = this.taskMemory.get(task.id) || {};
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
            status: "waiting_child",
            reason,
            scheduledDate: today,
            startedAt: nowIso,
            lastChildSendAt: nowIso,
            childReminderCount: 0,
            parentReminderCount: 0,
        };
        this.runs.set(run.runId, run);
        this.taskMemory.set(task.id, { lastScheduleDate: today });
        try {
            await this.sendWhatsApp(task.childChatId, this.buildChildMessage(task, run, false));
        }
        catch (error) {
            this.runs.delete(run.runId);
            this.taskMemory.set(task.id, {});
            await this.persistData();
            await this.syncOverviewStates();
            await this.syncTaskStates(task.id);
            await this.writeLastAction(`Failed to send child message for task ${task.id}: ${this.errorToText(error)}`);
            throw error;
        }
        await this.writeHistory({
            timestamp: nowIso,
            type: "started",
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
        this.rememberParticipant(message);
        if (this.cfg.logIncomingMessages) {
            await this.setStateChangedAsync("info.lastIncoming", { val: JSON.stringify(message.raw || message), ack: true });
        }
        const run = this.findMatchingRun(message);
        if (!run) {
            this.log.info(`Incoming message from ${message.from} could not be matched to an open task`);
            await this.persistData();
            await this.syncOverviewStates();
            return;
        }
        const task = this.tasks.get(run.taskId);
        if (!task) {
            return;
        }
        if (run.status === "waiting_child" && this.matchesTaskParticipant(task.childChatId, message) && (0, messageParser_1.matchesKeyword)(message.text, task.childKeywords)) {
            run.status = "waiting_parent";
            run.childDoneAt = new Date(message.timestamp).toISOString();
            run.lastParentSendAt = new Date().toISOString();
            await this.sendWhatsApp(task.parentChatId, this.buildParentMessage(task, run, false));
            await this.writeHistory({
                timestamp: new Date().toISOString(),
                type: "child_done",
                taskId: task.id,
                refCode: run.refCode,
                status: run.status,
                details: `${source} | ${message.from}`,
            });
            await this.writeLastAction(`Child confirmed task ${task.id} (${run.refCode})`);
            await this.persistData();
            await this.syncOverviewStates();
            await this.syncTaskStates(task.id);
            return;
        }
        if (run.status === "waiting_parent" && this.matchesTaskParticipant(task.parentChatId, message) && (0, messageParser_1.matchesKeyword)(message.text, task.parentKeywords)) {
            run.status = "confirmed";
            run.parentConfirmedAt = new Date(message.timestamp).toISOString();
            await this.sendWhatsApp(task.childChatId, `Super, die Aufgabe "${task.title}" wurde bestätigt. ✅`);
            await this.writeHistory({
                timestamp: new Date().toISOString(),
                type: "parent_confirmed",
                taskId: task.id,
                refCode: run.refCode,
                status: run.status,
                details: `${source} | ${message.from}`,
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
        await this.syncOverviewStates();
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
            return !!task && run.status === "waiting_child" && this.matchesTaskParticipant(task.childChatId, message);
        });
        if (childCandidates.length === 1) {
            return childCandidates[0];
        }
        const parentCandidates = Array.from(this.runs.values()).filter(run => {
            const task = this.tasks.get(run.taskId);
            return !!task && run.status === "waiting_parent" && this.matchesTaskParticipant(task.parentChatId, message);
        });
        if (parentCandidates.length === 1) {
            return parentCandidates[0];
        }
        return undefined;
    }
    matchesTaskParticipant(configuredId, message) {
        const configuredKeys = this.expandComparableIds(configuredId);
        const messageKeys = new Set();
        for (const candidate of this.getIncomingIdCandidates(message)) {
            for (const key of this.expandComparableIds(candidate)) {
                messageKeys.add(key);
            }
        }
        return configuredKeys.some(key => messageKeys.has(key));
    }
    getIncomingIdCandidates(message) {
        const raw = message.raw || {};
        const candidates = [
            message.from,
            String(raw.chatId || ""),
            String(raw.sender || ""),
            String(raw.from || ""),
            String(raw.fromId || ""),
        ].map(value => value.trim()).filter(Boolean);
        return Array.from(new Set(candidates));
    }
    expandComparableIds(input) {
        const value = String(input || "").trim().toLowerCase();
        if (!value) {
            return [];
        }
        const digits = value.replace(/\D/g, "");
        return Array.from(new Set([value, digits].filter(Boolean)));
    }
    rememberParticipant(message) {
        const raw = message.raw || {};
        const participantId = this.getCanonicalParticipantId(message);
        if (!participantId) {
            return;
        }
        const nowIso = new Date().toISOString();
        const displayName = this.normalizeParticipantName(String(raw.chatName || raw.fromName || raw.notifyName || raw.senderName || message.from).trim(), participantId);
        const existing = this.knownParticipants.get(participantId);
        this.knownParticipants.set(participantId, {
            id: participantId,
            displayName,
            phoneNumber: this.extractPhoneNumber(participantId),
            sourceType: participantId.includes("@") ? participantId.split("@")[1] : "",
            firstSeenAt: existing && existing.firstSeenAt ? existing.firstSeenAt : nowIso,
            lastSeenAt: nowIso,
            seenCount: (existing && existing.seenCount ? existing.seenCount : 0) + 1,
        });
    }
    getCanonicalParticipantId(message) {
        for (const candidate of this.getIncomingIdCandidates(message)) {
            const trimmed = String(candidate || "").trim();
            if (trimmed && trimmed.includes("@")) {
                return trimmed;
            }
        }
        return String(message.from || "").trim();
    }
    normalizeParticipantName(input, participantId) {
        const trimmed = input.trim();
        if (!trimmed || trimmed.toLowerCase() === "unknown") {
            return participantId;
        }
        return trimmed;
    }
    extractPhoneNumber(participantId) {
        const digits = participantId.replace(/\D/g, "");
        return digits || undefined;
    }
    getKnownParticipantOptions() {
        return Array.from(this.knownParticipants.values())
            .sort((a, b) => {
            const nameCompare = a.displayName.localeCompare(b.displayName, "de", { sensitivity: "base" });
            if (nameCompare !== 0) {
                return nameCompare;
            }
            return b.lastSeenAt.localeCompare(a.lastSeenAt);
        })
            .map(participant => ({ value: participant.id, label: this.formatParticipantLabel(participant) }));
    }
    getKnownParticipantsSummary() {
        const options = this.getKnownParticipantOptions();
        if (!options.length) {
            return {
                text: "Noch keine bekannten Kontakte. Lasse die Person einmal eine WhatsApp an die open-wa-Nummer senden. Danach taucht sie hier und in den Auswahllisten auf.",
                style: { whiteSpace: "pre-wrap" },
            };
        }
        const lines = ["Bekannte WhatsApp-Kontakte:", ...options.map(option => `• ${option.label}`)];
        return { text: lines.join("\n"), style: { whiteSpace: "pre-wrap" } };
    }
    formatParticipantLabel(participant) {
        const parts = [participant.displayName];
        if (participant.phoneNumber) {
            parts.push(participant.phoneNumber);
        }
        parts.push(participant.id);
        return parts.join(" — ");
    }
    buildChildMessage(task, run, isReminder) {
        const lines = [isReminder ? `Erinnerung: ${task.message}` : task.message, ""];
        const replyLink = this.buildReplyLink(`erledigt #${run.refCode}`);
        if (replyLink) {
            lines.push("✅ Einfach hier tippen und senden:", replyLink, "", "Alternativ reicht meistens auch einfach: erledigt");
        }
        else {
            lines.push(`Bitte antworte mit: erledigt #${run.refCode}`, "Alternativ reicht meistens auch einfach: erledigt");
        }
        return lines.join("\n");
    }
    buildParentMessage(task, run, isReminder) {
        const lines = [isReminder ? `Erinnerung zur Bestätigung: ${task.title}` : `${task.title} wurde als erledigt gemeldet.`, ""];
        const replyLink = this.buildReplyLink(`ja #${run.refCode}`);
        if (replyLink) {
            lines.push("✅ Zum Bestätigen einfach hier tippen und senden:", replyLink, "", "Alternativ reicht meistens auch einfach: ja");
        }
        else {
            lines.push(`Bitte bestätigen mit: ja #${run.refCode}`, "Alternativ reicht meistens auch einfach: ja");
        }
        return lines.join("\n");
    }
    buildReplyLink(replyText) {
        const phone = (this.cfg.replyLinkPhone || "").replace(/\D/g, "");
        if (!phone) {
            return null;
        }
        return `https://wa.me/${phone}?text=${encodeURIComponent(replyText)}`;
    }
    async sendChildReminder(task, run) {
        await this.sendWhatsApp(task.childChatId, this.buildChildMessage(task, run, true));
        run.lastChildSendAt = new Date().toISOString();
        run.childReminderCount += 1;
        await this.writeHistory({
            timestamp: new Date().toISOString(),
            type: "child_reminder",
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
        await this.sendWhatsApp(task.parentChatId, this.buildParentMessage(task, run, true));
        run.lastParentSendAt = new Date().toISOString();
        run.parentReminderCount += 1;
        await this.writeHistory({
            timestamp: new Date().toISOString(),
            type: "parent_reminder",
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
            type: "cancelled",
            taskId,
            refCode: run.refCode,
            status: "cancelled",
            details: reason,
        });
        await this.writeLastAction(`Open run ${run.refCode} cancelled for task ${taskId}`);
        await this.persistData();
        await this.syncOverviewStates();
        await this.syncTaskStates(taskId);
    }
    async resetAllRuns(reason) {
        const count = this.runs.size;
        this.runs.clear();
        this.taskMemory.clear();
        for (const taskId of this.tasks.keys()) {
            this.taskMemory.set(taskId, {});
        }
        if (count > 0) {
            await this.writeHistory({
                timestamp: new Date().toISOString(),
                type: "cancelled",
                taskId: "*",
                refCode: "RESET-ALL",
                status: "cancelled",
                details: `${reason} | cleared ${count} active run(s)`,
            });
        }
        await this.persistData();
        await this.syncOverviewStates();
        await this.syncAllTaskStates();
        await this.writeLastAction(`All runs reset (${count} cleared)`);
    }
    getOpenRunForTask(taskId) {
        return Array.from(this.runs.values()).find(run => run.taskId === taskId);
    }
    async syncOverviewStates() {
        const activeRuns = Array.from(this.runs.values()).map(run => ({ ...run, taskTitle: (this.tasks.get(run.taskId) || {}).title || run.taskId }));
        const knownParticipants = Array.from(this.knownParticipants.values()).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
        await this.setStateChangedAsync("runs.activeJson", { val: JSON.stringify(activeRuns, null, 2), ack: true });
        await this.setStateChangedAsync("runs.historyJson", { val: JSON.stringify(this.history.slice(-this.cfg.historyLimit), null, 2), ack: true });
        await this.setStateChangedAsync("info.knownParticipantsJson", { val: JSON.stringify(knownParticipants, null, 2), ack: true });
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
        const memory = this.taskMemory.get(taskId) || {};
        const displayedRun = run || completedRun;
        const status = run ? run.status : (completedRun && completedRun.status === "confirmed" ? "confirmed" : "idle");
        await this.setStateChangedAsync(`${baseId}.state`, { val: status, ack: true });
        await this.setStateChangedAsync(`${baseId}.refCode`, { val: displayedRun ? displayedRun.refCode : "", ack: true });
        await this.setStateChangedAsync(`${baseId}.startedAt`, { val: displayedRun ? displayedRun.startedAt : "", ack: true });
        await this.setStateChangedAsync(`${baseId}.childDoneAt`, { val: displayedRun ? displayedRun.childDoneAt || "" : "", ack: true });
        await this.setStateChangedAsync(`${baseId}.parentConfirmedAt`, { val: displayedRun ? displayedRun.parentConfirmedAt || "" : "", ack: true });
        await this.setStateChangedAsync(`${baseId}.childReminderCount`, { val: displayedRun ? displayedRun.childReminderCount || 0 : 0, ack: true });
        await this.setStateChangedAsync(`${baseId}.parentReminderCount`, { val: displayedRun ? displayedRun.parentReminderCount || 0 : 0, ack: true });
        await this.setStateChangedAsync(`${baseId}.lastScheduleDate`, { val: memory.lastScheduleDate || "", ack: true });
        const summary = run ? `${task.title}: ${run.status} (${run.refCode})` : (displayedRun && displayedRun.status === "confirmed" ? `${task.title}: confirmed (${displayedRun.refCode})` : `${task.title}: idle`);
        await this.setStateChangedAsync(`${baseId}.summary`, { val: summary, ack: true });
    }
    async sendWhatsApp(to, text) {
        const normalizedTo = this.normalizeOutgoingRecipient(to);
        if (!normalizedTo) {
            throw new Error("No recipient provided");
        }
        this.log.debug(`Sending WhatsApp message to ${normalizedTo}`);
        await this.sendToAsync(this.cfg.openWaInstance, "send", { to: normalizedTo, text });
    }
    normalizeOutgoingRecipient(to) {
        const trimmed = String(to || "").trim();
        if (!trimmed) {
            return "";
        }
        if (trimmed.includes("@")) {
            return trimmed;
        }
        const digits = trimmed.replace(/\D/g, "");
        if (!digits) {
            return trimmed;
        }
        return `${digits}@c.us`;
    }
    createRefCode(task) {
        const prefix = task.id.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10) || "TASK";
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
        await this.setStateChangedAsync("info.lastAction", { val: `${new Date().toISOString()} | ${message}`, ack: true });
    }
    errorToText(error) {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
    toLocalDateKey(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }
}
if (require.main !== module) {
    module.exports = options => new ReminderAdapter(options);
}
else {
    (() => new ReminderAdapter())();
}
