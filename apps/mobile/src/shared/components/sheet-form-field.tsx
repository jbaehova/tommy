import { Input, TextArea, TextField, Typography } from "heroui-native";
import { View } from "react-native";

import type { SheetFormFieldProps } from "@/shared/components/sheet-form-field.types";

export function SheetFormField({
  hint,
  trailing,
  isRequired = false,
  label,
  multiline = false,
  appearance = "default",
  hideLabel = false,
  ...inputProps
}: SheetFormFieldProps) {
  const Control = multiline ? TextArea : Input;
  return (
    <TextField isRequired={isRequired}>
      {!hideLabel && (
        <Typography type="body-xs" className="px-1 text-muted">
          {label}
          {isRequired ? " *" : ""}
        </Typography>
      )}
      <View className={trailing ? "flex-row items-center rounded-xl bg-grouped" : "flex-row items-center"}>
        <View className="min-w-0 flex-1">
          <Control
            accessibilityLabel={label}
            className={`rounded-xl bg-grouped px-3.5 font-sans text-sm ${multiline ? "min-h-24" : "min-h-11"} ${trailing ? "border-0 bg-transparent shadow-none" : appearance === "soft" ? "border-0 shadow-none" : ""}`}
            multiline={multiline}
            variant="primary"
            {...inputProps}
          />
        </View>
        {trailing}
      </View>
      {hint ? (
        <View className="px-1">
          <Typography.Paragraph type="body-xs" className="text-text-secondary">
            {hint}
          </Typography.Paragraph>
        </View>
      ) : null}
    </TextField>
  );
}
