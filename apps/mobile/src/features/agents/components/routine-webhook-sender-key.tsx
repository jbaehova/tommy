import { useIsFocused } from "expo-router";
import { Typography } from "heroui-native";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useQueryScope } from "@/features/auth/context/mobile-session-context";
import { SettingsRow } from "@/features/settings/components/settings-content";
import { SheetFormField } from "@/shared/components/sheet-form-field";
import { useText } from "@/shared/lib/text";
import { useAppForeground } from "@/shared/lib/use-app-foreground";
import { Press } from "@/shared/ui/press";

/** A signing key stays in this field until its explicit save. Drafts and queries never receive it. */
export function RoutineWebhookSenderKey({
  scopeKey,
  onSave,
  onSaved,
}: {
  scopeKey: string;
  onSave: (secret: string) => Promise<void>;
  onSaved?: (() => void) | undefined;
}) {
  const { t } = useText();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [apiUrl, userId, sessionScope] = useQueryScope();
  const currentScope = JSON.stringify([apiUrl, userId, sessionScope, scopeKey, focused, foreground]);
  const [readyScope, setReadyScope] = useState(currentScope);
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<"saved" | "failed" | null>(null);
  const generation = useRef(0);
  const scope = useRef(currentScope);
  scope.current = currentScope;
  useEffect(() => {
    generation.current += 1;
    setEditing(false);
    setSecret("");
    setPending(false);
    setResult(null);
    setReadyScope(currentScope);
    return () => {
      generation.current += 1;
    };
  }, [currentScope]);

  async function save() {
    const key = secret.trim();
    if (pending || !key || !focused || !foreground || readyScope !== currentScope) return;
    const request = ++generation.current;
    const requestScope = currentScope;
    setSecret("");
    setPending(true);
    setResult(null);
    try {
      await onSave(key);
      if (request !== generation.current || requestScope !== scope.current) return;
      onSaved?.();
      setEditing(false);
      setPending(false);
      setResult("saved");
    } catch {
      if (request !== generation.current || requestScope !== scope.current) return;
      // Only fixed text is shown. A rejected response must not echo the entered key.
      setPending(false);
      setResult("failed");
    }
  }

  if (!focused || !foreground || readyScope !== currentScope) return null;
  return (
    <>
      {editing ? (
        <View className="gap-3 px-4 py-3">
          <SheetFormField
            appearance="soft"
            label={t("mobile.agent.webhook.senderKey.label")}
            hint={t("mobile.agent.webhook.senderKey.hint")}
            value={secret}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            maxLength={1_024}
            editable={!pending}
            onChangeText={(value) => {
              setSecret(value);
              setResult(null);
            }}
          />
          <View className="flex-row gap-4">
            <Press
              accessibilityRole="button"
              disabled={pending || !secret.trim()}
              onPress={() => void save()}
              className="py-2"
            >
              <Typography.Paragraph
                className={pending || !secret.trim() ? "text-grouped-secondary" : "text-accent-text"}
              >
                {t(pending ? "common.saving" : "common.save")}
              </Typography.Paragraph>
            </Press>
            <Press
              accessibilityRole="button"
              disabled={pending}
              onPress={() => {
                generation.current += 1;
                setSecret("");
                setEditing(false);
                setResult(null);
              }}
              className="py-2"
            >
              <Typography.Paragraph className="text-grouped-secondary">{t("common.cancel")}</Typography.Paragraph>
            </Press>
          </View>
        </View>
      ) : (
        <SettingsRow
          disclosure={false}
          onPress={() => {
            setEditing(true);
            setResult(null);
          }}
        >
          <Typography.Paragraph className="text-accent-text">
            {t("mobile.agent.webhook.senderKey.open")}
          </Typography.Paragraph>
        </SettingsRow>
      )}
      {result ? (
        <View className="px-4 py-2">
          <Typography.Paragraph
            accessibilityRole={result === "failed" ? "alert" : undefined}
            type="body-xs"
            className={result === "failed" ? "text-danger-text" : "text-grouped-secondary"}
          >
            {t(result === "failed" ? "mobile.agent.webhook.senderKey.failed" : "mobile.agent.webhook.senderKey.saved")}
          </Typography.Paragraph>
        </View>
      ) : null}
    </>
  );
}
