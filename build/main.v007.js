"use strict";
const createBase = require("./main");
const { applyTaskRuntimePatches } = require("./lib/tasksPhonePatch.v007");
const { applyUiStatusPatches } = require("./lib/uiStatusPatch.v007");
module.exports = options => {
  const adapter = createBase(options);
  adapter.systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "system";
  applyTaskRuntimePatches(adapter);
  applyUiStatusPatches(adapter);
  return adapter;
};
if (require.main === module) {
  (() => module.exports())();
}
