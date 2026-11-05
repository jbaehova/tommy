import { join } from "node:path";

export function resolvePackageBin(root: string, name: string): string {
  const binDir = join(root, "node_modules", ".bin");

  return join(binDir, name);
}
