package run.tommy.quickactions

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.os.Build
import android.os.Bundle

/** `readQuickActionId` reads this ID as the digital assistant action. */
private const val ASSISTANT_ID = "assistant"

/**
 * The digital assistant action of the phone. It can show over the lock screen, so it draws nothing
 * and only asks the phone to unlock. The app opens after that, and never over the lock screen.
 */
class AssistantEntryActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val keyguard = getSystemService(KeyguardManager::class.java)
    // On an unlocked phone the activity ends here, before its black window draws.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || keyguard == null || !keyguard.isKeyguardLocked) {
      openApp()
      return
    }
    // The app stays behind the lock screen until the user unlocks the phone, so each result can open it.
    keyguard.requestDismissKeyguard(
      this,
      object : KeyguardManager.KeyguardDismissCallback() {
        override fun onDismissSucceeded() = openApp()

        override fun onDismissError() = openApp()

        override fun onDismissCancelled() = openApp()
      },
    )
  }

  private fun openApp() {
    val main = packageManager.getLaunchIntentForPackage(packageName)?.component
    if (main != null) {
      startActivity(
        Intent(SHORTCUT_ACTION)
          .setComponent(main)
          .putExtra(SHORTCUT_ID, ASSISTANT_ID)
          // A running app keeps its screens and gets the action in onNewIntent.
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      )
    }
    finish()
  }
}
