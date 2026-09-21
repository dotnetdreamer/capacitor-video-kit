package net.dotnetdreamer.choisy.videocomposer

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the process alive and un-frozen while a render runs.
 *
 * Without this, leaving the editor puts the app in the cached state and the system is free to
 * freeze it mid-encode - the customer comes back minutes later to a video that made no progress.
 * `mediaProcessing` is the service type made for exactly this case and exists from API 35; API 34
 * has no such type, but `dataSync` lists local file processing among its allowed uses; below 34
 * there is no typed foreground service at all.
 *
 * The service owns its own lifetime. It polls the registry once a second and stops when nothing is
 * rendering, rather than being told to stop - which is what keeps a `stopService` from racing a
 * `startForegroundService` whose `startForeground` has not happened yet (the crash that produces).
 */
class RenderService : Service() {

    private val main = Handler(Looper.getMainLooper())
    private var isForeground = false
    private var lastStartId = 0

    /** How long the tick waits, after the last job ends, before actually stopping. */
    private var idleTicks = 0

    override fun onCreate() {
        super.onCreate()
        JobRegistry.appContext = applicationContext
        RenderNotification.ensureChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        // startForeground has to happen within seconds of startForegroundService() or the system
        // kills the app, so it is the very first thing done here.
        if (!goForeground()) {
            stopSelfResult(startId)
            return START_NOT_STICKY
        }
        idleTicks = 0
        main.removeCallbacks(tick)
        main.post(tick)
        return START_NOT_STICKY
    }

    private fun goForeground(): Boolean {
        val notification = RenderNotification.build(this, (JobRegistry.overallProgress() * 100).toInt())
        return try {
            when {
                Build.VERSION.SDK_INT >= 35 -> {
                    // Deliberately NOT ServiceCompat: its API-34 path masks every type against the
                    // set that existed in Android 14, and mediaProcessing is not in it, so the
                    // framework would receive type 0 - which, with targetSdk 35+, it rejects
                    // outright. Calling the framework directly is the only way to actually get the
                    // type declared in the manifest.
                    //
                    // Nor FOREGROUND_SERVICE_TYPE_MANIFEST: that resolves to mediaProcessing AND
                    // dataSync together, and the service would then consume (and time out against)
                    // both of their background budgets.
                    startForeground(
                        RenderNotification.NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING,
                    )
                }
                Build.VERSION.SDK_INT == 34 -> ServiceCompat.startForeground(
                    this,
                    RenderNotification.NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                )
                // Below 34 there is no service type to declare, and the untyped overload is
                // exactly what the platform expects.
                else -> startForeground(RenderNotification.NOTIFICATION_ID, notification)
            }
            isForeground = true
            true
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException (background start, or the per-type budget
            // exhausted on API 35) and SecurityException (a permission missing from the merged
            // manifest) both land here. The render still runs on its own threads; only the
            // protection from being frozen is lost.
            Log.w(TAG, "startForeground refused: ${e.message}")
            false
        }
    }

    private val tick = object : Runnable {
        override fun run() {
            if (JobRegistry.active().isEmpty()) {
                // One grace tick: compose() may have just registered a job and asked for this
                // service in the same second.
                if (idleTicks++ >= 1) {
                    finishAndStop()
                    return
                }
            } else {
                idleTicks = 0
                RenderNotification.update(
                    this@RenderService,
                    (JobRegistry.overallProgress() * 100).toInt(),
                )
            }
            main.postDelayed(this, IDLE_POLL_MS)
        }
    }

    private fun finishAndStop() {
        main.removeCallbacks(tick)
        if (isForeground) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            isForeground = false
        }
        // stopSelfResult, not stopSelf: a start delivered after this one keeps the service alive
        // and re-runs onStartCommand instead of dropping the new job's protection on the floor.
        stopSelfResult(lastStartId)
    }

    /**
     * API 35+: the per-type background budget (six hours per day, reset whenever the app is in the
     * foreground) ran out. There are a few seconds to stop before the process is killed, so every
     * render is marked interrupted and the caller restarts it next time the app is visible.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "foreground service timed out (type=$fgsType)")
        JobRegistry.interruptAll("fgs_timeout")
        finishAndStop()
    }

    /** The API 34 signature. The platform never calls it for our types; overriding is harmless. */
    override fun onTimeout(startId: Int) {
        onTimeout(startId, 0)
    }

    override fun onDestroy() {
        main.removeCallbacks(tick)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "VideoComposer"
        private const val IDLE_POLL_MS = 1000L
        const val ACTION_START = "net.dotnetdreamer.choisy.videocomposer.action.START"

        /**
         * Asked for by `compose()` while the Activity is still visible - a background start throws
         * from API 31 and there is nothing useful to do about it except carry on unprotected.
         */
        fun start(ctx: Context) {
            try {
                ContextCompat.startForegroundService(
                    ctx,
                    Intent(ctx, RenderService::class.java).setAction(ACTION_START),
                )
            } catch (e: IllegalStateException) {
                // ForegroundServiceStartNotAllowedException extends this from API 31.
                Log.w(TAG, "render foreground service not started: ${e.message}")
            }
        }
    }
}
