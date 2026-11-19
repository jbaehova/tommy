import type { KnipConfig } from "knip";

// Stylesheets load packages with `@import`. Knip reads only script files, so this turns each
// `@import "<package>"` into a script import that it can follow.
const CSS_IMPORT = /@import\s+["']([^"']+)["']/g;

function compileCss(text: string): string {
  return [...text.matchAll(CSS_IMPORT)].map(([, specifier]) => `import "${specifier}";`).join("\n");
}

const config: KnipConfig = {
  compilers: { css: compileCss },
  // A released Team API protocol keeps its whole frozen codec, including the parts that no current
  // code uses (packages/contracts/AGENTS.md).
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
      project: ["src/**/*.{ts,tsx,css}", "scripts/**/*.ts", "tools/**/*.ts"],
      ignoreDependencies: [
        // Manual checks of the Telegram Mini App page drive a headless browser with it.
        "playwright-core",
      ],
    },
    "packages/*": {
      project: ["src/**/*.{ts,tsx,css}"],
    },
  },
};

export default config;
