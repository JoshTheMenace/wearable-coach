package dev.coach

import com.google.protobuf.CodedInputStream
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.zip.GZIPInputStream

class LessonPageLayoutTest {
    private fun page(id: String, title: String, body: String, support: Pair<String, String>? = null, hint: String = "Say “Next”") = JSONObject()
        .put("id", id).put("template", "teach").put("chapter", "LEARN · 1 OF 2").put("title", title).put("body", body).put("hint", hint)
        .apply { support?.let { put("support", JSONObject().put("title", it.first).put("body", it.second)) } }

    private fun authoredPages(): List<JSONObject> = listOf("cpr-lesson-pages.json", "cpr-scripted-pages.json").flatMap { file ->
        val pages = checkNotNull(javaClass.getResourceAsStream("/$file"))
            .bufferedReader().use { JSONArray(it.readText()) }
        (0 until pages.length()).map { pages.getJSONObject(it) }
    }

    @Test fun authoredPagesFitAboveTheBottomRegionWithoutShrinkingOrDroppingText() {
        for (page in authoredPages()) {
            val layout = LessonPageLayout.plan(page)
            assertTrue("${layout.id}: ${layout.height}px", layout.height <= LessonPageLayout.MAX_HEIGHT)
            assertEquals(LessonPageLayout.TOP + LessonPageLayout.PADDING, layout.rows.first().top)
            layout.rows.forEach { row ->
                assertTrue(LessonPageLayout.width(row.text, row.style) <= LessonPageLayout.TEXT_WIDTH)
                assertTrue(row.top + row.style.height <= 472)
                assertTrue(row.style.size >= 22)
            }
            val expected = listOf(page.getString("chapter"), page.getString("title"), page.getString("body"),
                page.optJSONObject("support")?.optString("title").orEmpty(), page.optJSONObject("support")?.optString("body").orEmpty(), page.getString("hint"))
                .joinToString(" ").trim().replace(Regex("\\s+"), " ")
            assertEquals(expected, layout.rows.joinToString(" ") { it.text })
            if (page.getString("template") != "show") assertFalse(layout.rows.any { "phone" in it.text.lowercase() })
            val firstHint = layout.rows.first { it.style == LessonPageLayout.Style.HINT }
            assertEquals(16, firstHint.gap)
        }
    }

    @Test fun longUnicodeWordsWrapWithoutBrokenCodePoints() {
        val text = "🧦".repeat(35)
        val layout = LessonPageLayout.plan(page("unicode", "Look here", text))
        val body = layout.rows.filter { it.style == LessonPageLayout.Style.BODY }
        assertEquals(text, body.joinToString("") { it.text })
        assertTrue(body.size > 1)
        assertTrue(body.all { row -> row.text.codePoints().allMatch { it !in 0xD800..0xDFFF } })
    }

    @Test fun oversizedPagesAreRejectedForAuthoringInsteadOfSilentlyTruncated() {
        val error = assertThrows(IllegalArgumentException::class.java) {
            GlassesHudPayload.encodeLesson(page("too-long", "Read this", "Important instruction. ".repeat(30)))
        }
        assertTrue(error.message.orEmpty().contains("split its content"))
    }

    private fun field3(bytes: ByteArray): ByteArray = CodedInputStream.newInstance(bytes).let {
        assertEquals(26, it.readTag()); it.readByteArray().also { _ -> assertTrue(it.isAtEnd) }
    }

    @Test fun nativePayloadUsesOneFixedUpperSurfaceAndMatchesPlannedTextSizes() {
        val page = authoredPages().first()
        val compressed = field3(field3(GlassesHudPayload.encodeLesson(page)))
        assertTrue(compressed.size <= 15_000)
        val json = GZIPInputStream(compressed.inputStream()).bufferedReader().use { JSONObject(it.readText()) }
        val root = json.getJSONObject("layout").getJSONObject("bloks_payload").getJSONObject("tree").getJSONObject("\u3408")
        assertEquals("flex_start", root.getString(","))
        assertEquals("center", root.getString("$"))
        assertEquals("32", root.getString(";"))
        val dimensions = root.getJSONObject("\u0084").getJSONObject("\u5e89")
        assertEquals("600", dimensions.getString(":")); assertEquals("600", dimensions.getString(")"))
        assertEquals(1, root.getJSONArray(" ").length())
        val card = root.getJSONArray(" ").getJSONObject(0).getJSONObject("\u587f")
        assertEquals("coach_lesson", card.getString("!"))
        assertEquals("520", card.getJSONObject("\u0084").getJSONObject("\u5e89").getString(":"))
        val rows = card.getJSONArray(" ").getJSONObject(0).getJSONObject("\u3408").getJSONArray(" ")
        val plan = LessonPageLayout.plan(page)
        assertEquals(plan.rows.size, rows.length())
        plan.rows.forEachIndexed { index, row ->
            val text = rows.getJSONObject(index).getJSONObject("\u3417")
            assertEquals(row.text, text.getString(")"))
            assertEquals("${row.style.size}sp", text.getString("-"))
            assertEquals("${row.style.height}sp", text.getString(";"))
            assertEquals(0, text.getJSONObject("\u0084").getJSONObject("\u5e89").getInt("A"))
        }
    }
}
