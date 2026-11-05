const { copyFileSync } = require("node:fs");
const { join } = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

/** Puts the kept signing key where the generated Android project looks for it. */
module.exports = (config, keystore) =>
  withDangerousMod(config, [
    "android",
    (modConfig) => {
      copyFileSync(keystore, join(modConfig.modRequest.platformProjectRoot, "app", "debug.keystore"));
      return modConfig;
    },
  ]);
