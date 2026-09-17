package dev.coach

import com.google.protobuf.CodedInputStream
import com.meta.wearable.dat.dwa.capability.display.internal.protos.DisplayRequestPayload
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.zip.GZIPInputStream
import java.util.Base64

class GlassesHudPayloadTest {
    private fun structure(value: Any?): Any? = when (value) {
        is JSONObject -> value.keys().asSequence().associateWith { structure(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { structure(value.get(it)) }
        else -> value
    }

    private fun field3(bytes: ByteArray): ByteArray {
        val input = CodedInputStream.newInstance(bytes)
        assertEquals(26, input.readTag())
        return input.readByteArray().also { assertTrue(input.isAtEnd) }
    }

    private fun envelope(bytes: ByteArray): JSONObject {
        val parsed = DisplayRequestPayload.parseFrom(bytes)
        assertTrue(parsed.hasDisplayContent())
        assertFalse(parsed.displayContent.hasContent()) // DAT 0.8 retains the unknown modern field.
        assertArrayEquals(bytes, parsed.toByteArray())
        val gzip = field3(field3(bytes))
        assertEquals(0x1f, gzip[0].toInt() and 255)
        assertEquals(0x8b, gzip[1].toInt() and 255)
        return GZIPInputStream(gzip.inputStream()).bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
    }

    private fun root(bytes: ByteArray) = envelope(bytes).getJSONObject("layout")
        .getJSONObject("bloks_payload").getJSONObject("tree").getJSONObject("\u3408")

    @Test fun matchesWearerConfirmedSdk09PayloadWithOnlyStableIdentifierChanged() {
        val actual = envelope(GlassesHudPayload.encode(listOf(
            GlassesHudPayload.Line("CENTERED COACH", true),
            GlassesHudPayload.Line("This card is in the middle")
        )))
        val fixture = checkNotNull(javaClass.getResourceAsStream("/sdk09-centered-card.json"))
            .bufferedReader(Charsets.UTF_8).use { it.readText() }
        val golden = JSONObject(fixture.replace("c0_pxqzygeyzwbe", "coach_card"))
        assertEquals("Payload differs from the wearer-confirmed centered card", structure(golden), structure(actual))
    }

    @Test fun preservesUnicodeAndTextStylesInsideTheCenteredCanvas() {
        val root = root(GlassesHudPayload.encode(listOf(
            GlassesHudPayload.Line("Look \"here\" ✓", true), GlassesHudPayload.Line("line1 🧦 line2")
        )))
        assertEquals("center", root.getString(","))
        val dimensions = root.getJSONObject("\u0084").getJSONObject("\u5e89")
        assertEquals("600", dimensions.getString(":"))
        assertEquals("600", dimensions.getString(")"))
        val card = root.getJSONArray(" ").getJSONObject(0).getJSONObject("\u587f")
        assertEquals("coach_card", card.getString("!"))
        val children = card.getJSONArray(" ").getJSONObject(0).getJSONObject("\u3408").getJSONArray(" ")
        val heading = children.getJSONObject(0).getJSONObject("\u3417")
        val body = children.getJSONObject(1).getJSONObject("\u3417")
        assertEquals("Look \"here\" ✓", heading.getString(")"))
        assertEquals("line1 🧦 line2", body.getString(")"))
        assertEquals("40sp", heading.getString("-"))
        assertEquals("28sp", body.getString("-"))
        assertEquals("#FFFFFF", body.getString("+"))
        assertEquals("12", body.getJSONObject("\u0084").getJSONObject("\u5e89").getString("1"))
    }

    @Test fun clearEncodesAnEmptyCanvasWithoutAnInteractiveCard() {
        assertEquals(0, root(GlassesHudPayload.encode(emptyList())).getJSONArray(" ").length())
    }

    @Test fun marineLobbyCarriesOneBoundedImageAndKeepsTheWelcomeAboveTheBottomRegion() {
        val image = ByteArray(13_000).also { java.util.Random(42).nextBytes(it) }
        val payload = GlassesHudPayload.encodeMarineLobby(image)
        assertTrue(field3(field3(payload)).size <= 15_000)
        val root = root(payload)
        assertEquals("flex_start", root.getString(",")); assertEquals("center", root.getString("$"))
        val children = root.getJSONArray(" ")
        assertEquals(3, children.length())
        val imageNode = children.getJSONObject(0).getJSONObject("\u340b")
        assertArrayEquals(image, Base64.getDecoder().decode(imageNode.getString(")").substringAfter(',')))
        assertEquals("fit_center", imageNode.getString("("))
        val imageBounds = imageNode.getJSONObject("\u0084").getJSONObject("\u5e89")
        assertEquals(220, imageBounds.getInt(":")); assertEquals(220, imageBounds.getInt(")"))
        var bottom = root.getInt(";") + imageBounds.getInt(")")
        for (i in 1 until children.length()) {
            val text = children.getJSONObject(i).getJSONObject("\u3417")
            bottom += text.getJSONObject("\u0084").getJSONObject("\u5e89").getInt("1") + text.getString(";").removeSuffix("sp").toInt()
        }
        assertTrue("Marine lobby extends below the readable region: $bottom", bottom <= 400)
        assertEquals("MARINE TUTOR", children.getJSONObject(1).getJSONObject("\u3417").getString(")"))
        assertEquals("What would you like to learn?", children.getJSONObject(2).getJSONObject("\u3417").getString(")"))
    }

    @Test fun marineLobbyRejectsMissingOrOversizedImagesBeforeTheyReachTheDisplayChannel() {
        assertThrows(IllegalArgumentException::class.java) { GlassesHudPayload.encodeMarineLobby(byteArrayOf()) }
        assertThrows(IllegalArgumentException::class.java) { GlassesHudPayload.encodeMarineLobby(ByteArray(13_001)) }
    }

    private fun textNodes(lines: List<GlassesHudPayload.Line>): List<JSONObject> {
        val children = root(GlassesHudPayload.encode(lines)).getJSONArray(" ")
            .getJSONObject(0).getJSONObject("\u587f").getJSONArray(" ")
            .getJSONObject(0).getJSONObject("\u3408").getJSONArray(" ")
        return (0 until children.length()).map { children.getJSONObject(it).getJSONObject("\u3417") }
    }

    @Test fun wrapsWordsAndUnicodeWithoutSplittingSurrogatePairs() {
        val nodes = textNodes(listOf(
            GlassesHudPayload.Line("Inspect the blue handle before continuing"),
            GlassesHudPayload.Line("🧦".repeat(30))
        ))
        assertEquals(listOf("Inspect the blue handle", "before continuing", "🧦".repeat(26), "🧦".repeat(4)),
            nodes.map { it.getString(")") })
    }

    @Test fun boundsLongHudAndAlwaysKeepsOverflowNotice() {
        val lines = listOf(GlassesHudPayload.Line("A long coaching heading 🧦", true),
            GlassesHudPayload.Line((1..15).joinToString("\n") { "Step $it: " + "🧦".repeat(30) })) +
            (1..5).map { GlassesHudPayload.Line("Checklist row $it: " + "x".repeat(80)) } +
            GlassesHudPayload.Line("Timer 09:59")
        val nodes = textNodes(lines)
        assertEquals("… More on phone", nodes.last().getString(")"))
        val estimatedHeight = 48 + nodes.sumOf { it.getString(";").removeSuffix("sp").toInt() } +
            12 * (nodes.size - 1)
        assertTrue("Estimated card height $estimatedHeight exceeds its budget", estimatedHeight <= 400)
        nodes.forEach {
            val value = it.getString(")")
            val width = if (it.getString("-") == "40sp") 18 else 26
            assertTrue(value.codePointCount(0, value.length) <= width)
            assertFalse(value.contains('\n'))
            assertTrue(value.codePoints().allMatch { point -> point !in 0xD800..0xDFFF })
        }
        assertEquals("Timer 09:59", lines.last().text)
    }
}
