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

const collect = (dir, depth, out) => {
  let items = [];
  try {
    items = dir.list();
  } catch (e) {
    return;
  }
  for (const item of items) {
    if (item instanceof Directory) {
      if (depth < MAX_DEPTH) collect(item, depth + 1, out);
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

export const folderService = {
  /** Abre el selector de carpetas del sistema (cualquier carpeta). */
  async pickFolder() {
    const dir = await Directory.pickDirectoryAsync();
    if (!dir) return null;
    await AsyncStorage.setItem(FOLDER_KEY, dir.uri);
    return dir.uri;
  },

  async getSavedFolder() {
    return AsyncStorage.getItem(FOLDER_KEY);
  },

  async clearFolder() {
    await AsyncStorage.removeItem(FOLDER_KEY);
  },

  /** Lista fotos y videos de la carpeta (incluye subcarpetas), más recientes primero. */
  async loadFolderAssets(uri) {
    const out = [];
    collect(new Directory(uri), 0, out);
    out.sort((a, b) => b.creationTime - a.creationTime);
    return out;
  },

  folderName(uri) {
    try {
      const decoded = decodeURIComponent(uri);
      return decoded.split(/[:/]/).filter(Boolean).pop() || 'Carpeta';
    } catch (e) {
      return 'Carpeta';
    }
  },

  async deleteFile(uri) {
    new File(uri).delete();
    return true;
  },
};
