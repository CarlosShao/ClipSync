package com.clipsync.clipsync_mobile

import android.content.Context
import android.util.Log

/**
 * 原生文本上传器（2026-09）：POST /api/clipboard，契约与 Dart ClipboardCapture 一致
 * （contentType=text、contentEncrypted/preview=原文、Idempotency-Key 幂等键）。
 * 服务端按 content_hash 去重，多个调用方（无障碍采集 / 一键同步 Activity）并发
 * 上传同一内容不会产生重复条目。
 */
object NativeClipboardUploader {

    private const val TAG = "NativeTextUpload"
    private const val MAX_CONTENT_LENGTH = 100_000

    private val inFlight = java.util.concurrent.atomic.AtomicBoolean(false)

    fun uploadAsync(context: Context, text: String, onDone: ((Boolean) -> Unit)? = null) {
        val body = text
        if (body.isBlank() || body.length > MAX_CONTENT_LENGTH) {
            onDone?.invoke(false)
            return
        }
        val appContext = context.applicationContext
        Thread {
            val ok = uploadBlocking(appContext, body)
            Log.i(TAG, "text upload ${if (ok) "SUCCESS" else "FAILED"} (${body.length} chars)")
            android.os.Handler(android.os.Looper.getMainLooper()).post { onDone?.invoke(ok) }
        }.start()
    }

    private fun uploadBlocking(context: Context, text: String): Boolean {
        val sp = context.getSharedPreferences("clipsync_sync_config", Context.MODE_PRIVATE)
        val baseUrl = sp.getString("baseUrl", null)?.trimEnd('/') ?: return false
        val token = sp.getString("token", null) ?: return false
        val deviceId = sp.getString("deviceId", null) ?: return false

        if (!inFlight.compareAndSet(false, true)) return false
        try {
            for (attempt in 1..3) {
                var conn: java.net.HttpURLConnection? = null
                try {
                    conn = (java.net.URL("$baseUrl/api/clipboard").openConnection() as java.net.HttpURLConnection)
                    conn.requestMethod = "POST"
                    conn.connectTimeout = 10000
                    conn.readTimeout = 15000
                    conn.doOutput = true
                    conn.setRequestProperty("Authorization", "Bearer $token")
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.setRequestProperty("Idempotency-Key", "mobile-native-${System.nanoTime()}")

                    val payload = org.json.JSONObject().apply {
                        put("sourceDeviceId", deviceId)
                        put("contentType", "text")
                        put("contentEncrypted", text)
                        put("contentPreview", text)
                        put("contentSize", text.length)
                        put("metadata", org.json.JSONObject())
                    }
                    conn.outputStream.use { os ->
                        os.write(payload.toString().toByteArray(Charsets.UTF_8))
                        os.flush()
                    }
                    val code = conn.responseCode
                    if (code == 201 || code == 200) return true
                    Log.w(TAG, "attempt $attempt code=$code")
                    if (code in 400..499) return false
                } catch (t: Throwable) {
                    Log.w(TAG, "attempt $attempt error: ${t.message}")
                    if (attempt < 3) {
                        try { Thread.sleep(800L * attempt) } catch (_: Throwable) {}
                    }
                } finally {
                    try { conn?.disconnect() } catch (_: Throwable) {}
                }
            }
            return false
        } finally {
            inFlight.set(false)
        }
    }
}
