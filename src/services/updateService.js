import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { Alert, Linking, Platform } from 'react-native';

const REPO_OWNER = 'Rembrandt7';
const REPO_NAME = 'galeria-app';

export const CURRENT_VERSION = 'v1.0.9';
export const CURRENT_BUILD_NUMBER = 17;

export const updateService = {
  /**
   * Consulta en GitHub si existe una versión más reciente o un APK disponible.
   */
  async checkForUpdates() {
    try {
      let apkAsset = null;
      let latestRun = null;

      // 1. Obtener información de la release publicada en GitHub
      try {
        const releaseRes = await fetch(
          `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
          { headers: { Accept: 'application/vnd.github.v3+json' } }
        );

        if (releaseRes.ok) {
          const release = await releaseRes.json();
          apkAsset = (release.assets || []).find(
            (a) => a.name && a.name.toLowerCase().endsWith('.apk')
          );
        }
      } catch (errRelease) {
        console.warn('No se pudo consultar GitHub Releases:', errRelease);
      }

      // 2. Obtener la última compilación exitosa en GitHub Actions
      try {
        const runsRes = await fetch(
          `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs?status=success&per_page=1`,
          { headers: { Accept: 'application/vnd.github.v3+json' } }
        );

        if (runsRes.ok) {
          const runsData = await runsRes.json();
          latestRun = runsData.workflow_runs && runsData.workflow_runs[0];
        }
      } catch (errRuns) {
        console.warn('No se pudo consultar GitHub Actions runs:', errRuns);
      }

      const remoteRunNumber = latestRun?.run_number || 0;
      // Hay actualización si la compilación en GitHub Actions es mayor a la instalada
      const hasUpdate = remoteRunNumber > CURRENT_BUILD_NUMBER;

      const directApkUrl =
        apkAsset?.browser_download_url ||
        `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/latest/app-release.apk`;

      return {
        hasUpdate,
        version: `v1.0.9 (Compilación #${remoteRunNumber || CURRENT_BUILD_NUMBER})`,
        currentVersion: `${CURRENT_VERSION} (#${CURRENT_BUILD_NUMBER})`,
        remoteRunNumber,
        apkUrl: directApkUrl,
        apkSize: apkAsset?.size || null,
        latestRunUrl: latestRun?.html_url || `https://github.com/${REPO_OWNER}/${REPO_NAME}/actions`,
        notes: hasUpdate
          ? 'Soporte para carpetas del sistema, permiso de acceso a todos los archivos y visor 100% estable.'
          : 'Tu aplicación está actualizada con la última versión disponible.',
        message: hasUpdate
          ? `Nueva compilación #${remoteRunNumber} disponible en GitHub.`
          : `Tu app ya está al día (${CURRENT_VERSION} #${CURRENT_BUILD_NUMBER}).`,
      };
    } catch (e) {
      console.error('Error general al consultar GitHub:', e);
      throw e;
    }
  },

  /**
   * Descarga el APK con seguimiento de porcentaje de progreso y lanza el instalador del sistema.
   */
  async downloadAndInstallApk(apkUrl, onProgress) {
    if (Platform.OS !== 'android') {
      Alert.alert('No soportado', 'La instalación de APK solo es compatible con Android.');
      return false;
    }

    try {
      const targetPath = `${FileSystem.cacheDirectory}galeria_update.apk`;

      // 1. Limpiar archivo previo si existía en cache
      try {
        const info = await FileSystem.getInfoAsync(targetPath);
        if (info.exists) {
          await FileSystem.deleteAsync(targetPath, { idempotent: true });
        }
      } catch (errClean) {
        // Ignorar
      }

      // 2. Descargar con seguimiento de progreso
      const downloadResumable = FileSystem.createDownloadResumable(
        apkUrl,
        targetPath,
        {},
        (dp) => {
          if (dp.totalBytesExpectedToWrite > 0) {
            const pct = dp.totalBytesWritten / dp.totalBytesExpectedToWrite;
            if (onProgress) onProgress(pct);
          }
        }
      );

      const downloadResult = await downloadResumable.downloadAsync();
      if (!downloadResult || downloadResult.status !== 200) {
        throw new Error(
          `Error en la descarga del paquete (código ${downloadResult?.status || 'desconocido'})`
        );
      }

      // 3. Convertir a Content URI compatible con Android FileProvider
      const contentUri = await FileSystem.getContentUriAsync(downloadResult.uri);

      // 4. Lanzar el instalador nativo de Android con flags requeridos (READ_URI + NEW_TASK)
      try {
        await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
          data: contentUri,
          type: 'application/vnd.android.package-archive',
          flags: 1 | 268435456, // FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK
        });
        return true;
      } catch (intentErr) {
        console.warn('IntentLauncher falló, probando con Sharing...', intentErr);
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(downloadResult.uri, {
            mimeType: 'application/vnd.android.package-archive',
            dialogTitle: 'Instalar actualización de Galería',
          });
          return true;
        }
        // Fallback garantizado: abrir directamente en el navegador Chrome
        await Linking.openURL(apkUrl);
        return true;
      }
    } catch (error) {
      console.error('Error durante la descarga o instalación:', error);
      // Fallback infalible si la descarga interna falla
      try {
        await Linking.openURL(apkUrl);
      } catch (e) {
        Alert.alert('Error', 'No se pudo iniciar la actualización: ' + (error?.message || String(error)));
      }
      return false;
    }
  },
};
