import Check from "lucide-react-native/icons/check";
import { AndroidHeaderButton } from "@/shared/components/android-header-button";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";

export function SheetSaveAction({
  dirty,
  canSave,
  pending,
  label: labelProp,
  pendingLabel: pendingLabelProp,
  onSave,
}: {
  dirty: boolean;
  canSave: boolean;
  pending: boolean;
  label?: string;
  pendingLabel?: string;
  onSave: () => void;
}) {
  const { t } = useText();
  const label = labelProp ?? t("mobile.shared.save.changes");
  const pendingLabel = pendingLabelProp ?? t("common.saving");
  return (
    <AndroidHeaderButton
      placement="right"
      icon={Check}
      hidden={!dirty && !pending}
      disabled={!dirty || !canSave || pending}
      accessibilityLabel={pending ? pendingLabel : label}
      onPress={() => {
        if (!dirty || !canSave || pending) return;
        void haptics.impact("light");
        onSave();
      }}
    />
  );
}
