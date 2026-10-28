---
description: Regla obligatoria para publicar y sincronizar actualizaciones en GitHub Releases para todas las aplicaciones de Rembrandt7 (YouTube Dolphin Mini, Dolphin Control Celular, Tienda Remb, Galería App, etc.).
globs: "**/*"
---

# 🚀 Regla Obligatoria Permanente: Publicación de Actualizaciones en GitHub Releases para Todas las Apps

> **REGLA FUNDAMENTAL**: En este proyecto y en todas las aplicaciones desarrolladas para GitHub (`@Rembrandt7`), **hacer `git push` NO es suficiente para que el usuario reciba la actualización**. 
> Para que las aplicaciones instaladas en la pantalla del carro (BYD Dolphin Mini), en celulares Samsung/Android o en **Tienda Remb** puedan detectar, descargar e instalar una nueva versión, **SIEMPRE ES OBLIGATORIO PUBLICAR O ACTUALIZAR LA RELEASE EN GITHUB RELEASES**.

---

## 📌 ¿Por qué existe esta regla?
Tanto **Tienda Remb** como el servicio de actualización automática ([updateService.js](file:///c:/Users/rblanco/OneDrive%20-%20Servicios%20Administrativos%20Javer,%20S.A.%20DE%20C.V/aplicaciones%20remb/aplk%20remb/yt-app/src/updateService.js)) consultan la API oficial de GitHub Releases:
`https://api.github.com/repos/Rembrandt7/<nombre-del-repo>/releases/latest`

Si solo se sube el código fuente con `git push`, la API de Releases sigue entregando la versión vieja, provocando que el usuario vea mensajes como *"Estás al día"* o no vea el nuevo build en la pantalla del vehículo.

---

## 📋 Protocolo Obligatorio en Cada Actualización (Paso a Paso)

Siempre que se implemente una mejora, corrección o nueva función en cualquier app:

### 1. Incrementar versión y build en todos los archivos de configuración
- En `app.json`: Incrementar `expo.version` y `expo.android.versionCode`.
- En `version.json`: Actualizar `version`, `buildNumber`, `title`, `name`, `body` (resumen detallado de lo nuevo) y `published_at`.
- En `src/updateService.js`: Actualizar `CURRENT_VERSION` y `CURRENT_BUILD_NUMBER`.

### 2. Confirmar y subir cambios a Git
- Ejecutar `git commit` con un mensaje claro que indique la versión y build (ejemplo: `Release v2.5.0 (#36): ...`).
- Subir a la rama principal: `git push origin main`.
- Actualizar la etiqueta local y remota: `git tag -f -a latest -m "Release vX.X.X"` y `git push origin latest --force`.

### 3. Publicar/Actualizar la Release en GitHub Releases
Se debe sincronizar la Release de GitHub para que la API devuelva la nueva versión y los APKs:
- **Título de la Release**: Formato estándar `vX.X.X (#Build) - Nombre de las novedades`.
- **Notas de la versión**: Copiar las viñetas del `body` de `version.json`.
- **Archivos indispensables en los Assets de la Release**:
  1. `YouTube-Dolphin-Mini.apk` (o el APK principal de la aplicación).
  2. `Dolphin-Control-Celular.apk` (si la app incluye versión para celular/controlador).
  3. `version.json` (actualizado con el nuevo número de build).

> 💡 **Método automatizado por API**:
> Se puede obtener el token de GitHub configurado en Windows Credential Manager con `('protocol=https', 'host=github.com', '') | git credential-manager get` y actualizar la release mediante `PATCH https://api.github.com/repos/Rembrandt7/<repo>/releases/<release_id>` y `POST https://uploads.github.com/.../assets?name=version.json`.

### 4. Verificación final obligatoria
Antes de dar por concluida la actualización y notificar al usuario, el asistente DEBE consultar la API pública:
```powershell
Invoke-RestMethod -Uri "https://api.github.com/repos/Rembrandt7/<nombre-repo>/releases/latest" | Select-Object name, tag_name, published_at
```
Y confirmar que el nombre y build reflejen la **nueva versión**.

---

## 🚗 Aplicaciones Cubiertas por esta Regla:
- **YouTube Dolphin Mini / Dolphin Control Celular** (`Rembrandt7/youtube-dolphin-app`)
- **Mi Galería Pro** (`Rembrandt7/galeria-app` o repositorio correspondiente)
- **NFC Smart Hub** (`Rembrandt7/nfc-smart-hub`)
- **Antigravity PC Control**
- Todas las apps presentes en el catálogo de **Tienda Remb**.
