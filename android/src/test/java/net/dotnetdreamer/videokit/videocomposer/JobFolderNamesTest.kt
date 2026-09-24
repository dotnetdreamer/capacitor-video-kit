package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.content.ContextWrapper
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import net.dotnetdreamer.videokit.publisher.BackgroundPublisherPlugin
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Which folder a batch id names, and that no id at all names one outside `video-batches`.
 *
 * The rule it protects: [JobFolders.cleanup] deletes the folder it is given, so an id naming the
 * folder above `video-batches` - `..` did, and `.` and the empty id named `video-batches` itself -
 * takes every post, and `filesDir` with them. Every id that does name a folder keeps the one it
 * always had, because drafts and hosts hold on to it. The iOS `JobFolderNamesTests` pins the same.
 */
class JobFolderNamesTest {

    @get:Rule
    val temp = TemporaryFolder()

    private lateinit var files: File
    private lateinit var cache: File
    private lateinit var root: File
    private lateinit var ctx: Context

    /** Every id that ever named a path outside its job folder, and the ones a page could send next. */
    private val hostile = listOf("..", ".", "", "../x", "a/../..", "../..", "/", "./..", "x/..")

    /** The ids every plugin refuses, with the words it refuses each in ([JobFolders.batchIdRefusal]). */
    private val refusals = listOf(
        ".." to "batchId cannot be '.' or '..'",
        "." to "batchId cannot be '.' or '..'",
        "" to "batchId is required",
    )

    @Before
    fun setUp() {
        files = temp.newFolder("files")
        cache = temp.newFolder("cache")
        root = File(files, "video-batches")
        // Only `filesDir` and `cacheDir` are asked for on the way to a job folder or the voice
        // cache; the framework's own Context is a stub here.
        ctx = object : ContextWrapper(null) {
            override fun getFilesDir(): File = files
            override fun getCacheDir(): File = cache
        }
    }

    @Test
    fun `an id that names a folder keeps the folder it always had`() {
        val names = listOf(
            "post-1" to "post-1",
            "batch-3f2a.9" to "batch-3f2a.9",
            "post 1" to "post_1",
            "vo:abc" to "vo_abc",
            "..." to "...",
            ".x" to ".x",
            "__" to "__",
            "../x" to ".._x",
            "a/../.." to "a_.._..",
        )
        for ((id, name) in names) {
            assertEquals(id, name, JobFolders.folderName(id))
            assertEquals(id, File(root, name), JobFolders.dir(ctx, id))
            assertNull(id, JobFolders.batchIdRefusal(id))
        }
    }

    @Test
    fun `the ids that name no folder of their own are refused, and named one inside all the same`() {
        assertEquals("batchId cannot be '.' or '..'", JobFolders.batchIdRefusal(".."))
        assertEquals("batchId cannot be '.' or '..'", JobFolders.batchIdRefusal("."))
        assertEquals("batchId is required", JobFolders.batchIdRefusal(""))

        assertEquals(File(root, "__"), JobFolders.dir(ctx, ".."))
        assertEquals(File(root, "_"), JobFolders.dir(ctx, "."))
        assertEquals(File(root, "_"), JobFolders.dir(ctx, ""))
    }

    @Test
    fun `no id names a path outside its folder in video-batches`() {
        for (id in hostile) {
            val dir = JobFolders.dir(ctx, id).normalize()
            assertEquals(id, root, dir.parentFile)
            val paths = listOf(
                JobFolders.inputs(ctx, id),
                JobFolders.stitched(ctx, id),
                JobFolders.poster(ctx, id),
                JobFolders.part(ctx, id, id),
                JobFolders.doneMarker(ctx, id),
            )
            for (path in paths) assertEquals("$id: ${path.path}", dir, path.normalize().parentFile)
        }
    }

    @Test
    fun `cleanup of any id deletes nothing outside its own folder`() {
        val outside = File(temp.root, "outside.txt").apply { writeText("x") }
        val besideRoot = File(files, "keep.txt").apply { writeText("x") }
        val neighbour = File(root, "neighbour/stitched.mp4").apply {
            parentFile?.mkdirs()
            writeText("x")
        }
        val own = File(root, ".._x/stitched.mp4").apply {
            parentFile?.mkdirs()
            writeText("x")
        }

        for (id in hostile) JobFolders.cleanup(ctx, id)

        assertTrue(outside.exists())
        assertTrue(besideRoot.exists())
        assertTrue(neighbour.exists())
        assertFalse("`../x` names a folder of its own and cleanup still deletes it", own.exists())
    }

    @Test
    fun `compose refuses a batch id that names no folder of its own`() {
        for (id in listOf("..", ".")) {
            try {
                ComposeSpecParser.parse(spec(id))
                fail("expected invalid_spec:batchId for $id")
            } catch (e: SpecException) {
                assertEquals("batchId", e.path)
                assertEquals("invalid_spec:batchId", e.message)
            }
        }
        assertEquals("../x", ComposeSpecParser.parse(spec("../x")).batchId)
    }

    @Test
    fun `prepareJob and cleanup refuse, through the plugin, an id that names no folder of its own`() {
        // Refused before anything is touched: a plugin with no bridge under it has no Context, so a
        // regression that let the id through would fail here rather than delete anything.
        val plugin = VideoComposerPlugin()
        val methods = listOf<Pair<String, (PluginCall) -> Unit>>(
            "prepareJob" to plugin::prepareJob,
            "cleanup" to plugin::cleanup,
        )
        for ((name, method) in methods) {
            for ((id, message) in refusals) {
                val call = RecordedCall(JSObject().put("batchId", id).put("inputs", JSArray()))
                method(call)
                assertEquals("$name $id", message to "invalid_spec", call.rejected)
            }
            val missing = RecordedCall(JSObject().put("inputs", JSArray()))
            method(missing)
            assertEquals(name, "batchId is required" to "invalid_spec", missing.rejected)
        }
    }

    @Test
    fun `the publisher refuses the same ids, through the plugin, before it reads a record`() {
        // Its record store is only made in `load()`, which a plugin with no bridge never runs, so a
        // regression that let the id through would fail here on the store rather than clear one.
        val plugin = BackgroundPublisherPlugin()
        val methods = listOf<Pair<String, (PluginCall) -> Unit>>(
            "getState" to plugin::getState,
            "cancel" to plugin::cancel,
            "retry" to plugin::retry,
            "clear" to plugin::clear,
        )
        for ((name, method) in methods) {
            for ((id, message) in refusals) {
                val call = RecordedCall(JSObject().put("batchId", id))
                method(call)
                assertEquals("$name $id", message to "invalid_request", call.rejected)
            }
        }
    }

    @Test
    fun `a voice take for an id that names no folder of its own goes into the voice cache`() {
        val voice = File(cache, "video-composer/voice")
        for (id in listOf(null, "", ".", "..")) assertEquals("$id", voice, VoiceRecorder.folderFor(ctx, id))
        assertEquals(File(root, "post-1/in"), VoiceRecorder.folderFor(ctx, "post-1"))
        assertEquals(File(root, ".._x/in"), VoiceRecorder.folderFor(ctx, "../x"))
    }

    private fun spec(batchId: String): JSONObject = JSONObject(
        """
        {
          "jobId": "job-1",
          "clips": [
            { "key": "a", "uri": "file:///a.mp4", "inMs": 0, "outMs": 2000,
              "speed": 1, "volume": 1, "muted": false, "fit": "contain" }
          ],
          "output": { "width": 720, "height": 1280, "fps": 30,
                      "videoBitrate": 4000000, "audioBitrate": 128000 },
          "filter": [],
          "overlays": [],
          "audio": { "originalMuted": false, "originalVolume": 1, "music": null, "voiceover": [] },
          "posterAtMs": 0
        }
        """.trimIndent(),
    ).put("batchId", batchId)
}

/**
 * A call as the bridge hands one to a plugin method, which remembers how it was rejected rather
 * than sending the rejection to a WebView there is none of. Every `reject` overload ends in the one
 * with four arguments. A call that resolves instead fails the test loudly, on the missing handler.
 */
private class RecordedCall(data: JSObject) : PluginCall(null, "test", "test", "test", data) {
    var rejected: Pair<String?, String?>? = null

    override fun reject(msg: String?, code: String?, ex: Exception?, data: JSObject?) {
        rejected = msg to code
    }
}
