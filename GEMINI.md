# Reglas Generales del Espacio de Trabajo — Ecosistema Remb & BYD Dolphin Mini

Bienvenido. Este espacio de trabajo contiene las aplicaciones desarrolladas por @Rembrandt7 para el ecosistema BYD Dolphin Mini, celular Samsung y utilidades de automatización.

---

## 🚀 REGLA DE ORO #1: SUBIDA AUTOMÁTICA Y VERIFICACIÓN REAL EN TIENDA REMB

**En cualquier cambio o mejora de software:**
1. **Subida Automática Inmediata**: CADA cambio que se realice DEBE subirse y publicarse en GitHub Releases **en ese mismo turno**. NUNCA esperar a que el usuario pregunte si ya se subió.
2. **Protocolo Obligatorio**:
   - Incrementar `version` y `buildNumber` / `versionCode` en `app.json`, `version.json` y `updateService.js`.
   - Ejecutar `git commit` y `git push origin main`.
   - Actualizar y subir la etiqueta `latest`: `git tag -f -a latest -m "..." && git push origin latest --force`.
3. **🛑 Cero Falsas Búsquedas (Prohibido decir "ya está subido" tras solo git push)**:
   - `git push` solo sube el código fuente. La compilación del APK en GitHub Actions tarda de **3 a 5 minutos**.
   - **NUNCA** le digas al usuario que la tarea está lista ni que busque en Tienda Remb mientras el workflow de Actions esté corriendo.
   - El asistente debe monitorear el workflow de GitHub Actions hasta que `status` sea `'completed'` y `conclusion` sea `'success'`.
4. **Verificación de la Release antes de Finalizar**:
   - Ejecutar:
     `Invoke-RestMethod -Uri "https://api.github.com/repos/Rembrandt7/<repo>/releases/latest"`
   - Confirmar que el archivo `.apk` esté subido con peso válido y que el nuevo build sea el visible.
   - Solo entonces dar por finalizada la tarea, entregando el enlace directo del APK y confirmando que ya está disponible en Tienda Remb.

---

## 🧠 Memoria de Reglas y Opciones Descartadas:
Consulta siempre:
- [.agents/rules/regla-verificacion-compilacion-tienda.md](file:///c:/Users/rblanco/OneDrive%20-%20Servicios%20Administrativos%20Javer,%20S.A.%20DE%20C.V/aplicaciones%20remb/aplk%20remb/.agents/rules/regla-verificacion-compilacion-tienda.md)
- [.agents/rules/regla-auto-subir-tienda-github.md](file:///c:/Users/rblanco/OneDrive%20-%20Servicios%20Administrativos%20Javer,%20S.A.%20DE%20C.V/aplicaciones%20remb/aplk%20remb/.agents/rules/regla-auto-subir-tienda-github.md)
- [.agents/rules/reglas-dolphin-no-repetir-errores.md](file:///c:/Users/rblanco/OneDrive%20-%20Servicios%20Administrativos%20Javer,%20S.A.%20DE%20C.V/aplicaciones%20remb/aplk%20remb/.agents/rules/reglas-dolphin-no-repetir-errores.md)
