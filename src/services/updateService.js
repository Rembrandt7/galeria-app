import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { Alert, Linking, Platform } from 'react-native';

const REPO_OWNER = 'Rembrandt7';
const REPO_NAME = 'galeria-app';
export const CURRENT_VERSION = 'v1.0.1';

export const updateService = {
  /**
   * Consulta en GitHub si existe una versión más reciente.
   */
  async checkForUpdates() {
    try {
      // 1. Intentar obtener la última release publicada
      const releaseRes = await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
        { headers: { Accept: 'application/vnd.github.v3+json' } }
      );

      if (releaseRes.ok) {
        const release = await releaseRes.json();
        const apkAsset = (release.assets || []).find(
          (a) => a.name && a.name.toLowerCase().endsWith('.apk')
        );

        if (apkAsset) {
          const isNewer = (release.tag_name || release.name) !== CURRENT_VERSION;
          return {
            hasUpdate: isNewer,
            version: release.tag_name || release.name,
            publishedAt: release.published_at,
            notes: release.body || 'Corrección de errores y mejoras de rendimiento.',
            apkUrl: apkAsset.browser_download_url,
            apkSize: apkAsset.size,
          };
        }
      }

      // 2. Si no hay releases publicadas, consultar la última compilación exitosa de GitHub Actions
      const runsRes = await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs?status=success&per_page=1`,
        { headers: { Accept: 'application/vnd.github.v3+json' } }
      );

      if (runsRes.ok) {
        const data = await runsRes.json();
        const latestRun = data.workflow_runs && data.workflow_runs[0];
        if (latestRun) {
          return {
            hasUpdate: false,
            latestRunUrl: latestRun.html_url,
            latestRunDate: latestRun.created_at,
            message: 'Tu app está en la versión actual o puedes descargar el build de GitHub Actions.',
          };
        }
      }

      return {
        hasUpdate: false,
        message: 'No se encontraron actualizaciones nuevas en GitHub.',
      };
    } catch (e) {
      console.error('Error al consultar GitHub:', e);
      throw e;
    }
  },

  /**
   * Descarga el APK con seguimiento de progreso y lanza el instalador del sistema.
   */
  async downloadAndInstallApk(apkUrl, onProgress) {
    if (Platform.OS !== 'android') {
      Alert.alert('No soportado', 'La instalación de APK solo es compatible con Android.');
      return false;
    }

    try {
      const targetPath = `${FileSystem.documentDirectory}galeria_update.apk`;

      // Limpiar archivo previo si existía
      try {
        const info = await FileSystem.getInfoAsync(targetPath);
        if (info.exists) {
          await FileSystem.deleteAsync(targetPath, { idempotent: true });
        }
      } catch (err) {
        // Ignorar
      }

      // Descargar con seguimiento de progreso
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
        throw new Error(`Error en la descarga (código ${downloadResult?.status || 'desconocido'})`);
      }

      // Convertir a Content URI (obligatorio en Android 7+)
      const contentUri = await FileSystem.getContentUriAsync(downloadResult.uri);

      // Lanzar el instalador nativo de Android
      try {
        await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
          data: contentUri,
          type: 'application/vnd.android.package-archive',
          flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
        });
        return true;
      } catch (intentErr) {
        // Fallback mediante compartir si el launcher directo requiere permiso adicional
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(downloadResult.uri, {
            mimeType: 'application/vnd.android.package-archive',
            dialogTitle: 'Instalar actualización de Galería',
          });
          return true;
        }
        throw intentErr;
      }
    } catch (error) {
      console.error('Error durante la descarga o instalación:', error);
      throw error;
    }
  },
};
