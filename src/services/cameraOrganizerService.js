import * as FileSystem from 'expo-file-system/legacy';
import { Directory, File } from 'expo-file-system';

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

export const cameraOrganizerService = {
  /**
   * Determina el año y mes de un archivo a partir de su nombre o fecha de creación.
   */
  getFileDate(asset) {
    const filename = asset.filename || asset.name || '';

    // 1. Intentar deducir la fecha desde el nombre de archivo (ej. IMG_20240512_142030, VID_20231224_...)
    const datePattern = /(?:IMG_|VID_|PXL_|Screenshot_)?(20\d\d)(0[1-9]|1[0-2])([0-3]\d)/i;
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
   * Crea FÍSICAMENTE en el almacenamiento las carpetas por mes con separación
   * de fotos y videos, y mueve físicamente los archivos para descongestionar la cámara.
   */
  async physicallyOrganizeFolder({
    targetDirUri,
    assets = [],
    onProgress,
  }) {
    if (!targetDirUri) throw new Error('Ruta de carpeta no válida');

    const cleanBaseUri = targetDirUri.endsWith('/')
      ? targetDirUri.slice(0, -1)
      : targetDirUri;

    // Solo organizamos archivos directos (sin meterse en subcarpetas ya creadas)
    const filesToOrganize = assets.filter((a) => !a.isDirectory);
    const total = filesToOrganize.length;

    if (total === 0) {
      return { success: true, moved: 0, monthsCreated: 0 };
    }

    const groups = cameraOrganizerService.groupAssetsByMonth(filesToOrganize);
    const monthFolderNames = Object.keys(groups);

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
          await FileSystem.makeDirectoryAsync(photosDirPath, { intermediates: true });
        }
        if (group.videos.length > 0) {
          await FileSystem.makeDirectoryAsync(videosDirPath, { intermediates: true });
        }
      } catch (errDir) {
        console.warn('Error al crear directorio físico:', errDir);
      }

      // Mover fotos físicamente a su carpeta de mes
      for (const photo of group.photos) {
        const filename = photo.filename || `foto_${Date.now()}.jpg`;
        const dest = `${photosDirPath}/${filename}`;
        try {
          if (photo.uri !== dest) {
            await FileSystem.moveAsync({
              from: photo.uri,
              to: dest,
            });
            photo.uri = dest;
          }
          moved++;
        } catch (errMove) {
          errors.push({ file: filename, error: String(errMove) });
        }

        if (onProgress) {
          onProgress({
            current: moved,
            total,
            percent: moved / total,
            currentFile: filename,
            currentMonth: monthName,
          });
        }
      }

      // Mover videos físicamente a su carpeta de mes
      for (const video of group.videos) {
        const filename = video.filename || `video_${Date.now()}.mp4`;
        const dest = `${videosDirPath}/${filename}`;
        try {
          if (video.uri !== dest) {
            await FileSystem.moveAsync({
              from: video.uri,
              to: dest,
            });
            video.uri = dest;
          }
          moved++;
        } catch (errMove) {
          errors.push({ file: filename, error: String(errMove) });
        }

        if (onProgress) {
          onProgress({
            current: moved,
            total,
            percent: moved / total,
            currentFile: filename,
            currentMonth: monthName,
          });
        }
      }
    }

    return {
      success: true,
      moved,
      total,
      monthsCreated: monthFolderNames.length,
      monthFolderNames,
      errorsCount: errors.length,
    };
  },
};
