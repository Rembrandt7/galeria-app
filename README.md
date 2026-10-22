# 📸 Mi Galería - Aplicación Android

Una aplicación móvil moderna de galería para Android desarrollada con **React Native** y **Expo**, capaz de leer las fotos y videos del almacenamiento local, organizar por carpetas/álbumes, gestionar favoritos, visualizar en pantalla completa con zoom y generar un archivo **APK** listo para instalar.

---

## 🚀 Características Implementadas

- 🖼️ **Cuadrícula de Fotos y Videos**:
  - Carga rápida y optimizada con memoria caché mediante `expo-image`.
  - Orden cronológico de las fotos del dispositivo.
  - Indicadores visuales para videos con duración.
  - Filtro interactivo en el encabezado (Todas, Solo Fotos, Solo Videos).
  - Paginación continua (scroll infinito) y *Pull-to-Refresh* (deslizar hacia abajo para refrescar).
- 🔍 **Visor a Pantalla Completa**:
  - Deslizamiento suave entre fotos (gesto táctil y flechas de navegación).
  - Zoom interactivo (1x, 2x, 3x) para apreciar detalles.
  - Botón de información con metadata (nombre, fecha de captura, dimensiones en px, tipo de archivo).
- 📁 **Navegación por Álbumes**:
  - Detección automática de todas las carpetas multimedia del teléfono (Cámara, WhatsApp, Screenshots, Descargas, etc.).
  - Portada automática con la foto más reciente de cada carpeta y conteo de fotos.
  - Al tocar un álbum, se abre la vista detallada de sus fotos con botón para regresar.
- ❤️ **Sección de Favoritos**:
  - Marca fotos o videos favoritos con un toque.
  - Persistencia de datos local mediante `AsyncStorage` (se conservan al cerrar o apagar el celular).
  - Pestaña dedicada para ver y filtrar tus imágenes preferidas.
- 📤 **Compartir y Eliminar**:
  - Botón de compartir nativo (`expo-sharing`) para enviar a WhatsApp, Telegram, correo o redes sociales.
  - Eliminación segura con confirmación del sistema (`expo-media-library`).
- 🎨 **Diseño Oscuro Premium**:
  - Interfaz moderna en tema oscuro (*Dark Mode*) que hace resaltar los colores de las fotografías.

---

## 📱 ¿Cómo probar la app al instante en tu celular?

1. Instala la app gratuita **Expo Go** desde [Google Play Store](https://play.google.com/store/apps/details?id=host.exp.exponent) en tu celular Android.
2. Abre la terminal en la carpeta del proyecto:
   ```bash
   cd galeria-app
   npx expo start
   ```
3. En la terminal aparecerá un **código QR**.
4. Abre la app **Expo Go** en tu celular, toca en **"Scan QR code"** y escanea el código.
5. ¡La app cargará en tu teléfono con acceso a tus fotos y podrás usarla inmediatamente!

---

## 📦 ¿Cómo generar el archivo APK instalable?

Para generar el archivo `.apk` autónomo (que puedes enviar por WhatsApp, Drive o instalar en cualquier teléfono Android):

1. Dentro de la carpeta `galeria-app`, ejecuta:
   ```bash
   npx eas-cli build -p android --profile preview
   ```
2. Si es tu primera vez, te pedirá iniciar sesión o crear una cuenta gratuita en Expo (toma 1 minuto).
3. EAS compilará el APK en la nube de forma automática (no necesitas tener instalado Android Studio en tu PC).
4. Al terminar el proceso, la consola te entregará:
   - Un enlace directo para descargar el archivo `.apk`.
   - Un código QR para descargarlo directamente desde el navegador de tu celular.
5. Descarga el archivo `.apk` en tu celular, ábrelo y pulsa **Instalar**.
