package dev.coach

import org.json.JSONObject

// Conservative native-font estimates; optical legibility still needs wearer confirmation.
internal object LessonPageLayout {
    const val CANVAS = 600
    const val CARD_WIDTH = 520
    const val TOP = 32
    const val PADDING = 24
    const val TEXT_WIDTH = CARD_WIDTH - PADDING * 2
    const val MAX_HEIGHT = 464
    enum class Style(val size: Int, val height: Int, val bold: Boolean = false) {
        CHAPTER(22, 28), TITLE(36, 44, true), BODY(28, 36), SUPPORT(28, 36, true), HINT(24, 30)
    }
    data class Row(val text: String, val style: Style, val gap: Int, val top: Int)
    data class Layout(val id: String, val template: String, val rows: List<Row>, val height: Int)

    fun width(text: String, style: Style): Double = text.codePoints().toArray().sumOf { point ->
        val factor = when {
            Character.isWhitespace(point) -> .34
            point > 0x2fff -> 1.0
            point.toChar() in "ilI.,:;!|'’‘" -> .32
            point.toChar() in "MW@#%" -> .92
            Character.isUpperCase(point) -> .70
            else -> .60
        }
        factor * style.size * if (style.bold) 1.04 else 1.0
    }

    private fun wrap(text: String, style: Style): List<String> = text.lines().flatMap { paragraph ->
        buildList {
            var line = ""
            for (word in paragraph.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }) {
                val candidate = if (line.isEmpty()) word else "$line $word"
                if (width(candidate, style) <= TEXT_WIDTH) { line = candidate; continue }
                if (line.isNotEmpty()) add(line)
                line = ""
                for (point in word.codePoints().toArray()) {
                    val character = String(Character.toChars(point))
                    if (width(line + character, style) > TEXT_WIDTH) { add(line); line = "" }
                    line += character
                }
            }
            if (line.isNotEmpty()) add(line)
        }
    }

    fun plan(page: JSONObject): Layout {
        val id = page.getString("id")
        val template = page.getString("template")
        require(template in setOf("teach", "show", "practice", "recap")) { "Unknown lesson template: $template" }
        val rows = mutableListOf<Row>()
        var height = PADDING
        fun block(text: String, style: Style, gap: Int) {
            require(text.isNotBlank() && text.length <= 1000) { "Lesson $id has an empty or oversized text block" }
            wrap(text, style).forEachIndexed { index, line ->
                val before = if (index == 0) gap else 0
                height += before
                rows += Row(line, style, before, TOP + height)
                height += style.height
            }
        }
        block(page.getString("chapter"), Style.CHAPTER, 0)
        block(page.getString("title"), Style.TITLE, 8)
        block(page.getString("body"), Style.BODY, 12)
        page.optJSONObject("support")?.let { support ->
            support.optString("title").takeIf { it.isNotBlank() }?.let { block(it, Style.SUPPORT, 16) }
            block(support.getString("body"), Style.BODY, if (support.optString("title").isBlank()) 16 else 4)
        }
        block(page.getString("hint"), Style.HINT, 16)
        height += PADDING
        require(height <= MAX_HEIGHT) { "Lesson $id needs ${height}px; split its content into shorter pages (maximum ${MAX_HEIGHT}px)" }
        return Layout(id, template, rows, height)
    }
}
