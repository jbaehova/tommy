/** Brand marks for integrations. The file imports only plain paths, so the public site can use it without the shared UI root. */

import { DISCORD_MARK_PATH, GITHUB_MARK_PATH } from "@tommy/brand/connector-mark-shape";

/** GitHub's mark. Lucide has no brand icons, so the path is GitHub's own. */
export function GitHubMark(props: { class?: string | undefined }) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={GITHUB_MARK_PATH} />
    </svg>
  );
}

/** Discord's mark, for the same reason. */
export function DiscordMark(props: { class?: string | undefined }) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={DISCORD_MARK_PATH} />
    </svg>
  );
}
