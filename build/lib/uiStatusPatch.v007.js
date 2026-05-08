"use strict";
function formatLocalDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("de-DE", { hour12: false, timeZoneName: "short" });
}
function shortDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short"
  });
}
function compactStatusLabel(status) {
  if (status === "waiting_child") return "wartet auf Kind";
  if (status === "waiting_parent") return "wartet auf Papa";
  if (status === "confirmed") return "bestätigt";
  if (status === "idle") return "kein aktiver Lauf";
  return status || "kein aktiver Lauf";
}
function applyUiStatusPatches(adapter) {
  const originalEnsureStaticStates = adapter.ensureStaticStates?.bind(adapter);
  adapter.ensureStaticStates = async function () {
    if (originalEnsureStaticStates) await originalEnsureStaticStates();
    for (const [id, common] of [
      ["info.systemTimeZone", { name: "System time zone", type: "string", role: "text", read: true, write: false, def: this.systemTimeZone }],
      ["info.knownParticipantsJson", { name: "Known participants as JSON", type: "string", role: "json", read: true, write: false, def: "[]" }]
    ]) {
      await this.extendObject(id, { type: "state", common, native: {} });
    }
  };
  adapter.syncOverviewStates = async function () {
    const activeRuns = Array.from(this.runs.values()).map(run => ({ ...run, taskTitle: this.tasks.get(run.taskId)?.title || run.taskId, startedAtLocal: formatLocalDateTime(run.startedAt), childDoneAtLocal: formatLocalDateTime(run.childDoneAt), parentConfirmedAtLocal: formatLocalDateTime(run.parentConfirmedAt) }));
    const history = this.history.slice(-this.cfg.historyLimit).map(entry => ({ ...entry, timestampLocal: formatLocalDateTime(entry.timestamp) }));
    const knownParticipants = Array.from(this.knownParticipants.values()).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    await this.setStateChangedAsync("runs.activeJson", { val: JSON.stringify(activeRuns, null, 2), ack: true });
    await this.setStateChangedAsync("runs.historyJson", { val: JSON.stringify(history, null, 2), ack: true });
    await this.setStateChangedAsync("info.knownParticipantsJson", { val: JSON.stringify(knownParticipants, null, 2), ack: true });
    await this.setStateChangedAsync("info.systemTimeZone", { val: this.systemTimeZone, ack: true });
  };
  adapter.syncTaskStates = async function (taskId, completedRun) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const run = this.getOpenRunForTask(taskId);
    const baseId = `tasks.${taskId}.status`;
    const memory = this.taskMemory.get(taskId) || {};
    const displayedRun = run || completedRun;
    const status = run ? run.status : displayedRun && displayedRun.status === "confirmed" ? "confirmed" : "idle";
    await this.setStateChangedAsync(`${baseId}.state`, { val: status, ack: true });
    await this.setStateChangedAsync(`${baseId}.refCode`, { val: displayedRun ? displayedRun.refCode : "", ack: true });
    await this.setStateChangedAsync(`${baseId}.startedAt`, { val: formatLocalDateTime(displayedRun && displayedRun.startedAt), ack: true });
    await this.setStateChangedAsync(`${baseId}.childDoneAt`, { val: formatLocalDateTime(displayedRun && displayedRun.childDoneAt), ack: true });
    await this.setStateChangedAsync(`${baseId}.parentConfirmedAt`, { val: formatLocalDateTime(displayedRun && displayedRun.parentConfirmedAt), ack: true });
    await this.setStateChangedAsync(`${baseId}.childReminderCount`, { val: displayedRun ? displayedRun.childReminderCount || 0 : 0, ack: true });
    await this.setStateChangedAsync(`${baseId}.parentReminderCount`, { val: displayedRun ? displayedRun.parentReminderCount || 0 : 0, ack: true });
    await this.setStateChangedAsync(`${baseId}.lastScheduleDate`, { val: memory.lastScheduleDate || "", ack: true });
    const schedule = typeof this.getScheduleSummary === "function" ? this.getScheduleSummary(task) : (task.time || "-");
    const summary = run
      ? `${task.title} · aktiver Lauf: Ja · ${compactStatusLabel(run.status)} · ${schedule} · Ref ${run.refCode}`
      : displayedRun && displayedRun.status === "confirmed"
        ? `${task.title} · aktiver Lauf: Nein · bestätigt · ${schedule}`
        : `${task.title} · aktiver Lauf: Nein · kein aktiver Lauf · ${schedule}`;
    await this.setStateChangedAsync(`${baseId}.summary`, { val: summary, ack: true });
  };
  adapter.writeLastAction = async function (message) {
    await this.setStateChangedAsync("info.lastAction", { val: `${formatLocalDateTime(new Date().toISOString())} | ${message}`, ack: true });
  };
  adapter.getStatusOverview = function () {
    if (!this.tasks.size) return { text: "Keine Aufgaben konfiguriert.", style: { whiteSpace: "pre-wrap" } };
    const lines = [];
    for (const task of this.tasks.values()) {
      const run = this.getOpenRunForTask(task.id);
      const schedule = typeof this.getScheduleSummary === "function" ? this.getScheduleSummary(task) : (task.time || "-");
      if (run) {
        lines.push(`${task.title} [${task.id}]`);
        lines.push(`Aktiver Lauf: Ja`);
        lines.push(`Status: ${compactStatusLabel(run.status)}`);
        lines.push(`Zeitplan: ${schedule}`);
        lines.push(`Referenz: ${run.refCode}`);
      } else {
        lines.push(`${task.title} [${task.id}]`);
        lines.push(`Aktiver Lauf: Nein`);
        lines.push(`Status: kein aktiver Lauf`);
        lines.push(`Zeitplan: ${schedule}`);
      }
      lines.push("");
    }
    return { text: lines.join("\n").trim(), style: { whiteSpace: "pre-wrap" } };
  };
  adapter.getHistoryOverview = function () {
    const history = Array.isArray(this.history) ? this.history.slice(-6).reverse() : [];
    if (!history.length) {
      return { text: "Noch keine Aktionen.", style: { whiteSpace: "pre-wrap" } };
    }
    const mapType = {
      started: "gestartet",
      child_done: "Kind erledigt",
      parent_confirmed: "Papa bestätigt",
      cancelled: "reset/abgebrochen",
      child_reminder: "Erinnerung Kind",
      parent_reminder: "Erinnerung Papa"
    };
    const lines = history.map(entry => `${shortDateTime(entry.timestamp)} · ${mapType[entry.type] || entry.type} · ${entry.taskId}${entry.refCode ? ` · ${entry.refCode}` : ""}`);
    return { text: lines.join("\n"), style: { whiteSpace: "pre-wrap" } };
  };
  adapter.on("message", obj => {
    if (!obj || !obj.callback) return;
    if (obj.command === "statusOverview") {
      adapter.sendTo(obj.from, obj.command, adapter.getStatusOverview(), obj.callback);
      return;
    }
    if (obj.command === "historyOverview") {
      adapter.sendTo(obj.from, obj.command, adapter.getHistoryOverview(), obj.callback);
    }
  });
  return adapter;
}
module.exports = { applyUiStatusPatches, formatLocalDateTime };
