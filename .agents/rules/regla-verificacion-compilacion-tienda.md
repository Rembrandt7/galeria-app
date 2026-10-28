---
description: Regla estricta: NUNCA dar por terminada una tarea ni avisar que ya se subió hasta que GitHub Actions termine de compilar y el APK esté verificado y visible en Tienda Remb / GitHub Releases.
globs: "**/*"
---

# 🛑 REGLA OBLIGATORIA: CERO FALSAS BÚSQUEDAS — ESPERAR COMPILACIÓN Y PUBLICACIÓN REAL EN TIENDA REMB

> **MANDATO INQUEBRANTABLE**:
> **NUNCA** le digas al usuario que un cambio está "listo", "terminado" o "subido a la tienda" inmediatamente después de hacer `git push`.
> El comando `git push` solo sube el código fuente. La compilación del APK en GitHub Actions toma de **3 a 5 minutos**.
> Si avisas antes de tiempo, el usuario entra a Tienda Remb o a su auto y la actualización aún no existe (**falsa búsqueda**).

---

## 📋 PROTOCOLO OBLIGATORIO DE CIERRE DE TAREA

Cada vez que modifiques código en cualquier app (`galeria-app`, `yt-app`, `nfc-app`, etc.):

### 1. Incrementar Versión y Build
- Subir `version` y `buildNumber` / `versionCode` en `app.json`, `version.json` y `updateService.js`.
- Hacer `git commit -m "..."`.
- Hacer `git push origin main`.
- Actualizar tag `latest`: `git tag -f -a latest -m "..."` y `git push origin latest --force`.

### 2. Monitorear GitHub Actions (Prohibido dar por terminada la tarea)
- Obtener el ID del workflow en ejecución:
  ```powershell
  $run = Invoke-RestMethod -Uri "https://api.github.com/repos/Rembrandt7/<repo>/actions/runs?per_page=1"
  $runId = $run.workflow_runs[0].id
  ```
- Esperar de manera activa hasta que:
  - `status` sea `"completed"`
  - `conclusion` sea `"success"`
- Si necesitas pausar el turno mientras compila, infórmale al usuario:
  *"El código ya está en GitHub y el workflow de GitHub Actions está compilando el APK nativo. Esperando a que finalice para confirmar la publicación en Tienda Remb..."*

### 3. Verificación Técnica de la Release
- Antes de dar por concluida la tarea, ejecutar:
  ```powershell
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/Rembrandt7/<repo>/releases/latest"
  $rel.assets | Select-Object name, size, browser_download_url
  ```
- Confirmar que el archivo `.apk` esté presente, tenga tamaño mayor a 0 y coincida con el nuevo build.

### 4. Mensaje Final al Usuario
Solo cuando el paso 3 sea exitoso, dar por concluida la tarea e incluir:
- Número de versión y Build nuevo (ej. `v1.4.2 #50`).
- Confirmación explícita: **"Ya está visible y disponible en Tienda Remb y en la Release oficial"**.
- Enlace directo al archivo `.apk` de la Release.
