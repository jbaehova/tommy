import * as Application from "expo-application";
import Constants from "expo-constants";
import { Typography } from "heroui-native";
import { View } from "react-native";
import { AppLogo } from "@/features/auth/components/app-logo";
import { SettingsContent } from "@/features/settings/components/settings-content";
import { useText } from "@/shared/lib/text";

const PRODUCT_NAME = "Tommy";

export function AboutSettingsScreen() {
  const { t } = useText();
  const version = Constants.expoConfig?.version ?? t("mobile.settings.about.development");
  // The version code of the installed app, and the commit that `app.config.js` read at build time.
  const commit = Constants.expoConfig?.extra?.buildCommit;
  const details = [Application.nativeBuildVersion, typeof commit === "string" ? commit : null].filter(Boolean);
  const versionLabel = details.length > 0 ? `${version} (${details.join(", ")})` : version;
  return (
    <SettingsContent>
      <View className="items-center gap-4 px-4 pb-6 pt-8">
        <AppLogo size={56} />
        <View className="items-center gap-1">
          <Typography.Heading type="h4" align="center">
            {PRODUCT_NAME}
          </Typography.Heading>
          <Typography.Paragraph type="body-xs" align="center" className="text-grouped-secondary" selectable>
            {versionLabel}
          </Typography.Paragraph>
        </View>
      </View>
    </SettingsContent>
  );
}
