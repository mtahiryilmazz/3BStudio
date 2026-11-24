package com.photo2print.scanner

import android.content.Context
import android.media.Image
import android.opengl.Matrix
import com.google.ar.core.Config
import com.google.ar.core.Frame
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import java.nio.ByteOrder
import kotlin.math.roundToInt

data class Point3D(val xMm: Float, val yMm: Float, val zMm: Float)

/**
 * Captures world-space 3D millimeter point clouds using Google ARCore Raw Depth API.
 * Deduplicates points on a 2mm voxel grid to keep memory compact for 3D printing reconstruction.
 */
class ArDepthSessionManager(private val context: Context) {
    private var session: Session? = null
    private val voxelSet = HashSet<Long>(50_000)
    private val points = ArrayList<Point3D>(50_000)

    var isDepthSupported: Boolean = false
        private set

    fun initialize(): Boolean {
        val arSession = Session(context)
        isDepthSupported = arSession.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
        val config = arSession.config.apply {
            depthMode = if (isDepthSupported) Config.DepthMode.AUTOMATIC else Config.DepthMode.DISABLED
            focusMode = Config.FocusMode.AUTO
        }
        arSession.configure(config)
        session = arSession
        return isDepthSupported
    }

    fun resume() {
        session?.resume()
    }

    fun pause() {
        session?.pause()
    }

    fun close() {
        session?.close()
        session = null
    }

    fun clearScan() {
        voxelSet.clear()
        points.clear()
    }

    fun getPointCount(): Int = points.size

    fun snapshotPoints(): List<Point3D> = points.toList()

    /**
     * Call per GL frame while scanning is active. Unprojects confident depth pixels
     * (0.15m - 1.2m range) into world coordinates (millimeters).
     */
    fun processFrame(textureId: Int): Int {
        val arSession = session ?: return 0
        arSession.setCameraTextureName(textureId)
        val frame: Frame = arSession.update()
        val camera = frame.camera
        if (camera.trackingState != TrackingState.TRACKING) return 0

        var depthImage: Image? = null
        var confImage: Image? = null
        var added = 0

        try {
            depthImage = frame.acquireRawDepthImage16Bits()
            confImage = frame.acquireRawDepthConfidenceImage()

            val intrinsics = camera.imageIntrinsics
            val imgDims = intrinsics.imageDimensions
            val focal = intrinsics.focalLength
            val principal = intrinsics.principalPoint

            val dw = depthImage.width
            val dh = depthImage.height
            val scaleX = imgDims[0].toFloat() / dw.toFloat()
            val scaleY = imgDims[1].toFloat() / dh.toFloat()

            val depthBuf = depthImage.planes[0].buffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
            val confBuf = confImage.planes[0].buffer

            val modelMatrix = FloatArray(16)
            camera.pose.toMatrix(modelMatrix, 0)

            val step = 3 // Sample every 3rd pixel for real-time speed
            val localPt = FloatArray(4)
            val worldPt = FloatArray(4)

            for (y in 0 until dh step step) {
                for (x in 0 until dw step step) {
                    val idx = y * dw + x
                    val conf = confBuf.get(idx).toInt() and 0xFF
                    if (conf < 160) continue // Filter noisy low-confidence depth samples

                    val depthMm = depthBuf.get(idx).toInt() and 0xFFFF
                    if (depthMm < 150 || depthMm > 1200) continue // Tabletop scanning range: 15cm - 1.2m

                    val zMeters = depthMm / 1000f
                    val camX = ((x * scaleX) - principal[0]) * zMeters / focal[0]
                    val camY = -((y * scaleY) - principal[1]) * zMeters / focal[1]
                    val camZ = -zMeters

                    localPt[0] = camX
                    localPt[1] = camY
                    localPt[2] = camZ
                    localPt[3] = 1f

                    Matrix.multiplyMV(worldPt, 0, modelMatrix, 0, localPt, 0)
                    val xMm = worldPt[0] * 1000f
                    val yMm = worldPt[1] * 1000f
                    val zMm = worldPt[2] * 1000f

                    // 2mm voxel deduplication hash
                    val vx = (xMm / 2f).roundToInt().toLong() + 100_000L
                    val vy = (yMm / 2f).roundToInt().toLong() + 100_000L
                    val vz = (zMm / 2f).roundToInt().toLong() + 100_000L
                    val key = (vx shl 40) or (vy shl 20) or vz

                    if (voxelSet.add(key)) {
                        points.add(Point3D(xMm, yMm, zMm))
                        added++
                    }
                }
            }
        } catch (_: Exception) {
            // Depth frame may not be ready on every frame
        } finally {
            depthImage?.close()
            confImage?.close()
        }
        return added
    }
}
