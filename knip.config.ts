import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // A released Team API protocol keeps its whole frozen codec, including the parts that no current
  // code uses.
  ignoreIssues: {
    "packages/contracts/src/team-protocol/v*.ts": ["exports", "types"],
    "packages/contracts/src/team-protocol/*-v*.ts": ["exports", "types"],
    "packages/contracts/src/team-protocol/provider-aware-codec.ts": ["exports", "types"],
  },
  workspaces: {
    ".": {
      // The electron-vite plugin of knip reads the inputs of electron.vite.config.ts.
      entry: [
        // Each file in scripts/ is a command that package.json, CI or another script runs.
        "scripts/**/*.ts",
        "tools/**/*.ts",
      ],
      project: ["src/**/*.ts", "scripts/**/*.ts", "tools/**/*.ts"],
      ignoreDependencies: [
        // Manual checks of the Telegram Mini App page drive a headless browser with it.
        "playwright-core",
      ],
    },
    "packages/*": {
      project: ["src/**/*.ts"],
    },
  },
};

export default config;
