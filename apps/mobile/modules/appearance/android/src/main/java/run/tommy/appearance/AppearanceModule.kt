package run.tommy.appearance

import android.app.UiModeManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Gives the system the light or dark look that the user chose in the app. From Android 12 the system
 * keeps it for the app and draws the splash screen with it. Without it, a dark app on a light phone
 * opened on a light screen for as long as the splash showed.
 */
class AppearanceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TommyAppearance")

    /** `system`, `light` or `dark`. Android 11 and earlier have no such setting, and nothing changes. */
    Function("setNightMode") { mode: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function
      val manager = appContext.reactContext?.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        ?: return@Function
      val nightMode = when (mode) {
        "dark" -> UiModeManager.MODE_NIGHT_YES
        "light" -> UiModeManager.MODE_NIGHT_NO
        // The app follows the phone again.
        else -> UiModeManager.MODE_NIGHT_AUTO
      }
      // The system keeps the value, and the same value again changes nothing.
      manager.setApplicationNightMode(nightMode)
    }
  }
}
