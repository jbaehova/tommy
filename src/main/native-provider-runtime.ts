import { chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import { sourceText } from "@tommy/i18n/source";
import { Effect } from "effect";
import { parsePiVersion } from "../backend/cli";
import { sha256File } from "../backend/file-hash";
import { assertSafeArchive, extractArchive, rejectNonRegularFiles } from "./provider-runtime-archive";
import type { ProviderRuntimeDescriptor, ProviderStageContext } from "./provider-runtime-descriptors";
import { ProviderRuntimeFailure, runtimeIO } from "./provider-runtime-effects";

/** Native provider archives share staging and verification, not their wire protocols. */
export function nativeProviderRuntime(runtime: "pi"): ProviderRuntimeDescriptor {
  return {
    runtime,
    spec: (target, lock) => {
      const provider = lock[runtime];
      const artifact = provider.artifacts[target];
      return {
        runtime,
        target,
        source: "lock",
        version: provider.version,
        packageVersion: provider.version,
        url: artifact.url,
        archiveDigest: { algorithm: "sha256", hex: artifact.assetSha256 },
        downloadBytes: artifact.downloadBytes,
        installedBytes: artifact.installedBytes,
        executableName: artifact.executable,
      };
    },
    stage: Effect.fn("NativeProvider.stage")(function* ({ spec, downloadedPath, staging }: ProviderStageContext) {
      const message = sourceText("error.provider.nativeArchiveInvalid");
      yield* assertSafeArchive(downloadedPath, ["pi"], message);
      yield* extractArchive(downloadedPath, staging);
      yield* rejectNonRegularFiles(join(staging, "pi"));
      yield* runtimeIO(() => rename(join(staging, "pi"), join(staging, "bin")));
      yield* runtimeIO(() => chmod(join(staging, "bin", spec.executableName), 0o755));
    }),
    verify: Effect.fn("NativeProvider.verify")(function* (root, spec, lock) {
      for (const [path, expected] of Object.entries(lock[runtime].artifacts[spec.target].files)) {
        const actual = yield* sha256File(join(root, path)).pipe(
          Effect.mapError(({ cause }) => new ProviderRuntimeFailure({ cause })),
        );
        if (actual !== expected)
          return yield* new ProviderRuntimeFailure({ cause: new Error(sourceText("error.provider.nativeChecksum")) });
      }
    }),
    parseVersion: parsePiVersion,
  };
}
