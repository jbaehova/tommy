import { canAdministerServer, type StoredFileRow } from "@tommy/contracts/ipc";
import { MOBILE_ATTACHMENT_BYTES } from "@tommy/team-client/remote-peer";
import { Directory } from "expo-file-system";
import { Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { Button, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import Check from "lucide-react-native/icons/check";
import { useEffect, useRef, useState } from "react";
import { Alert, FlatList, View } from "react-native";
import { useUniwind } from "uniwind";
import { StoredFile } from "@/features/agents/components/agent-files";
import { useQueryScope } from "@/features/auth/context/mobile-session-context";
import { downloadLibraryFiles } from "@/features/servers/model/library-download";
import { useServerStorage } from "@/features/servers/model/use-server-storage";
import {
  SettingsContent,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/settings-content";
import { SettingsPicker } from "@/features/settings/components/settings-controls";
import {
  useMobileWorkspace,
  useMobileWorkspaceActions,
  useMobileWorkspaceReader,
} from "@/features/workspace/context/mobile-workspace-context";
import { SoftPressable } from "@/shared/components/soft-pressable";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";

const FILTERS = ["all", "images", "videos", "audio", "documents", "other"] as const;
type LibraryFilter = (typeof FILTERS)[number];
const FILTER_KEYS = {
  all: "mobile.server.library.filter.all",
  images: "mobile.server.library.filter.images",
  videos: "mobile.server.library.filter.videos",
  audio: "mobile.server.library.filter.audio",
  documents: "mobile.server.library.filter.documents",
  other: "mobile.server.library.filter.other",
} as const;

function fileFilter(file: StoredFileRow): Exclude<LibraryFilter, "all"> {
  if (file.mimeType.startsWith("image/")) return "images";
  if (file.mimeType.startsWith("video/")) return "videos";
  if (file.mimeType.startsWith("audio/")) return "audio";
  if (
    file.mimeType.startsWith("text/") ||
    file.mimeType === "application/pdf" ||
    /\.(?:docx?|xlsx?|pptx?|odt|ods|rtf|csv|json|md)$/iu.test(file.name)
  )
    return "documents";
  return "other";
}

/** A host-wide Library uses the same permission-filtered, bounded scan as Storage. */
export function ServerLibraryScreen() {
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const scope = useQueryScope();
  const { servers } = useMobileWorkspace();
  const server = servers.find((item) => item.id === serverId);
  return (
    <Library key={JSON.stringify([scope, serverId, server?.membershipId, server?.publicKey])} serverId={serverId} />
  );
}

function Library({ serverId }: { serverId: string }) {
  const { t, format, errorMessage } = useText();
  const { theme } = useUniwind();
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const { servers, agents } = useMobileWorkspace();
  const actions = useMobileWorkspaceActions();
  const workspace = useMobileWorkspaceReader();
  const server = servers.find((item) => item.id === serverId);
  const { available, query, rescan } = useServerStorage(serverId);
  const focused = useIsFocused();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failures, setFailures] = useState(0);
  const generation = useRef(0);
  const focus = useRef(focused);
  focus.current = focused;
  const online = server?.state === "online";
  const canDelete = Boolean(server && canAdministerServer(server.role));
  const access = `${available}:${online}:${canDelete}`;
  const previousAccess = useRef(access);
  useEffect(() => {
    if (previousAccess.current === access)
      return () => {
        generation.current += 1;
      };
    previousAccess.current = access;
    generation.current += 1;
    setSelected(new Set());
    setSelecting(false);
    setBusy(false);
    setProgress(0);
    setFailures(0);
    return () => {
      generation.current += 1;
    };
  }, [access]);
  useEffect(() => {
    if (focused) return;
    generation.current += 1;
    setBusy(false);
  }, [focused]);

  const words = search.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const files = (query.data?.files ?? [])
    .filter((file) => {
      if (filter !== "all" && fileFilter(file) !== filter) return false;
      const agent = agents.find((item) => item.serverId === serverId && item.id === file.agentId);
      const text = `${file.name} ${agent?.name ?? ""} ${file.conversation?.title ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const picked = files.filter((file) => selected.has(file.id));
  const allSelected = files.length > 0 && picked.length === files.length;

  function permitted(request: number, remove = false): boolean {
    if (generation.current !== request || !focus.current) return false;
    const current = workspace();
    const host = current.servers.find((item) => item.id === serverId);
    return Boolean(
      host?.state === "online" && current.canReadServerStorage(serverId) && (!remove || canAdministerServer(host.role)),
    );
  }

  function complete(fileId: string): void {
    setSelected((current) => new Set([...current].filter((id) => id !== fileId)));
    setProgress((current) => current + 1);
  }

  function cancel(): void {
    generation.current += 1;
    setBusy(false);
  }

  async function download(): Promise<void> {
    if (
      busy ||
      picked.length === 0 ||
      picked.some((file) => file.status === "missing" || file.size > MOBILE_ATTACHMENT_BYTES)
    )
      return;
    const request = ++generation.current;
    const selectedFiles = [...picked];
    setBusy(true);
    setProgress(0);
    setFailures(0);
    try {
      const directory = await Directory.pickDirectoryAsync();
      if (!permitted(request)) return;
      const failed = await downloadLibraryFiles(
        directory,
        selectedFiles,
        (fileId) => actions.downloadAttachment(serverId, fileId),
        () => permitted(request),
        complete,
      );
      if (permitted(request)) setFailures(failed);
    } catch (error) {
      if (permitted(request) && !(error instanceof Error && "code" in error && error.code === "ERR_PICKER_CANCELLED"))
        setFailures(selectedFiles.length);
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }

  function confirmDelete(): void {
    if (busy || picked.length === 0 || !canDelete || picked.some((file) => !file.deletable)) return;
    const selectedFiles = [...picked];
    const confirmation = generation.current;
    Alert.alert(
      t("mobile.server.library.deleteTitle", { count: selectedFiles.length }),
      t("mobile.server.library.deleteBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.delete"),
          style: "destructive",
          onPress: () => {
            if (permitted(confirmation, true)) void remove(selectedFiles);
          },
        },
      ],
    );
  }

  async function remove(selectedFiles: readonly StoredFileRow[]): Promise<void> {
    const request = ++generation.current;
    let failed = 0;
    setBusy(true);
    setProgress(0);
    setFailures(0);
    try {
      for (const file of selectedFiles) {
        if (!permitted(request, true)) break;
        try {
          await actions.deleteStoredFile(file.id, serverId);
          if (permitted(request, true)) complete(file.id);
        } catch {
          failed += 1;
        }
      }
      if (permitted(request, true)) {
        setFailures(failed);
        void haptics.notification(failed ? "error" : "success");
        await rescan();
      }
    } catch {
      if (permitted(request, true)) setFailures(Math.max(1, failed));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }

  if (!server || !available)
    return (
      <SettingsContent>
        <SettingsNote>
          {t(server ? "mobile.workspace.error.filesUnsupported" : "mobile.server.unavailable")}
        </SettingsNote>
      </SettingsContent>
    );

  const header = (
    <View className="gap-3 px-4 pb-3 pt-2">
      <SettingsSection>
        <SettingsRow
          disclosure={false}
          trailing={
            <SettingsPicker
              value={filter}
              options={FILTERS.map((value) => ({ value, label: t(FILTER_KEYS[value]) }))}
              enabled={!busy}
              dark={theme === "dark"}
              label={t("mobile.server.library.filter")}
              onChange={setFilter}
            />
          }
        >
          <Typography.Paragraph>{t("mobile.server.library.filter")}</Typography.Paragraph>
        </SettingsRow>
      </SettingsSection>
      <View className="flex-row flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          isDisabled={busy || !online}
          onPress={() => {
            setSelecting((value) => !value);
            setSelected(new Set());
            setFailures(0);
          }}
        >
          <Button.Label>{t(selecting ? "common.cancel" : "mobile.server.library.select")}</Button.Label>
        </Button>
        {selecting ? (
          <Button
            size="sm"
            variant="ghost"
            isDisabled={busy || files.length === 0}
            onPress={() => setSelected(allSelected ? new Set() : new Set(files.map((file) => file.id)))}
          >
            <Button.Label>
              {t(allSelected ? "mobile.server.library.clearSelection" : "mobile.server.library.selectAll")}
            </Button.Label>
          </Button>
        ) : null}
      </View>
      {selecting ? (
        <View className="gap-2">
          <Typography.Paragraph>{t("mobile.server.library.selected", { count: picked.length })}</Typography.Paragraph>
          <View className="flex-row flex-wrap gap-2">
            <Button
              size="sm"
              isDisabled={
                busy ||
                !online ||
                picked.length === 0 ||
                picked.some((file) => file.status === "missing" || file.size > MOBILE_ATTACHMENT_BYTES)
              }
              onPress={() => void download()}
            >
              <Button.Label>{t("mobile.server.library.download")}</Button.Label>
            </Button>
            {canDelete ? (
              <Button
                size="sm"
                variant="ghost"
                isDisabled={busy || !online || picked.length === 0 || picked.some((file) => !file.deletable)}
                onPress={confirmDelete}
              >
                <Button.Label>{t("common.delete")}</Button.Label>
              </Button>
            ) : null}
            {busy ? (
              <Button size="sm" variant="ghost" onPress={cancel}>
                <Button.Label>{t("common.cancel")}</Button.Label>
              </Button>
            ) : null}
          </View>
          {busy ? <SettingsNote>{t("mobile.server.library.progress", { count: progress })}</SettingsNote> : null}
          {picked.some((file) => file.size > MOBILE_ATTACHMENT_BYTES) ? (
            <SettingsNote>{t("mobile.chat.attachment.tooLargeForMobile")}</SettingsNote>
          ) : null}
        </View>
      ) : null}
      {failures > 0 ? <SettingsNote>{t("mobile.server.library.failed", { count: failures })}</SettingsNote> : null}
      {!online ? <SettingsNote>{t("mobile.agent.info.usage.reconnect")}</SettingsNote> : null}
      {query.isError ? (
        <SettingsNote>{errorMessage(query.error, t("mobile.server.storage.loadFailed"))}</SettingsNote>
      ) : null}
      {query.data?.truncated ? <SettingsNote>{t("mobile.agent.files.truncated")}</SettingsNote> : null}
    </View>
  );

  return (
    <View className="flex-1 bg-sheet">
      <Stack.SearchBar
        placeholder={t("mobile.server.library.search")}
        autoCapitalize="none"
        hideWhenScrolling={false}
        hideNavigationBar={false}
        {...{ headerIconColor: String(foreground), textColor: String(foreground), hintTextColor: String(muted) }}
        onChangeText={(event) => {
          if (!busy) setSearch(event.nativeEvent.text);
        }}
        onCancelButtonPress={() => {
          if (!busy) setSearch("");
        }}
        onClose={() => {
          if (!busy) setSearch("");
        }}
      />
      <FlatList
        data={files}
        keyExtractor={(file) => file.id}
        ListHeaderComponent={header}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshing={query.isFetching}
        onRefresh={() => {
          if (!busy && online) void rescan().catch(() => undefined);
        }}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item: file }) =>
          selecting ? (
            <View className="mx-4 bg-grouped">
              <SoftPressable
                accessibilityRole="checkbox"
                accessibilityLabel={file.name}
                accessibilityState={{ checked: selected.has(file.id), disabled: busy || !online }}
                disabled={busy || !online}
                className="min-h-[46px] px-3.5 py-2"
                onPress={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(file.id)) next.delete(file.id);
                    else next.add(file.id);
                    return next;
                  })
                }
              >
                <View className="flex-row items-center gap-3">
                  <View className="min-w-0 flex-1">
                    <Typography.Paragraph numberOfLines={2}>{file.name}</Typography.Paragraph>
                    <Typography.Paragraph className="text-grouped-secondary">
                      {format.fileSize(file.size)}
                    </Typography.Paragraph>
                  </View>
                  {selected.has(file.id) ? <Check size={18} color={String(foreground)} /> : null}
                </View>
              </SoftPressable>
            </View>
          ) : (
            <View className="mx-4 bg-grouped">
              {file.agentId ? (
                <Typography.Paragraph className="px-3.5 pt-2 text-grouped-secondary" numberOfLines={1}>
                  {agents.find((agent) => agent.serverId === serverId && agent.id === file.agentId)?.name ??
                    t("mobile.server.storage.removedAgent")}
                </Typography.Paragraph>
              ) : null}
              <StoredFile
                serverId={serverId}
                file={file}
                canDelete={online && canDelete && file.deletable}
                onChanged={() => void rescan().catch(() => undefined)}
              />
            </View>
          )
        }
        ListEmptyComponent={
          <View className="px-4">
            <SettingsNote>
              {t(
                query.isPending
                  ? "mobile.server.storage.measuring"
                  : search || filter !== "all"
                    ? "mobile.server.library.noMatches"
                    : "mobile.server.storage.noFiles",
              )}
            </SettingsNote>
          </View>
        }
      />
    </View>
  );
}
