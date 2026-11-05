import { parseDirectPairingLink } from "@tommy/contracts/direct-connection";
import { router } from "expo-router";
import { Button } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { useState } from "react";
import { TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import { pairMobileDevice } from "@/features/auth/api/mobile-auth";
import { AppLogo } from "@/features/auth/components/app-logo";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { takePendingPairingLink } from "@/features/links/model/incoming-links";
import { APP_FONT } from "@/shared/lib/app-font";
import { useText } from "@/shared/lib/text";
import { Txt } from "@/shared/ui/text";

/** Pairs this phone with its one server: a QR code of `tommy pair`, or its address and code. */
export function SignInScreen() {
  const { t, errorMessage } = useText();
  const insets = useSafeAreaInsets();
  const { connect } = useMobileSession();
  const [link] = useState(() => {
    const pending = takePendingPairingLink();
    return pending ? parseDirectPairingLink(pending) : null;
  });
  const [address, setAddress] = useState(link?.url ?? "");
  const [code, setCode] = useState(link?.code ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, muted] = useThemeColor(["foreground", "muted"]);
  const field = String(useCSSVariable("--tommy-bg-grouped"));
  const inputStyle = {
    backgroundColor: field,
    borderRadius: 12,
    color: text,
    fontFamily: APP_FONT,
    fontSize: 14,
    height: 46,
    paddingHorizontal: 14,
  };

  async function pair() {
    setBusy(true);
    setError(null);
    try {
      connect(await pairMobileDevice(address, code));
    } catch (cause) {
      setError(errorMessage(cause, t("mobile.auth.pair.unreachable")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View
      className="flex-1 justify-center gap-2 bg-background"
      style={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 24 }}
    >
      <View className="items-center gap-4 pb-6">
        <AppLogo size={68} />
        <View className="items-center gap-1.5">
          <Txt variant="title">{t("mobile.auth.pair.title")}</Txt>
          <Txt variant="sub" tone="muted" style={{ textAlign: "center" }}>
            {t("mobile.auth.pair.description")}
          </Txt>
        </View>
      </View>
      <TextInput
        accessibilityLabel={t("mobile.auth.pair.address")}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        inputMode="url"
        onChangeText={setAddress}
        placeholder={t("mobile.auth.pair.address")}
        placeholderTextColor={muted}
        style={inputStyle}
        value={address}
      />
      <TextInput
        accessibilityLabel={t("mobile.auth.pair.code")}
        autoCapitalize="characters"
        autoCorrect={false}
        editable={!busy}
        onChangeText={setCode}
        placeholder={t("mobile.auth.pair.code")}
        placeholderTextColor={muted}
        style={inputStyle}
        value={code}
      />
      {error ? (
        <Txt variant="sub" tone="danger" className="px-1">
          {error}
        </Txt>
      ) : null}
      <Button className="mt-2" isDisabled={busy || !address.trim() || !code.trim()} onPress={() => void pair()}>
        {t("mobile.auth.pair.connect")}
      </Button>
      <Button variant="secondary" isDisabled={busy} onPress={() => router.push("/scan-qr-code")}>
        {t("mobile.auth.pair.scan")}
      </Button>
    </View>
  );
}
