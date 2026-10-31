import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Linking, Platform } from 'react-native';

const REPO_OWNER = 'Rembrandt7';
const REPO_NAME = 'galeria-app';

export const CURRENT_VERSION = 'v1.5.6';
export const CURRENT_BUILD_NUMBER = 65;

const SAVED_APKS_STORAGE_KEY = '@galeria_saved_apks_v1';
const APK_STORAGE_DIR = `${FileSystem.documentDirectory}apk_updates/`;

async function ensureApkDir() {
  const dirInfo = await FileSystem.getInfoAsync(APK_STORAGE_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(APK_STORAGE_DIR, { intermediates: true });
  }
}

async function fileExistsWithSize(uri) {
  if (!uri) return { exists: false, size: 0 };
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info?.exists && (info.size || 0) > 0) {
      return { exists: true, size: info.size };
    }
  } catch (_e) {}
  return { exists: false, size: 0 };
}

export const updateService = {
  /**
   * Consulta en GitHub si existe una versión más reciente o un APK disponible.
   */
  async checkForUpdates() {
    try {
      let apkAsset = null;
      let latestRun = null;
      let buildingRun = null;

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

      // 2. Obtener las últimas compilaciones en GitHub Actions (incluyendo en progreso y exitosas)
      try {
        const runsRes = await fetch(
          `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs?per_page=5`,
          { headers: { Accept: 'application/vnd.github.v3+json' } }
        );

        if (runsRes.ok) {
          const runsData = await runsRes.json();
          const allRuns = runsData.workflow_runs || [];
          buildingRun = allRuns.find(
            (r) => r.status === 'in_progress' || r.status === 'queued'
          );
          latestRun = allRuns.find(
            (r) => r.status === 'completed' && r.conclusion === 'success'
          );
        }
      } catch (errRuns) {
        console.warn('No se pudo consultar GitHub Actions runs:', errRuns);
      }

      const remoteRunNumber = latestRun?.run_number || 0;
      const buildingRunNumber = buildingRun?.run_number || 0;
      // Hay actualización si la compilación en GitHub Actions es mayor a la instalada
      const hasUpdate = remoteRunNumber > CURRENT_BUILD_NUMBER;

      const directApkUrl =
        apkAsset?.browser_download_url ||
        `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/latest/app-release.apk`;

      const commitTitle = latestRun?.display_title || latestRun?.head_commit?.message || '';
      const versionMatch = commitTitle.match(/v\d+\.\d+\.\d+/i);
      const detectedVersion = versionMatch ? versionMatch[0] : CURRENT_VERSION;

      const buildingMsg =
        buildingRunNumber > remoteRunNumber
          ? `\n⏳ Nota: La compilación #${buildingRunNumber} se está generando ahora mismo en GitHub Actions.`
          : '';

      return {
        hasUpdate,
        alreadyInstalled: !hasUpdate && remoteRunNumber > 0 && CURRENT_BUILD_NUMBER >= remoteRunNumber,
        detectedVersion,
        version: `${detectedVersion} (Compilación #${remoteRunNumber || CURRENT_BUILD_NUMBER})`,
        currentVersion: `${CURRENT_VERSION} (#${CURRENT_BUILD_NUMBER})`,
        remoteRunNumber,
        buildingRunNumber,
        apkUrl: directApkUrl,
        apkSize: apkAsset?.size || null,
        latestRunUrl:
          buildingRun?.html_url ||
          latestRun?.html_url ||
          `https://github.com/${REPO_OWNER}/${REPO_NAME}/actions`,
        notes: hasUpdate
          ? `Actualización lista para descargar dentro de la app. Se conservará la versión anterior como respaldo y se eliminará el APK más viejo automáticamente.${buildingMsg}`
          : `Ya tienes instalada la última versión disponible (${CURRENT_VERSION} #${CURRENT_BUILD_NUMBER}). No necesitas volver a descargarla.${buildingMsg}`,
        message: hasUpdate
          ? `Nueva compilación #${remoteRunNumber} disponible en GitHub.${buildingMsg}`
          : buildingRunNumber > CURRENT_BUILD_NUMBER
          ? `⏳ La compilación #${buildingRunNumber} aún se está generando en GitHub Actions. Intenta de nuevo en unos minutos.`
          : `✅ Ya tienes instalada la versión más reciente (${CURRENT_VERSION} #${CURRENT_BUILD_NUMBER}).`,
      };
    } catch (e) {
      console.error('Error general al consultar GitHub:', e);
      throw e;
    }
  },

  /**
   * Obtiene los APKs guardados localmente en la app (actual descargado y versión anterior de respaldo),
   * verificando que los archivos existan físicamente en memoria.
   */
  async getSavedApks() {
    try {
      await ensureApkDir();
      const raw = await AsyncStorage.getItem(SAVED_APKS_STORAGE_KEY);
      let data = raw ? JSON.parse(raw) : { current: null, previous: null };

      // Migrar si existía un galeria_update.apk antiguo en caché y aún no hay registro
      const legacyCacheApk = `${FileSystem.cacheDirectory}galeria_update.apk`;
      const legacyCheck = await fileExistsWithSize(legacyCacheApk);
      if (legacyCheck.exists && !data.current) {
        const migratedPath = `${APK_STORAGE_DIR}galeria_build_${CURRENT_BUILD_NUMBER}.apk`;
        try {
          await FileSystem.moveAsync({ from: legacyCacheApk, to: migratedPath });
          data.current = {
            buildNumber: CURRENT_BUILD_NUMBER,
            version: CURRENT_VERSION,
            label: `${CURRENT_VERSION} (#${CURRENT_BUILD_NUMBER})`,
            uri: migratedPath,
            sizeBytes: legacyCheck.size,
            downloadedAt: Date.now(),
          };
          await AsyncStorage.setItem(SAVED_APKS_STORAGE_KEY, JSON.stringify(data));
        } catch (_e) {}
      }

      if (data.current) {
        const checkCur = await fileExistsWithSize(data.current.uri);
        if (!checkCur.exists) {
          data.current = null;
        } else {
          data.current.sizeBytes = checkCur.size;
        }
      }

      if (data.previous) {
        const checkPrev = await fileExistsWithSize(data.previous.uri);
        if (!checkPrev.exists) {
          data.previous = null;
        } else {
          data.previous.sizeBytes = checkPrev.size;
        }
      }

      // Si current desapareció pero previous existe, promover previous
      if (!data.current && data.previous) {
        data.current = data.previous;
        data.previous = null;
      }

      await AsyncStorage.setItem(SAVED_APKS_STORAGE_KEY, JSON.stringify(data));
      return data;
    } catch (e) {
      return { current: null, previous: null };
    }
  },

  /**
   * Lanza el instalador nativo de Android directamente desde un APK ya guardado en el teléfono,
   * SIN volver a descargarlo de internet.
   */
  async installSavedApk(apkUri) {
    if (Platform.OS !== 'android') {
      Alert.alert('No soportado', 'La instalación de APK solo es compatible con Android.');
      return false;
    }
    const check = await fileExistsWithSize(apkUri);
    if (!check.exists) {
      Alert.alert('Archivo no encontrado', 'El archivo APK guardado ya no existe en el almacenamiento.');
      return false;
    }

    try {
      const contentUri = await FileSystem.getContentUriAsync(apkUri);
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        type: 'application/vnd.android.package-archive',
        flags: 1 | 268435456, // FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK
      });
      return true;
    } catch (intentErr) {
      console.warn('IntentLauncher falló con APK guardado, probando con Sharing...', intentErr);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(apkUri, {
          mimeType: 'application/vnd.android.package-archive',
          dialogTitle: 'Instalar versión guardada de Mi Galería',
        });
        return true;
      }
      Alert.alert('Error', 'No se pudo abrir el instalador del sistema.');
      return false;
    }
  },

  /**
   * Descarga el APK dentro de la app, rota la versión anterior (conservando solo la versión previa
   * y eliminando cualquier APK más viejo) y lanza el instalador del sistema.
   */
  async downloadAndInstallApk(apkUrl, onProgress, meta = {}) {
    if (Platform.OS !== 'android') {
      Alert.alert('No soportado', 'La instalación de APK solo es compatible con Android.');
      return false;
    }

    try {
      await ensureApkDir();
      const buildNum = meta.buildNumber || meta.remoteRunNumber || Date.now();
      const versionStr = meta.version || CURRENT_VERSION;
      const tempDownloadPath = `${APK_STORAGE_DIR}downloading_temp.apk`;

      // 1. Limpiar temporal previo si quedó incompleto
      try {
        await FileSystem.deleteAsync(tempDownloadPath, { idempotent: true });
      } catch (_e) {}

      // 2. Descargar dentro de la app con seguimiento de porcentaje
      const downloadResumable = FileSystem.createDownloadResumable(
        apkUrl,
        tempDownloadPath,
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

      const downloadedCheck = await fileExistsWithSize(downloadResult.uri);
      if (!downloadedCheck.exists) {
        throw new Error('El archivo APK descargado está vacío.');
      }

      // 3. Rotación inteligente de versiones:
      //    - Si ya había un APK actual (de otra compilación), pasa a ser "previous" (versión anterior guardada)
      //    - El APK más antiguo ("previous" viejo) se elimina automáticamente para no acumular espacio
      const saved = await updateService.getSavedApks();
      const finalApkPath = `${APK_STORAGE_DIR}galeria_build_${buildNum}.apk`;

      if (saved.current) {
        if (saved.current.buildNumber !== buildNum && saved.current.uri !== finalApkPath) {
          // Eliminar el APK anterior más viejo si existía
          if (saved.previous?.uri && saved.previous.uri !== saved.current.uri) {
            try {
              await FileSystem.deleteAsync(saved.previous.uri, { idempotent: true });
            } catch (_e) {}
          }
          // El que era actual pasa a ser la versión anterior guardada
          saved.previous = saved.current;
        } else if (saved.current.uri && saved.current.uri !== finalApkPath) {
          try {
            await FileSystem.deleteAsync(saved.current.uri, { idempotent: true });
          } catch (_e) {}
        }
      }

      // Mover el temporal descargado a su nombre definitivo
      try {
        await FileSystem.deleteAsync(finalApkPath, { idempotent: true });
      } catch (_e) {}
      await FileSystem.moveAsync({ from: tempDownloadPath, to: finalApkPath });

      saved.current = {
        buildNumber: buildNum,
        version: versionStr,
        label:
          typeof versionStr === 'string' && versionStr.includes('#')
            ? versionStr
            : `${versionStr} (#${buildNum})`,
        uri: finalApkPath,
        sizeBytes: downloadedCheck.size,
        downloadedAt: Date.now(),
      };

      await AsyncStorage.setItem(SAVED_APKS_STORAGE_KEY, JSON.stringify(saved));

      // 4. Limpiar cualquier otro archivo .apk huérfano en la carpeta de actualizaciones o en caché
      try {
        const files = await FileSystem.readDirectoryAsync(APK_STORAGE_DIR);
        for (const f of files) {
          const fullUri = `${APK_STORAGE_DIR}${f}`;
          if (fullUri !== saved.current?.uri && fullUri !== saved.previous?.uri) {
            await FileSystem.deleteAsync(fullUri, { idempotent: true });
          }
        }
        await FileSystem.deleteAsync(`${FileSystem.cacheDirectory}galeria_update.apk`, {
          idempotent: true,
        });
      } catch (_e) {}

      // 5. Lanzar el instalador nativo desde el APK guardado
      return await updateService.installSavedApk(finalApkPath);
    } catch (error) {
      console.error('Error durante la descarga o instalación:', error);
      Alert.alert(
        'Error al descargar actualización',
        'No se pudo descargar el APK dentro de la aplicación: ' + (error?.message || String(error))
      );
      return false;
    }
  },
};
