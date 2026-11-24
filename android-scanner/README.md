# Photo2Print Android 3D Tarayıcı (ARCore Depth API)

Bu klasör, **Android telefonunuzun derinlik algılama / ARCore Depth API sensörünü** kullanarak 3D nokta bulutu (`.ply`) taraması yapan ve doğrudan masaüstündeki **Photo2Print 3D Studio** uygulamasına aktaran yerel Android projesini içerir.

## Android'de LiDAR / Derinlik Taraması Nasıl Çalışır?
- Android telefonların çoğunda iPhone Pro'lardaki gibi donanımsal LiDAR bulunmaz (istisna: eski ToF sensörlü bazı modeller); bunun yerine Google **ARCore Depth API** kamera hareketi + stereo/ToF derinlik haritası ile gerçek ölçekli (milimetre) derinlik görüntüsü üretir.
- **Küçük kırık ev eşyaları (3–15 cm) için en yüksek kaliteyi** şu iki yöntemi birleştirerek alırsınız:
  1. **Web QR Tarama (Anında Kurulumsuz):** PC uygulamasındaki `Android ile Tara (QR)` butonunu kullanın; telefon kamerasıyla 4–5 açıdan fotoğraf çekin ve masaüstünde hem **Bulut AI** hem **Yerel Offline** motorlarla pürüzsüz STL üretin.
  2. **Bu Native Android ARCore Depth Uygulaması:** Büyük veya düzensiz yüzeyli eşyalarda nokta bulutu (`.ply`) çıkarıp PC'ye gönderir; PC'deki `plyImporter` nokta bulutunu otomatik olarak su geçirmez (manifold) 3D baskı ağına dönüştürür.

## APK Derleme Adımları (Android Studio)
Bu bilgisayarda yalnızca Java 8 ve `adb` kurulu olduğu için APK'yı derlemek üzere:
1. [Android Studio](https://developer.android.com/studio) kurun (SDK Platform **34** ve **JDK 17** ile birlikte gelir).
2. `android-scanner` klasörünü Android Studio ile açın (**Open Project**).
3. Gradle senkronizasyonu tamamlandıktan sonra telefonunuzu USB Hata Ayıklama açık şekilde bağlayın ve **Run (Shift+F10)** veya **Build > Build Bundle(s) / APK(s) > Build APK(s)** seçin.
4. Uygulamada PC'deki `Android ile Tara (QR)` penceresinde görünen **API Adresi** (ör. `http://192.168.1.42:3001`) ve **6 haneli Oturum Kodu**nu girip `.PLY Olarak PC'ye Gönder` butonuna basın.
