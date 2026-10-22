import { Directory, File } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';

const FOLDER_KEY = '@galeria_selected_folder';
const MAX_DEPTH = 4;

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif'];
const VIDEO_EXT = ['mp4', 'mkv', 'mov', 'webm', 'avi', '3gp', 'm4v'];

const getMediaType = (file) => {
  const mime = (file.type || '').toLowerCase();
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  const ext = (file.name || '').split('.').pop().toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'photo';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return null;
};

export const folderService = {
  /** Abre el selector de carpetas del sistema. */
  async pickFolder() {
    try {
      const dir = await Directory.pickDirectoryAsync();
      if (!dir) return null;
      await AsyncStorage.setItem(FOLDER_KEY, dir.uri);
      return dir.uri;
    } catch (e) {
      console.error('Error al seleccionar carpeta:', e);
      return null;
    }
  },

  async getSavedFolder() {
    return AsyncStorage.getItem(FOLDER_KEY);
  },

  async clearFolder() {
    await AsyncStorage.removeItem(FOLDER_KEY);
  },

  /**
   * Lee la carpeta actual de forma instantánea sin hacer llamadas pesadas a disco por cada archivo.
   */
  async readDirectory(uri, onBatch) {
    try {
      const dir = new Directory(uri);
      const items = dir.list();
      const subfolders = [];
      const assets = [];

      let processed = 0;
      for (const item of items) {
        if (item instanceof Directory) {
          subfolders.push({
            id: item.uri,
            uri: item.uri,
            name: item.name || folderService.folderName(item.uri),
            isDirectory: true,
          });
        } else {
          const mediaType = getMediaType(item);
          if (!mediaType) continue;
          assets.push({
            id: item.uri,
            uri: item.uri,
            filename: item.name,
            mediaType,
            creationTime: 0,
            width: null,
            height: null,
            fromFolder: true,
          });
        }
        processed++;

        // Emisión temprana del primer lote (~24 fotos) en milisegundos
        if (onBatch && processed === 24 && assets.length > 0) {
          onBatch({
            subfolders: [...subfolders].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
            assets: [...assets].sort((a, b) => b.filename.localeCompare(a.filename, undefined, { numeric: true, sensitivity: 'base' })),
            isPartial: true,
          });
        }
      }

      // Ordenar subcarpetas alfabéticamente
      subfolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      // Ordenar fotos por nombre descendente (los nombres de fotos como IMG_2026... ya tienen fecha)
      assets.sort((a, b) => b.filename.localeCompare(a.filename, undefined, { numeric: true, sensitivity: 'base' }));

      if (onBatch) {
        onBatch({ subfolders, assets, isPartial: false });
      }

      return { subfolders, assets };
    } catch (e) {
      console.warn('Error al leer carpeta:', e);
      return { subfolders: [], assets: [] };
    }
  },

  /**
   * Carga recursiva rápida para "Todo junto".
   */
  async loadFolderAssets(uri, onBatch) {
    const out = [];
    const collect = (dir, depth) => {
      let items = [];
      try {
        items = dir.list();
      } catch (e) {
        return;
      }
      const batch = [];
      for (const item of items) {
        if (item instanceof Directory) {
          if (depth < MAX_DEPTH) collect(item, depth + 1);
        } else {
          const mediaType = getMediaType(item);
          if (!mediaType) continue;
          const assetObj = {
            id: item.uri,
            uri: item.uri,
            filename: item.name,
            mediaType,
            creationTime: 0,
            width: null,
            height: null,
            fromFolder: true,
          };
          out.push(assetObj);
          batch.push(assetObj);
        }
      }

      if (onBatch && batch.length > 0) {
        onBatch(batch);
      }
    };

    collect(new Directory(uri), 0);
    out.sort((a, b) => b.filename.localeCompare(a.filename, undefined, { numeric: true, sensitivity: 'base' }));
    return out;
  },

  folderName(uri) {
    try {
      const decoded = decodeURIComponent(uri);
      const parts = decoded.split(/[:/]/).filter(Boolean);
      return parts[parts.length - 1] || 'Carpeta';
    } catch (e) {
      return 'Carpeta';
    }
  },

  async deleteFile(uri) {
    try {
      new File(uri).delete();
      return true;
    } catch (e) {
      console.error('Error al eliminar archivo de carpeta:', e);
      return false;
    }
  },
};
