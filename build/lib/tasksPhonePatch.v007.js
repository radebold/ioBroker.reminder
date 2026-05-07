"use strict";
const { normalizeAdapterConfig } = require("./config");
const { createMessageFingerprint, extractRefCode, matchesKeyword } = require("./messageParser");
function mapTask(raw = {}, index = 0) {
  const id = String(raw.id || raw.title || `task-${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `task-${index + 1}`;
  const toKeywords = (value, fallback) => {
    const text = value == null ? "" : String(value);
    const list = (text ? text.split(",") : fallback).map(x => String(x).trim().toLowerCase()).filter(Boolean);
    return Array.from(new Set(list));
  };
  const normalizePhone = value => String(value == null ? "" : value).replace(/[^\d+]/g, "");
  return {
    enabled: raw.enabled !== false,
    id,
    title: String(raw.title || `Task ${index + 1}`).trim() || `Task ${index + 1}`,
    message: String(raw.message || `Please complete task ${index + 1}.`).trim() || `Please complete task ${index + 1}.`,
    weekday: Number.isInteger(Number(raw.weekday)) ? Number(raw.weekday) : 1,
    time: String(raw.time || "17:00").trim() || "17:00",
    childReplyId: String(raw.childReplyId || raw.childParticipantId || raw.childChatId || "").trim(),
    parentReplyId: String(raw.parentReplyId || raw.parentParticipantId || raw.parentChatId || "").trim(),
    childSendNumber: normalizePhone(raw.childSendNumber || raw.childPhoneNumber || raw.childPhone || raw.childNumber || raw.childChatId || ""),
    parentSendNumber: normalizePhone(raw.parentSendNumber || raw.parentPhoneNumber || raw.parentPhone || raw.parentNumber || raw.parentChatId || ""),
    childReminderHours: Math.max(1, Number(raw.childReminderHours) || 3),
    parentReminderHours: Math.max(1, Number(raw.parentReminderHours) || 3),
    childKeywords: toKeywords(raw.childKeywords, ["erledigt", "fertig", "done"]),
    parentKeywords: toKeywords(raw.parentKeywords, ["ja", "bestätigt", "bestaetigt", "ok"])
  };
}
function buildRecipientVariants(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  const variants = [];
  const add = v => {
    const txt = String(v || "").trim();
    if (txt && !variants.includes(txt)) variants.push(txt);
  };
  add(raw);
  if (digits) {
    add(digits);
    add(`+${digits}`);
    add(`${digits}@c.us`);
    add(`+${digits}@c.us`);
  }
  return variants;
}
function applyTaskRuntimePatches(adapter) {
  adapter.loadTasksFromConfig = async function () {
    this.cfg = normalizeAdapterConfig(this.config);
    const tasks = Array.isArray(this.cfg.tasks) ? this.cfg.tasks : [];
    this.tasks.clear();
    for (let i = 0; i < tasks.length; i++) {
      const task = mapTask(tasks[i], i);
      this.tasks.set(task.id, task);
      if (!this.taskMemory.has(task.id)) this.taskMemory.set(task.id, {});
      await this.ensureTaskObjects(task);
    }
  };
  adapter.sendWhatsApp = async function (to, text) {
    const variants = buildRecipientVariants(to);
    if (!variants.length) throw new Error("No recipient provided");
    let lastError = null;
    for (const recipient of variants) {
      try {
        this.log.debug(`Trying WhatsApp message to ${recipient}`);
        await this.sendToAsync(this.cfg.openWaInstance, "send", { to: recipient, text });
        this.log.debug(`WhatsApp send accepted for ${recipient}`);
        return;
      } catch (error) {
        lastError = error;
        this.log.warn(`WhatsApp send failed for ${recipient}: ${error && error.message ? error.message : String(error)}`);
      }
    }
    throw lastError || new Error("WhatsApp send failed for all recipient variants");
  };
  adapter.matchesTaskParticipant = function (replyId, message, fallbackPhone) {
    const configuredKeys = new Set();
    const addKey = value => {
      const raw = String(value || "").trim().toLowerCase();
      if (!raw) return;
      configuredKeys.add(raw);
      const digits = raw.replace(/\D/g, "");
      if (digits) configuredKeys.add(digits);
    };
    addKey(replyId);
    addKey(fallbackPhone);
    const raw = message.raw || {};
    const messageKeys = new Set();
    for (const candidate of [message.from, raw.chatId, raw.sender, raw.from, raw.fromId]) {
      const txt = String(candidate || "").trim().toLowerCase();
      if (!txt) continue;
      messageKeys.add(txt);
      const digits = txt.replace(/\D/g, "");
      if (digits) messageKeys.add(digits);
    }
    for (const key of configuredKeys) if (messageKeys.has(key)) return true;
    return false;
  };
  adapter.findMatchingRun = function (message) {
    const refCode = extractRefCode(message.text);
    if (refCode) {
      for (const run of this.runs.values()) if (run.refCode === refCode) return run;
    }
    const childCandidates = Array.from(this.runs.values()).filter(run => {
      const task = this.tasks.get(run.taskId);
      return !!task && run.status === "waiting_child" && this.matchesTaskParticipant(task.childReplyId, message, task.childSendNumber);
    });
    if (childCandidates.length === 1) return childCandidates[0];
    const parentCandidates = Array.from(this.runs.values()).filter(run => {
      const task = this.tasks.get(run.taskId);
      return !!task && run.status === "waiting_parent" && this.matchesTaskParticipant(task.parentReplyId, message, task.parentSendNumber);
    });
    if (parentCandidates.length === 1) return parentCandidates[0];
    return undefined;
  };
  adapter.startRun = async function (task, reason) {
    const existing = this.getOpenRunForTask(task.id);
    if (existing) return;
    const nowIso = new Date().toISOString();
    const today = this.toLocalDateKey(new Date());
    const run = { runId: `${task.id}-${Date.now()}`, taskId: task.id, refCode: this.createRefCode(task), status: "waiting_child", reason, scheduledDate: today, startedAt: nowIso, lastChildSendAt: nowIso, childReminderCount: 0, parentReminderCount: 0 };
    this.runs.set(run.runId, run);
    this.taskMemory.set(task.id, { lastScheduleDate: today });
    try {
      await this.sendWhatsApp(task.childSendNumber, this.buildChildMessage(task, run, false));
    } catch (error) {
      this.runs.delete(run.runId);
      this.taskMemory.set(task.id, {});
      await this.persistData();
      await this.syncOverviewStates();
      await this.syncTaskStates(task.id);
      await this.writeLastAction(`Failed to send child message for ${task.id}: ${error && error.message ? error.message : String(error)}`);
      throw error;
    }
    await this.writeHistory({ timestamp: nowIso, type: "started", taskId: task.id, refCode: run.refCode, status: run.status, details: `${reason} | ${task.time}` });
    await this.writeLastAction(`Task ${task.id} started with ref ${run.refCode}`);
    await this.persistData();
    await this.syncOverviewStates();
    await this.syncTaskStates(task.id);
  };
  adapter.sendChildReminder = async function (task, run) {
    try {
      await this.sendWhatsApp(task.childSendNumber, this.buildChildMessage(task, run, true));
    } catch (error) {
      await this.writeLastAction(`Failed to send child reminder for ${task.id}: ${error && error.message ? error.message : String(error)}`);
      throw error;
    }
    run.lastChildSendAt = new Date().toISOString();
    run.childReminderCount += 1;
    await this.writeHistory({ timestamp: new Date().toISOString(), type: "child_reminder", taskId: task.id, refCode: run.refCode, status: run.status, details: `Count ${run.childReminderCount}` });
    await this.writeLastAction(`Child reminder sent for task ${task.id} (${run.refCode})`);
    await this.persistData();
    await this.syncOverviewStates();
    await this.syncTaskStates(task.id);
  };
  adapter.sendParentReminder = async function (task, run) {
    try {
      await this.sendWhatsApp(task.parentSendNumber, this.buildParentMessage(task, run, true));
    } catch (error) {
      await this.writeLastAction(`Failed to send parent reminder for ${task.id}: ${error && error.message ? error.message : String(error)}`);
      throw error;
    }
    run.lastParentSendAt = new Date().toISOString();
    run.parentReminderCount += 1;
    await this.writeHistory({ timestamp: new Date().toISOString(), type: "parent_reminder", taskId: task.id, refCode: run.refCode, status: run.status, details: `Count ${run.parentReminderCount}` });
    await this.writeLastAction(`Parent reminder sent for task ${task.id} (${run.refCode})`);
    await this.persistData();
    await this.syncOverviewStates();
    await this.syncTaskStates(task.id);
  };
  adapter.tick = async function () {
    const now = new Date();
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;
      if (!task.childSendNumber || !task.parentSendNumber) continue;
      if (this.isDueNow(task, now)) await this.startRun(task, "schedule");
    }
    for (const run of this.runs.values()) {
      const task = this.tasks.get(run.taskId);
      if (!task) continue;
      if (run.status === "waiting_child" && this.shouldSendReminder(run.lastChildSendAt, task.childReminderHours, now)) await this.sendChildReminder(task, run);
      if (run.status === "waiting_parent" && this.shouldSendReminder(run.lastParentSendAt, task.parentReminderHours, now)) await this.sendParentReminder(task, run);
    }
    await this.syncOverviewStates();
    await this.syncAllTaskStates();
  };
  adapter.processIncoming = async function (message, source) {
    const fingerprint = createMessageFingerprint(message);
    if (fingerprint === this.lastMessageFingerprint) return;
    this.lastMessageFingerprint = fingerprint;
    if (typeof this.rememberParticipant === "function") this.rememberParticipant(message);
    if (this.cfg.logIncomingMessages) await this.setStateChangedAsync("info.lastIncoming", { val: JSON.stringify(message.raw || message), ack: true });
    const run = this.findMatchingRun(message);
    if (!run) {
      await this.persistData();
      await this.syncOverviewStates();
      return;
    }
    const task = this.tasks.get(run.taskId);
    if (!task) return;
    if (run.status === "waiting_child" && this.matchesTaskParticipant(task.childReplyId, message, task.childSendNumber) && matchesKeyword(message.text, task.childKeywords)) {
      run.status = "waiting_parent";
      run.childDoneAt = new Date(message.timestamp).toISOString();
      run.lastParentSendAt = new Date().toISOString();
      await this.sendWhatsApp(task.parentSendNumber, this.buildParentMessage(task, run, false));
      await this.writeHistory({ timestamp: new Date().toISOString(), type: "child_done", taskId: task.id, refCode: run.refCode, status: run.status, details: `${source} | ${message.from}` });
      await this.writeLastAction(`Child confirmed task ${task.id} (${run.refCode})`);
      await this.persistData();
      await this.syncOverviewStates();
      await this.syncTaskStates(task.id);
      return;
    }
    if (run.status === "waiting_parent" && this.matchesTaskParticipant(task.parentReplyId, message, task.parentSendNumber) && matchesKeyword(message.text, task.parentKeywords)) {
      run.status = "confirmed";
      run.parentConfirmedAt = new Date(message.timestamp).toISOString();
      await this.sendWhatsApp(task.childSendNumber, `Super, die Aufgabe \"${task.title}\" wurde bestätigt. ✅`);
      await this.writeHistory({ timestamp: new Date().toISOString(), type: "parent_confirmed", taskId: task.id, refCode: run.refCode, status: run.status, details: `${source} | ${message.from}` });
      this.runs.delete(run.runId);
      await this.writeLastAction(`Parent confirmed task ${task.id} (${run.refCode})`);
      await this.persistData();
      await this.syncOverviewStates();
      await this.syncTaskStates(task.id, run);
    }
  };
  return adapter;
}
module.exports = { applyTaskRuntimePatches };
