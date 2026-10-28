---
description: Reglas permanentes y memoria de errores descartados para BYD Dolphin Mini (YouTube Dolphin Mini, Dolphin Control Celular y Tienda Remb). NUNCA repetir las opciones descartadas aquí listadas.
---

# 🧠 Memoria Permanente de Aprendizaje: Opciones Descartadas vs. Soluciones Probadas (BYD Dolphin Mini)

> **REGLA CRÍTICA**: Antes de modificar cualquier parte de `yt-app/App.js`, `yt-app/withYoutubeCarFeatures.js`, `yt-app/src/updateService.js` o `yt-app/src/TiendaRembModal.js`, verifica siempre esta lista de opciones descartadas para **NUNCA volver a repetir un fallo ya resuelto**.

---

## 1. 🎵 SPOTIFY (Por qué falló varias veces y qué NO volver a hacer)

### ❌ Opciones Descartadas (PROHIBIDO REPETIR):
1. **NO usar User-Agent de Chrome Android o Windows sin polyfills ES2024 ni spoof de Widevine EME**:
   - El WebView del BYD Dolphin Mini corre Android 10 (Chromium 83). El bundle JS 2025 de `open.spotify.com` usa `Object.hasOwn`, `Array.prototype.at`, `String.prototype.replaceAll`, `structuredClone` y `Promise.allSettled`. Sin esos polyfills en `onPageStarted`, Spotify se queda en pantalla negra total.
2. **NO devolver una promesa rechazada ni un objeto falso sin proteger `HTMLMediaElement.prototype.setMediaKeys`**:
   - Si `navigator.requestMediaKeySystemAccess` rechaza la promesa o si `setMediaKeys` recibe un objeto falso no nativo sin estar envuelto, el reproductor de Spotify crashea con `TypeError`. Siempre normalizar `robustness: 'SW_SECURE_CRYPTO'` (Widevine L3) antes de llamar al `origEme` nativo y envolver `setMediaKeys`.
3. **NO cerrar `spotifyIsAuthPage` en `onNavigationStateChange` solo porque la URL contenga `open.spotify.com`**:
   - Cuando el usuario toca `🔑 Iniciar Sesión`, el WebView todavía está en `open.spotify.com` un instante antes de cargar `accounts.spotify.com`. Si `onNavigationStateChange` apaga `spotifyIsAuthPage` al ver `open.spotify.com` sin verificar `spotifyVisitedAuthRef.current === true`, saca al usuario de inmediato y no lo deja iniciar sesión.
4. **NO inyectar automáticamente `#__dolphin_spotify_car_ui` a los 2 segundos (`__spWatchTicks === 2`) encima de `open.spotify.com`**:
   - Eso tapaba la pantalla de inicio de sesión y el reproductor web de Spotify.
5. **NO pre-cargar pistas falsas con `previewUrl: ''` ni llamar `playSpotifyTrackItem` (función inexistente)**:
   - Siempre usar `playSpotifyTrack(tr, tIdx)` y mantener montado `<WebView ref={spotifyAudioWebViewRef} />` para reproducir audio real al instante.

---

## 2. 📘 FACEBOOK Y 🎬 REELS (Por qué fallaron y qué NO volver a hacer)

### ❌ Opciones Descartadas (PROHIBIDO REPETIR):
1. **NO usar `https://m.facebook.com` con User-Agent móvil como URL inicial**:
   - Facebook redirige `m.facebook.com` con HTTP 302 hacia `/unified/login_via/app/` e intenta abrir esquemas `intent://` o `fb://`, lo cual provoca pantalla de error `ERR_UNKNOWN_URL_SCHEME` en el WebView del carro.
   - **Solución fija**: Usar siempre `https://www.facebook.com/login.php?locale=es_LA` (para login), `https://www.facebook.com/?locale=es_LA` (para muro) y `https://www.facebook.com/reel/` (para Reels) con `SAFARI_COMPAT_UA` + bloqueo de `intent:`, `fb:`, `fbapi:`, `market:` y `/unified/login_via/app` tanto en `DolphinCompatWebViewClient` (Kotlin) como en `onShouldStartLoadWithRequest`.
2. **NO llamar funciones auxiliares en JSX (como `buildWebCompatPolyfillJs()`) sin definirlas a nivel global en `App.js`**:
   - Causó `ReferenceError: Property 'buildWebCompatPolyfillJs' doesn't exist`.
3. **NO inyectar scripts en Reels (`buildReelsAutoAdvanceInjectedJs`) sin incluir primero los polyfills ES2024**:
   - Tanto YouTube Shorts como Facebook Reels requieren los polyfills de `Object.hasOwn`, `Array.prototype.at`, `String.prototype.replaceAll`, `structuredClone` y `Promise.allSettled` antes de cargar en Android 10 WebView.

---

## 3. 🪞 MIRROR SCREEN Y ROTACIÓN (Por qué falló antes y qué NO tocar)

### ❌ Opciones Descartadas (PROHIBIDO REPETIR):
1. **NO usar `Image` de React Native recargando un `<Image source={{ uri: frameUrl }} />` cada 100ms como visor principal**:
   - Causaba parpadeo (pantalla negra entre cuadros).
   - **Solución fija que YA funciona (NO MOVER)**: Usar el visor HTML5 `<canvas>` con doble buffer `new Image()` en `mirrorWebViewRef` y el servicio nativo `ScreenMirrorService.kt` + `CarYoutubeModule.kt` (`startPhonePullerNow`).
2. **NO fijar las dimensiones de `VirtualDisplay` al inicio sin recrear al girar o abrir el Samsung Galaxy Z Fold**:
   - Cuando el celular se abre (Fold) o gira a horizontal, `ScreenMirrorService.kt` debe detectar el cambio de `width/height` y actualizar el `ImageReader` / `VirtualDisplay` para que nunca se vea acostado en el carro.
3. **NO usar `stretch` que desproporcione la imagen del celular**:
   - Mantener `object-fit: contain` (modo proporcional al máximo alto o ancho) y colocar la barra de controles a la izquierda (`side`) cuando el alto está lleno, o abajo (`bottom`) cuando sobra espacio vertical.

---

## 4. 📱 COMPILACIÓN DUAL Y ACTUALIZACIONES GITHUB (`YouTube-Dolphin-Mini` vs `Dolphin-Control-Celular`)

### ❌ Opciones Descartadas (PROHIBIDO REPETIR):
1. **NO dejar clases Kotlin duplicadas en dos carpetas (`com/rembrant/youtubedolphin` y `com/rembrant/dolphinremote`)**:
   - Provocaba errores `Redeclaration` en Kotlin o que `BuildConfig` apuntara al paquete incorrecto.
   - **Solución fija**: Todas las clases Kotlin viven únicamente en `com.rembrant.youtubedolphin` (`namespace 'com.rembrant.youtubedolphin'`), y `sync_build.js` cambia únicamente `applicationId` (`com.rembrant.youtubedolphin` para carro, `com.rembrant.dolphinremote` para celular), el `FileProvider` authority y `IS_PHONE_CONTROLLER_BUILD`.
2. **NO olvidar sincronizar `IS_PHONE_CONTROLLER_BUILD` tanto en `App.js` como en `src/updateService.js`**:
   - Si `src/updateService.js` se queda en `false` al compilar la app del celular, el celular descarga el APK del carro y Android rechaza la actualización por conflicto de paquete.
3. **NO guardar ni leer `version.json` o notas de versión con codificación ANSI/Windows-1252**:
   - Siempre usar UTF-8 puro y pasar los textos por `cleanUtf8Text()` para que jamás salgan caracteres raros en los acentos (`Ã³`, `Ã¡`).

---

## 5. 🛍️ TIENDA REMB (Todas las Apps de GitHub de `@Rembrandt7`)

### ❌ Opciones Descartadas (PROHIBIDO REPETIR):
1. **NO depender exclusivamente de 22 llamadas seguidas a `api.github.com/repos/Rembrandt7/.../releases` sin catálogo base completo**:
   - GitHub bloquea con `HTTP 403 Rate Limit` tras 60 peticiones por hora por IP.
   - **Solución fija**: `TiendaRembModal.js` siempre inicia con `GUARANTEED_GITHUB_APKS` (las 5 APKs publicadas en `@Rembrandt7`: `YouTube Dolphin Mini`, `Dolphin Control Celular`, `NFC Smart Hub`, `Antigravity PC Control` y `Mi Galería Pro` usando enlaces directos CDN `github.com/Rembrandt7/.../releases/download/latest/...`) y `GUARANTEED_GITHUB_REPOS` (los 21 repositorios de `@Rembrandt7`), y mezcla encima cualquier novedad de la API.

---

## 6. 🎛️ INTERFAZ Y BOTONES (Regla de Diseño del Usuario)

- **NUNCA saturar las barras con más de 5-6 botones seguidos ni quitar funciones que ya sirven**:
  - **Barra Superior Izquierda/Centro**: Solo las 5 apps principales (`YouTube`, `Spotify`, `Maps`, `Mirror`, `WhatsApp`) + el botón **`📱 Más Apps ▾`** (donde viven `Reels`, `Facebook`, `USB Movies`, `Mapa + Música Dividida`, `Photos`, `Gemini IA` y `Tienda Remb`).
  - **Barra Superior Derecha**: Solo 4 controles (`🔍 Buscar`, `🌙 Apagar`, `⚙️ Menú` y `👤`).
  - **Barra Inferior de YouTube**: Solo 5 botones (`📋 Lista`, `🎬 Reels`, `⏭️ Siguiente`, `🎛️ Opciones ▾` y `Completa`).
