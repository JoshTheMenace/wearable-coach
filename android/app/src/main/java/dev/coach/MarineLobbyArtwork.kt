package dev.coach

import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import java.io.ByteArrayOutputStream

internal object MarineLobbyArtwork {
    // The bundled original stays unchanged. Only the display transport gets a bounded encoding.
    fun encode(resources: Resources): ByteArray {
        val original = checkNotNull(BitmapFactory.decodeResource(resources, R.drawable.marine_seal))
        try {
            for (size in listOf(220, 200, 180)) {
                val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
                try {
                    Canvas(bitmap).apply {
                        drawColor(Color.BLACK)
                        drawBitmap(original, null, Rect(0, 0, size, size), Paint(Paint.FILTER_BITMAP_FLAG))
                    }
                    for (quality in listOf(85, 70, 55)) {
                        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, quality, it) }.toByteArray()
                        if (bytes.size <= 13_000) return bytes
                    }
                } finally { bitmap.recycle() }
            }
            error("Marine logo exceeds the display image budget")
        } finally { original.recycle() }
    }
}
