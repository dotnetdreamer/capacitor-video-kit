package net.dotnetdreamer.videokit.videocomposer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
// Resources live in the merged module, not in this file's own package.
import net.dotnetdreamer.videokit.R
import androidx.core.app.NotificationManagerCompat

/**
 * The "Preparing your video" card. It exists because a foreground service has to show something,
 * not because anyone needs to read it - hence low importance, silent, and only-alert-once.
 *
 * Nothing here asks for POST_NOTIFICATIONS. A foreground service runs perfectly well without the
 * grant; the card simply only appears in the system's Task Manager, which is an acceptable trade
 * for not throwing a permission dialog at someone in the middle of editing.
 */
object RenderNotification {

    const val NOTIFICATION_ID = 41001
    private const val CHANNEL_ID = "videokit.render"

    fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            ctx.getString(R.string.videokit_render_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        manager.createNotificationChannel(channel)
    }

    fun build(ctx: Context, percent: Int): Notification {
        val safePercent = percent.coerceIn(0, 100)
        return NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_render)
            .setContentTitle(ctx.getString(R.string.videokit_render_notification_title))
            .setContentText(ctx.getString(R.string.videokit_render_notification_text, safePercent))
            // Indeterminate until the first frame lands, so the bar never sits dead at zero.
            .setProgress(100, safePercent, safePercent <= 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(launchIntent(ctx))
            .build()
    }

    fun update(ctx: Context, percent: Int) {
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return
        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, build(ctx, percent))
        } catch (e: SecurityException) {
            // API 33+ without the grant. The service keeps running; only the card is missing.
        }
    }

    private fun launchIntent(ctx: Context): PendingIntent? {
        val intent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
        return PendingIntent.getActivity(ctx, 0, intent, PendingIntent.FLAG_IMMUTABLE)
    }
}
