import { Directory, File } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, Linking, Alert } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import * as LegacyFS from 'expo-file-system/legacy';

const FOLDER_KEY = '@galeria_selected_folder';
const FOLDERS_LIST_KEY = '@galeria_saved_folders_list';
const MAX_DEPTH = 4;

export const COMMON_SYSTEM_FOLDERS = [
  {
    id: 'internal_root',
    name: 'Memoria Interna (Raíz)',
    uri: 'file:///storage/emulated/0',
    icon: 'phone-portrait-outline',
    description: 'Acceso a todas las carpetas del teléfono',
  },
  {
    id: 'whatsapp_media',
    name: 'WhatsApp (Fotos y Videos)',
    uri: 'file:///storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media',
    icon: 'logo-whatsapp',
    description: 'Fotos, videos y estados recibidos y enviados',
  },
  {
    id: 'download',
    name: 'Descargas (Download)',
    uri: 'file:///storage/emulated/0/Download',
    icon: 'download-outline',
    description: 'Archivos e imágenes descargadas',
  },
  {
    id: 'dcim',
    name: 'Cámara (DCIM)',
    uri: 'file:///storage/emulated/0/DCIM',
    icon: 'camera-outline',
    description: 'Fotos y videos de la cámara original',
  },
  {
    id: 'pictures',
    name: 'Imágenes (Pictures)',
    uri: 'file:///storage/emulated/0/Pictures',
    icon: 'images-outline',
    description: 'Capturas de pantalla y fotos de apps',
  },
  {
    id: 'telegram',
    name: 'Telegram Media',
    uri: 'file:///storage/emulated/0/Android/media/org.telegram.messenger',
    icon: 'paper-plane-outline',
    description: 'Archivos multimedia recibidos en Telegram',
  },
];

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

// --- Utilidades rápidas basadas en el nombre (sin llamadas nativas por archivo) ---
const mediaTypeByName = (name) => {
  const i = name.lastIndexOf('.');
  if (i < 0) return null;
  const ext = name.slice(i + 1).toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'photo';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return null;
};

const hasExtension = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 && name.length - i <= 6;
};

const nameFromUri = (uri) => {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch (e) {
    // usar el uri tal cual
  }
  const last = decoded.split('/').pop() || '';
  return last.split(':').pop() || last;
};

const byFilenameDesc = (a, b) =>
  a.filename < b.filename ? 1 : a.filename > b.filename ? -1 : 0;

const byNameAsc = (a, b) => {
  const x = (a.name || '').toLowerCase();
  const y = (b.name || '').toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

export const folderService = {
  folderName(uri) {
    try {
      const decoded = decodeURIComponent(uri);
      const parts = decoded.split(/[:/]/).filter(Boolean);
      return parts[parts.length - 1] || 'Carpeta';
    } catch (e) {
      return 'Carpeta';
    }
  },

  /**
   * Obtiene la lista completa de carpetas agregadas por el usuario.
   * Si existe una carpeta previa única, la migra automáticamente a la lista.
   */
  async getSavedFolders() {
    try {
      const raw = await AsyncStorage.getItem(FOLDERS_LIST_KEY);
      let list = raw ? JSON.parse(raw) : [];

      // Migración de versión previa con una sola carpeta
      if (!list || list.length === 0) {
        const legacy = await AsyncStorage.getItem(FOLDER_KEY);
        if (legacy) {
          list = [{ uri: legacy, name: folderService.folderName(legacy) }];
          await AsyncStorage.setItem(FOLDERS_LIST_KEY, JSON.stringify(list));
        }
      }

      return Array.isArray(list) ? list : [];
    } catch (e) {
      console.warn('Error al obtener lista de carpetas guardadas:', e);
      return [];
    }
  },

  /**
   * Agrega una nueva carpeta a la lista guardada.
   */
  async addSavedFolder(uri, name) {
    try {
      const current = await folderService.getSavedFolders();
      const existing = current.find((f) => f.uri === uri);
      if (existing) return current;

      const newFolder = {
        uri,
        name: name || folderService.folderName(uri),
        addedAt: Date.now(),
      };
      const updated = [newFolder, ...current];
      await AsyncStorage.setItem(FOLDERS_LIST_KEY, JSON.stringify(updated));
      await AsyncStorage.setItem(FOLDER_KEY, uri);
      return updated;
    } catch (e) {
      console.error('Error al guardar nueva carpeta:', e);
      return [];
    }
  },

  /**
   * Elimina una carpeta de la lista guardada.
   */
  async removeSavedFolder(uri) {
    try {
      const current = await folderService.getSavedFolders();
      const updated = current.filter((f) => f.uri !== uri);
      await AsyncStorage.setItem(FOLDERS_LIST_KEY, JSON.stringify(updated));
      if (updated.length > 0) {
        await AsyncStorage.setItem(FOLDER_KEY, updated[0].uri);
      } else {
        await AsyncStorage.removeItem(FOLDER_KEY);
      }
      return updated;
    } catch (e) {
      console.error('Error al remover carpeta:', e);
      return [];
    }
  },

  /**
   * Abre el selector nativo del sistema para elegir y agregar una nueva carpeta.
   */
  async pickFolder() {
    try {
      const dir = await Directory.pickDirectoryAsync();
      if (!dir) return null;
      const folders = await folderService.addSavedFolder(dir.uri, dir.name);
      return { uri: dir.uri, name: dir.name || folderService.folderName(dir.uri), folders };
    } catch (e) {
      console.error('Error al seleccionar carpeta:', e);
      return null;
    }
  },

  /**
   * Abre la configuración especial de Android para conceder acceso a todos los archivos
   * (necesario para ver carpetas ocultas, descargas completas y carpetas del sistema).
   */
  async openAllFilesAccessSettings() {
    if (Platform.OS !== 'android') {
      Alert.alert('Aviso', 'Esta configuración solo aplica para dispositivos Android.');
      return;
    }
    try {
      await IntentLauncher.startActivityAsync(
        'android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION',
        { data: 'package:com.rembrant.galeriaapp' }
      );
    } catch (e1) {
      try {
        await IntentLauncher.startActivityAsync(
          'android.settings.MANAGE_ALL_FILES_ACCESS_PERMISSION'
        );
      } catch (e2) {
        Linking.openSettings();
      }
    }
  },

  async getSavedFolder() {
    const list = await folderService.getSavedFolders();
    return list.length > 0 ? list[0].uri : null;
  },

  async clearFolder() {
    await AsyncStorage.removeItem(FOLDER_KEY);
    await AsyncStorage.removeItem(FOLDERS_LIST_KEY);
  },

  /**
   * Lista un nivel de carpeta de forma RÁPIDA: una sola llamada nativa para obtener
   * los nombres y el tipo se deduce por extensión (sin consultar archivo por archivo).
   */
  async _listFast(uri) {
    let entries;
    if (uri.startsWith('content://')) {
      const children = await LegacyFS.StorageAccessFramework.readDirectoryAsync(uri);
      entries = children.map((u) => ({ uri: u, name: nameFromUri(u) }));
    } else if (uri.startsWith('file://')) {
      const base = uri.endsWith('/') ? uri : `${uri}/`;
      const names = await LegacyFS.readDirectoryAsync(uri);
      entries = names.map((n) => ({ uri: base + encodeURIComponent(n), name: n }));
    } else {
      throw new Error('Ruta no soportada para lectura rápida');
    }

    const assets = [];
    const candidates = [];
    for (const e of entries) {
      const mediaType = mediaTypeByName(e.name);
      if (mediaType) {
        assets.push({
          id: e.uri,
          uri: e.uri,
          filename: e.name,
          mediaType,
          creationTime: 0,
          width: null,
          height: null,
          fromFolder: true,
        });
      } else if (!hasExtension(e.name)) {
        candidates.push(e);
      }
    }

    let dirEntries = candidates;
    if (uri.startsWith('file://')) {
      // Confirmar cuáles candidatos son realmente carpetas (pocos, en lotes paralelos)
      dirEntries = [];
      const limited = candidates.slice(0, 400);
      for (let i = 0; i < limited.length; i += 25) {
        const slice = limited.slice(i, i + 25);
        const infos = await Promise.all(
          slice.map((c) => LegacyFS.getInfoAsync(c.uri).catch(() => null))
        );
        infos.forEach((info, j) => {
          if (info && info.isDirectory) dirEntries.push(slice[j]);
        });
      }
    }

    const subfolders = dirEntries.map((e) => ({
      id: e.uri,
      uri: e.uri,
      name: e.name || folderService.folderName(e.uri),
      isDirectory: true,
    }));

    return { subfolders, assets };
  },

  /**
   * Lectura de respaldo (más lenta) usando la API nueva de expo-file-system.
   */
  async _listSlow(uri) {
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
        if (mediaType) {
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
      }
      processed++;
      // Ceder el hilo para que la pantalla no se congele con carpetas enormes
      if (processed % 150 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return { subfolders, assets };
  },

  async _listLevel(uri) {
    try {
      const fast = await folderService._listFast(uri);
      if (fast.assets.length > 0 || fast.subfolders.length > 0) return fast;
    } catch (e) {
      // continuar con el método de respaldo
    }
    return folderService._listSlow(uri);
  },

  /**
   * Lee la carpeta actual (rápido, ordenada de la más reciente a la más antigua).
   */
  async readDirectory(uri, onBatch) {
    try {
      const { subfolders, assets } = await folderService._listLevel(uri);
      subfolders.sort(byNameAsc);
      assets.sort(byFilenameDesc);
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
   * Carga recursiva para "Todo junto" (asíncrona, no bloquea la interfaz).
   */
  async loadFolderAssets(uri, onBatch) {
    const out = [];
    const walk = async (dirUri, depth) => {
      let level;
      try {
        level = await folderService._listLevel(dirUri);
      } catch (e) {
        return;
      }
      if (level.assets.length > 0) {
        for (const a of level.assets) out.push(a);
        if (onBatch) onBatch(level.assets);
      }
      if (depth < MAX_DEPTH) {
        for (const sub of level.subfolders) {
          if (sub.name && sub.name.startsWith('.')) continue; // omitir .thumbnails, .trash...
          await walk(sub.uri, depth + 1);
        }
      }
    };

    await walk(uri, 0);
    out.sort(byFilenameDesc);
    return out;
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
