const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");

// Android notifications come through Firebase Cloud Messaging, which needs the Firebase file of the
// app. The root .env holds its values, and this config writes the file into the ignored .expo folder.
// With no values, the app builds and gets no notifications on Android. Variables that the shell or CI
// sets replace the values in .env.
const ROOT_ENV_FILE = join(__dirname, "../../.env");
const GOOGLE_SERVICES_FILE = "./.expo/google-services.json";
const FIREBASE_VARIABLES = [
  "FIREBASE_ANDROID_API_KEY",
  "FIREBASE_ANDROID_APP_ID",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_PROJECT_NUMBER",
  "FIREBASE_STORAGE_BUCKET",
];

if (existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);

/** @param {string} packageName */
function writeGoogleServicesFile(packageName) {
  const path = join(__dirname, GOOGLE_SERVICES_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const content = {
    project_info: {
      project_number: process.env.FIREBASE_PROJECT_NUMBER,
      project_id: process.env.FIREBASE_PROJECT_ID,
      storage_bucket: process.env.FIREBASE_STORAGE_BUCKET,
    },
    client: [
      {
        client_info: {
          mobilesdk_app_id: process.env.FIREBASE_ANDROID_APP_ID,
          android_client_info: { package_name: packageName },
        },
        oauth_client: [],
        api_key: [{ current_key: process.env.FIREBASE_ANDROID_API_KEY }],
        services: { appinvite_service: { other_platform_oauth_client: [] } },
      },
    ],
    configuration_version: "1",
  };
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
}

/** @param {{ config: import('expo/config').ExpoConfig }} context */
module.exports = ({ config: baseConfig }) => {
  // The phone only accepts an update that has the key of the installed app. `expo prebuild` makes a
  // new key each time, so the root .env names the file to keep, outside the repository. A leading
  // `~/` is the home folder, so one .env works on each computer of the same user.
  const keystore = process.env.TOMMY_ANDROID_KEYSTORE?.replace(/^~(?=\/)/u, homedir());
  const signed = keystore
    ? { ...baseConfig, plugins: [...(baseConfig.plugins ?? []), ["./plugins/with-android-keystore", keystore]] }
    : baseConfig;
  // A release build numbers its version code from the release version, so Android accepts it as
  // an update of an older release.
  const versionCode = Number(process.env.TOMMY_ANDROID_VERSION_CODE);
  const config =
    Number.isInteger(versionCode) && versionCode > 0
      ? { ...signed, android: { ...signed.android, versionCode } }
      : signed;
  const missing = FIREBASE_VARIABLES.filter((name) => !process.env[name]);
  if (missing.length === FIREBASE_VARIABLES.length) return config;
  if (missing.length > 0) throw new Error(`Set ${missing.join(", ")} in the root .env file.`);
  writeGoogleServicesFile(config.android.package);
  return { ...config, android: { ...config.android, googleServicesFile: GOOGLE_SERVICES_FILE } };
};
