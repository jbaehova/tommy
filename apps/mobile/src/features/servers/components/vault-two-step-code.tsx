import type { VaultTwoStepCodes } from "@tommy/contracts/ipc";
import { groupedTwoStepCode } from "@tommy/contracts/two-step-code";
import * as Clipboard from "expo-clipboard";
import { useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useVaultTwoStepCode } from "@/features/servers/model/use-vault-two-step-code";
import { SettingsNote, SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";
import { useAppForeground } from "@/shared/lib/use-app-foreground";
import { Txt } from "@/shared/ui/text";

interface VaultTwoStepCodeProps {
  identity: string;
  itemId: string;
  allowed: boolean;
  load(): Promise<VaultTwoStepCodes>;
}

/** A changed login or session gets new local state before a code can be shown. */
export function VaultTwoStepCode(props: VaultTwoStepCodeProps) {
  return <VaultTwoStepCodeView key={JSON.stringify([props.identity, props.itemId])} {...props} />;
}

/** A saved login's current code. The setup key is never returned to this component. */
function VaultTwoStepCodeView({ identity, itemId, allowed, load }: VaultTwoStepCodeProps) {
  const { t, format } = useText();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [shown, setShown] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyEpoch = useRef(0);
  const active = shown && allowed && focused && foreground;
  const reader = useVaultTwoStepCode({ identity, itemId, active, load });
  useEffect(() => {
    if (!active) return;
    const epoch = ++copyEpoch.current;
    return () => {
      if (copyEpoch.current === epoch) copyEpoch.current += 1;
    };
  }, [active]);
  useEffect(() => {
    if (!focused || !foreground || !allowed) {
      setShown(false);
      setCopyFailed(false);
    }
  }, [allowed, focused, foreground]);

  const copy = async () => {
    const code = reader.currentCode();
    if (!code) return;
    const epoch = copyEpoch.current;
    try {
      const copied = await Clipboard.setStringAsync(code, { android: { isSensitive: true } });
      if (copyEpoch.current !== epoch) return;
      setCopyFailed(!copied);
      if (copied) void haptics.notification("success");
    } catch {
      if (copyEpoch.current === epoch) setCopyFailed(true);
    }
  };

  return (
    <SettingsSection title={t("mobile.server.vault.twoStep.title")}>
      <SettingsRow
        disclosure={false}
        disabled={!allowed}
        expanded={shown}
        onPress={() => {
          setShown((value) => !value);
          setCopyFailed(false);
        }}
      >
        <Txt tone="accent">{t(shown ? "mobile.server.vault.twoStep.hide" : "mobile.server.vault.twoStep.show")}</Txt>
      </SettingsRow>
      {active ? (
        <>
          <SettingsRow
            disclosure={false}
            disabled={!reader.code || reader.remainingMs <= 1_000}
            onPress={() => void copy()}
            accessibilityLabel={t("mobile.server.vault.twoStep.copy")}
            trailing={
              reader.code ? (
                <Txt variant="caption" tone="accent">
                  {t("common.copy")}
                </Txt>
              ) : undefined
            }
          >
            <View className="gap-1">
              <Txt variant="title">
                {reader.code
                  ? groupedTwoStepCode(reader.code)
                  : t(reader.failed ? "mobile.server.vault.twoStep.loadFailed" : "mobile.server.vault.twoStep.loading")}
              </Txt>
              {reader.code ? (
                <Txt variant="caption" tone="muted">
                  {t("mobile.server.vault.twoStep.remaining", {
                    seconds: format.number(Math.ceil(reader.remainingMs / 1_000)),
                  })}
                </Txt>
              ) : null}
            </View>
          </SettingsRow>
          {reader.failed ? (
            <SettingsRow disclosure={false} onPress={reader.retry}>
              <Txt tone="accent">{t("mobile.server.vault.retry")}</Txt>
            </SettingsRow>
          ) : null}
          {reader.failed || copyFailed ? (
            <SettingsNote>
              {t(copyFailed ? "mobile.server.vault.twoStep.copyFailed" : "mobile.server.vault.twoStep.loadFailed")}
            </SettingsNote>
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}
