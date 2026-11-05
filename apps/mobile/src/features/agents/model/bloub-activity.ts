import { COLOR_BY_ID } from "@norbert_bodziony/bloub";
import { bloubAvatarProfile } from "@tommy/brand/bloub-avatar";
import type { AvatarHue } from "@tommy/contracts/ipc";

export function getBloubAvatarColor(seed: string, hue: AvatarHue | null): string {
  const profile = bloubAvatarProfile(seed, hue);
  return COLOR_BY_ID.get(profile.color)?.hex ?? "#8b5cf6";
}
