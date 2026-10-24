import * as FileSystem from 'expo-file-system/legacy';
import { Directory, File } from 'expo-file-system';

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

/**
 * Convierte una ruta SAF content:// (ej. primary:DCIM/Camera) a su ruta física file:///storage/emulated/0/...
 * para permitir crear carpetas y mover archivos por mes sin fallos en Android.
 */
function toPhysicalFileUri(uri) {
  if (!uri || typeof uri !== 'string') return uri;
  if (uri.startsWith('file://')) {
    try {
      return decodeURIComponent(uri);
    } catch (e) {
      return uri;
    }
  }
  if (uri.startsWith('content://')) {
    try {
      const docMatch = uri.match(/\/document\/([^/?#]+)/i) || uri.match(/\/tree\/([^/?#]+)/i);
      if (docMatch && docMatch[1]) {
        const docId = decodeURIComponent(docMatch[1]);
        if (/^primary:/i.test(docId)) {
          const rel = docId.replace(/^primary:/i, '').replace(/^\/+/, '');
          return `file:///storage/emulated/0/${rel}`;
        }
        const sdMatch = docId.match(/^([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}):(.+)$/);
        if (sdMatch) {
          return `file:///storage/${sdMatch[1]}/${sdMatch[2].replace(/^\/+/, '')}`;
        }
      }
    } catch (e) {
      // continuar
    }
  }
  return uri;
}

export const cameraOrganizerService = {
  /**
   * Devuelve la clave del mes activo actual (ej. "2026-10") y su nombre legible (ej. "2026-10 Octubre")
   */
  getCurrentMonthInfo() {
    const now = new Date();
    const year = String(now.getFullYear());
    const monthIndex = now.getMonth();
    const monthPadded = String(monthIndex + 1).padStart(2, '0');
    const monthName = MONTH_NAMES[monthIndex];
    return {
      key: `${year}-${monthPadded}`,
      folderName: `${year}-${monthPadded} ${monthName}`,
    };
  },
  /**
   * Determina el año y mes de un archivo a partir de su nombre o fecha de creación.
   */
  getFileDate(asset) {
    const filename = asset.filename || asset.name || '';

    // 1. Intentar deducir la fecha desde el nombre de archivo (ej. IMG_20240512, IMG-20240512-WA0001, Screenshot_2024-05-12)
    const datePattern = /(?:IMG[-_]?|VID[-_]?|PXL[-_]?|Screenshot[-_]?|WA[-_]?)?(20[0-3]\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/i;
    const match = filename.match(datePattern);
    if (match) {
      const year = match[1];
      const monthIndex = parseInt(match[2], 10) - 1;
      const monthPadded = match[2];
      const monthName = MONTH_NAMES[monthIndex] || 'Mes';
      return {
        key: `${year}-${monthPadded}`,
        folderName: `${year}-${monthPadded} ${monthName}`,
        year,
        monthName,
      };
    }

    // 2. Intentar deducir desde creationTime
    if (asset.creationTime && asset.creationTime > 0) {
      const d = new Date(asset.creationTime);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2000) {
        const year = d.getFullYear();
        const monthIndex = d.getMonth();
        const monthPadded = String(monthIndex + 1).padStart(2, '0');
        const monthName = MONTH_NAMES[monthIndex];
        return {
          key: `${year}-${monthPadded}`,
          folderName: `${year}-${monthPadded} ${monthName}`,
          year,
          monthName,
        };
      }
    }

    return {
      key: 'Varios',
      folderName: 'Varios y Anteriores',
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
      // Ignorar si es un directorio
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
   * Crea FÍSICAMENTE en el almacenamiento las carpetas por mes para los meses anteriores,
   * dejando todas las fotos y videos del MES ACTIVO en la carpeta raíz.
   */
  async physicallyOrganizeFolder({
    targetDirUri,
    assets = [],
    keepActiveMonthInRoot = true,
    onProgress,
    control,
  }) {
    if (!targetDirUri) throw new Error('Ruta de carpeta no válida');

    const physicalBase = toPhysicalFileUri(targetDirUri);
    const cleanBaseUri = physicalBase.endsWith('/')
      ? physicalBase.slice(0, -1)
      : physicalBase;

    // Solo organizamos archivos directos (sin meterse en subcarpetas ya creadas)
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
          const info = await FileSystem.getInfoAsync(physItemUri);
          if (info && info.modificationTime) {
            item.creationTime = info.modificationTime > 1e11 ? info.modificationTime : info.modificationTime * 1000;
          }
        } catch (e) {
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
        // Las fotos y videos del mes activo se quedan en la carpeta raíz
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

    let moved = 0;
    const errors = [];

    for (const monthName of monthFolderNames) {
      const group = groups[monthName];

      const monthDirPath = `${cleanBaseUri}/${monthName}`;
      const photosDirPath = `${monthDirPath}/Fotos`;
      const videosDirPath = `${monthDirPath}/Videos`;

      // Crear carpetas físicas si tienen archivos
      try {
        if (group.photos.length > 0) {
          try {
            await FileSystem.makeDirectoryAsync(photosDirPath, { intermediates: true });
          } catch (e1) {
            new Directory(photosDirPath).create({ intermediates: true, idempotent: true });
          }
        }
        if (group.videos.length > 0) {
          try {
            await FileSystem.makeDirectoryAsync(videosDirPath, { intermediates: true });
          } catch (e1) {
            new Directory(videosDirPath).create({ intermediates: true, idempotent: true });
          }
        }
      } catch (errDir) {
        console.warn('Error al crear directorio físico:', errDir);
      }

      // Mover fotos físicamente a su carpeta de mes
      for (const photo of group.photos) {
        if (control?.waitIfPaused) await control.waitIfPaused();
        if (control?.isCancelled) {
          return {
            success: true,
            cancelled: true,
            moved,
            keptInRoot,
            total,
            monthsCreated: monthFolderNames.length,
            monthFolderNames,
            activeMonthName: currentMonth.folderName,
            errorsCount: errors.length,
          };
        }
        const filename = photo.filename || `foto_${Date.now()}.jpg`;
        const dest = `${photosDirPath}/${filename}`;
        const srcPhys = toPhysicalFileUri(photo.uri);
        try {
          if (srcPhys !== dest) {
            try {
              await FileSystem.moveAsync({ from: srcPhys, to: dest });
            } catch (moveErr1) {
              await new File(srcPhys).move(new File(dest));
            }
            photo.uri = dest;
          }
          moved++;
        } catch (errMove) {
          errors.push({ file: filename, error: String(errMove) });
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

      // Mover videos físicamente a su carpeta de mes
      for (const video of group.videos) {
        if (control?.waitIfPaused) await control.waitIfPaused();
        if (control?.isCancelled) {
          return {
            success: true,
            cancelled: true,
            moved,
            keptInRoot,
            total,
            monthsCreated: monthFolderNames.length,
            monthFolderNames,
            activeMonthName: currentMonth.folderName,
            errorsCount: errors.length,
          };
        }
        const filename = video.filename || `video_${Date.now()}.mp4`;
        const dest = `${videosDirPath}/${filename}`;
        const srcPhys = toPhysicalFileUri(video.uri);
        try {
          if (srcPhys !== dest) {
            try {
              await FileSystem.moveAsync({ from: srcPhys, to: dest });
            } catch (moveErr1) {
              await new File(srcPhys).move(new File(dest));
            }
            video.uri = dest;
          }
          moved++;
        } catch (errMove) {
          errors.push({ file: filename, error: String(errMove) });
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

    return {
      success: true,
      moved,
      keptInRoot,
      total,
      monthsCreated: monthFolderNames.length,
      monthFolderNames,
      activeMonthName: currentMonth.folderName,
      errorsCount: errors.length,
    };
  },
};
