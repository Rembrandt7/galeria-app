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
  /** Abre el selector de carpetas del sistema (cualquier carpeta de almacenamiento o SD). */
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
   * Lee ÚNICAMENTE el nivel actual de la carpeta (no recursivo, ultra rápido).
   * Devuelve las subcarpetas y las fotos/videos sueltos de este nivel.
   */
  async readDirectory(uri) {
    try {
      const dir = new Directory(uri);
      const items = dir.list();
      const subfolders = [];
      const assets = [];

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
          let modified = 0;
          try {
            modified = item.modificationTime || 0;
          } catch (e) {}
          assets.push({
            id: item.uri,
            uri: item.uri,
            filename: item.name,
            mediaType,
            creationTime: modified,
            width: null,
            height: null,
            fromFolder: true,
          });
        }
      }

      // Subcarpetas alfabéticamente
      subfolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      // Fotos más recientes primero
      assets.sort((a, b) => b.creationTime - a.creationTime);

      return { subfolders, assets };
    } catch (e) {
      console.warn('Error al leer carpeta:', e);
      return { subfolders: [], assets: [] };
    }
  },

  /**
   * Carga todas las fotos y videos de esta carpeta y todas sus subcarpetas (recursivo).
   * Se usa para el apartado "Ver todo junto".
   */
  async loadFolderAssets(uri) {
    const out = [];
    const collect = (dir, depth) => {
      let items = [];
      try {
        items = dir.list();
      } catch (e) {
        return;
      }
      for (const item of items) {
        if (item instanceof Directory) {
          if (depth < MAX_DEPTH) collect(item, depth + 1);
        } else {
          const mediaType = getMediaType(item);
          if (!mediaType) continue;
          let modified = 0;
          try {
            modified = item.modificationTime || 0;
          } catch (e) {}
          out.push({
            id: item.uri,
            uri: item.uri,
            filename: item.name,
            mediaType,
            creationTime: modified,
            width: null,
            height: null,
            fromFolder: true,
          });
        }
      }
    };

    collect(new Directory(uri), 0);
    out.sort((a, b) => b.creationTime - a.creationTime);
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
