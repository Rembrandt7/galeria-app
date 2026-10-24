import * as FileSystem from 'expo-file-system/legacy';
import { Directory, File } from 'expo-file-system';
import { NativeModules } from 'react-native';

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

/**
 * Convierte cualquier URI (file:// o content:// SAF) a una ruta file:/// válida y codificada
 * segmento por segmento para que Java URI.create() y FilePermissionService nunca fallen con espacios.
 */
function toPhysicalFileUri(uri) {
  if (!uri || typeof uri !== 'string') return uri;
  let rawPath = null;

  if (uri.startsWith('file://')) {
    rawPath = uri.replace(/^file:\/+/i, '');
    try {
      rawPath = decodeURIComponent(rawPath);
    } catch (e) {
      // mantener rawPath
    }
  } else if (uri.startsWith('content://')) {
    try {
      const docMatch = uri.match(/\/document\/([^/?#]+)/i) || uri.match(/\/tree\/([^/?#]+)/i);
      if (docMatch && docMatch[1]) {
        const docId = decodeURIComponent(docMatch[1]);
        if (/^primary:/i.test(docId)) {
          const rel = docId.replace(/^primary:/i, '').replace(/^\/+/, '');
          rawPath = `storage/emulated/0/${rel}`;
        } else if (/^home:/i.test(docId)) {
          const rel = docId.replace(/^home:/i, '').replace(/^\/+/, '');
          rawPath = `storage/emulated/0/Documents/${rel}`;
        } else {
          const sdMatch = docId.match(/^([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}):(.+)$/);
          if (sdMatch) {
            rawPath = `storage/${sdMatch[1]}/${sdMatch[2].replace(/^\/+/, '')}`;
          }
        }
      }
    } catch (e) {
      // continuar
    }
  }

  if (rawPath !== null) {
    const segments = rawPath
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg));
    return `file:///${segments.join('/')}`;
  }

  return uri;
}

/**
 * Obtiene o crea una subcarpeta dentro de un Directory existente (funciona para file:// y content:// SAF).
 * Al llamar createDirectory sobre el padre que YA existe en disco, FilePermissionService valida el padre
 * (canWrite() === true) en lugar de fallar sobre la ruta hija que aún no existe.
 */
function getOrCreateSubdirectory(parentDir, childName) {
  const parentUri = parentDir.uri.replace(/\/+$/, '');

  // 1. Si es file://, verificar primero si ya existe en disco
  if (parentUri.startsWith('file://')) {
    const candidateUri = `${parentUri}/${encodeURIComponent(childName)}`;
    try {
      const candidateDir = new Directory(candidateUri);
      if (candidateDir.exists) {
        return candidateDir;
      }
    } catch (e) {
      // continuar con creación
    }
    return parentDir.createDirectory(childName);
  }

  // 2. Si es content:// (SAF), buscar primero entre los hijos existentes para no duplicar carpetas
  try {
    const items = parentDir.list();
    for (const item of items) {
      if (item instanceof Directory && item.name === childName) {
        return item;
      }
    }
  } catch (e) {
    // continuar
  }

  return parentDir.createDirectory(childName);
}

export const cameraOrganizerService = {
  /**
   * Devuelve la clave del mes activo actual (ej. "2026-10") y su nombre de carpeta (ej. "2026-10_Octubre")
   */
  getCurrentMonthInfo() {
    const now = new Date();
    const year = String(now.getFullYear());
    const monthIndex = now.getMonth();
    const monthPadded = String(monthIndex + 1).padStart(2, '0');
    const monthName = MONTH_NAMES[monthIndex];
    return {
      key: `${year}-${monthPadded}`,
      folderName: `${year}-${monthPadded}_${monthName}`,
    };
  },

  /**
   * Determina el año y mes de un archivo a partir de su nombre o fecha de modificación/creación.
   */
  getFileDate(asset) {
    const filename = asset.filename || asset.name || '';

    // 1. Intentar deducir la fecha desde el nombre de archivo (ej. IMG_20240512, IMG-20240512-WA0001, Screenshot_2024-05-12)
    const datePattern = /(?:IMG[-_]?|VID[-_]?|PXL[-_]?|Screenshot[-_]?|WA[-_]?| signal[-_]?)?(20[0-3]\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/i;
    const match = filename.match(datePattern);
    if (match) {
      const year = match[1];
      const monthIndex = parseInt(match[2], 10) - 1;
      const monthPadded = match[2];
      const monthName = MONTH_NAMES[monthIndex] || 'Mes';
      return {
        key: `${year}-${monthPadded}`,
        folderName: `${year}-${monthPadded}_${monthName}`,
        year,
        monthName,
      };
    }

    // 1b. Intentar deducir si el nombre tiene un timestamp en milisegundos (ej. 1715532000123.jpg)
    const tsMatch = filename.match(/(1[5-9]\d{11})/);
    if (tsMatch) {
      const d = new Date(parseInt(tsMatch[1], 10));
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2015 && d.getFullYear() <= 2035) {
        const year = String(d.getFullYear());
        const monthIndex = d.getMonth();
        const monthPadded = String(monthIndex + 1).padStart(2, '0');
        const monthName = MONTH_NAMES[monthIndex];
        return {
          key: `${year}-${monthPadded}`,
          folderName: `${year}-${monthPadded}_${monthName}`,
          year,
          monthName,
        };
      }
    }

    // 2. Intentar deducir desde creationTime / modificationTime
    if (asset.creationTime && asset.creationTime > 0) {
      const d = new Date(asset.creationTime);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2000) {
        const year = String(d.getFullYear());
        const monthIndex = d.getMonth();
        const monthPadded = String(monthIndex + 1).padStart(2, '0');
        const monthName = MONTH_NAMES[monthIndex];
        return {
          key: `${year}-${monthPadded}`,
          folderName: `${year}-${monthPadded}_${monthName}`,
          year,
          monthName,
        };
      }
    }

    return {
      key: 'Varios',
      folderName: 'Varios_y_Anteriores',
      year: 'Otros',
      monthName: 'Varios',
    };
  },

  /**
   * Analiza los archivos de la carpeta y los agrupa por mes, separando fotos y videos.
   */
  groupAssetsByMonth(assets = []) {
    const groups = {};

    for (const asset of assets) {
      if (asset.isDirectory) continue;

      const dateInfo = cameraOrganizerService.getFileDate(asset);
      const groupKey = dateInfo.folderName;

      if (!groups[groupKey]) {
        groups[groupKey] = {
          folderName: dateInfo.folderName,
          key: dateInfo.key,
          photos: [],
          videos: [],
          all: [],
        };
      }

      if (asset.mediaType === 'video') {
        groups[groupKey].videos.push(asset);
      } else {
        groups[groupKey].photos.push(asset);
      }
      groups[groupKey].all.push(asset);
    }

    // Ordenar los meses de más reciente a más antiguo
    const sortedKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
    const sortedGroups = {};
    for (const k of sortedKeys) {
      sortedGroups[k] = groups[k];
    }

    return sortedGroups;
  },

  /**
   * Crea FÍSICAMENTE en el almacenamiento las carpetas por mes (ej. "2026-10_Octubre/Fotos" y "Videos")
   * y mueve todas las fotos y videos correspondientes.
   */
  async physicallyOrganizeFolder({
    targetDirUri,
    assets = [],
    keepActiveMonthInRoot = false,
    onProgress,
    control,
  }) {
    if (!targetDirUri) throw new Error('Ruta de carpeta no válida');

    const filesToOrganize = assets.filter((a) => !a.isDirectory);
    const total = filesToOrganize.length;

    if (total === 0) {
      return { success: true, moved: 0, keptInRoot: 0, monthsCreated: 0 };
    }

    // Completar fecha de modificación real del archivo cuando el nombre no contenga fecha
    for (const item of filesToOrganize) {
      if (!item.creationTime && cameraOrganizerService.getFileDate(item).key === 'Varios' && item.uri) {
        const physItemUri = toPhysicalFileUri(item.uri);
        try {
          const f = new File(physItemUri);
          if (f.modificationTime) {
            item.creationTime = f.modificationTime > 1e11 ? f.modificationTime : f.modificationTime * 1000;
            continue;
          }
        } catch (e1) {
          // probar LegacyFS
        }
        try {
          const info = await FileSystem.getInfoAsync(physItemUri);
          if (info && info.modificationTime) {
            item.creationTime = info.modificationTime > 1e11 ? info.modificationTime : info.modificationTime * 1000;
          }
        } catch (e2) {
          // continuar
        }
      }
    }

    const currentMonth = cameraOrganizerService.getCurrentMonthInfo();
    const allGroups = cameraOrganizerService.groupAssetsByMonth(filesToOrganize);
    const groups = {};
    let keptInRoot = 0;

    for (const [monthFolderName, grp] of Object.entries(allGroups)) {
      if (keepActiveMonthInRoot && grp.key === currentMonth.key) {
        keptInRoot += grp.all.length;
      } else {
        groups[monthFolderName] = grp;
      }
    }

    const monthFolderNames = Object.keys(groups);
    const totalToMove = filesToOrganize.length - keptInRoot;

    if (totalToMove <= 0) {
      return {
        success: true,
        moved: 0,
        keptInRoot,
        total,
        monthsCreated: 0,
        monthFolderNames: [],
        activeMonthName: currentMonth.folderName,
        errorsCount: 0,
      };
    }

    // Determinar el Directory base de trabajo:
    // Preferimos file:// físico si tiene permisos de escritura, y si no, usamos el URI SAF content:// directamente
    const physicalBaseUri = toPhysicalFileUri(targetDirUri);
    let baseDir = null;
    let usingSaf = false;

    try {
      const candidatePhysDir = new Directory(physicalBaseUri);
      if (candidatePhysDir.exists) {
        baseDir = candidatePhysDir;
      }
    } catch (e) {
      // No se pudo abrir como file://
    }

    if (!baseDir && targetDirUri.startsWith('content://')) {
      baseDir = new Directory(targetDirUri);
      usingSaf = true;
    } else if (!baseDir) {
      baseDir = new Directory(physicalBaseUri);
    }

    let moved = 0;
    let monthsActuallyCreated = 0;
    const errors = [];

    for (const monthName of monthFolderNames) {
      const group = groups[monthName];
      let monthDir = null;

      try {
        if (!usingSaf && NativeModules?.VideoEngineModule?.ensureSubfolderNative) {
          try {
            await NativeModules.VideoEngineModule.ensureSubfolderNative(physicalBaseUri, monthName);
          } catch (_eNatDir) {
            // continuar con getOrCreateSubdirectory
          }
        }

        try {
          monthDir = getOrCreateSubdirectory(baseDir, monthName);
        } catch (firstDirErr) {
          // Si falló con file:// por falta de permiso "Acceso a todos los archivos" y tenemos content:// SAF, cambiar a SAF
          if (!usingSaf && targetDirUri.startsWith('content://')) {
            baseDir = new Directory(targetDirUri);
            usingSaf = true;
            monthDir = getOrCreateSubdirectory(baseDir, monthName);
          } else {
            throw firstDirErr;
          }
        }

        monthsActuallyCreated++;
      } catch (errDir) {
        errors.push({ file: monthName, error: String(errDir?.message || errDir) });
        continue;
      }

      // Mover fotos directamente a la carpeta del mes (ej. 2026-09_Septiembre -> mostrada como "Septiembre 2026")
      for (const photo of group.photos) {
        if (control?.waitIfPaused) await control.waitIfPaused();
        if (control?.isCancelled) {
          return {
            success: true,
            cancelled: true,
            moved,
            keptInRoot,
            total,
            monthsCreated: monthsActuallyCreated,
            monthFolderNames,
            activeMonthName: currentMonth.folderName,
            errorsCount: errors.length,
          };
        }

        const filename = photo.filename || `foto_${Date.now()}.jpg`;
        try {
          if (!usingSaf && NativeModules?.VideoEngineModule?.moveFileToSubfolderNative) {
            try {
              const newUri = await NativeModules.VideoEngineModule.moveFileToSubfolderNative(
                toPhysicalFileUri(photo.uri),
                physicalBaseUri,
                monthName,
                filename
              );
              photo.uri = newUri;
              moved++;
              if (onProgress) {
                onProgress({
                  current: moved,
                  total: totalToMove,
                  percent: totalToMove > 0 ? moved / totalToMove : 1,
                  currentFile: filename,
                  currentMonth: monthName,
                });
              }
              continue;
            } catch (_eNatMove) {
              // fallback a srcFile.move(monthDir)
            }
          }
          const srcUri = usingSaf ? photo.uri : toPhysicalFileUri(photo.uri);
          const srcFile = new File(srcUri);
          await Promise.resolve(srcFile.move(monthDir));
          photo.uri = srcFile.uri;
          moved++;
        } catch (errMove) {
          errors.push({ file: filename, error: String(errMove?.message || errMove) });
        }

        if (onProgress) {
          onProgress({
            current: moved,
            total: totalToMove,
            percent: totalToMove > 0 ? moved / totalToMove : 1,
            currentFile: filename,
            currentMonth: monthName,
          });
        }
      }

      // Mover videos directamente a la carpeta del mes
      for (const video of group.videos) {
        if (control?.waitIfPaused) await control.waitIfPaused();
        if (control?.isCancelled) {
          return {
            success: true,
            cancelled: true,
            moved,
            keptInRoot,
            total,
            monthsCreated: monthsActuallyCreated,
            monthFolderNames,
            activeMonthName: currentMonth.folderName,
            errorsCount: errors.length,
          };
        }

        const filename = video.filename || `video_${Date.now()}.mp4`;
        try {
          if (!usingSaf && NativeModules?.VideoEngineModule?.moveFileToSubfolderNative) {
            try {
              const newUri = await NativeModules.VideoEngineModule.moveFileToSubfolderNative(
                toPhysicalFileUri(video.uri),
                physicalBaseUri,
                monthName,
                filename
              );
              video.uri = newUri;
              moved++;
              if (onProgress) {
                onProgress({
                  current: moved,
                  total: totalToMove,
                  percent: totalToMove > 0 ? moved / totalToMove : 1,
                  currentFile: filename,
                  currentMonth: monthName,
                });
              }
              continue;
            } catch (_eNatMove) {
              // fallback a srcFile.move(monthDir)
            }
          }
          const srcUri = usingSaf ? video.uri : toPhysicalFileUri(video.uri);
          const srcFile = new File(srcUri);
          await Promise.resolve(srcFile.move(monthDir));
          video.uri = srcFile.uri;
          moved++;
        } catch (errMove) {
          errors.push({ file: filename, error: String(errMove?.message || errMove) });
        }

        if (onProgress) {
          onProgress({
            current: moved,
            total: totalToMove,
            percent: totalToMove > 0 ? moved / totalToMove : 1,
            currentFile: filename,
            currentMonth: monthName,
          });
        }
      }
    }

    if (moved === 0 && monthsActuallyCreated === 0 && errors.length > 0) {
      const err = new Error(
        'Android bloqueó la creación de carpetas en esta ruta. Activa el permiso "Acceso a todos los archivos" en Configuración e inténtalo de nuevo.'
      );
      err.code = 'PERMISSION_REQUIRED';
      throw err;
    }

    return {
      success: true,
      moved,
      keptInRoot,
      total,
      monthsCreated: monthsActuallyCreated,
      monthFolderNames,
      activeMonthName: currentMonth.folderName,
      errorsCount: errors.length,
    };
  },
};
