"use strict";
const createBase = require("./main");
const { applyTaskRuntimePatches } = require("./lib/tasksPhonePatch.v007");
const { applyUiStatusPatches } = require("./lib/uiStatusPatch.v007");
module.exports = options => {
  const adapter = createBase(options);
  adapter.systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "system";
  applyTaskRuntimePatches(adapter);
  applyUiStatusPatches(adapter);
  adapter.on("message", async obj => {
    if (!obj) {
      return;
    }
    if (obj.command === "resetTask") {
      const taskId = String(obj.message && obj.message.taskId || "").trim();
      if (!taskId) {
        return;
      }
      if (typeof adapter.cancelOpenRun === "function") {
        await adapter.cancelOpenRun(taskId, "admin reset button");
      }
      if (obj.callback) {
        adapter.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
      }
    }
  });
  return adapter;
};
if (require.main === module) {
  (() => module.exports())();
}
