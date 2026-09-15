package net.dotnetdreamer.choisy.postpublisher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
// Resources live in the merged module, not in this file's own package.
import net.dotnetdreamer.choisy.videokit.R
import androidx.core.app.NotificationManagerCompat
import androidx.work.ForegroundInfo

/**
 * The "Posting your video" card. One notification id shared by both workers, so the customer sees
 * a single card that runs from the first byte to the finished post rather than one per step.
 *
 * Nothing here asks for POST_NOTIFICATIONS: the upload runs either way, and without the grant the
 * card simply only appears in the system's Task Manager.
 */
object PostingNotification {

    const val NOTIFICATION_ID = 41002
    private const val CHANNEL_ID = "choisy.posting"

    fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                ctx.getString(R.string.choisy_posting_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                setShowBadge(false)
                enableVibration(false)
                setSound(null, null)
            },
        )
    }

    fun build(ctx: Context, percent: Int, done: Int, total: Int): Notification {
        val safePercent = percent.coerceIn(0, 100)
        val counter = if (total > 0) "$done/$total" else ""
        return NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_posting)
            .setContentTitle(ctx.getString(R.string.choisy_posting_notification_title))
            .setContentText(
                ctx.getString(R.string.choisy_posting_notification_text, safePercent, counter),
            )
            .setProgress(100, safePercent, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(launchIntent(ctx))
            .build()
    }

    fun foregroundInfo(ctx: Context, percent: Int, done: Int, total: Int): ForegroundInfo {
        val notification = build(ctx, percent, done, total)
        return if (Build.VERSION.SDK_INT >= 29) {
            // The type has to match what the manifest merge declares on WorkManager's own service.
            ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION_ID, notification)
        }
    }

    fun update(ctx: Context, percent: Int, done: Int, total: Int) {
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return
        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, build(ctx, percent, done, total))
        } catch (e: SecurityException) {
            // API 33+ without the grant. The work continues; only the card is missing.
        }
    }

    fun cancel(ctx: Context) {
        try {
            NotificationManagerCompat.from(ctx).cancel(NOTIFICATION_ID)
        } catch (e: SecurityException) {
            // Nothing to do; the card was never shown.
        }
    }

    private fun launchIntent(ctx: Context): PendingIntent? {
        val intent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
        return PendingIntent.getActivity(ctx, 0, intent, PendingIntent.FLAG_IMMUTABLE)
    }
}
