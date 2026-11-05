// URLs and query strings the Team API client builds.
//
// The `tommy-remote-*` schemes are how a remote host's attachments, agent avatars and server logo
// reach the renderer: the host's own URLs are not reachable from there, so `addRemotePreviewUrls`
// rewrites them in place on a decoded payload before it leaves the main process. `src/main/index.ts`
// registers the matching protocol handlers, and they parse exactly what these three builders emit.

import type { ConversationPageAnchor, DirectConversationPageAnchor } from "@tommy/contracts/ipc";
import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";

export function pageQuery(anchor: ConversationPageAnchor | DirectConversationPageAnchor, limit: number): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (anchor.type === "before") query.set("before", anchor.cursor);
  if (anchor.type === "around") query.set("around", anchor.messageId);
  return `?${query.toString()}`;
}

export function addRemotePreviewUrls<T>(value: T, serverId: string): T {
  if (Array.isArray(value)) {
    for (const item of value) addRemotePreviewUrls(item, serverId);
    return value;
  }
  if (!isDynamicRecord(value)) return value;
  const record = value;
  if ("previewUrl" in record && isString(record.id)) {
    Reflect.set(record, "previewUrl", remoteAttachmentPreviewUrl(serverId, record.id));
  }
  if (isString(record.avatarUrl) && record.avatarUrl.startsWith("tommy-avatar:") && isString(record.id)) {
    Reflect.set(record, "avatarUrl", remoteAgentAvatarUrl(serverId, record.id, record.avatarUrl));
  }
  for (const item of Object.values(record)) addRemotePreviewUrls(item, serverId);
  return value;
}

function remoteAttachmentPreviewUrl(serverId: string, attachmentId: string): string {
  return `tommy-remote-attachment://${encodeURIComponent(serverId)}/${encodeURIComponent(attachmentId)}`;
}

function remoteAgentAvatarUrl(serverId: string, agentId: string, sourceUrl: string): string {
  const source = new URL(sourceUrl);
  const target = new URL(`tommy-remote-avatar://${encodeURIComponent(serverId)}/${encodeURIComponent(agentId)}`);
  target.search = source.search;
  return target.toString();
}

export function remoteServerLogoUrl(serverId: string, version: string): string {
  const target = new URL(`tommy-remote-server-logo://${encodeURIComponent(serverId)}/logo`);
  target.searchParams.set("v", version);
  return target.toString();
}
