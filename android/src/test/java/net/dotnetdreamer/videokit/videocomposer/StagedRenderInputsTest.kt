package net.dotnetdreamer.videokit.videocomposer

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.util.Base64

/**
 * What [StagedRenderInputs] writes, where, and what it refuses.
 *
 * The containment rule is the one worth most: both calls take a name from the page and act on the
 * file it names, so a name that reaches outside the kit's folder would let a page append to, or
 * delete, any file the app can write. The rest - chunks decoded one by one, the extension taken with
 * or without its dot - is what makes a staged file the bytes the page had.
 */
class StagedRenderInputsTest {

    @get:Rule
    val temp = TemporaryFolder()

    private lateinit var folder: File

    @Before
    fun setUp() {
        folder = File(temp.root, "cache/videokit-render-inputs")
    }

    /** The JVM's decoder standing in for the framework's, which is a stub here. */
    private fun stage(data: String, uri: String? = null, extension: String? = null): File =
        StagedRenderInputs.stage(folder, data, uri, extension) { Base64.getDecoder().decode(it) }

    private fun encode(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    private fun uriOf(file: File): String = "file://${file.path}"

    @Test
    fun `a first chunk makes a new file in the folder, named with its extension`() {
        val file = stage(encode(byteArrayOf(1, 2, 3)), extension = "wav")
        assertEquals(folder.path, file.parentFile?.path)
        assertTrue(file.name, Regex("[0-9a-f-]{36}\\.wav").matches(file.name))
        assertArrayEquals(byteArrayOf(1, 2, 3), file.readBytes())
    }

    @Test
    fun `every first chunk makes a file of its own`() {
        assertNotEquals(stage(encode(byteArrayOf(1))), stage(encode(byteArrayOf(1))))
    }

    @Test
    fun `an extension is the same with its dot or without`() {
        assertTrue(stage("", extension = ".m4a").name.endsWith(".m4a"))
        assertTrue(stage("", extension = "m4a").name.endsWith(".m4a"))
    }

    @Test
    fun `no extension, an empty one or a lone dot names the file without one`() {
        for (extension in listOf(null, "", ".")) {
            assertFalse("$extension", stage("", extension = extension).name.contains('.'))
        }
    }

    @Test
    fun `an extension that could reach into a path is refused, not cleaned`() {
        for (extension in listOf("../x", "a/b", "tar.gz", "..", "m4a ", "x".repeat(17))) {
            assertThrows(extension, StagedRenderInputs.Refused::class.java) { stage("", extension = extension) }
        }
        assertFalse(folder.exists() && folder.list()!!.isNotEmpty())
    }

    @Test
    fun `later chunks are appended in order, each decoded with its own padding`() {
        // Two one-byte chunks each carry their own padding, as `btoa` writes them in
        // withNativeRenderInputs; joined as text they are not base64 at all.
        val first = stage(encode(byteArrayOf(65)), extension = "wav")
        val again = stage(encode(byteArrayOf(66)), uri = uriOf(first))
        stage(encode(byteArrayOf(67, 68)), uri = uriOf(again))
        assertEquals(first, again)
        assertEquals("ABCD", first.readText())
    }

    @Test
    fun `an append is answered in the spelling the file was first given`() {
        val first = stage(encode(byteArrayOf(1)))
        val roundabout = "file://${folder.path}/../videokit-render-inputs/${first.name}"
        assertEquals(first.path, stage(encode(byteArrayOf(2)), uri = roundabout).path)
    }

    @Test
    fun `a bare path and a single-slash file URI name a staged file as well`() {
        val first = stage(encode(byteArrayOf(1)))
        stage(encode(byteArrayOf(2)), uri = first.path)
        stage(encode(byteArrayOf(3)), uri = "file:${first.path}")
        assertArrayEquals(byteArrayOf(1, 2, 3), first.readBytes())
    }

    @Test
    fun `an extension on an append changes nothing, since the name was settled with the file`() {
        // As the contract's StageRenderInputOptions.extension has it: "Checked on every call, used
        // only on the first".
        val first = stage(encode(byteArrayOf(1)), extension = "wav")
        assertEquals(first, stage(encode(byteArrayOf(2)), uri = uriOf(first), extension = "mp3"))
        assertEquals(first, stage(encode(byteArrayOf(3)), uri = uriOf(first), extension = ".m4a"))
        assertArrayEquals(byteArrayOf(1, 2, 3), first.readBytes())
        assertEquals(listOf(first.name), folder.list()!!.toList())
    }

    @Test
    fun `an extension that is not one is refused on an append too, and the file is left alone`() {
        // The iOS stage checks it on every chunk, so a page that sends one with its fifth chunk is
        // told on both engines, and in the same words.
        val first = stage(encode(byteArrayOf(1)), extension = "wav")
        for (extension in listOf("../x", "a/b", "tar.gz")) {
            val refusal = assertThrows(extension, StagedRenderInputs.Refused::class.java) {
                stage(encode(byteArrayOf(2)), uri = uriOf(first), extension = extension)
            }
            assertEquals("$extension is not an extension", refusal.message)
        }
        assertArrayEquals(byteArrayOf(1), first.readBytes())
    }

    @Test
    fun `an extension is checked before the file an append names`() {
        // A call wrong in two ways is refused for the same one on both engines: iOS reads the
        // extension first.
        val elsewhere = "content://media/external/audio/media/12"
        val refusal = assertThrows(StagedRenderInputs.Refused::class.java) {
            stage(encode(byteArrayOf(2)), uri = elsewhere, extension = "../x")
        }
        assertEquals("../x is not an extension", refusal.message)
    }

    @Test
    fun `an append is refused anywhere but a staged file`() {
        val outside = File(temp.root, "drafts.json").apply { writeText("{}") }
        val beside = File(temp.root, "cache/other.wav").apply { parentFile?.mkdirs(); writeText("x") }
        val nested = File(folder, "inner/clip.wav").apply { parentFile?.mkdirs(); writeText("x") }
        val staged = stage(encode(byteArrayOf(1)))
        val refused = listOf(
            uriOf(outside),
            outside.path,
            uriOf(beside),
            "file://${folder.path}/../other.wav",
            uriOf(nested),
            uriOf(folder),
            "content://media/external/audio/media/12",
            "blob:https://localhost/1b4e28ba",
            "https://example.test/${staged.name}",
            staged.name,
            "",
        )
        for (uri in refused) {
            assertThrows(uri, StagedRenderInputs.Refused::class.java) { stage(encode(byteArrayOf(9)), uri = uri) }
        }
        assertEquals("{}", outside.readText())
        assertEquals("x", beside.readText())
        assertEquals("x", nested.readText())
        assertArrayEquals(byteArrayOf(1), staged.readBytes())
    }

    @Test
    fun `a link in the folder does not lead out of it`() {
        val outside = File(temp.root, "drafts.json").apply { writeText("{}") }
        stage("")
        val link = File(folder, "link.wav").toPath()
        Files.createSymbolicLink(link, outside.toPath())
        assertThrows(StagedRenderInputs.Refused::class.java) { stage(encode(byteArrayOf(9)), uri = uriOf(link.toFile())) }
        assertEquals("{}", outside.readText())
    }

    @Test
    fun `an append to a file that has gone is refused rather than begun again`() {
        val first = stage(encode(byteArrayOf(1)))
        first.delete()
        assertThrows(StagedRenderInputs.Refused::class.java) { stage(encode(byteArrayOf(2)), uri = uriOf(first)) }
        assertFalse(first.exists())
    }

    @Test
    fun `data that is not base64 is refused, and a first chunk leaves nothing behind`() {
        assertThrows(StagedRenderInputs.Refused::class.java) { stage("not base64!", extension = "wav") }
        assertFalse(folder.exists() && folder.list()!!.isNotEmpty())
    }

    @Test
    fun `data is refused by the rule here, not by a decoder that would let it through`() {
        // android.util.Base64 on a phone passes over every character outside the alphabet and
        // takes a last group without its padding, so it decodes every one of these. This stand-in
        // does the same, and each is refused only because stage checks the text itself, as iOS's
        // Data(base64Encoded:) does.
        val alphabet = ('A'..'Z') + ('a'..'z') + ('0'..'9') + '+' + '/'
        val lenient = { text: String ->
            val kept = text.filter { it in alphabet }
            Base64.getDecoder().decode(kept + "=".repeat((4 - kept.length % 4) % 4))
        }
        val first = stage(encode(byteArrayOf(1)))
        val refused = listOf(
            "AAAA!",
            "AAAA AAAA",
            "AAAA\nAAAA",
            "data:audio/wav;base64,AAAA",
            "AAAAAA",
            "AAA-",
            "AAA_",
        )
        for (data in refused) {
            assertThrows(data, StagedRenderInputs.Refused::class.java) {
                StagedRenderInputs.stage(folder, data, uriOf(first), null, lenient)
            }
            assertThrows(data, StagedRenderInputs.Refused::class.java) {
                StagedRenderInputs.stage(folder, data, null, "wav", lenient)
            }
        }
        assertArrayEquals(byteArrayOf(1), first.readBytes())
        assertEquals(listOf(first.name), folder.list()!!.toList())
        // What btoa writes still goes through: no bytes, one, two, three, and the two symbols.
        for (data in listOf("", "AA==", "AAA=", "AAAA", "+/+/")) {
            StagedRenderInputs.stage(folder, data, uriOf(first), null, lenient)
        }
        assertEquals(10L, first.length())
    }

    @Test
    fun `a release deletes the staged files it names and passes over every other name`() {
        val outside = File(temp.root, "drafts.json").apply { writeText("{}") }
        val kept = stage(encode(byteArrayOf(1)))
        val released = stage(encode(byteArrayOf(2)))
        val gone = stage(encode(byteArrayOf(3))).apply { delete() }
        StagedRenderInputs.release(
            folder,
            listOf(
                uriOf(released),
                uriOf(gone),
                uriOf(outside),
                "file://${folder.path}/../../drafts.json",
                uriOf(folder),
                "content://media/external/audio/media/12",
                "",
            ),
        )
        assertFalse(released.exists())
        assertTrue(kept.exists())
        assertTrue(outside.exists())
        assertTrue(folder.isDirectory)
    }

    @Test
    fun `a name is inside only when it sits directly in the folder`() {
        assertEquals(File(folder, "a.wav"), StagedRenderInputs.staged(folder, "file://${folder.path}/a.wav"))
        assertNull(StagedRenderInputs.staged(folder, "file://${folder.path}"))
        assertNull(StagedRenderInputs.staged(folder, "file://${folder.path}/x/a.wav"))
        assertNull(StagedRenderInputs.staged(folder, "file://${folder.parent}/a.wav"))
        assertNull(StagedRenderInputs.staged(folder, "file:a.wav"))
    }
}
