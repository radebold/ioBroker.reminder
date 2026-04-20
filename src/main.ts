import { Adapter, getAbsoluteInstanceDataDir } from '@iobroker/adapter-core';
import type {
  ActiveRun,
  AdapterConfig,
  HistoryEntry,
  IncomingMessage,
  PersistedStore,
  RunStatus,
  TaskConfig,
  TaskMemory,
} from './lib/types';
import { normalizeAdapterConfig, normalizeTasks, weekdayLabel } from './lib/config';
import { createMessageFingerprint, extractRefCode, matchesKeyword, normalizeIncomingMessage } from './lib/messageParser';
import { loadRuntimeStore, saveRuntimeStore } from './lib/runtimeStore';

class ReminderAdapter extends Adapter {
  private cfg!: AdapterConfig;
  private tasks = new Map<string, TaskConfig>();
  private runs = new Map<string, ActiveRun>();
  private taskMemory = new Map<string, TaskMemory>();
  private history: HistoryEntry[] = [];
  private lastMessageFingerprint = '';
  private tickTimer?: ReturnType<typeof setInterval>;
  private dataDir = '';

  public constructor(options: Partial<ioBroker.AdapterOptions> = {}) {
    super({
      ...options,
      name: 'reminder',
    });

    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('message', this.onMessage.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  private async onReady(): Promise<void> {
    this.cfg = normalizeAdapterConfig(this.config as Record<string, unknown>);
    this.dataDir = getAbsoluteInstanceDataDir(this);

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
    } else {
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

  private onUnload(callback: () => void): void {
    try {
      if (this.tickTimer) {
        clearInterval(this.tickTimer);
      }
      void this.setStateChangedAsync('info.connection', { val: false, ack: true });
    } finally {
      callback();
    }
  }

  private async onMessage(obj: ioBroker.Message): Promise<void> {
    if (!obj) {
      return;
    }

    if (obj.command === 'incoming') {
      const incoming = normalizeIncomingMessage(obj.message);
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

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    if (!state) {
      return;
    }

    if (this.cfg.incomingStateId && id === this.cfg.incomingStateId) {
      const incoming = normalizeIncomingMessage(state.val);
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
      const incoming = normalizeIncomingMessage(state.val);
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

  private async ensureStaticStates(): Promise<void> {
    await this.extendObject('tasks', {
      type: 'channel',
      common: { name: 'Tasks' },
      native: {},
    });
  }

  private async loadPersistedData(): Promise<void> {
    const stored: PersistedStore = await loadRuntimeStore(this.dataDir);
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

  private async persistData(): Promise<void> {
    const store: PersistedStore = {
      runs: Object.fromEntries(this.runs.entries()),
      taskMemory: Object.fromEntries(this.taskMemory.entries()),
      history: this.history.slice(-this.cfg.historyLimit),
      lastMessageFingerprint: this.lastMessageFingerprint,
    };
    await saveRuntimeStore(this.dataDir, store);
  }

  private async loadTasksFromConfig(): Promise<void> {
    const normalizedTasks = normalizeTasks(this.cfg.tasks);
    this.tasks.clear();

    for (const task of normalizedTasks) {
      this.tasks.set(task.id, task);
      if (!this.taskMemory.has(task.id)) {
        this.taskMemory.set(task.id, {});
      }
      await this.ensureTaskObjects(task);
    }
  }

  private async ensureTaskObjects(task: TaskConfig): Promise<void> {
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

    const states: Array<{ id: string; common: ioBroker.ObjectCommon }> = [
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

  private async tick(): Promise<void> {
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

  private isDueNow(task: TaskConfig, now: Date): boolean {
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

  private shouldSendReminder(lastSendAt: string | undefined, intervalHours: number, now: Date): boolean {
    if (!lastSendAt) {
      return true;
    }
    const last = new Date(lastSendAt);
    return now.getTime() - last.getTime() >= intervalHours * 60 * 60 * 1000;
  }

  private async startRun(task: TaskConfig, reason: 'schedule' | 'manual'): Promise<void> {
    const existing = this.getOpenRunForTask(task.id);
    if (existing) {
      this.log.warn(`Task ${task.id} already has an open run (${existing.refCode}), no new run started`);
      return;
    }

    const nowIso = new Date().toISOString();
    const today = this.toLocalDateKey(new Date());
    const run: ActiveRun = {
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

    await this.sendWhatsApp(task.childChatId, this.buildChildMessage(task, run, false));
    await this.writeHistory({
      timestamp: nowIso,
      type: 'started',
      taskId: task.id,
      refCode: run.refCode,
      status: run.status,
      details: `${reason} | ${weekdayLabel(task.weekday)} ${task.time}`,
    });
    await this.writeLastAction(`Task ${task.id} started with ref ${run.refCode}`);
    await this.persistData();
    await this.syncOverviewStates();
    await this.syncTaskStates(task.id);
  }

  private async processIncoming(message: IncomingMessage, source: 'foreign-state' | 'messagebox' | 'command-state'): Promise<void> {
    const fingerprint = createMessageFingerprint(message);
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

    if (run.status === 'waiting_child' && this.matchesTaskParticipant(task.childChatId, message) && matchesKeyword(message.text, task.childKeywords)) {
      run.status = 'waiting_parent';
      run.childDoneAt = new Date(message.timestamp).toISOString();
      run.lastParentSendAt = new Date().toISOString();

      await this.sendWhatsApp(task.parentChatId, this.buildParentMessage(task, run, false));
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

    if (run.status === 'waiting_parent' && this.matchesTaskParticipant(task.parentChatId, message) && matchesKeyword(message.text, task.parentKeywords)) {
      run.status = 'confirmed';
      run.parentConfirmedAt = new Date(message.timestamp).toISOString();

      await this.sendWhatsApp(task.childChatId, `Super, die Aufgabe "${task.title}" wurde bestätigt. ✅`);
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

  private findMatchingRun(message: IncomingMessage): ActiveRun | undefined {
    const refCode = extractRefCode(message.text);

    if (refCode) {
      for (const run of this.runs.values()) {
        if (run.refCode === refCode) {
          return run;
        }
      }
    }

    const childCandidates = Array.from(this.runs.values()).filter(run => {
      const task = this.tasks.get(run.taskId);
      return !!task && run.status === 'waiting_child' && this.matchesTaskParticipant(task.childChatId, message);
    });

    if (childCandidates.length === 1) {
      return childCandidates[0];
    }

    const parentCandidates = Array.from(this.runs.values()).filter(run => {
      const task = this.tasks.get(run.taskId);
      return !!task && run.status === 'waiting_parent' && this.matchesTaskParticipant(task.parentChatId, message);
    });

    if (parentCandidates.length === 1) {
      return parentCandidates[0];
    }

    return undefined;
  }

  private matchesTaskParticipant(configuredId: string, message: IncomingMessage): boolean {
    const configuredKeys = this.expandComparableIds(configuredId);
    const messageKeys = new Set<string>();

    for (const candidate of this.getIncomingIdCandidates(message)) {
      for (const key of this.expandComparableIds(candidate)) {
        messageKeys.add(key);
      }
    }

    return configuredKeys.some(key => messageKeys.has(key));
  }

  private getIncomingIdCandidates(message: IncomingMessage): string[] {
    const raw = message.raw ?? {};
    const candidates = [
      message.from,
      String(raw.chatId ?? ''),
      String(raw.sender ?? ''),
      String(raw.from ?? ''),
      String(raw.fromId ?? ''),
    ].map(value => value.trim()).filter(Boolean);

    return Array.from(new Set(candidates));
  }

  private expandComparableIds(input: string): string[] {
    const value = String(input ?? '').trim().toLowerCase();
    if (!value) {
      return [];
    }

    const digits = value.replace(/\D/g, '');
    return Array.from(new Set([value, digits].filter(Boolean)));
  }

  private buildChildMessage(task: TaskConfig, run: ActiveRun, isReminder: boolean): string {
    const lines: string[] = [];
    lines.push(isReminder ? `Erinnerung: ${task.message}` : task.message);
    lines.push('');

    const replyLink = this.buildReplyLink(`erledigt #${run.refCode}`);
    if (replyLink) {
      lines.push('✅ Einfach hier tippen und senden:');
      lines.push(replyLink);
      lines.push('');
      lines.push('Alternativ reicht meistens auch einfach: erledigt');
    } else {
      lines.push(`Bitte antworte mit: erledigt #${run.refCode}`);
      lines.push('Alternativ reicht meistens auch einfach: erledigt');
    }

    return lines.join('\n');
  }

  private buildParentMessage(task: TaskConfig, run: ActiveRun, isReminder: boolean): string {
    const lines: string[] = [];
    lines.push(isReminder ? `Erinnerung zur Bestätigung: ${task.title}` : `${task.title} wurde als erledigt gemeldet.`);
    lines.push('');

    const replyLink = this.buildReplyLink(`ja #${run.refCode}`);
    if (replyLink) {
      lines.push('✅ Zum Bestätigen einfach hier tippen und senden:');
      lines.push(replyLink);
      lines.push('');
      lines.push('Alternativ reicht meistens auch einfach: ja');
    } else {
      lines.push(`Bitte bestätigen mit: ja #${run.refCode}`);
      lines.push('Alternativ reicht meistens auch einfach: ja');
    }

    return lines.join('\n');
  }

  private buildReplyLink(replyText: string): string | null {
    const phone = this.cfg.replyLinkPhone?.replace(/\D/g, '') ?? '';
    if (!phone) {
      return null;
    }
    return `https://wa.me/${phone}?text=${encodeURIComponent(replyText)}`;
  }

  private async sendChildReminder(task: TaskConfig, run: ActiveRun): Promise<void> {
    await this.sendWhatsApp(task.childChatId, this.buildChildMessage(task, run, true));
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

  private async sendParentReminder(task: TaskConfig, run: ActiveRun): Promise<void> {
    await this.sendWhatsApp(task.parentChatId, this.buildParentMessage(task, run, true));
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

  private async cancelOpenRun(taskId: string, reason: string): Promise<void> {
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

  private getOpenRunForTask(taskId: string): ActiveRun | undefined {
    return Array.from(this.runs.values()).find(run => run.taskId === taskId);
  }

  private async syncOverviewStates(): Promise<void> {
    const activeRuns = Array.from(this.runs.values()).map(run => ({
      ...run,
      taskTitle: this.tasks.get(run.taskId)?.title ?? run.taskId,
    }));

    await this.setStateChangedAsync('runs.activeJson', { val: JSON.stringify(activeRuns, null, 2), ack: true });
    await this.setStateChangedAsync('runs.historyJson', { val: JSON.stringify(this.history.slice(-this.cfg.historyLimit), null, 2), ack: true });
  }

  private async syncAllTaskStates(): Promise<void> {
    for (const task of this.tasks.values()) {
      await this.syncTaskStates(task.id);
    }
  }

  private async syncTaskStates(taskId: string, completedRun?: ActiveRun): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    const run = this.getOpenRunForTask(taskId);
    const baseId = `tasks.${taskId}.status`;
    const memory = this.taskMemory.get(taskId) ?? {};
    const displayedRun = run ?? completedRun;
    const status: RunStatus | 'idle' = run?.status ?? (completedRun?.status === 'confirmed' ? 'confirmed' : 'idle');

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

  private async sendWhatsApp(to: string, text: string): Promise<void> {
    if (!to) {
      throw new Error('No recipient provided');
    }
    await this.sendToAsync(this.cfg.openWaInstance, 'send', { to, text });
  }

  private createRefCode(task: TaskConfig): string {
    const prefix = task.id.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 10) || 'TASK';
    const suffix = Math.floor(1000 + Math.random() * 9000);
    return `${prefix}-${suffix}`;
  }

  private async writeHistory(entry: HistoryEntry): Promise<void> {
    this.history.push(entry);
    if (this.history.length > this.cfg.historyLimit) {
      this.history = this.history.slice(-this.cfg.historyLimit);
    }
  }

  private async writeLastAction(message: string): Promise<void> {
    await this.setStateChangedAsync('info.lastAction', { val: `${new Date().toISOString()} | ${message}`, ack: true });
  }

  private toLocalDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

if (require.main !== module) {
  module.exports = (options?: Partial<ioBroker.AdapterOptions>) => new ReminderAdapter(options);
} else {
  (() => new ReminderAdapter())();
}
