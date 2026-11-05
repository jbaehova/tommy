// Expo SDK 58 changed the default fingerprint preset to `balanced`, which hashes a native package in
// node_modules by its name and version only. `strict` hashes its native files, as SDK 57 did, so a
// patch in the root `patches/` folder that changes native code also changes `runtimeVersion`.
//
// `pod install` downloads sherpa-onnx into `modules/speech/ios/vendor/`, after EAS has already hashed the
// project, so the build would hash a different tree. The podspec pins the archive's SHA-256 and is hashed.
/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  preset: "strict",
  ignorePaths: ["modules/speech/ios/vendor/**/*"],
};
