const { copyFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { basename, join, parse, resolve } = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

// Adds the notification sounds to the app. The Android resources reject the `-` in the file names, so
// Android gets copies with `_` in place of `-`. `TommyMessagingService.kt` and the notification
// channels (`android-notification-channels.ts`) use those names.

/** @type {import('expo/config-plugins').ConfigPlugin<{ sounds: string[] }>} */
module.exports = (config, { sounds }) => {
  return withDangerousMod(config, [
    "android",
    (config) => {
      const { projectRoot, platformProjectRoot } = config.modRequest;
      const raw = join(platformProjectRoot, "app", "src", "main", "res", "raw");
      mkdirSync(raw, { recursive: true });
      const resources = [];
      for (const sound of sounds) {
        const { name, ext } = parse(basename(sound));
        const resource = name.replaceAll("-", "_");
        copyFileSync(resolve(projectRoot, sound), join(raw, `${resource}${ext}`));
        resources.push(`@raw/${resource}`);
      }
      // The app finds a sound by its name only, so the resource shrinker of a release build removed
      // the files, and each channel got the Android notification sound.
      writeFileSync(
        join(raw, "keep_tommy_notification_sounds.xml"),
        `<?xml version="1.0" encoding="utf-8"?>\n<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="${resources.join(",")}" />\n`,
      );
      return config;
    },
  ]);
};
