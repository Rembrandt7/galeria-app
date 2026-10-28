---
description: Regla estricta: Cada cambio realizado en cualquier aplicación DEBE ser subido y publicado de inmediato en GitHub Releases para que aparezca al instante en Tienda Remb y en la actualización del carro.
globs: "**/*"
---

# 🚨 REGLA ESTRICTA PERMANENTE: SUBIDA AUTOMÁTICA A GITHUB Y TIENDA REMB

> **MANDATO OBLIGATORIO**: Cada vez que se realice un cambio, corrección, ajuste o mejora en cualquier aplicación (`yt-app`, `galeria-app`, `nfc-smart-hub`, etc.), el asistente **DEBE SUBIRLO Y PUBLICARLO AUTOMÁTICAMENTE EN GITHUB RELEASES EN ESE MISMO TURNO**, sin esperar a que el usuario lo solicite.

---

## ⚡ Flujo de Ejecución Obligatorio en Cada Modificación:

1. **Subir versión y build**:
   - Incrementar `version` (ej. `v2.5.1` -> `v2.5.2`) y `buildNumber` / `versionCode` (ej. `37` -> `38`) en:
     - `app.json`
     - `version.json`
     - `src/updateService.js`

2. **Commit y Push a GitHub**:
   - `git commit -m "Release vX.X.X (#Build): ..."`
   - `git push origin main`
   - `git tag -f -a latest -m "Release vX.X.X (#Build)" && git push origin latest --force`

3. **Monitoreo y Espera Activa de GitHub Actions (Cero Falsas Búsquedas)**:
   - **PROHIBIDO** decir "ya quedó subido a la tienda" inmediatamente tras el push.
   - El APK tarda de 3 a 5 minutos en compilarse en los runners de GitHub Actions.
   - El agente DEBE monitorear el workflow con `Invoke-RestMethod -Uri "https://api.github.com/repos/Rembrandt7/<repo>/actions/runs"` hasta que `status == 'completed'` y `conclusion == 'success'`.

4. **Verificación Automática de la Release antes de Finalizar**:
   - Consultar `Invoke-RestMethod -Uri "https://api.github.com/repos/Rembrandt7/<repo>/releases/latest"`.
   - Certificar que el asset `.apk` esté subido con peso válido y que el nuevo build ya esté visible públicamente para **Tienda Remb** y para la pantalla del vehículo.
   - Solo entonces dar por finalizada la tarea y entregar el link directo de descarga.
