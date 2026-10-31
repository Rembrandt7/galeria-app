import * as MediaLibrary from 'expo-media-library';
import * as Crypto from 'expo-crypto';
import * as LegacyFS from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { compressionService } from './compressionService';
import { mediaService } from './mediaService';
import { folderService } from './folderService';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const toHex = (buffer) =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

function normalizePhysPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  let clean = uri.trim();
  try {
    clean = decodeURIComponent(clean);
  } catch (_e) {}
  if (clean.startsWith('content://')) {
    const docMatch = clean.match(/\/document\/([^/?#]+)/i);
    if (docMatch && docMatch[1]) {
      const docId = docMatch[1];
      if (/^primary:/i.test(docId)) {
        clean = `/storage/emulated/0/${docId.replace(/^primary:/i, '').replace(/^\/+/, '')}`;
      }
    }
  }
  clean = clean
    .replace(/^file:\/+/i, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  return clean.toLowerCase();
}

function toPhysicalFileUri(uri) {
  if (!uri || typeof uri !== 'string') return null;
  if (uri.startsWith('file://')) return uri;
  if (uri.startsWith('/')) return `file://${uri}`;
  const phys = folderService.toPhysicalUri ? folderService.toPhysicalUri(uri) : null;
  if (phys && phys.startsWith('file://')) return phys;
  return null;
}

function extractFolderLabel(uri) {
  if (!uri || typeof uri !== 'string') return '';
  let clean = uri;
  try {
    clean = decodeURIComponent(clean);
  } catch (_e) {}
  clean = clean.replace(/^file:\/+/i, '/').replace(/^\/storage\/emulated\/0\/?/i, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts.length <= 1) return 'Memoria interna';
  parts.pop(); // quitar nombre de archivo
  return parts.slice(-2).join('/');
}

/**
 * Extrae el nombre base sin sufijos típicos de copia:
 * Ej: "IMG_20261020_120000 (1).jpg" -> { stem: "img_20261020_120000", ext: "jpg", hasCopySuffix: true }
 *     "IMG_20261020_120000 - copia.jpg" -> { stem: "img_20261020_120000", ext: "jpg", hasCopySuffix: true }
 */
function parseNormalizedFilename(filename = '', uri = '') {
  const raw = String(filename || uri.split('/').pop() || '').trim();
  const dotIdx = raw.lastIndexOf('.');
  if (dotIdx <= 0) {
    return { raw, stem: raw.toLowerCase(), ext: '', hasCopySuffix: false };
  }
  const ext = raw.slice(dotIdx + 1).toLowerCase();
  const origStem = raw.slice(0, dotIdx).trim();

  const copyPattern =
    /(?:\s*\(\d+\)|\s*-\s*copia(?:\s*\(\d+\))?|\s*_\s*copia|\s+copia(?:\s+\d+)?|\s*-\s*copy(?:\s*\(\d+\))?|\s*_copy(?:\s*\d+)?|\s+copy(?:\s+\d+)?|~\d+|_[123])$/i;
  const hasCopySuffix = copyPattern.test(origStem);
  const cleanedStem = origStem.replace(copyPattern, '').trim().toLowerCase();

  return {
    raw,
    stem: cleanedStem.length >= 4 ? cleanedStem : origStem.toLowerCase(),
    ext,
    hasCopySuffix,
  };
}

export const duplicateService = {
  /**
   * Carga todos los archivos multimedia (fotos y videos) de una carpeta específica
   * incluyendo sus subcarpetas recursivamente.
   */
  async loadFolderMedia(folderUri, fallbackAssets = [], onProgress, control) {
    const merged = [];
    const seenPaths = new Set();

    const addAsset = (a) => {
      if (!a || !a.uri) return;
      const key = normalizePhysPath(a.uri) || String(a.id || a.uri);
      if (seenPaths.has(key)) return;
      seenPaths.add(key);
      merged.push(a);
    };

    if (folderUri) {
      try {
        const recursive = await folderService.loadFolderAssets(folderUri, (chunk) => {
          if (Array.isArray(chunk)) {
            chunk.forEach(addAsset);
            if (onProgress) {
              onProgress({ phase: 'listing', done: merged.length, total: null });
            }
          }
        });
        if (Array.isArray(recursive)) {
          recursive.forEach(addAsset);
        }
      } catch (_e) {}
    }

    if (Array.isArray(fallbackAssets)) {
      fallbackAssets.forEach(addAsset);
    }

    if (onProgress) {
      onProgress({ phase: 'listing', done: merged.length, total: merged.length });
    }
    return merged;
  },

  /**
   * Trae todas las fotos y videos de la galería del teléfono usando el motor nativo rápido
   * más las carpetas guardadas (para incluir rutas como 2do plano o Descargas).
   */
  async loadAllPhotos(onProgress, control) {
    const all = [];
    const seenPaths = new Set();

    const addUnique = (a) => {
      if (!a || !a.uri) return;
      const key = normalizePhysPath(a.uri) || String(a.id || a.uri);
      if (seenPaths.has(key)) return;
      seenPaths.add(key);
      all.push(a);
    };

    if (control?.waitIfPaused) await control.waitIfPaused();
    if (control?.isCancelled) return all;

    // 1. Motor nativo rápido (devuelve URIs file:// físicos y fileSize directo de MediaStore)
    try {
      const fastRes = await mediaService.getAssets({
        first: 10000,
        mediaType: ['photo', 'video'],
      });
      if (Array.isArray(fastRes?.assets) && fastRes.assets.length > 0) {
        fastRes.assets.forEach(addUnique);
        if (onProgress) onProgress({ phase: 'listing', done: all.length, total: null });
      }
    } catch (_e) {}

    // 2. Escanear también carpetas guardadas (2do plano, Videos Descargados, etc.) por si no están indexadas en MediaStore
    try {
      const savedFolders = await folderService.getSavedFolders();
      for (const f of savedFolders || []) {
        if (control?.waitIfPaused) await control.waitIfPaused();
        if (control?.isCancelled) return all;
        if (!f?.uri) continue;
        // Evitar escanear la raíz entera /storage/emulated/0 dos veces si ya cargamos MediaStore
        if (/^file:\/\/\/storage\/emulated\/0\/?$/i.test(f.uri) && all.length > 0) continue;
        try {
          const folderItems = await folderService.loadFolderAssets(f.uri);
          if (Array.isArray(folderItems)) {
            folderItems.forEach(addUnique);
            if (onProgress) onProgress({ phase: 'listing', done: all.length, total: null });
          }
        } catch (_fe) {}
      }
    } catch (_e2) {}

    // 3. Fallback a MediaLibrary paginado solo si no se obtuvo nada antes
    if (all.length === 0) {
      let after = null;
      let hasNext = true;
      while (hasNext) {
        if (control?.waitIfPaused) await control.waitIfPaused();
        if (control?.isCancelled) return all;
        const page = await MediaLibrary.getAssetsAsync({
          first: 500,
          after: after || undefined,
          mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
          sortBy: [MediaLibrary.SortBy.creationTime],
        });
        (page.assets || []).forEach(addUnique);
        after = page.endCursor;
        hasNext = page.hasNextPage;
        if (onProgress) onProgress({ phase: 'listing', done: all.length, total: null });
      }
    }

    return all;
  },

  /**
   * Busca fotos y videos duplicados:
   * - Fase 1: Archivos con el mismo tamaño en bytes + verificación de contenido (SHA-256 o firma exacta).
   * - Fase 2: Copias con el mismo nombre base (ej. "IMG_1234(1).jpg", "IMG_1234 - copia.jpg" o mismo nombre en otra carpeta)
   *           y misma resolución/tamaño similar.
   * Devuelve grupos de 2 o más copias.
   */
  async findDuplicates(assetsInput, onProgress, control) {
    if (!Array.isArray(assetsInput) || assetsInput.length === 0) return [];

    // 0) Deduplicar entradas que apunten exactamente al mismo archivo físico en disco
    const uniqueAssets = [];
    const seenPhys = new Set();
    for (const item of assetsInput) {
      if (!item || !item.uri) continue;
      const isMedia =
        item.mediaType === 'photo' ||
        item.mediaType === 'video' ||
        /\.(jpg|jpeg|png|webp|heic|heif|gif|bmp|mp4|mov|m4v|mkv|webm|3gp|avi)$/i.test(
          item.filename || item.uri || ''
        );
      if (!isMedia) continue;

      const physKey = normalizePhysPath(item.uri) || String(item.id || item.uri);
      if (seenPhys.has(physKey)) continue;
      seenPhys.add(physKey);

      const resolvedType =
        item.mediaType === 'video' ||
        /\.(mp4|mov|m4v|mkv|webm|3gp|avi)$/i.test(item.filename || item.uri || '')
          ? 'video'
          : 'photo';

      uniqueAssets.push({
        ...item,
        mediaType: resolvedType,
        folderLabel: extractFolderLabel(item.uri),
      });
    }

    if (uniqueAssets.length < 2) return [];

    // 1) Obtener tamaño real de cada archivo (usando primero fileSize nativo de MediaStore / directorio)
    const withSizes = [];
    const bySize = new Map();
    let i = 0;

    for (const asset of uniqueAssets) {
      if (control?.waitIfPaused) await control.waitIfPaused();
      if (control?.isCancelled) return [];

      let size = Number(asset.fileSize || asset.size || 0);
      if (!size || size <= 0) {
        const physUri = toPhysicalFileUri(asset.uri) || asset.uri;
        try {
          size = new File(physUri).size || 0;
        } catch (_e) {
          size = 0;
        }
      }
      if (!size || size <= 0) {
        try {
          size = (await compressionService.getFileSize(asset)) || 0;
        } catch (_e2) {
          size = 0;
        }
      }

      const enriched = {
        ...asset,
        size: size > 0 ? size : 0,
        fileSize: size > 0 ? size : 0,
      };
      withSizes.push(enriched);

      if (size > 0) {
        const list = bySize.get(size) || [];
        list.push(enriched);
        bySize.set(size, list);
      }

      i += 1;
      if (i % 50 === 0 || i === uniqueAssets.length) {
        if (onProgress) onProgress({ phase: 'sizes', done: i, total: uniqueAssets.length });
        await tick();
      }
    }

    // 2) Candidatos con tamaño en bytes idéntico
    const candidates = [];
    bySize.forEach((list) => {
      if (list.length > 1) candidates.push(...list);
    });

    const byHash = new Map();
    const groupedAssetIds = new Set();
    let j = 0;
    const MAX_FULL_HASH_BYTES = 8 * 1024 * 1024; // 8 MB para lectura completa en memoria

    for (const asset of candidates) {
      if (control?.waitIfPaused) await control.waitIfPaused();
      if (control?.isCancelled) return [];

      let hexHash = null;
      const physUri = toPhysicalFileUri(asset.uri) || asset.uri;

      // Para fotos y archivos <= 8 MB, calculamos SHA-256 real del contenido
      if (asset.size > 0 && asset.size <= MAX_FULL_HASH_BYTES) {
        try {
          const bytes = await new File(physUri).bytes();
          if (bytes && bytes.byteLength > 0) {
            const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
            hexHash = toHex(digest);
          }
        } catch (_errBytes) {}

        if (!hexHash) {
          try {
            const base64 = await LegacyFS.readAsStringAsync(physUri, {
              encoding: LegacyFS.EncodingType.Base64,
            });
            if (base64) {
              hexHash = await Crypto.digestStringAsync(
                Crypto.CryptoDigestAlgorithm.SHA256,
                base64
              );
            }
          } catch (_errB64) {}
        }
      }

      // Si es un video/archivo > 8 MB o si Android restringió la lectura directa por URI,
      // usamos firma determinista (tamaño exacto en bytes + tipo + dimensiones + duración)
      // para NUNCA omitir duplicados reales.
      if (!hexHash) {
        const w = Number(asset.width || 0);
        const h = Number(asset.height || 0);
        const dur = Math.round(Number(asset.duration || 0));
        hexHash = `sig_${asset.mediaType}_${w}x${h}_${dur}`;
      }

      const key = `exact-${asset.size}-${hexHash}`;
      const list = byHash.get(key) || [];
      list.push(asset);
      byHash.set(key, list);

      j += 1;
      if (onProgress) onProgress({ phase: 'hash', done: j, total: candidates.length });
      if (j % 8 === 0) await tick();
    }

    const groups = [];
    const sortCopiesBestFirst = (a, b) => {
      const parsedA = parseNormalizedFilename(a.filename, a.uri);
      const parsedB = parseNormalizedFilename(b.filename, b.uri);
      // Preferir conservar el archivo que NO tiene sufijo "(1)" o "copia"
      if (parsedA.hasCopySuffix !== parsedB.hasCopySuffix) {
        return parsedA.hasCopySuffix ? 1 : -1;
      }
      return (a.creationTime || 0) - (b.creationTime || 0);
    };

    byHash.forEach((list, key) => {
      if (list.length > 1) {
        list.sort(sortCopiesBestFirst);
        list.forEach((item) => groupedAssetIds.add(item.id || item.uri));
        groups.push({ key, items: list, matchType: 'exact' });
      }
    });

    // 3) Segunda pasada: Detectar copias por nombre de archivo normalizado (ej. "IMG_001 (1).jpg", "IMG_001 - copia.jpg" o mismo nombre en distintas carpetas)
    const byStem = new Map();
    for (const asset of withSizes) {
      const uid = asset.id || asset.uri;
      if (groupedAssetIds.has(uid)) continue;
      const parsed = parseNormalizedFilename(asset.filename, asset.uri);
      if (!parsed.stem || parsed.stem.length < 4) continue;
      const stemKey = `${asset.mediaType}:${parsed.stem}.${parsed.ext}`;
      const list = byStem.get(stemKey) || [];
      list.push({ asset, parsed });
      byStem.set(stemKey, list);
    }

    byStem.forEach((entries, stemKey) => {
      if (entries.length < 2) return;
      // Verificar que coincidan en dimensiones o en tamaño muy cercano (<= 5% de diferencia, típico de EXIF modificado)
      const matched = [];
      const used = new Set();

      for (let aIdx = 0; aIdx < entries.length; aIdx++) {
        if (used.has(aIdx)) continue;
        const base = entries[aIdx];
        const cluster = [base.asset];

        for (let bIdx = aIdx + 1; bIdx < entries.length; bIdx++) {
          if (used.has(bIdx)) continue;
          const cand = entries[bIdx];
          const a = base.asset;
          const b = cand.asset;

          const sameDims =
            a.width > 0 &&
            a.height > 0 &&
            b.width > 0 &&
            b.height > 0 &&
            a.width === b.width &&
            a.height === b.height;

          const maxSz = Math.max(a.size || 0, b.size || 0);
          const minSz = Math.min(a.size || 0, b.size || 0);
          const closeSize = maxSz > 0 && minSz > 0 && (maxSz - minSz) / maxSz <= 0.05;

          const hasCopyTag = base.parsed.hasCopySuffix || cand.parsed.hasCopySuffix;

          if ((sameDims && closeSize) || (hasCopyTag && (closeSize || sameDims))) {
            used.add(bIdx);
            cluster.push(b);
          }
        }

        if (cluster.length > 1) {
          used.add(aIdx);
          cluster.sort(sortCopiesBestFirst);
          groups.push({
            key: `name-${stemKey}-${aIdx}`,
            items: cluster,
            matchType: 'copy_name',
          });
        }
      }
    });

    groups.sort((a, b) => (b.items[0]?.size || 0) - (a.items[0]?.size || 0));
    return groups;
  },
};
