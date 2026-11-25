package com.photo2print.scanner

import android.Manifest
import android.content.pm.PackageManager
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import java.io.File
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

class MainActivity : ComponentActivity() {
    private lateinit var arManager: ArDepthSessionManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        arManager = ArDepthSessionManager(this)

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                ScannerScreen(arManager = arManager)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        arManager.resume()
    }

    override fun onPause() {
        super.onPause()
        arManager.pause()
    }

    override fun onDestroy() {
        super.onDestroy()
        arManager.close()
    }
}

@Composable
fun ScannerScreen(arManager: ArDepthSessionManager) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var hasCameraPerm by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted -> hasCameraPerm = granted }

    var isScanning by remember { mutableStateOf(false) }
    var depthSupported by remember { mutableStateOf<Boolean?>(null) }
    var pointCount by remember { mutableIntStateOf(0) }
    var pcUrl by remember { mutableStateOf("http://192.168.1.100:3000") }
    var sessionId by remember { mutableStateOf("") }
    var statusText by remember { mutableStateOf("Kamerayı masadaki kırık parçaya doğrultun.") }

    LaunchedEffect(hasCameraPerm) {
        if (!hasCameraPerm) {
            permLauncher.launch(Manifest.permission.CAMERA)
        } else if (depthSupported == null) {
            runCatching { arManager.initialize() }
                .onSuccess { supported ->
                    depthSupported = supported
                    statusText = if (supported) {
                        "ARCore Depth API hazır! Taramayı başlatabilirsiniz."
                    } else {
                        "Bu cihazda ARCore Depth sensörü yok; web QR fotoğraf taramayı kullanabilirsiniz."
                    }
                }
                .onFailure { err ->
                    depthSupported = false
                    statusText = "ARCore başlatılamadı: ${err.message}"
                }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF090D16))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            text = "3BStudio Android 3D Derinlik Tarayıcı",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            color = Color(0xFF38BDF8)
        )

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .background(Color(0xFF0F172A)),
            contentAlignment = Alignment.Center
        ) {
            if (hasCameraPerm && depthSupported == true) {
                AndroidView(
                    factory = { ctx ->
                        GLSurfaceView(ctx).apply {
                            setEGLContextClientVersion(2)
                            setRenderer(object : GLSurfaceView.Renderer {
                                private var texId = 0
                                override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
                                    val ids = IntArray(1)
                                    GLES20.glGenTextures(1, ids, 0)
                                    texId = ids[0]
                                    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texId)
                                }

                                override fun onSurfaceChanged(gl: GL10?, w: Int, h: Int) {
                                    GLES20.glViewport(0, 0, w, h)
                                }

                                override fun onDrawFrame(gl: GL10?) {
                                    GLES20.glClearColor(0.04f, 0.06f, 0.1f, 1f)
                                    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
                                    if (isScanning) {
                                        arManager.processFrame(texId)
                                        pointCount = arManager.getPointCount()
                                    }
                                }
                            })
                            renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
                        }
                    },
                    modifier = Modifier.fillMaxSize()
                )
            } else {
                Text(text = statusText, color = Color.LightGray, modifier = Modifier.padding(16.dp))
            }

            Surface(
                color = Color(0xCC0F172A),
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(12.dp)
            ) {
                Text(
                    text = "Toplanan Nokta: $pointCount",
                    color = Color(0xFF34D399),
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                )
            }
        }

        Text(text = statusText, style = MaterialTheme.typography.bodySmall, color = Color.LightGray)

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            Button(
                onClick = { isScanning = !isScanning },
                enabled = depthSupported == true,
                modifier = Modifier.weight(1f)
            ) {
                Text(if (isScanning) "Duraklat" else "Taramayı Başlat")
            }
            OutlinedButton(
                onClick = {
                    isScanning = false
                    arManager.clearScan()
                    pointCount = 0
                }
            ) {
                Text("Sıfırla")
            }
        }

        OutlinedTextField(
            value = pcUrl,
            onValueChange = { pcUrl = it },
            label = { Text("3BStudio adresi (örn: http://192.168.1.100:3000)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )

        OutlinedTextField(
            value = sessionId,
            onValueChange = { sessionId = it },
            label = { Text("Oturum Kodu (QR penceresindeki 6 haneli kod)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )

        Button(
            onClick = {
                val pts = arManager.snapshotPoints()
                if (pts.size < 20) {
                    statusText = "Önce parçanın etrafında biraz tarama yapın (en az 20 nokta)."
                    return@Button
                }
                scope.launch {
                    val outFile = File(context.cacheDir, "scan_${System.currentTimeMillis()}.ply")
                    PlyExporter.writeAsciiPly(pts, outFile)
                    statusText = ".PLY oluşturuldu (${pts.size} nokta), PC'ye gönderiliyor..."
                    val res = PlyExporter.uploadToPcStudio(pcUrl, sessionId, outFile)
                    statusText = res.fold(
                        onSuccess = { "✓ Nokta bulutu 3BStudio'ya aktarıldı!" },
                        onFailure = { e -> "Gönderim hatası: ${e.message}. Dosya: ${outFile.absolutePath}" }
                    )
                }
            },
            enabled = pointCount > 0 && sessionId.isNotBlank(),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(".PLY Olarak PC'ye Gönder (Otomatik 3D Mesh)")
        }
    }
}
