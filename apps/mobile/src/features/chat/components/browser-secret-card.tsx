import { INPUT_LIMITS } from "@tommy/contracts/input-limits";
import type { BrowserTakeoverRequest, LocalBrowserSecretResponse } from "@tommy/contracts/ipc";
import { GlassView } from "expo-glass-effect";
import { Button, Spinner, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import ArrowUp from "lucide-react-native/icons/arrow-up";
import Globe from "lucide-react-native/icons/globe";
import KeyRound from "lucide-react-native/icons/key-round";
import X from "lucide-react-native/icons/x";
import { type ReactNode, useRef, useState } from "react";
import { Pressable, TextInput, type TextInputInstance, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { QuestionPromptController } from "@/features/chat/components/use-question-prompt";
import { haptics } from "@/shared/lib/haptics";
import { selectionColorProps } from "@/shared/lib/selection-color";
import { useText } from "@/shared/lib/text";
import { Switch } from "@/shared/ui/switch";

/**
 * The surface of a browser request above the composer: one opaque gray, as the chat scrolls under
 * it, and the neutral action color for the one main action. Cancel is the close button.
 */
function BrowserRequestCard({
  icon,
  title,
  body,
  busy,
  onCancel,
  children,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  busy: boolean;
  onCancel: () => void;
  children: ReactNode;
}) {
  const { t } = useText();
  const muted = useThemeColor("muted");
  const insets = useSafeAreaInsets();
  return (
    <View className="pb-2" style={{ paddingLeft: insets.left + 16, paddingRight: insets.right + 16 }}>
      <View
        className="gap-3 rounded-[26px] bg-control py-3 pr-2 pl-4"
        style={{ borderCurve: "continuous" }}
        accessibilityState={{ busy }}
      >
        <View className="flex-row items-start gap-2">
          <View className="min-w-0 flex-1 gap-0.5 pt-1.5">
            <View className="flex-row items-center gap-2">
              {icon}
              <Typography.Paragraph
                type="body-sm"
                weight="semibold"
                className="min-w-0 flex-1"
                accessibilityRole="header"
              >
                {title}
              </Typography.Paragraph>
            </View>
            <Typography.Paragraph type="body-xs" className="text-muted">
              {body}
            </Typography.Paragraph>
          </View>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            accessibilityLabel={t("common.cancel")}
            isDisabled={busy}
            onPress={onCancel}
          >
            <X color={String(muted)} size={18} />
          </Button>
        </View>
        <View className="gap-2 pr-2">{children}</View>
      </View>
    </View>
  );
}

/** A browser step that the user completes in the browser: Open browser, I'm done, or Cancel. */
export function BrowserTakeoverCard({
  request,
  respondToTakeover,
  openBrowser,
}: {
  request: BrowserTakeoverRequest;
  respondToTakeover: (decision: "complete" | "cancel") => Promise<void>;
  /** Shows the tab live on the phone. Absent when the host cannot stream it. */
  openBrowser?: () => void;
}) {
  const { t } = useText();
  const muted = useThemeColor("muted");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const finish = async (decision: "complete" | "cancel") => {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      await respondToTakeover(decision);
      void haptics.notification("success");
    } catch {
      void haptics.notification("error");
      setError(true);
    } finally {
      setPending(false);
    }
  };
  const reload = request.secret?.requiresReload ? ` ${t("mobile.chat.browserSecret.takeoverReload")}` : "";
  return (
    <BrowserRequestCard
      icon={<Globe color={String(muted)} size={14} strokeWidth={2.2} />}
      title={t("mobile.chat.browserSecret.takeoverTitle")}
      body={
        request.reason === "sign-in-blocked"
          ? t("mobile.chat.browserSecret.signInBlockedBody")
          : `${t("mobile.chat.browserSecret.takeoverBody")}${reload}`
      }
      busy={pending}
      onCancel={() => void finish("cancel")}
    >
      <View className="flex-row gap-2">
        {openBrowser ? (
          <Button
            size="sm"
            className="flex-1 bg-action"
            isDisabled={pending}
            onPress={() => {
              void haptics.impact("soft");
              openBrowser();
            }}
          >
            <Button.Label className="text-action-foreground">{t("mobile.browser.open")}</Button.Label>
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={openBrowser ? "ghost" : "primary"}
          className={openBrowser ? "flex-1" : "flex-1 bg-action"}
          isDisabled={pending}
          onPress={() => void finish("complete")}
        >
          <Button.Label className={openBrowser ? undefined : "text-action-foreground"}>
            {t("mobile.chat.browserSecret.done")}
          </Button.Label>
        </Button>
      </View>
      {error ? (
        <Typography.Paragraph type="body-xs" className="text-danger-text" accessibilityRole="alert">
          {t("mobile.chat.browserSecret.takeoverFailed")}
        </Typography.Paragraph>
      ) : null}
    </BrowserRequestCard>
  );
}

// The composer's bar: its inset, its height and its corner, so the secure field takes its place.
const BAR_INSET = 16;
const BAR_HEIGHT = 48;

/**
 * The form of a password or a code, in the place of the composer, so the screen has one field. A
 * password form can also ask for the account name, and offer the Vault. The values stay in this
 * component: they do not go to the draft, the queue or the chat, and the secret is cleared when sent.
 * The composer comes back when the request is answered or cancelled.
 */
export function BrowserSecretForm({
  request,
  respond,
  bottomInset,
  canSaveToVault,
}: {
  request: BrowserTakeoverRequest;
  respond: (input: LocalBrowserSecretResponse) => Promise<void>;
  bottomInset: number;
  /** The account is an owner or admin of a host with a Vault. */
  canSaveToVault: boolean;
}) {
  const { t } = useText();
  const [muted, foreground, actionForeground] = useThemeColor(["muted", "foreground", "accent-foreground"]);
  const secretField = useRef<TextInputInstance>(null);
  const [value, setValue] = useState("");
  const [username, setUsername] = useState(request.secret?.username ?? "");
  const [save, setSave] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const password = request.secret?.method === "password";
  const asksUsername = password && request.secret?.askUsername === true;
  const digits = request.secret?.digits ?? 6;
  const title = asksUsername
    ? t("mobile.chat.browserSecret.signIn")
    : password
      ? t("mobile.chat.browserSecret.password")
      : request.secret?.method === "authenticator"
        ? t("mobile.chat.browserSecret.authenticatorCode")
        : t("mobile.chat.browserSecret.oneTimeCode");
  const secretLabel = password ? t("mobile.chat.browserSecret.password") : title;
  const ready =
    !pending && (password ? Boolean(value) && (!asksUsername || Boolean(username.trim())) : value.length === digits);
  const send = async (decision: "submit" | "cancel") => {
    if (pending) return;
    setPending(true);
    setError(false);
    const identity = { agentId: request.agentId, requestId: request.requestId };
    const input: LocalBrowserSecretResponse =
      decision === "submit"
        ? {
            ...identity,
            decision,
            secret: value,
            ...(asksUsername ? { username: username.trim() } : {}),
            ...(password && canSaveToVault && save ? { saveToVault: true as const } : {}),
          }
        : { ...identity, decision };
    setValue("");
    try {
      await respond(input);
      void haptics.notification("success");
    } catch {
      void haptics.notification("error");
      setError(true);
    } finally {
      if (input.decision === "submit") input.secret = "";
      setPending(false);
    }
  };
  return (
    // Opaque, as the composer it replaces: the chat does not show between the form and the keyboard.
    <View className="bg-background" style={{ paddingBottom: Math.max(bottomInset, 10) - 8 }}>
      <BrowserRequestCard
        icon={<KeyRound color={String(muted)} size={14} strokeWidth={2.2} />}
        title={title}
        body={t("mobile.chat.browserSecret.submitOnce", {
          origin: (request.secret?.origin ?? "").replace(/^https:\/\//u, ""),
        })}
        busy={pending}
        onCancel={() => void send("cancel")}
      >
        {asksUsername ? (
          <TextInput
            accessibilityLabel={t("mobile.chat.browserSecret.username")}
            placeholder={t("mobile.chat.browserSecret.username")}
            placeholderTextColor={String(muted)}
            {...selectionColorProps(foreground)}
            className="h-11 rounded-2xl bg-background px-4 font-sans text-foreground"
            style={{ borderCurve: "continuous", fontSize: 16 }}
            autoFocus={!username}
            autoCorrect={false}
            autoCapitalize="none"
            autoComplete="off"
            maxLength={512}
            value={username}
            editable={!pending}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => secretField.current?.focus()}
            onChangeText={setUsername}
          />
        ) : null}
        <TextInput
          ref={secretField}
          // The composer's ID: the chat's keyboard gesture follows the one field that is shown.
          nativeID="chat-composer-input"
          accessibilityLabel={secretLabel}
          placeholder={secretLabel}
          placeholderTextColor={String(muted)}
          {...selectionColorProps(foreground)}
          className="h-11 rounded-2xl bg-background px-4 font-sans text-foreground"
          style={{ borderCurve: "continuous", fontSize: 16 }}
          autoFocus={!asksUsername || Boolean(username)}
          secureTextEntry
          autoCorrect={false}
          autoCapitalize="none"
          keyboardType={password ? "default" : "number-pad"}
          autoComplete={password ? "off" : "one-time-code"}
          maxLength={password ? 4096 : digits}
          value={value}
          editable={!pending}
          returnKeyType="send"
          onSubmitEditing={() => {
            if (ready) void send("submit");
          }}
          onChangeText={(text) => setValue(password ? text : text.replace(/[^0-9]/gu, "").slice(0, digits))}
        />
        {password && canSaveToVault ? (
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: save, disabled: pending }}
            disabled={pending}
            className="flex-row items-center justify-between py-1 pl-1"
            onPress={() => setSave((current) => !current)}
          >
            <Typography.Paragraph type="body-sm">{t("mobile.chat.browserSecret.saveToVault")}</Typography.Paragraph>
            <Switch value={save} onValueChange={setSave} disabled={pending} />
          </Pressable>
        ) : null}
        {error ? (
          <Typography.Paragraph type="body-xs" className="text-danger-text" accessibilityRole="alert">
            {t("mobile.chat.browserSecret.submitFailed")}
          </Typography.Paragraph>
        ) : null}
        <Button size="sm" className="bg-action" isDisabled={!ready} onPress={() => void send("submit")}>
          {pending ? (
            <Spinner size="sm" color={String(actionForeground)} />
          ) : (
            <Button.Label className="text-action-foreground">{t("mobile.chat.browserSecret.submit")}</Button.Label>
          )}
        </Button>
      </BrowserRequestCard>
    </View>
  );
}

interface SecureComposerColors {
  bottomInset: number;
  liquidGlassAvailable: boolean;
  fallbackBackground: ViewStyle["backgroundColor"];
  foreground: ViewStyle["backgroundColor"];
  muted: ViewStyle["backgroundColor"];
  action: ViewStyle["backgroundColor"];
  actionForeground: ViewStyle["backgroundColor"];
}

/**
 * The masked field in the place of the composer, with the composer's inset, height and send button,
 * so the screen has one field. Its value is the caller's: it never goes to the draft, the queue or
 * the chat.
 */
function SecureComposerBar({
  label,
  placeholder,
  value,
  onChangeText,
  ready,
  pending,
  onSubmit,
  keyboardType,
  autoComplete,
  maxLength,
  bottomInset,
  liquidGlassAvailable,
  fallbackBackground,
  foreground,
  muted,
  action,
  actionForeground,
}: SecureComposerColors & {
  label: string;
  /** The text of the empty field, when it is not the label. */
  placeholder?: string | undefined;
  value: string;
  onChangeText: (text: string) => void;
  ready: boolean;
  pending: boolean;
  onSubmit: () => void;
  keyboardType: "default" | "number-pad";
  autoComplete: "off" | "one-time-code";
  maxLength: number;
}) {
  const { t } = useText();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingLeft: insets.left + BAR_INSET,
        paddingRight: insets.right + BAR_INSET,
        paddingTop: 8,
        paddingBottom: Math.max(bottomInset, 10),
      }}
    >
      <GlassView
        glassEffectStyle={liquidGlassAvailable ? "regular" : "none"}
        style={{
          backgroundColor: liquidGlassAvailable ? "transparent" : fallbackBackground,
          borderCurve: "continuous",
          borderRadius: BAR_HEIGHT / 2,
          height: BAR_HEIGHT,
          overflow: "hidden",
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 16,
          paddingRight: 4,
        }}
      >
        <TextInput
          // The composer's ID: the chat's keyboard gesture follows the one field that is shown.
          nativeID="chat-composer-input"
          accessibilityLabel={label}
          placeholder={placeholder ?? label}
          placeholderTextColor={String(muted)}
          {...selectionColorProps(foreground)}
          className="min-w-0 flex-1 font-sans text-foreground"
          style={{ fontSize: 16 }}
          secureTextEntry
          autoCorrect={false}
          autoCapitalize="none"
          keyboardType={keyboardType}
          autoComplete={autoComplete}
          maxLength={maxLength}
          value={value}
          editable={!pending}
          returnKeyType="send"
          onSubmitEditing={() => {
            if (ready) onSubmit();
          }}
          onChangeText={onChangeText}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile.chat.browserSecret.submit")}
          accessibilityState={{ disabled: !ready, busy: pending }}
          disabled={!ready}
          className="size-10 items-center justify-center rounded-full"
          style={{ backgroundColor: ready ? action : "transparent" }}
          onPress={onSubmit}
        >
          {pending ? (
            <Spinner size="sm" color={String(foreground)} />
          ) : (
            <ArrowUp color={String(ready ? actionForeground : muted)} size={21} strokeWidth={2.2} />
          )}
        </Pressable>
      </GlassView>
    </View>
  );
}

/**
 * Takes the place of the composer while the open question of a form asks for a private answer, such
 * as an API key, a password or a card number. The question card above keeps the title, Skip and
 * Cancel; this is its one field. The value is cleared when it is sent.
 */
export function QuestionSecretComposer({
  controller,
  ...colors
}: SecureComposerColors & { controller: QuestionPromptController }) {
  const { t } = useText();
  const label = controller.question?.question ?? "";
  const value = controller.draft;
  const ready = !controller.disabled && Boolean(value.trim());
  return (
    <SecureComposerBar
      label={label}
      placeholder={t("mobile.chat.question.privatePlaceholder")}
      value={value}
      onChangeText={controller.setDraft}
      ready={ready}
      pending={controller.pending}
      onSubmit={() => {
        if (ready) controller.answer([value.trim()]);
      }}
      keyboardType="default"
      autoComplete="off"
      maxLength={INPUT_LIMITS.promptAnswerText}
      {...colors}
    />
  );
}
