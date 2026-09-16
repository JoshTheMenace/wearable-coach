package dev.coach

import com.google.protobuf.CodedOutputStream
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream

// DAT 0.9 display wire format over the pinned DAT 0.8 transport; no SDK versions are mixed.
object GlassesHudPayload {
    data class Line(val text: String, val heading: Boolean = false)
    private fun key(value: Int) = String(Character.toChars(value))
    private fun node(id: Int, attributes: JSONObject) = JSONObject().put(key(id), attributes)
    private fun column(children: JSONArray, alignment: String) = JSONObject()
        .put(key(41), "column").put(key(42), "no_wrap")
        .put(key(44), alignment).put(key(36), "stretch").put(key(32), children)
    private fun field(number: Int, bytes: ByteArray) = ByteArrayOutputStream().also { output ->
        CodedOutputStream.newInstance(output).also { it.writeByteArray(number, bytes); it.flush() }
    }.toByteArray()

    private fun Line.rowCost() = if (heading) 60 else 48 // Font line height plus 12 spacing.

    // Character widths are estimates, not measured pixels. Keep the full HUD on the phone.
    private fun presentation(lines: List<Line>): List<Line> {
        val rows = lines.flatMap { line ->
            val width = if (line.heading) 18 else 26
            line.text.lines().flatMap { paragraph ->
                val points = paragraph.codePoints().toArray()
                if (points.size <= width) listOf(Line(paragraph, line.heading)) else buildList {
                    var start = 0
                    while (start < points.size) {
                        var end = minOf(start + width, points.size)
                        if (end < points.size) {
                            end = (end - 1 downTo start + 1)
                                .firstOrNull { Character.isWhitespace(points[it]) } ?: end
                        }
                        add(Line(String(points, start, end - start), line.heading))
                        start = end
                        while (start < points.size && Character.isWhitespace(points[start])) start++
                    }
                }
            }
        }
        // 48 card padding; omit the first row's 12 gap. Reserve a body footer when truncated.
        if (36 + rows.sumOf { it.rowCost() } <= 400) return rows
        var height = 48 + 36
        return rows.takeWhile { height += it.rowCost(); height <= 400 } + Line("… More on phone")
    }

    fun encode(lines: List<Line>): ByteArray {
        val textNodes = JSONArray()
        presentation(lines).forEachIndexed { index, line ->
            val style = JSONObject().put(key(65), 0) // Prevent text shrinking; gap is a top margin.
            if (index > 0) style.put(key(49), "12")
            textNodes.put(node(13335, JSONObject().put(key(41), line.text)
                .put(key(35), if (line.heading) "optimistic-iris-hd-700" else "optimistic-iris-sd-400")
                .put(key(45), if (line.heading) "40sp" else "28sp")
                .put(key(59), if (line.heading) "48sp" else "36sp")
                .put(key(43), "#FFFFFF").put(key(132), node(24201, style))))
        }
        val children = JSONArray()
        if (lines.isNotEmpty()) {
            val content = column(textNodes, "flex_start")
                .put(key(59), "24").put(key(54), "24").put(key(58), "24").put(key(55), "24")
            // Canonical SDK 0.9 nested clickable CARD. Its click action intentionally has no app effect.
            children.put(node(22655, JSONObject()
                .put(key(32), JSONArray().put(node(13320, content)))
                .put(key(33), "coach_card").put(key(43), true)
                .put(key(132), node(24201, JSONObject().put(key(65), 0)))
                .put(key(133), JSONArray().put(node(23426, JSONObject().put(key(35), "(jl9 \"coach_card\")"))))
                .put(key(41), node(23457, JSONObject().put(key(38), "default").put(key(40), "medium")))))
        }
        // Short content otherwise sits at the bottom. This canvas was verified on Display firmware v128.
        val root = column(children, "center").put(key(132), node(24201, JSONObject()
            .put(key(58), "600").put(key(41), "600")))
        val envelope = JSONObject().put("layout", JSONObject().put("bloks_payload",
            JSONObject().put("tree", node(13320, root)).put("ft", JSONObject())))
        val gzip = ByteArrayOutputStream().also { output ->
            GZIPOutputStream(output).use { it.write(envelope.toString().toByteArray(Charsets.UTF_8)) }
        }.toByteArray()
        // DisplayRequestPayload.display_content(3) -> DisplayRequest.bloks_payload(3).
        return field(3, field(3, gzip))
    }
}
