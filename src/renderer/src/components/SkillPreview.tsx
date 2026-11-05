import type { ComponentProps } from "@solidjs/web";
import { SkillPreview as SharedSkillPreview } from "@tommy/ui/components/SkillPreview";
import { appPort } from "../app-port";

export function SkillPreview(props: Omit<ComponentProps<typeof SharedSkillPreview>, "onOpenUrl">) {
  return <SharedSkillPreview {...props} onOpenUrl={(url) => appPort().openUrl(url)} />;
}
