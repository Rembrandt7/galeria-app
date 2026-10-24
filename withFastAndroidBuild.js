const { withGradleProperties, withDangerousMod, withMainApplication } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const VIDEO_ENGINE_PACKAGE_KT = `package com.rembrant.galeriaapp

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class VideoEnginePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(VideoEngineModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
`;

const VIDEO_ENGINE_MODULE_KT = `package com.rembrant.galeriaapp

import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.media.MediaScannerConnection
import android.net.Uri
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.Matrix
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.Executors

class VideoEngineModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val executor = Executors.newSingleThreadExecutor()

    override fun getName(): String = "VideoEngineModule"

    private fun cleanFilePath(uriOrPath: String): String {
        var clean = uriOrPath.trim()
        if (clean.startsWith("file://")) {
            clean = clean.removePrefix("file://")
        }
        return try {
            java.net.URLDecoder.decode(clean, "UTF-8")
        } catch (e: Exception) {
            clean
        }
    }

    private fun emitProgress(percent: Double, stage: String) {
        try {
            val params = Arguments.createMap().apply {
                putDouble("percent", percent.coerceIn(0.0, 1.0))
                putString("stage", stage)
            }
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("VideoEngineProgress", params)
        } catch (e: Exception) {
            // ignore event emission errors
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Requerido por React Native NativeEventEmitter
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Requerido por React Native NativeEventEmitter
    }

    @ReactMethod
    fun copyToCacheNative(sourceUriOrPath: String, destPath: String, promise: Promise) {
        executor.execute {
            try {
                val cleanDest = cleanFilePath(destPath)
                val destFile = File(cleanDest)
                destFile.parentFile?.mkdirs()
                if (destFile.exists()) destFile.delete()

                val inputStream = if (sourceUriOrPath.startsWith("content://")) {
                    reactContext.contentResolver.openInputStream(Uri.parse(sourceUriOrPath))
                } else {
                    FileInputStream(File(cleanFilePath(sourceUriOrPath)))
                } ?: throw IllegalStateException("No se pudo abrir el archivo origen")

                inputStream.use { input ->
                    FileOutputStream(destFile, false).use { output ->
                        val buf = ByteArray(64 * 1024)
                        var len: Int
                        while (input.read(buf).also { len = it } > 0) {
                            output.write(buf, 0, len)
                        }
                        output.flush()
                    }
                }
                promise.resolve("file://" + destFile.absolutePath)
            } catch (e: Exception) {
                promise.reject("COPY_ERROR", e.message ?: "Error al copiar archivo a caché", e)
            }
        }
    }

    @ReactMethod
    fun overwriteFileNative(sourcePath: String, targetUriOrPath: String, promise: Promise) {
        executor.execute {
            try {
                val srcFile = File(cleanFilePath(sourcePath))
                if (!srcFile.exists() || srcFile.length() <= 0L) {
                    throw IllegalStateException("El archivo comprimido/recortado temporal no existe o está vacío.")
                }

                // 1. Si el destino es content://, intentar también extraer su ruta física real si pertenece a almacenamiento primario
                var writtenPhysicalPath: String? = null
                if (!targetUriOrPath.startsWith("content://")) {
                    val destFile = File(cleanFilePath(targetUriOrPath))
                    FileInputStream(srcFile).use { input ->
                        FileOutputStream(destFile, false).use { output ->
                            output.channel.truncate(0L)
                            val buf = ByteArray(64 * 1024)
                            var len: Int
                            while (input.read(buf).also { len = it } > 0) {
                                output.write(buf, 0, len)
                            }
                            output.flush()
                            output.fd.sync()
                        }
                    }
                    writtenPhysicalPath = destFile.absolutePath
                } else {
                    // Intentar vía ContentResolver en modo "wt" (write + truncate)
                    val uri = Uri.parse(targetUriOrPath)
                    val outStream = reactContext.contentResolver.openOutputStream(uri, "wt")
                        ?: reactContext.contentResolver.openOutputStream(uri, "w")
                        ?: throw IllegalStateException("ContentResolver no permitió abrir el destino en modo escritura")
                    FileInputStream(srcFile).use { input ->
                        outStream.use { output ->
                            val buf = ByteArray(64 * 1024)
                            var len: Int
                            while (input.read(buf).also { len = it } > 0) {
                                output.write(buf, 0, len)
                            }
                            output.flush()
                        }
                    }
                }

                if (writtenPhysicalPath != null) {
                    try {
                        MediaScannerConnection.scanFile(
                            reactContext,
                            arrayOf(writtenPhysicalPath),
                            null,
                            null
                        )
                    } catch (_: Exception) {}
                }

                val res = Arguments.createMap().apply {
                    putBoolean("success", true)
                    putDouble("sizeBytes", srcFile.length().toDouble())
                }
                promise.resolve(res)
            } catch (e: Exception) {
                promise.reject("OVERWRITE_ERROR", e.message ?: "No se pudo sobrescribir el archivo original", e)
            }
        }
    }

    @ReactMethod
    fun getVideoMetadata(sourcePath: String, promise: Promise) {
        executor.execute {
            val retriever = MediaMetadataRetriever()
            try {
                val path = cleanFilePath(sourcePath)
                val file = File(path)
                retriever.setDataSource(path)

                val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
                val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
                val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
                val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                val bitrate = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toLongOrNull() ?: 0L
                val sizeBytes = if (file.exists()) file.length() else 0L

                val map = Arguments.createMap().apply {
                    putInt("width", width)
                    putInt("height", height)
                    putInt("rotation", rotation)
                    putDouble("durationMs", durationMs.toDouble())
                    putDouble("bitrate", bitrate.toDouble())
                    putDouble("sizeBytes", sizeBytes.toDouble())
                }
                promise.resolve(map)
            } catch (e: Exception) {
                promise.reject("METADATA_ERROR", e.message ?: "No se pudo leer metadatos del video", e)
            } finally {
                try {
                    retriever.release()
                } catch (_: Exception) {}
            }
        }
    }

    private data class SegmentUs(val startUs: Long, val endUs: Long, val offsetUs: Long)

    private fun parseSegmentsUs(segments: ReadableArray?, totalDurationUs: Long): List<SegmentUs> {
        val raw = mutableListOf<Pair<Long, Long>>()
        if (segments != null && segments.size() > 0) {
            for (i in 0 until segments.size()) {
                val map = segments.getMap(i) ?: continue
                val sMs = if (map.hasKey("startMs")) map.getDouble("startMs") else 0.0
                val eMs = if (map.hasKey("endMs")) map.getDouble("endMs") else (totalDurationUs / 1000.0)
                val sUs = (sMs * 1000.0).toLong().coerceAtLeast(0L)
                val eUs = (eMs * 1000.0).toLong().coerceAtMost(if (totalDurationUs > 0) totalDurationUs else Long.MAX_VALUE)
                if (eUs > sUs + 50_000L) {
                    raw.add(Pair(sUs, eUs))
                }
            }
        }
        if (raw.isEmpty()) {
            val end = if (totalDurationUs > 0) totalDurationUs else Long.MAX_VALUE
            raw.add(Pair(0L, end))
        }
        raw.sortBy { it.first }

        val result = mutableListOf<SegmentUs>()
        var accumulatedUs = 0L
        for (pair in raw) {
            result.add(SegmentUs(pair.first, pair.second, accumulatedUs))
            accumulatedUs += (pair.second - pair.first)
        }
        return result
    }

    /**
     * Une uno o múltiples tramos de un video de forma instantánea (Stream Copy sin pérdida de calidad ni resolución)
     */
    @ReactMethod
    fun trimSegments(sourcePath: String, outputPath: String, segments: ReadableArray, promise: Promise) {
        executor.execute {
            val inPath = cleanFilePath(sourcePath)
            val outPath = cleanFilePath(outputPath)
            var muxer: MediaMuxer? = null
            val videoExtractor = MediaExtractor()
            val audioExtractor = MediaExtractor()
            val retriever = MediaMetadataRetriever()

            try {
                File(outPath).parentFile?.mkdirs()
                if (File(outPath).exists()) File(outPath).delete()

                retriever.setDataSource(inPath)
                val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
                val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                val totalDurationUs = durationMs * 1000L

                val segList = parseSegmentsUs(segments, totalDurationUs)
                val totalTargetUs = segList.sumOf { (it.endUs - it.startUs).coerceAtLeast(1L) }.coerceAtLeast(1L)

                videoExtractor.setDataSource(inPath)
                audioExtractor.setDataSource(inPath)

                var videoTrackIdx = -1
                var audioTrackIdx = -1
                var muxerVideoTrack = -1
                var muxerAudioTrack = -1
                var maxBufferSize = 2 * 1024 * 1024

                muxer = MediaMuxer(outPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                if (rotation != 0) {
                    muxer.setOrientationHint(rotation)
                }

                for (i in 0 until videoExtractor.trackCount) {
                    val format = videoExtractor.getTrackFormat(i)
                    val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
                    if (mime.startsWith("video/") && videoTrackIdx == -1) {
                        videoTrackIdx = i
                        muxerVideoTrack = muxer.addTrack(format)
                        if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
                            maxBufferSize = maxOf(maxBufferSize, format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
                        }
                    } else if (mime.startsWith("audio/") && audioTrackIdx == -1) {
                        audioTrackIdx = i
                        muxerAudioTrack = muxer.addTrack(format)
                        if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
                            maxBufferSize = maxOf(maxBufferSize, format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
                        }
                    }
                }

                if (videoTrackIdx == -1) {
                    throw IllegalStateException("No se encontró pista de video válida.")
                }

                muxer.start()
                val buffer = ByteBuffer.allocateDirect(maxBufferSize)
                val bufferInfo = MediaCodec.BufferInfo()

                // 1. Copiar tramos de video
                videoExtractor.selectTrack(videoTrackIdx)
                var lastVideoPtsUs = -1L
                val actualSegmentStartOffsets = mutableListOf<SegmentUs>()
                var runningOffsetUs = 0L

                for ((segIdx, seg) in segList.withIndex()) {
                    videoExtractor.seekTo(seg.startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
                    var firstSamplePts = -1L
                    var lastSampleInSegPts = seg.startUs

                    while (true) {
                        bufferInfo.offset = 0
                        bufferInfo.size = videoExtractor.readSampleData(buffer, 0)
                        if (bufferInfo.size < 0) break

                        val sampleTime = videoExtractor.sampleTime
                        if (sampleTime < 0 || sampleTime > seg.endUs) break

                        if (firstSamplePts == -1L) {
                            firstSamplePts = sampleTime
                        }

                        var newPts = runningOffsetUs + (sampleTime - firstSamplePts).coerceAtLeast(0L)
                        if (newPts <= lastVideoPtsUs) {
                            newPts = lastVideoPtsUs + 1000L
                        }
                        lastVideoPtsUs = newPts
                        lastSampleInSegPts = sampleTime

                        bufferInfo.presentationTimeUs = newPts
                        bufferInfo.flags = if ((videoExtractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) {
                            MediaCodec.BUFFER_FLAG_KEY_FRAME
                        } else {
                            0
                        }
                        muxer.writeSampleData(muxerVideoTrack, buffer, bufferInfo)
                        videoExtractor.advance()
                    }

                    val actualStart = if (firstSamplePts >= 0L) firstSamplePts else seg.startUs
                    val actualEnd = maxOf(actualStart + 1000L, lastSampleInSegPts)
                    actualSegmentStartOffsets.add(SegmentUs(actualStart, actualEnd, runningOffsetUs))
                    runningOffsetUs = (lastVideoPtsUs + 33_333L).coerceAtLeast(runningOffsetUs)

                    emitProgress(((segIdx + 1).toDouble() / segList.size.toDouble()) * 0.85, "Recortando y uniendo tramos...")
                }

                // 2. Copiar tramos de audio sincronizados con el inicio real de cada tramo de video
                if (audioTrackIdx != -1 && muxerAudioTrack != -1) {
                    audioExtractor.selectTrack(audioTrackIdx)
                    var lastAudioPtsUs = -1L
                    for (seg in actualSegmentStartOffsets) {
                        audioExtractor.seekTo(seg.startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
                        while (true) {
                            bufferInfo.offset = 0
                            bufferInfo.size = audioExtractor.readSampleData(buffer, 0)
                            if (bufferInfo.size < 0) break

                            val sampleTime = audioExtractor.sampleTime
                            if (sampleTime < 0 || sampleTime > seg.endUs) break

                            if (sampleTime >= seg.startUs) {
                                var newPts = seg.offsetUs + (sampleTime - seg.startUs)
                                if (newPts <= lastAudioPtsUs) {
                                    newPts = lastAudioPtsUs + 500L
                                }
                                lastAudioPtsUs = newPts
                                bufferInfo.presentationTimeUs = newPts
                                bufferInfo.flags = if ((audioExtractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) {
                                    MediaCodec.BUFFER_FLAG_KEY_FRAME
                                } else {
                                    0
                                }
                                muxer.writeSampleData(muxerAudioTrack, buffer, bufferInfo)
                            }
                            audioExtractor.advance()
                        }
                    }
                }

                emitProgress(1.0, "¡Tramos listos!")
                val outFile = File(outPath)
                val res = Arguments.createMap().apply {
                    putString("outputPath", "file://" + outFile.absolutePath)
                    putDouble("sizeBytes", outFile.length().toDouble())
                }
                promise.resolve(res)
            } catch (e: Exception) {
                promise.reject("TRIM_ERROR", e.message ?: "Error al recortar tramos del video", e)
            } finally {
                try { videoExtractor.release() } catch (_: Exception) {}
                try { audioExtractor.release() } catch (_: Exception) {}
                try { retriever.release() } catch (_: Exception) {}
                try { muxer?.stop() } catch (_: Exception) {}
                try { muxer?.release() } catch (_: Exception) {}
            }
        }
    }

    /**
     * Comprime el video por hardware (GPU/MediaCodec) manteniendo el 100% de la resolución original (width x height)
     */
    @ReactMethod
    fun compressVideo(
        sourcePath: String,
        outputPath: String,
        qualityFactor: Double,
        segments: ReadableArray?,
        promise: Promise
    ) {
        executor.execute {
            val inPath = cleanFilePath(sourcePath)
            val outPath = cleanFilePath(outputPath)

            val videoExtractor = MediaExtractor()
            val audioExtractor = MediaExtractor()
            val retriever = MediaMetadataRetriever()
            var decoder: MediaCodec? = null
            var encoder: MediaCodec? = null
            var muxer: MediaMuxer? = null
            var surfaceBridge: TranscodeSurfaceBridge? = null

            try {
                File(outPath).parentFile?.mkdirs()
                if (File(outPath).exists()) File(outPath).delete()

                val inFile = File(inPath)
                val origSizeBytes = if (inFile.exists()) inFile.length() else 0L

                retriever.setDataSource(inPath)
                val origWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 1280
                val origHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 720
                val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
                val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 1000L
                val metaBitrate = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toLongOrNull() ?: 0L

                val totalDurationUs = (durationMs * 1000L).coerceAtLeast(100_000L)
                val segList = parseSegmentsUs(segments, totalDurationUs)
                val totalTargetUs = segList.sumOf { (it.endUs - it.startUs).coerceAtLeast(1L) }.coerceAtLeast(1L)
                val lastSegEndUs = segList.last().endUs

                videoExtractor.setDataSource(inPath)
                audioExtractor.setDataSource(inPath)

                var videoTrackIdx = -1
                var audioTrackIdx = -1
                var inputVideoFormat: MediaFormat? = null
                var inputAudioFormat: MediaFormat? = null

                for (i in 0 until videoExtractor.trackCount) {
                    val fmt = videoExtractor.getTrackFormat(i)
                    val mime = fmt.getString(MediaFormat.KEY_MIME) ?: ""
                    if (mime.startsWith("video/") && videoTrackIdx == -1) {
                        videoTrackIdx = i
                        inputVideoFormat = fmt
                    } else if (mime.startsWith("audio/") && audioTrackIdx == -1) {
                        audioTrackIdx = i
                        inputAudioFormat = fmt
                    }
                }

                if (videoTrackIdx == -1 || inputVideoFormat == null) {
                    throw IllegalStateException("El archivo no contiene una pista de video compatible.")
                }

                // Alinear ancho y alto a múltiplos de 2 conservando 100% la resolución original
                val encWidth = (origWidth and 0xFFFE).coerceAtLeast(16)
                val encHeight = (origHeight and 0xFFFE).coerceAtLeast(16)

                var frameRate = 30
                if (inputVideoFormat.containsKey(MediaFormat.KEY_FRAME_RATE)) {
                    try {
                        frameRate = inputVideoFormat.getInteger(MediaFormat.KEY_FRAME_RATE).coerceIn(15, 60)
                    } catch (_: Exception) {
                        try {
                            frameRate = inputVideoFormat.getFloat(MediaFormat.KEY_FRAME_RATE).toInt().coerceIn(15, 60)
                        } catch (_: Exception) {}
                    }
                }

                // Calcular bitrate objetivo inteligente garantizando reducción real de peso a resolución 100% original
                val estimatedOrigBitrate = if (metaBitrate > 0L) {
                    metaBitrate
                } else {
                    ((origSizeBytes * 8L * 1000L) / durationMs.coerceAtLeast(1L)).coerceAtLeast(1_500_000L)
                }

                val factor = qualityFactor.coerceIn(0.20, 0.85)
                val bppBudget = (encWidth.toLong() * encHeight.toLong() * frameRate.toLong() * (0.13 * factor)).toLong()
                val directRatioBudget = (estimatedOrigBitrate.toDouble() * factor).toLong()
                val targetBitrate = minOf(directRatioBudget, bppBudget)
                    .coerceIn(500_000L, 22_000_000L)
                    .toInt()

                val outMime = MediaFormat.MIMETYPE_VIDEO_AVC
                val outputVideoFormat = MediaFormat.createVideoFormat(outMime, encWidth, encHeight).apply {
                    setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                    setInteger(MediaFormat.KEY_BIT_RATE, targetBitrate)
                    setInteger(MediaFormat.KEY_FRAME_RATE, frameRate)
                    setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
                }

                encoder = MediaCodec.createEncoderByType(outMime)
                encoder.configure(outputVideoFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                val encoderInputSurface = encoder.createInputSurface()
                surfaceBridge = TranscodeSurfaceBridge(encoderInputSurface, encWidth, encHeight)
                encoder.start()

                val inMime = inputVideoFormat.getString(MediaFormat.KEY_MIME) ?: MediaFormat.MIMETYPE_VIDEO_AVC
                decoder = MediaCodec.createDecoderByType(inMime)
                decoder.configure(inputVideoFormat, surfaceBridge.decoderOutputSurface, null, 0)
                decoder.start()

                muxer = MediaMuxer(outPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                if (rotation != 0) {
                    muxer.setOrientationHint(rotation)
                }

                var muxerAudioTrack = -1
                if (audioTrackIdx != -1 && inputAudioFormat != null) {
                    try {
                        muxerAudioTrack = muxer.addTrack(inputAudioFormat)
                    } catch (_: Exception) {
                        muxerAudioTrack = -1
                    }
                }

                videoExtractor.selectTrack(videoTrackIdx)
                if (segList.first().startUs > 0L) {
                    videoExtractor.seekTo(segList.first().startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
                }

                val decBufferInfo = MediaCodec.BufferInfo()
                val encBufferInfo = MediaCodec.BufferInfo()
                var inputDone = false
                var decoderDone = false
                var encoderDone = false
                var muxerStarted = false
                var muxerVideoTrack = -1
                var lastEncodedPtsUs = -1L
                var lastProgressEmitMs = 0L

                fun mapPtsToSegments(ptsUs: Long): Long? {
                    for (seg in segList) {
                        if (ptsUs >= seg.startUs && ptsUs <= seg.endUs) {
                            return seg.offsetUs + (ptsUs - seg.startUs)
                        }
                    }
                    return null
                }

                while (!encoderDone) {
                    // 1. Alimentar el decoder
                    if (!inputDone) {
                        val inBufIdx = decoder.dequeueInputBuffer(5_000L)
                        if (inBufIdx >= 0) {
                            val inBuf = decoder.getInputBuffer(inBufIdx)
                            if (inBuf != null) {
                                val sampleSize = videoExtractor.readSampleData(inBuf, 0)
                                val sampleTime = videoExtractor.sampleTime
                                if (sampleSize < 0 || (sampleTime > lastSegEndUs && lastSegEndUs < Long.MAX_VALUE)) {
                                    decoder.queueInputBuffer(
                                        inBufIdx, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM
                                    )
                                    inputDone = true
                                } else {
                                    decoder.queueInputBuffer(
                                        inBufIdx, 0, sampleSize, sampleTime, videoExtractor.sampleFlags
                                    )
                                    videoExtractor.advance()
                                }
                            }
                        }
                    }

                    // 2. Drenar el decoder y renderizar hacia el encoder si el cuadro pertenece a un tramo activo
                    if (!decoderDone) {
                        val decStatus = decoder.dequeueOutputBuffer(decBufferInfo, 5_000L)
                        if (decStatus >= 0) {
                            val isEos = (decBufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                            val ptsUs = decBufferInfo.presentationTimeUs
                            val mappedPtsUs = if (decBufferInfo.size > 0) mapPtsToSegments(ptsUs) else null
                            val doRender = mappedPtsUs != null

                            decoder.releaseOutputBuffer(decStatus, doRender)

                            if (doRender && mappedPtsUs != null) {
                                var safePtsUs = mappedPtsUs
                                if (safePtsUs <= lastEncodedPtsUs) {
                                    safePtsUs = lastEncodedPtsUs + 1000L
                                }
                                lastEncodedPtsUs = safePtsUs

                                if (surfaceBridge.awaitNewImage()) {
                                    surfaceBridge.drawImage(safePtsUs * 1000L)
                                    surfaceBridge.swapBuffers()
                                }

                                val now = System.currentTimeMillis()
                                if (now - lastProgressEmitMs > 140L) {
                                    lastProgressEmitMs = now
                                    val pct = (safePtsUs.toDouble() / totalTargetUs.toDouble()).coerceIn(0.0, 0.92)
                                    emitProgress(pct, "Comprimiendo video (100% resolución)...")
                                }
                            }

                            if (isEos) {
                                decoderDone = true
                                encoder.signalEndOfInputStream()
                            }
                        }
                    }

                    // 3. Drenar el encoder hacia el MediaMuxer
                    while (true) {
                        val encStatus = encoder.dequeueOutputBuffer(encBufferInfo, 5_000L)
                        if (encStatus == MediaCodec.INFO_TRY_AGAIN_LATER) {
                            break
                        } else if (encStatus == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                            if (!muxerStarted) {
                                muxerVideoTrack = muxer.addTrack(encoder.outputFormat)
                                muxer.start()
                                muxerStarted = true
                            }
                        } else if (encStatus >= 0) {
                            val encodedData = encoder.getOutputBuffer(encStatus)
                            if ((encBufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                                encBufferInfo.size = 0
                            }
                            if (encBufferInfo.size > 0 && muxerStarted && encodedData != null) {
                                encodedData.position(encBufferInfo.offset)
                                encodedData.limit(encBufferInfo.offset + encBufferInfo.size)
                                muxer.writeSampleData(muxerVideoTrack, encodedData, encBufferInfo)
                            }
                            encoder.releaseOutputBuffer(encStatus, false)
                            if ((encBufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                                encoderDone = true
                                break
                            }
                        }
                    }
                }

                // 4. Copiar el audio original sin pérdida para los tramos activos
                if (muxerStarted && muxerAudioTrack != -1 && audioTrackIdx != -1) {
                    emitProgress(0.95, "Sincronizando pista de audio...")
                    audioExtractor.selectTrack(audioTrackIdx)
                    val audioBuf = ByteBuffer.allocateDirect(512 * 1024)
                    val audioInfo = MediaCodec.BufferInfo()
                    var lastAudioPtsUs = -1L

                    for (seg in segList) {
                        audioExtractor.seekTo(seg.startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
                        while (true) {
                            audioInfo.offset = 0
                            audioInfo.size = audioExtractor.readSampleData(audioBuf, 0)
                            if (audioInfo.size < 0) break

                            val sampleTime = audioExtractor.sampleTime
                            if (sampleTime < 0 || sampleTime > seg.endUs) break

                            if (sampleTime >= seg.startUs) {
                                var newPts = seg.offsetUs + (sampleTime - seg.startUs)
                                if (newPts <= lastAudioPtsUs) {
                                    newPts = lastAudioPtsUs + 500L
                                }
                                lastAudioPtsUs = newPts
                                audioInfo.presentationTimeUs = newPts
                                audioInfo.flags = if ((audioExtractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) {
                                    MediaCodec.BUFFER_FLAG_KEY_FRAME
                                } else {
                                    0
                                }
                                muxer.writeSampleData(muxerAudioTrack, audioBuf, audioInfo)
                            }
                            audioExtractor.advance()
                        }
                    }
                }

                emitProgress(1.0, "¡Compresión completada!")
                val outFile = File(outPath)
                val res = Arguments.createMap().apply {
                    putString("outputPath", "file://" + outFile.absolutePath)
                    putDouble("sizeBytes", outFile.length().toDouble())
                    putDouble("originalSizeBytes", origSizeBytes.toDouble())
                    putInt("width", encWidth)
                    putInt("height", encHeight)
                    putInt("targetBitrate", targetBitrate)
                }
                promise.resolve(res)
            } catch (e: Exception) {
                promise.reject("COMPRESS_ERROR", e.message ?: "Error al comprimir el video", e)
            } finally {
                try { videoExtractor.release() } catch (_: Exception) {}
                try { audioExtractor.release() } catch (_: Exception) {}
                try { retriever.release() } catch (_: Exception) {}
                try { decoder?.stop() } catch (_: Exception) {}
                try { decoder?.release() } catch (_: Exception) {}
                try { encoder?.stop() } catch (_: Exception) {}
                try { encoder?.release() } catch (_: Exception) {}
                try { surfaceBridge?.release() } catch (_: Exception) {}
                try { muxer?.stop() } catch (_: Exception) {}
                try { muxer?.release() } catch (_: Exception) {}
            }
        }
    }
}

/**
 * Puente OpenGL ES 2.0 / EGL14 entre la salida del Decoder y la superficie de entrada del Encoder
 * manteniendo el 100% de la resolución original en GPU sin copias en CPU.
 */
private class TranscodeSurfaceBridge(
    private val encoderSurface: Surface,
    private val width: Int,
    private val height: Int
) : SurfaceTexture.OnFrameAvailableListener {

    private var eglDisplay: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var eglContext: EGLContext = EGL14.EGL_NO_CONTEXT
    private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE

    private var surfaceTexture: SurfaceTexture? = null
    var decoderOutputSurface: Surface? = null
        private set

    private val frameSyncObject = Object()
    private var frameAvailable = false
    private val handlerThread = HandlerThread("VideoEngineFrameListener")

    private var program = 0
    private var textureId = -12345
    private var uMVPMatrixHandle = 0
    private var uSTMatrixHandle = 0
    private var aPositionHandle = 0
    private var aTextureHandle = 0

    private val mMVPMatrix = FloatArray(16)
    private val mSTMatrix = FloatArray(16)
    private val triangleVertices: FloatBuffer

    init {
        val verticesData = floatArrayOf(
            // X, Y, Z, U, V
            -1.0f, -1.0f, 0f, 0f, 0f,
             1.0f, -1.0f, 0f, 1f, 0f,
            -1.0f,  1.0f, 0f, 0f, 1f,
             1.0f,  1.0f, 0f, 1f, 1f
        )
        triangleVertices = ByteBuffer.allocateDirect(verticesData.size * 4)
            .order(ByteOrder.nativeOrder())
            .asFloatBuffer()
        triangleVertices.put(verticesData).position(0)
        Matrix.setIdentityM(mSTMatrix, 0)

        initEGL()
        initGL()

        handlerThread.start()
        val st = SurfaceTexture(textureId)
        st.setOnFrameAvailableListener(this, Handler(handlerThread.looper))
        surfaceTexture = st
        decoderOutputSurface = Surface(st)
    }

    private fun initEGL() {
        eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val version = IntArray(2)
        EGL14.eglInitialize(eglDisplay, version, 0, version, 1)

        val attribList = intArrayOf(
            EGL14.EGL_RED_SIZE, 8,
            EGL14.EGL_GREEN_SIZE, 8,
            EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            0x3142, 1, // EGL_RECORDABLE_ANDROID
            EGL14.EGL_NONE
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val numConfigs = IntArray(1)
        EGL14.eglChooseConfig(eglDisplay, attribList, 0, configs, 0, configs.size, numConfigs, 0)

        val ctxAttribs = intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE)
        eglContext = EGL14.eglCreateContext(eglDisplay, configs[0], EGL14.EGL_NO_CONTEXT, ctxAttribs, 0)

        val surfaceAttribs = intArrayOf(EGL14.EGL_NONE)
        eglSurface = EGL14.eglCreateWindowSurface(eglDisplay, configs[0], encoderSurface, surfaceAttribs, 0)
        EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)
    }

    private fun loadShader(shaderType: Int, source: String): Int {
        val shader = GLES20.glCreateShader(shaderType)
        GLES20.glShaderSource(shader, source)
        GLES20.glCompileShader(shader)
        return shader
    }

    private fun initGL() {
        val vertexShader = """
            uniform mat4 uMVPMatrix;
            uniform mat4 uSTMatrix;
            attribute vec4 aPosition;
            attribute vec4 aTextureCoord;
            varying vec2 vTextureCoord;
            void main() {
                gl_Position = uMVPMatrix * aPosition;
                vTextureCoord = (uSTMatrix * aTextureCoord).xy;
            }
        """.trimIndent()

        val fragmentShader = """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            varying vec2 vTextureCoord;
            uniform samplerExternalOES sTexture;
            void main() {
                gl_FragColor = texture2D(sTexture, vTextureCoord);
            }
        """.trimIndent()

        val vs = loadShader(GLES20.GL_VERTEX_SHADER, vertexShader)
        val fs = loadShader(GLES20.GL_FRAGMENT_SHADER, fragmentShader)
        program = GLES20.glCreateProgram()
        GLES20.glAttachShader(program, vs)
        GLES20.glAttachShader(program, fs)
        GLES20.glLinkProgram(program)

        aPositionHandle = GLES20.glGetAttribLocation(program, "aPosition")
        aTextureHandle = GLES20.glGetAttribLocation(program, "aTextureCoord")
        uMVPMatrixHandle = GLES20.glGetUniformLocation(program, "uMVPMatrix")
        uSTMatrixHandle = GLES20.glGetUniformLocation(program, "uSTMatrix")

        val textures = IntArray(1)
        GLES20.glGenTextures(1, textures, 0)
        textureId = textures[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)
        GLES20.glTexParameterf(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR.toFloat())
        GLES20.glTexParameterf(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR.toFloat())
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    }

    override fun onFrameAvailable(st: SurfaceTexture?) {
        synchronized(frameSyncObject) {
            frameAvailable = true
            frameSyncObject.notifyAll()
        }
    }

    fun awaitNewImage(): Boolean {
        synchronized(frameSyncObject) {
            var waited = 0
            while (!frameAvailable && waited < 600) {
                try {
                    frameSyncObject.wait(100)
                    waited += 100
                } catch (_: InterruptedException) {
                    break
                }
            }
            if (!frameAvailable) return false
            frameAvailable = false
        }
        surfaceTexture?.updateTexImage()
        return true
    }

    fun drawImage(presentationTimeNs: Long) {
        val st = surfaceTexture ?: return
        st.getTransformMatrix(mSTMatrix)

        GLES20.glViewport(0, 0, width, height)
        GLES20.glClearColor(0.0f, 0.0f, 0.0f, 1.0f)
        GLES20.glClear(GLES20.GL_DEPTH_BUFFER_BIT or GLES20.GL_COLOR_BUFFER_BIT)
        GLES20.glUseProgram(program)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)

        triangleVertices.position(0)
        GLES20.glVertexAttribPointer(aPositionHandle, 3, GLES20.GL_FLOAT, false, 20, triangleVertices)
        GLES20.glEnableVertexAttribArray(aPositionHandle)

        triangleVertices.position(3)
        GLES20.glVertexAttribPointer(aTextureHandle, 2, GLES20.GL_FLOAT, false, 20, triangleVertices)
        GLES20.glEnableVertexAttribArray(aTextureHandle)

        Matrix.setIdentityM(mMVPMatrix, 0)
        GLES20.glUniformMatrix4fv(uMVPMatrixHandle, 1, false, mMVPMatrix, 0)
        GLES20.glUniformMatrix4fv(uSTMatrixHandle, 1, false, mSTMatrix, 0)

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glFinish()

        EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, presentationTimeNs)
    }

    fun swapBuffers() {
        EGL14.eglSwapBuffers(eglDisplay, eglSurface)
    }

    fun release() {
        try { handlerThread.quitSafely() } catch (_: Exception) {}
        if (eglDisplay !== EGL14.EGL_NO_DISPLAY) {
            EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            EGL14.eglDestroySurface(eglDisplay, eglSurface)
            EGL14.eglDestroyContext(eglDisplay, eglContext)
            EGL14.eglReleaseThread()
            EGL14.eglTerminate(eglDisplay)
        }
        eglDisplay = EGL14.EGL_NO_DISPLAY
        eglContext = EGL14.EGL_NO_CONTEXT
        eglSurface = EGL14.EGL_NO_SURFACE
        try { decoderOutputSurface?.release() } catch (_: Exception) {}
        try { surfaceTexture?.release() } catch (_: Exception) {}
        try { encoderSurface.release() } catch (_: Exception) {}
        decoderOutputSurface = null
        surfaceTexture = null
    }
}
`;

module.exports = function withFastAndroidBuild(config) {
  // 1. Optimización de compilación Gradle y arquitecturas ARM
  config = withGradleProperties(config, (gradleConfig) => {
    const setProp = (key, value) => {
      const idx = gradleConfig.modResults.findIndex(
        (item) => item.type === 'property' && item.key === key
      );
      if (idx >= 0) {
        gradleConfig.modResults[idx].value = value;
      } else {
        gradleConfig.modResults.push({ type: 'property', key, value });
      }
    };

    setProp('reactNativeArchitectures', 'arm64-v8a,armeabi-v7a');
    setProp('org.gradle.parallel', 'true');
    setProp('org.gradle.caching', 'true');
    setProp('org.gradle.configureondemand', 'true');
    setProp('org.gradle.jvmargs', '-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8');

    return gradleConfig;
  });

  // 2. Inyectar motor nativo de compresión y recorte multi-tramo de video (VideoEngineModule)
  config = withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const pkgDir = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        'com',
        'rembrant',
        'galeriaapp'
      );
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'VideoEnginePackage.kt'), VIDEO_ENGINE_PACKAGE_KT, 'utf8');
      fs.writeFileSync(path.join(pkgDir, 'VideoEngineModule.kt'), VIDEO_ENGINE_MODULE_KT, 'utf8');
      return modConfig;
    },
  ]);

  // 3. Registrar VideoEnginePackage en MainApplication.kt
  config = withMainApplication(config, (appConfig) => {
    let contents = appConfig.modResults.contents;
    if (!contents.includes('VideoEnginePackage')) {
      if (contents.includes('PackageList(this).packages.apply {')) {
        contents = contents.replace(
          'PackageList(this).packages.apply {',
          'PackageList(this).packages.apply {\n              add(VideoEnginePackage())'
        );
      } else if (contents.includes('PackageList(this).packages')) {
        contents = contents.replace(
          'PackageList(this).packages',
          'PackageList(this).packages.apply { add(VideoEnginePackage()) }'
        );
      }
      appConfig.modResults.contents = contents;
    }
    return appConfig;
  });

  return config;
};
