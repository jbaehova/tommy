import Plus from "lucide-react-native/icons/plus";
import { AndroidHeaderButton } from "@/shared/components/android-header-button";
import { haptics } from "@/shared/lib/haptics";

/** The "+" of the header: the native toolbar on iOS. */
export function HeaderAddAction({ label, onPress }: { label: string; onPress: () => void }) {
  const press = () => {
    void haptics.impact("light");
    onPress();
  };
  return <AndroidHeaderButton placement="right" icon={Plus} accessibilityLabel={label} onPress={press} />;
}
