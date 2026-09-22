package net.dotnetdreamer.videokit.publisher

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * One JSON file per batch, holding everything needed to finish the job with no JavaScript alive.
 *
 * It lives outside the batch's media folder on purpose: forgetting the record and deleting the files
 * are separate decisions made by different callers at different times.
 *
 * Writes go to a temporary file and are renamed into place, which is atomic on a single volume, so
 * a process killed mid-write leaves the previous record intact rather than a half-written one. The
 * plugin thread and a worker both write, hence a lock per batch id.
 */
class PublishStore(context: Context) {

    private val appContext = context.applicationContext
    private val dir = File(appContext.filesDir, "background-publisher")

    private fun fileFor(batchId: String) = File(dir, "${safe(batchId)}.json")

    fun load(batchId: String): PublishEntry? = lockFor(batchId).withLock {
        val file = fileFor(batchId)
        if (!file.exists()) return null
        return try {
            PublishEntry.from(JSONObject(file.readText()))
        } catch (e: Exception) {
            // A record we cannot read is worse than none: it would stall the batch forever.
            Log.w(TAG, "dropping unreadable record for $batchId: ${e.message}")
            file.delete()
            null
        }
    }

    fun save(entry: PublishEntry) {
        lockFor(entry.request.batchId).withLock { writeLocked(entry) }
    }

    /** Read, change, write - all under the batch's own lock, so two writers cannot interleave. */
    fun update(batchId: String, block: (PublishEntry) -> Unit): PublishEntry? =
        lockFor(batchId).withLock {
            val file = fileFor(batchId)
            if (!file.exists()) return null
            val entry = try {
                PublishEntry.from(JSONObject(file.readText()))
            } catch (e: Exception) {
                Log.w(TAG, "dropping unreadable record for $batchId: ${e.message}")
                file.delete()
                return null
            }
            block(entry)
            writeLocked(entry)
            entry
        }

    fun delete(batchId: String) {
        lockFor(batchId).withLock {
            fileFor(batchId).delete()
            locks.remove(batchId)
        }
    }

    fun all(): List<PublishEntry> = dir.listFiles()
        ?.filter { it.isFile && it.name.endsWith(".json") }
        ?.mapNotNull { file ->
            try {
                PublishEntry.from(JSONObject(file.readText()))
            } catch (e: Exception) {
                Log.w(TAG, "skipping unreadable record ${file.name}: ${e.message}")
                null
            }
        }
        ?: emptyList()

    /** Drops finished records the caller never cleared. */
    fun sweep(now: Long, retainMs: Long) {
        all().forEach { entry ->
            val finished = entry.state.phase == Phase.DONE
            if (finished && entry.updatedAt > 0L && now - entry.updatedAt > retainMs) {
                delete(entry.request.batchId)
            }
        }
    }

    private fun writeLocked(entry: PublishEntry) {
        if (!dir.exists() && !dir.mkdirs()) {
            Log.w(TAG, "could not create ${dir.path}")
            return
        }
        entry.updatedAt = System.currentTimeMillis()
        val target = fileFor(entry.request.batchId)
        val temp = File(dir, "${target.name}.tmp")
        try {
            temp.writeText(entry.toJson().toString())
            if (!temp.renameTo(target)) {
                // Rename can fail if the destination exists on some filesystems; falling back to a
                // direct write is still better than losing the record.
                target.delete()
                if (!temp.renameTo(target)) {
                    target.writeText(entry.toJson().toString())
                    temp.delete()
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "could not persist ${entry.request.batchId}: ${e.message}")
            temp.delete()
        }
    }

    private fun lockFor(batchId: String): ReentrantLock =
        locks.getOrPut(batchId) { ReentrantLock() }

    private fun safe(s: String) = s.replace(Regex("[^A-Za-z0-9._-]"), "_")

    companion object {
        private const val TAG = "BackgroundPublisher"

        /** Locks are shared across every store instance, since they guard one set of files. */
        private val locks = ConcurrentHashMap<String, ReentrantLock>()

        /** How long a finished record is kept in case the caller wants to read the result. */
        const val DONE_RETENTION_MS = 30L * 24 * 60 * 60 * 1000
    }
}
