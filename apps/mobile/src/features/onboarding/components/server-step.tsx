import { useIsFocused, usePathname } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import type { LucideIcon } from "lucide-react-native";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import Cloud from "lucide-react-native/icons/cloud";
import Mail from "lucide-react-native/icons/mail";
import Monitor from "lucide-react-native/icons/monitor";
import { View } from "react-native";
import { GlassChoice } from "@/features/onboarding/components/onboarding-glass";
import { glassAfter, type OnboardingMotion, STAGGER_MS } from "@/features/onboarding/components/onboarding-motion";
import { StepHeader, StepScroll } from "@/features/onboarding/components/onboarding-parts";
import type { MobileServer } from "@/features/workspace/model/workspace-types";
import { useScreenLoadingLabel } from "@/shared/components/app-loading-overlay";
import { useText } from "@/shared/lib/text";

interface ServerOption {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  onPress: () => void;
}

function OptionRow({ option, index }: { option: ServerOption; index: number }) {
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const Icon = option.icon;
  return (
    <View>
      <GlassChoice
        label={option.title}
        hint={option.description}
        appearDelay={glassAfter(STAGGER_MS * (3 + index))}
        onPress={option.onPress}
      >
        <View className="flex-row items-center gap-3 py-3.5 pr-3 pl-3.5">
          <View className="size-10 items-center justify-center rounded-full bg-background">
            <Icon size={20} color={String(foreground)} strokeWidth={1.75} />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Typography.Paragraph className="font-medium">{option.title}</Typography.Paragraph>
            <Typography.Paragraph type="body-sm" className="text-grouped-secondary">
              {option.description}
            </Typography.Paragraph>
          </View>
          <ChevronRight size={18} color={String(muted)} strokeWidth={1.75} />
        </View>
      </GlassChoice>
    </View>
  );
}

/**
 * Where the agents will run. Each choice opens the flow that already does that job. A server that
 * was added and still connects shows here until it is online; then the flow moves on by itself.
 */
export function ServerStep({
  motion,
  connecting,
  onComputer,
  onCloud,
  onInvitation,
}: {
  motion: OnboardingMotion;
  /** A server that the account has but that is not online yet. */
  connecting: MobileServer | null;
  onComputer: () => void;
  /** Absent when the account cannot have a cloud server. */
  onCloud: (() => void) | null;
  onInvitation: () => void;
}) {
  const { t } = useText();
  // The app loader covers the step while the server connects, and rolls up when it is online.
  const focused = useIsFocused();
  const pathname = usePathname();
  useScreenLoadingLabel(
    pathname,
    connecting && focused ? t("mobile.onboarding.server.connecting", { name: connecting.name }) : null,
  );
  const options: ServerOption[] = [
    {
      id: "invitation",
      icon: Mail,
      title: t("mobile.onboarding.server.invitation"),
      description: t("mobile.onboarding.server.invitationBody"),
      onPress: onInvitation,
    },
    ...(onCloud
      ? [
          {
            id: "cloud",
            icon: Cloud,
            title: t("mobile.onboarding.server.cloud"),
            description: t("mobile.onboarding.server.cloudBody"),
            onPress: onCloud,
          },
        ]
      : []),
    {
      id: "computer",
      icon: Monitor,
      title: t("mobile.onboarding.server.computer"),
      description: t("mobile.onboarding.server.computerBody"),
      onPress: onComputer,
    },
  ];
  return (
    <StepScroll>
      <StepHeader
        title={t("mobile.onboarding.server.title")}
        body={t("mobile.onboarding.server.body")}
        motion={motion}
      />
      {connecting ? null : (
        <View className="gap-3">
          {options.map((option, index) => (
            <OptionRow key={option.id} option={option} index={index} />
          ))}
        </View>
      )}
    </StepScroll>
  );
}
