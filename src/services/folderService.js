import { Directory, File } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, Linking, Alert, NativeModules } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import * as LegacyFS from 'expo-file-system/legacy';

const FOLDER_KEY = '@galeria_selected_folder';
const FOLDERS_LIST_KEY = '@galeria_saved_folders_list';
const MAX_DEPTH = 4;

export const DOWNLOADED_VIDEOS_FOLDER_NAME = 'Videos Descargados';
export const DOWNLOADED_VIDEOS_FOLDER_URI = 'file:///storage/emulated/0/Movies/Videos Descargados';

export const COMMON_SYSTEM_FOLDERS = [
  {
    id: 'videos_descargados',
    name: 'Videos Descargados',
    uri: DOWNLOADED_VIDEOS_FOLDER_URI,
    icon: 'cloud-download-outline',
    description: 'Carpeta propia donde se guardan los videos descargados por enlace',
  },
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

// Carpetas del sistema Android que nunca contienen fotos/videos del usuario o no deben escanearse como álbumes vacíos
const NON_MEDIA_DIR_REGEX =
  /^(\.|android|data|obb|alarms|ringtones|notifications|podcasts|music|audiobooks|documents|cache|code_cache|temp|tmp|thumbnails|trash|backup|backups|crash|logs)$/i;

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

const MONTH_NAMES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

const formatSegmentAsMonthYear = (seg) => {
  if (!seg) return null;
  const m = String(seg).trim().match(/^(20\d{2})[-_](0[1-9]|1[0-2])(?:[-_]?([A-Za-zÁÉÍÓÚáéíóúñÑ]+))?$/i);
  if (!m) return null;
  const year = m[1];
  const monthIdx = parseInt(m[2], 10) - 1;
  const rawMonth = m[3] || MONTH_NAMES_ES[monthIdx] || 'Mes';
  const cleanMonth = rawMonth.charAt(0).toUpperCase() + rawMonth.slice(1).toLowerCase();
  return `${cleanMonth} ${year}`;
};

export const folderService = {
  formatFolderDisplayName(rawName, uri = '') {
    const directMonth = formatSegmentAsMonthYear(rawName);
    if (directMonth) return directMonth;

    if (uri) {
      try {
        const decoded = decodeURIComponent(uri);
        const parts = decoded.split(/[:/]/).filter(Boolean);
        const last = parts[parts.length - 1] || rawName || '';
        const prev = parts.length >= 2 ? parts[parts.length - 2] : '';

        const lastMonth = formatSegmentAsMonthYear(last);
        if (lastMonth) return lastMonth;

        if (/^(fotos|videos|imágenes|imagenes)$/i.test(last) && prev) {
          const prevMonth = formatSegmentAsMonthYear(prev);
          if (prevMonth) return prevMonth;
          if (!/^(storage|emulated|0|primary|dcim|pictures|media)$/i.test(prev)) {
            return `${prev} (${last})`;
          }
        }
      } catch (_e) {}
    }

    return rawName || 'Carpeta';
  },

  folderName(uri) {
    try {
      const decoded = decodeURIComponent(uri);
      const parts = decoded.split(/[:/]/).filter(Boolean);
      const last = parts[parts.length - 1] || 'Carpeta';
      return folderService.formatFolderDisplayName(last, uri);
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

      if (!Array.isArray(list)) return [];

      // Actualizar nombres repetitivos ("Fotos", "2026-09_Septiembre") a formato Mes y Año ("Septiembre 2026")
      return list.map((item) => ({
        ...item,
        name: folderService.formatFolderDisplayName(item.name, item.uri),
      }));
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
   * Agrega múltiples carpetas seleccionadas desde el escáner inteligente en un solo paso.
   */
  async addMultipleSavedFolders(foldersToAdd = []) {
    try {
      const current = await folderService.getSavedFolders();
      const existingSet = new Set(current.map((f) => folderService.toPhysicalUri(f.uri) || f.uri));
      const addedItems = [];
      let now = Date.now();
      for (const item of foldersToAdd) {
        if (!item?.uri) continue;
        const norm = folderService.toPhysicalUri(item.uri) || item.uri;
        if (existingSet.has(norm) || existingSet.has(item.uri)) continue;
        existingSet.add(norm);
        addedItems.push({
          uri: item.uri,
          name: item.name || folderService.folderName(item.uri),
          addedAt: now++,
        });
      }
      if (addedItems.length === 0) return current;
      const updated = [...addedItems, ...current];
      await AsyncStorage.setItem(FOLDERS_LIST_KEY, JSON.stringify(updated));
      await AsyncStorage.setItem(FOLDER_KEY, addedItems[0].uri);
      return updated;
    } catch (e) {
      console.error('Error al guardar múltiples carpetas:', e);
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

  _coverMemCache: new Map(),

  /**
   * Obtiene rápidamente la primera imagen/video (portada), el conteo de archivos y subcarpetas de una carpeta.
   */
  async getFolderCoverAndCount(uri, depth = 0) {
    if (!uri || depth > 1) return { coverUri: null, count: 0, subfolderCount: 0 };
    if (depth === 0) {
      const cached = folderService._coverMemCache.get(uri);
      if (cached && Date.now() - cached.time < 180000) {
        return cached.data;
      }
    }
    try {
      const phys = folderService.toPhysicalUri(uri) || uri;
      let entries = [];
      if (phys.startsWith('file://')) {
        const names = await LegacyFS.readDirectoryAsync(phys);
        const base = phys.endsWith('/') ? phys : `${phys}/`;
        entries = names.map((n) => ({ name: n, uri: base + encodeURIComponent(n) }));
      } else if (uri.startsWith('content://')) {
        const children = await LegacyFS.StorageAccessFramework.readDirectoryAsync(uri);
        entries = children.map((u) => ({ name: nameFromUri(u), uri: u }));
      }

      let mediaCount = 0;
      let bestCoverName = '';
      let bestCoverUri = null;
      const subDirs = [];
      for (const e of entries) {
        if (!e.name || e.name.startsWith('.')) continue;
        const mType = mediaTypeByName(e.name);
        if (mType) {
          mediaCount++;
          if (!bestCoverUri || e.name > bestCoverName) {
            bestCoverName = e.name;
            bestCoverUri = e.uri;
          }
        } else if (!hasExtension(e.name) && !NON_MEDIA_DIR_REGEX.test(e.name.trim())) {
          subDirs.push(e);
        }
      }

      if (mediaCount > 0) {
        const res = {
          coverUri: bestCoverUri,
          count: mediaCount,
          subfolderCount: subDirs.length,
        };
        if (depth === 0) {
          folderService._coverMemCache.set(uri, { data: res, time: Date.now() });
        }
        return res;
      }

      // Si la carpeta raíz solo tiene subcarpetas (ej. DCIM -> Camera o carpeta organizada por meses),
      // buscar portada y sumar conteo en las primeras 5 subcarpetas en paralelo
      let firstCover = null;
      let totalSubCount = 0;
      let nonEmptySubDirs = 0;
      const subResults = await Promise.all(
        subDirs.slice(0, 5).map((sub) => folderService.getFolderCoverAndCount(sub.uri, depth + 1))
      );
      for (const subRes of subResults) {
        if ((subRes.count || 0) > 0) {
          nonEmptySubDirs++;
          totalSubCount += subRes.count || 0;
          if (!firstCover && subRes.coverUri) {
            firstCover = subRes.coverUri;
          }
        }
      }
      const finalRes = {
        coverUri: firstCover,
        count: totalSubCount,
        subfolderCount: nonEmptySubDirs,
      };
      if (depth === 0) {
        folderService._coverMemCache.set(uri, { data: finalRes, time: Date.now() });
      }
      return finalRes;
    } catch (_e) {}
    return { coverUri: null, count: 0, subfolderCount: 0 };
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
      if (!e.name || e.name.startsWith('.')) continue;
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
      } else if (!hasExtension(e.name) && !NON_MEDIA_DIR_REGEX.test(e.name.trim())) {
        candidates.push(e);
      }
    }

    let dirEntries = candidates;
    if (uri.startsWith('file://') && candidates.length > 0) {
      // Confirmar cuáles candidatos son realmente carpetas (lote rápido de máximo 30)
      dirEntries = [];
      const limited = candidates.slice(0, 30);
      const infos = await Promise.all(
        limited.map((c) => LegacyFS.getInfoAsync(c.uri).catch(() => null))
      );
      infos.forEach((info, j) => {
        if (info && info.isDirectory) dirEntries.push(limited[j]);
      });
    }

    const subfolders = dirEntries.map((e) => ({
      id: e.uri,
      uri: e.uri,
      rawName: e.name,
      name: folderService.formatFolderDisplayName(e.name, e.uri),
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
          rawName: item.name,
          name: folderService.formatFolderDisplayName(item.name, item.uri),
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
   * Enriquece el tamaño en bytes (fileSize) de una lista de assets en lotes paralelos sin bloquear la UI.
   */
  async enrichAssetsFileSizes(assets = [], onUpdated) {
    if (!assets || assets.length === 0) return assets;
    let changed = false;
    const BATCH = 35;
    for (let i = 0; i < assets.length; i += BATCH) {
      const slice = assets.slice(i, i + BATCH);
      await Promise.all(
        slice.map(async (item) => {
          if (item.fileSize && item.fileSize > 0) return;
          const physUri = folderService.toPhysicalUri(item.uri) || item.uri;
          try {
            const info = await LegacyFS.getInfoAsync(physUri);
            if (info?.exists && typeof info.size === 'number' && info.size > 0) {
              item.fileSize = info.size;
              changed = true;
              return;
            }
          } catch (_e) {}
          try {
            const sz = new File(physUri).size;
            if (typeof sz === 'number' && sz > 0) {
              item.fileSize = sz;
              changed = true;
            }
          } catch (_e2) {}
        })
      );
    }
    if (changed && onUpdated) {
      onUpdated([...assets]);
    }
    return assets;
  },

  _dirMemCache: new Map(),

  /**
   * Lee la carpeta actual (rápido, ordenada de la más reciente a la más antigua) y enriquece tamaños y portadas de subcarpetas.
   * Si la carpeta actual es una carpeta de mes que tenía subcarpetas "Fotos" y "Videos", aplana sus archivos automáticamente.
   */
  async readDirectory(uri, onBatch, { forceRefresh = false } = {}) {
    try {
      // Si ya tenemos esta carpeta en caché en memoria, entregarla al instante (0 ms)
      const cached = folderService._dirMemCache.get(uri);
      if (!forceRefresh && cached) {
        if (onBatch) {
          onBatch({
            subfolders: [...cached.subfolders],
            assets: [...cached.assets],
            isPartial: false,
          });
        }
        // Si la caché tiene menos de 2 minutos, no volver a escanear el disco
        if (Date.now() - (cached.time || 0) < 120000) {
          return { subfolders: cached.subfolders, assets: cached.assets };
        }
      }

      let { subfolders, assets } = await folderService._listLevel(uri);

      // Si existen subcarpetas "Fotos" o "Videos" (creadas por versiones previas del organizador por meses),
      // incorporar sus fotos/videos directamente en la vista del mes para no obligar a entrar a "Fotos".
      const mediaSubfolders = subfolders.filter((s) =>
        /^(fotos|videos)$/i.test((s.rawName || s.name || '').trim())
      );
      if (mediaSubfolders.length > 0) {
        const flattened = await Promise.all(
          mediaSubfolders.map((ms) => folderService._listLevel(ms.uri).catch(() => ({ subfolders: [], assets: [] })))
        );
        const removeSet = new Set();
        flattened.forEach((res, idx) => {
          if (res.assets && res.assets.length > 0) {
            assets.push(...res.assets);
          }
          if (!res.subfolders || res.subfolders.length === 0) {
            removeSet.add(mediaSubfolders[idx].uri);
          }
        });
        if (removeSet.size > 0) {
          subfolders = subfolders.filter((s) => !removeSet.has(s.uri));
        }
      }

      assets.sort(byFilenameDesc);

      // Si ya hay fotos/videos directos en esta carpeta, entregarlos de inmediato sin mostrar subcarpetas vacías aún
      if (onBatch && assets.length > 0) {
        onBatch({ subfolders: [], assets: [...assets], isPartial: true });
      }

      // Inspeccionar subcarpetas y conservar ÚNICAMENTE las que contengan al menos 1 imagen o video
      const inspectedSubs = await Promise.all(
        subfolders.slice(0, 24).map(async (sub) => {
          const info = await folderService.getFolderCoverAndCount(sub.uri, 0);
          if (!info || !(info.count > 0)) return null;
          return {
            ...sub,
            coverUri: info.coverUri || null,
            count: info.count,
          };
        })
      );

      const validSubfolders = inspectedSubs.filter(Boolean);
      validSubfolders.sort((a, b) => {
        const ra = a.rawName || a.name || '';
        const rb = b.rawName || b.name || '';
        const isMonthA = /^20\d{2}[-_](0[1-9]|1[0-2])/.test(ra);
        const isMonthB = /^20\d{2}[-_](0[1-9]|1[0-2])/.test(rb);
        if (isMonthA && isMonthB) return rb.localeCompare(ra); // Meses más recientes primero
        return (b.count || 0) - (a.count || 0);
      });

      folderService._dirMemCache.set(uri, {
        subfolders: validSubfolders,
        assets,
        time: Date.now(),
      });
      if (onBatch) {
        onBatch({
          subfolders: [...validSubfolders],
          assets: [...assets],
          isPartial: false,
        });
      }
      return { subfolders: validSubfolders, assets };
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

  /**
   * Escanea recursivamente una carpeta en busca de subcarpetas vacías (sin fotos, videos ni otros archivos útiles).
   */
  async scanEmptyFolders(rootUri, onProgress) {
    const emptyFolders = [];
    if (!rootUri) return emptyFolders;

    const checkDir = async (dirUri, dirName, depth) => {
      if (depth > 5) return false;
      let entries = [];
      const phys = folderService.toPhysicalUri(dirUri) || dirUri;
      try {
        if (phys.startsWith('file://')) {
          const names = await LegacyFS.readDirectoryAsync(phys);
          const base = phys.endsWith('/') ? phys : `${phys}/`;
          entries = names.map((n) => ({ name: n, uri: base + encodeURIComponent(n) }));
        } else if (dirUri.startsWith('content://')) {
          const children = await LegacyFS.StorageAccessFramework.readDirectoryAsync(dirUri);
          entries = children.map((u) => ({ name: nameFromUri(u), uri: u }));
        }
      } catch (_e) {
        return false;
      }

      const meaningfulEntries = entries.filter((e) => e.name !== '.nomedia' && e.name !== '.DS_Store');
      if (meaningfulEntries.length === 0) {
        if (depth > 0) {
          emptyFolders.push({
            uri: phys,
            originalUri: dirUri,
            name: dirName || folderService.folderName(phys),
          });
          if (onProgress) onProgress(emptyFolders.length, dirName);
        }
        return true;
      }

      let hasNonEmptyChild = false;
      for (const entry of meaningfulEntries) {
        const media = mediaTypeByName(entry.name);
        if (media || hasExtension(entry.name)) {
          hasNonEmptyChild = true;
          continue;
        }
        try {
          const info = await LegacyFS.getInfoAsync(entry.uri);
          if (info && info.isDirectory) {
            const subIsEmpty = await checkDir(entry.uri, entry.name, depth + 1);
            if (!subIsEmpty) {
              hasNonEmptyChild = true;
            }
          } else if (info && info.exists) {
            hasNonEmptyChild = true;
          }
        } catch (_err) {
          hasNonEmptyChild = true;
        }
      }

      if (!hasNonEmptyChild && depth > 0) {
        emptyFolders.push({
          uri: phys,
          originalUri: dirUri,
          name: dirName || folderService.folderName(phys),
        });
        if (onProgress) onProgress(emptyFolders.length, dirName);
        return true;
      }
      return false;
    };

    await checkDir(rootUri, folderService.folderName(rootUri), 0);
    return emptyFolders;
  },

  /**
   * Elimina una lista de carpetas vacías (de las más profundas a las más superficiales).
   */
  async deleteEmptyFolders(emptyFolders = []) {
    let deletedCount = 0;
    const sorted = [...emptyFolders].sort((a, b) => (b.uri || '').length - (a.uri || '').length);
    for (const folder of sorted) {
      const target = folder.uri || folder.originalUri;
      if (!target) continue;
      try {
        await LegacyFS.deleteAsync(target, { idempotent: true });
        deletedCount++;
      } catch (_e1) {
        try {
          new Directory(target).delete();
          deletedCount++;
        } catch (_e2) {
          // ignorar si el sistema lo bloqueó
        }
      }
    }
    return deletedCount;
  },

  /**
   * Escáner inteligente de carpetas del dispositivo:
   * Recorre la memoria interna buscando carpetas que contienen fotos o videos y que aún NO han sido agregadas,
   * devolviendo sugerencias ordenadas por cantidad de archivos multimedia.
   */
  async scanSuggestedFolders(savedFolders = [], onProgress) {
    const existingSet = new Set(
      (savedFolders || []).flatMap((f) => [
        f.uri,
        folderService.toPhysicalUri(f.uri),
        (folderService.toPhysicalUri(f.uri) || '').toLowerCase(),
      ])
    );

    const suggestions = [];
    const visited = new Set();

    const ROOTS_TO_SCAN = [
      { uri: 'file:///storage/emulated/0/DCIM', label: 'DCIM' },
      { uri: 'file:///storage/emulated/0/Pictures', label: 'Pictures' },
      { uri: 'file:///storage/emulated/0/Movies', label: 'Movies' },
      { uri: 'file:///storage/emulated/0/Download', label: 'Download' },
      {
        uri: 'file:///storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media',
        label: 'WhatsApp Media',
      },
      {
        uri: 'file:///storage/emulated/0/Android/media/com.whatsapp.w4b/WhatsApp Business/Media',
        label: 'WhatsApp Business',
      },
      {
        uri: 'file:///storage/emulated/0/Android/media/org.telegram.messenger',
        label: 'Telegram',
      },
      { uri: 'file:///storage/emulated/0', label: 'Memoria Interna' },
    ];

    const SKIP_DIRS = new Set([
      'android',
      '.thumbnails',
      '.trash',
      '.trashed',
      'cache',
      'code_cache',
      'alarms',
      'notifications',
      'ringtones',
      'podcasts',
      'music',
      'audiobooks',
    ]);

    const scanDir = async (dirUri, parentLabel, depth, maxDepth) => {
      const norm = (folderService.toPhysicalUri(dirUri) || dirUri).replace(/\/+$/, '');
      const normKey = norm.toLowerCase();
      if (visited.has(normKey)) return;
      visited.add(normKey);

      let names = [];
      try {
        names = await LegacyFS.readDirectoryAsync(norm);
      } catch (_e) {
        return;
      }

      let photoCount = 0;
      let videoCount = 0;
      const subDirs = [];
      const base = `${norm}/`;

      for (const name of names) {
        if (!name || name.startsWith('.')) continue;
        const mType = mediaTypeByName(name);
        if (mType === 'photo') {
          photoCount++;
        } else if (mType === 'video') {
          videoCount++;
        } else if (!hasExtension(name)) {
          if (depth === 0 && norm === 'file:///storage/emulated/0' && SKIP_DIRS.has(name.toLowerCase())) {
            continue;
          }
          if (SKIP_DIRS.has(name.toLowerCase())) continue;
          subDirs.push({ name, uri: base + encodeURIComponent(name) });
        }
      }

      // Si tiene subcarpetas "Fotos" o "Videos" (ej. dentro de carpetas de mes 2026-09_Septiembre),
      // sumar sus archivos directamente a la carpeta del mes y no sugerir "Fotos" por separado.
      const remainingSubDirs = [];
      for (const sd of subDirs) {
        if (/^(fotos|videos)$/i.test(sd.name.trim())) {
          try {
            const subNames = await LegacyFS.readDirectoryAsync(sd.uri);
            for (const sn of subNames) {
              const sm = mediaTypeByName(sn);
              if (sm === 'photo') photoCount++;
              else if (sm === 'video') videoCount++;
            }
            visited.add(sd.uri.toLowerCase());
            continue;
          } catch (_e) {}
        }
        remainingSubDirs.push(sd);
      }

      const totalMedia = photoCount + videoCount;
      const isAlreadySaved = existingSet.has(norm) || existingSet.has(normKey);

      if (totalMedia > 0 && !isAlreadySaved && norm !== 'file:///storage/emulated/0') {
        const folderTitle = folderService.folderName(norm);
        const relPath = norm.replace(/^file:\/\/\/storage\/emulated\/0\/?/i, '') || folderTitle;
        suggestions.push({
          uri: norm,
          name: folderTitle,
          relativePath: relPath,
          photoCount,
          videoCount,
          totalMedia,
        });
        if (onProgress) {
          onProgress({ foundCount: suggestions.length, currentFolder: relPath });
        }
      }

      if (depth < maxDepth && remainingSubDirs.length > 0) {
        const limited = remainingSubDirs.slice(0, 60);
        for (let i = 0; i < limited.length; i += 20) {
          const slice = limited.slice(i, i + 20);
          const infos = await Promise.all(
            slice.map((s) => LegacyFS.getInfoAsync(s.uri).catch(() => null))
          );
          for (let j = 0; j < slice.length; j++) {
            if (infos[j] && infos[j].isDirectory) {
              await scanDir(slice[j].uri, slice[j].name, depth + 1, maxDepth);
            }
          }
        }
      }
    };

    for (const root of ROOTS_TO_SCAN) {
      const maxD = root.uri === 'file:///storage/emulated/0' ? 2 : 3;
      await scanDir(root.uri, root.label, 0, maxD);
    }

    suggestions.sort((a, b) => b.totalMedia - a.totalMedia);
    return suggestions;
  },

  toPhysicalUri(uri) {
    if (!uri || typeof uri !== 'string') return '';
    if (uri.startsWith('file://')) return uri.replace(/\/+$/, '');
    if (uri.startsWith('/')) return `file://${uri.replace(/\/+$/, '')}`;
    if (uri.startsWith('content://')) {
      try {
        const docMatch = uri.match(/\/document\/([^/?#]+)/i);
        const treeMatch = uri.match(/\/tree\/([^/?#]+)/i);
        const rawId = (docMatch && docMatch[1]) || (treeMatch && treeMatch[1]);
        if (rawId) {
          const decoded = decodeURIComponent(rawId);
          if (/^primary:/i.test(decoded)) {
            const rel = decoded.replace(/^primary:/i, '').replace(/^\/+|\/+$/g, '');
            return rel ? `file:///storage/emulated/0/${rel}` : 'file:///storage/emulated/0';
          }
          const sdMatch = decoded.match(/^([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}):(.*)$/);
          if (sdMatch) {
            const vol = sdMatch[1];
            const rel = sdMatch[2].replace(/^\/+|\/+$/g, '');
            return rel ? `file:///storage/${vol}/${rel}` : `file:///storage/${vol}`;
          }
        }
      } catch (_e) {}
    }
    return uri.replace(/\/+$/, '');
  },

  async ensureDownloadedVideosFolder() {
    let finalUri = DOWNLOADED_VIDEOS_FOLDER_URI;
    try {
      const created = await folderService.createSubfolder(
        'file:///storage/emulated/0/Movies',
        DOWNLOADED_VIDEOS_FOLDER_NAME
      );
      if (created) finalUri = created;
    } catch (_e) {
      // Si el permiso físico aún no está activo, igual registrar la ruta estándar
    }
    try {
      await folderService.addSavedFolder(finalUri, DOWNLOADED_VIDEOS_FOLDER_NAME);
    } catch (_e2) {}
    return finalUri;
  },

  async createSubfolder(parentDirUri, subName) {
    const cleanName = (subName || '').trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!cleanName) throw new Error('Ingresa un nombre válido para la carpeta.');
    const basePhys = folderService.toPhysicalUri(parentDirUri);
    if (NativeModules?.VideoEngineModule?.ensureSubfolderNative) {
      return await NativeModules.VideoEngineModule.ensureSubfolderNative(basePhys, cleanName);
    }
    const targetUri = `${basePhys}/${cleanName}`;
    try {
      await LegacyFS.makeDirectoryAsync(targetUri, { intermediates: true });
    } catch (_e) {
      new Directory(targetUri).create({ intermediates: true, idempotent: true });
    }
    return targetUri;
  },

  async moveAssetsToFolder(assets, targetDirUri, relativeSubfolder = '') {
    if (!assets || assets.length === 0) return { moved: 0, total: 0 };
    const basePhys = folderService.toPhysicalUri(targetDirUri);
    const sub = (relativeSubfolder || '').trim();
    const finalDirPhys = sub ? `${basePhys}/${sub}` : basePhys;

    let moved = 0;
    for (const item of assets) {
      if (!item?.uri) continue;
      const fileName = item.filename || nameFromUri(item.uri) || `media_${Date.now()}.jpg`;
      try {
        if (NativeModules?.VideoEngineModule?.moveFileToSubfolderNative) {
          await NativeModules.VideoEngineModule.moveFileToSubfolderNative(
            item.uri,
            basePhys,
            sub,
            fileName
          );
          moved++;
        } else {
          const srcPhys = folderService.toPhysicalUri(item.uri);
          const destUri = `${finalDirPhys}/${fileName}`;
          try {
            await LegacyFS.makeDirectoryAsync(finalDirPhys, { intermediates: true });
          } catch (_e) {}
          try {
            await LegacyFS.moveAsync({ from: srcPhys, to: destUri });
          } catch (_mErr) {
            await new File(srcPhys).move(new File(destUri));
          }
          moved++;
        }
      } catch (e) {
        console.warn('Error moviendo archivo:', fileName, e);
      }
    }
    return { moved, total: assets.length };
  },

  invalidateCache(uri = null) {
    if (!uri) {
      folderService._dirMemCache.clear();
      folderService._coverMemCache.clear();
      return;
    }
    folderService._dirMemCache.delete(uri);
    folderService._coverMemCache.delete(uri);
  },

  async deleteFile(uri) {
    try {
      new File(uri).delete();
      folderService._dirMemCache.clear();
      return true;
    } catch (e) {
      console.error('Error al eliminar archivo de carpeta:', e);
      return false;
    }
  },

  /**
   * Clasifica inteligentemente si un álbum o carpeta parece ser de sistema, caché,
   * recursos internos de una app o carpeta residual del sistema,
   * para sugerirla como "Carpeta de Sistema" y desactivarla automáticamente (permitiendo activarla manualmente).
   */
  classifySystemFolder(item) {
    if (!item) return { isSystemSuggested: false, reason: '', category: 'normal' };

    const rawTitle = String(item.title || item.name || '').trim();
    const uri = String(item.uri || '').trim();
    const displayName = folderService.formatFolderDisplayName(rawTitle, uri);
    const lowerName = displayName.toLowerCase();
    const lowerRaw = rawTitle.toLowerCase();
    const lowerUri = uri.toLowerCase();
    const count = Number(item.assetCount ?? item.count ?? 0);
    const subCount = Number(item.subfolderCount || 0);

    // 1. Nunca marcar como sistema las carpetas esenciales del usuario ni las organizadas por Mes y Año
    if (
      item.isDownloadedVideos ||
      item.isFavoritesCard ||
      item.isVariosCard ||
      /^(camera|cámara|camara|dcim|videos descargados|favoritos|screenshots|capturas|whatsapp images|whatsapp video|whatsapp|download|descargas|pictures|imágenes|imagenes|movies|películas|peliculas|familia|viajes|trabajo|instagram|facebook|tiktok|telegram|telegram images|telegram video|restored|recuerdos)$/i.test(
        lowerName
      ) ||
      /^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+20\d{2}/i.test(
        lowerName
      )
    ) {
      return { isSystemSuggested: false, reason: '', category: 'normal' };
    }

    // 2. Carpetas ocultas por punto (ej. .thumbnails, .Statuses, .trashed, .cache)
    if (rawTitle.startsWith('.') || displayName.startsWith('.')) {
      return {
        isSystemSuggested: true,
        reason: 'Carpeta oculta del sistema (.)',
        category: 'system_name',
      };
    }

    // 3. Miniaturas, caché, temporales, sistema Android o papeleras internas
    if (
      /(thumbnail|thumb|albumthumbs|avatarcache|cache|temp|tmp|trash|trashed|rubbish|recycle|backup|logs|crash|debug|preload|^android$|^data$|^obb$|^media$|^system$)/i.test(
        lowerName
      ) ||
      /(thumbnail|cache|temp|trash|\.statuses|\.thumbnails)/i.test(lowerRaw)
    ) {
      return {
        isSystemSuggested: true,
        reason: 'Caché / Miniaturas del sistema',
        category: 'system_name',
      };
    }

    // 4. Stickers, estados temporales, notas de voz, GIFs, tonos o recursos internos de apps
    if (
      /(sticker|animated gif|voice note|statuses|status|profile photo|wallpapers|ringtones|notifications|alarms|emoji|emoticon|icono|icons|assets|drawable|splash|ads|sdk|obb|^sent$|^private$|whatsapp audio|whatsapp documents|telegram audio|telegram documents)/i.test(
        lowerName
      ) ||
      /(\/android\/data\/|\/android\/obb\/|whatsapp stickers|whatsapp animated gifs|whatsapp voice notes|\.statuses)/i.test(
        lowerUri
      )
    ) {
      return {
        isSystemSuggested: true,
        reason: 'Stickers / Recursos internos de app',
        category: 'system_name',
      };
    }

    // 5. Carpetas con nombres técnicos (IDs numéricos largos, paquetes com.*, caché de apps) o con 1 solo archivo suelto
    if (
      /^(com\.|org\.|net\.|[0-9a-f]{8,}|\d{5,})/i.test(lowerRaw) ||
      (count === 1 && subCount === 0)
    ) {
      return {
        isSystemSuggested: true,
        reason: count === 1 ? 'Carpeta de 1 solo archivo (Sistema / App)' : 'Carpeta técnica de aplicación',
        category: count === 1 ? 'single_file' : 'system_name',
      };
    }

    return { isSystemSuggested: false, reason: '', category: 'normal' };
  },

  /**
   * Clasifica si una carpeta, álbum o archivo multimedia pertenece al segmento:
   * - 'photos': Fotos de cámara (DCIM y sus subcarpetas) y Dron (DJI, Drone).
   * - 'files': Archivos (Download, Archivos, Documentos), Screenshots, WhatsApp, X (Twitter), Threads, Redes.
   *
   * Cumple la regla estricta del usuario:
   * "uno de fotos: alli se guardaran las cosas que esten dentro de la carpeta de dcmi las carpetas que esten alli y las del dron
   *  y en otro archivos: los archivos que esten en la carpeta de archivos y los screenshots y whatsapp, x threds guardalas alli que esas no aparescan en las fotos"
   */
  classifyMediaSegment(itemOrAsset) {
    if (!itemOrAsset) return 'photos';

    if (itemOrAsset.isFavoritesCard) return 'photos';
    if (itemOrAsset.isVariosCard) return 'all';

    const rawTitle = String(
      itemOrAsset.title || itemOrAsset.name || itemOrAsset.sourceFolderTitle || ''
    ).trim();
    const uri = String(itemOrAsset.uri || '').trim();
    const filename = String(itemOrAsset.filename || '').trim();

    const lowerTitle = rawTitle.toLowerCase();
    const lowerUri = uri.toLowerCase();
    const lowerFilename = filename.toLowerCase();
    const combined = `${lowerTitle} ${lowerUri} ${lowerFilename}`;

    // 1. REGLA ESTRICTA DE EXCLUSIÓN: "que esas no aparescan en las fotos"
    // Screenshots / capturas, WhatsApp, X (Twitter), Threads, Descargas, Archivos, Documentos y Redes van al segmento 'files'
    const isFilesOrSocial =
      /screenshot|captura|screen_capture|grabaci[oó]n.*pantalla/i.test(combined) ||
      /whatsapp|wa\d{4}|wa_|_wa\d/i.test(combined) ||
      /\b(x|twitter|x-corp)\b/i.test(lowerTitle) ||
      /\/x\//i.test(lowerUri) ||
      /twitter/i.test(combined) ||
      /threads/i.test(combined) ||
      /download|descarga|descargas|archivos|documents|documentos|files/i.test(combined) ||
      /facebook|fb_temp|instagram|tiktok|telegram|reddit|pinterest|snaptube|videos descargados/i.test(
        combined
      );

    if (isFilesOrSocial) {
      return 'files';
    }

    // 2. Segmento 'photos': DCIM y sus subcarpetas, Cámara y Drones (DJI, dron)
    const isPhotosOrDrone =
      /dcim/i.test(lowerUri) ||
      /dcim/i.test(lowerTitle) ||
      /^(camera|c[aá]mara|camara)$/i.test(lowerTitle) ||
      /dron|drone|dji/i.test(combined) ||
      /100media|100andro|restored/i.test(combined) ||
      /^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+20\d{2}/i.test(
        lowerTitle
      );

    if (isPhotosOrDrone) {
      return 'photos';
    }

    // Por defecto, fotos
    return 'photos';
  },
};
