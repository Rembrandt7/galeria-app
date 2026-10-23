import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';

/**
 * Extrae rutas físicas file:// a partir de cualquier URI (incluyendo URIs SAF content:// de Android)
 * Ejemplo: content://com.android.externalstorage.documents/tree/.../document/primary%3ADCIM%2FCamera%2Ffoto.jpg
 * -> file:///storage/emulated/0/DCIM/Camera/foto.jpg
 */
function getCandidateFileUris(uri) {
  if (!uri || typeof uri !== 'string') return [];
  const list = [];

  const addFileVariants = (fileUri) => {
    if (!fileUri || !fileUri.startsWith('file://')) return;
    if (!list.includes(fileUri)) list.push(fileUri);
    try {
      const decoded = decodeURIComponent(fileUri);
      if (!list.includes(decoded)) list.push(decoded);
    } catch (e) {
      // ignorar
    }
    try {
      const encoded = encodeURI(decodeURIComponent(fileUri));
      if (!list.includes(encoded)) list.push(encoded);
    } catch (e) {
      // ignorar
    }
  };

  if (uri.startsWith('file://')) {
    addFileVariants(uri);
  } else if (uri.startsWith('/')) {
    addFileVariants(`file://${uri}`);
  } else if (uri.startsWith('content://')) {
    // Extraer ruta real del documento SAF si pertenece al almacenamiento del teléfono
    try {
      const docMatch = uri.match(/\/document\/([^/?#]+)/i);
      if (docMatch && docMatch[1]) {
        const docId = decodeURIComponent(docMatch[1]);
        if (/^primary:/i.test(docId)) {
          const relPath = docId.replace(/^primary:/i, '').replace(/^\/+/, '');
          addFileVariants(`file:///storage/emulated/0/${relPath}`);
        } else if (/^home:/i.test(docId)) {
          const relPath = docId.replace(/^home:/i, '').replace(/^\/+/, '');
          addFileVariants(`file:///storage/emulated/0/Documents/${relPath}`);
        } else {
          const sdMatch = docId.match(/^([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}):(.+)$/);
          if (sdMatch) {
            const vol = sdMatch[1];
            const relPath = sdMatch[2].replace(/^\/+/, '');
            addFileVariants(`file:///storage/${vol}/${relPath}`);
          }
        }
      }
    } catch (e) {
      // ignorar
    }
    if (!list.includes(uri)) list.push(uri);
  } else {
    list.push(uri);
  }

  return list;
}

/**
 * Obtiene únicamente las rutas file:// físicas posibles para un asset o URI
 */
function getPhysicalFileCandidates(assetOrUri) {
  const isObj = assetOrUri && typeof assetOrUri === 'object';
  const uri = isObj ? assetOrUri.uri : assetOrUri;
  const all = getCandidateFileUris(uri);
  if (isObj && assetOrUri.localUri) {
    for (const c of getCandidateFileUris(assetOrUri.localUri)) {
      if (!all.includes(c)) all.push(c);
    }
  }
  return all.filter((u) => u && u.startsWith('file://'));
}

/**
 * Lee el tamaño real en disco de una ruta específica sin usar cachés en memoria
 */
async function readRawSizeFromUri(candidate) {
  if (!candidate) return 0;
  // Para file:// priorizamos FileSystem.getInfoAsync que hace stat() directo al sistema de archivos
  if (candidate.startsWith('file://')) {
    try {
      const info = await FileSystem.getInfoAsync(candidate);
      if (info?.exists && typeof info.size === 'number' && info.size > 0) {
        return info.size;
      }
    } catch (e) {
      // continuar
    }
    try {
      const sz = new File(candidate).size;
      if (typeof sz === 'number' && sz > 0) return sz;
    } catch (e) {
      // continuar
    }
    return 0;
  }

  // Para content://
  try {
    const info = await FileSystem.getInfoAsync(candidate);
    if (info?.exists && typeof info.size === 'number' && info.size > 0) {
      return info.size;
    }
  } catch (e) {
    // continuar
  }
  try {
    const sz = new File(candidate).size;
    if (typeof sz === 'number' && sz > 0) return sz;
  } catch (e) {
    // continuar
  }
  return 0;
}

/**
 * Copia cualquier archivo (content:// o file://) a un archivo temporal limpio en caché
 * para que ImageManipulator pueda procesarlo sin errores de permisos ni rutas SAF.
 */
async function copyToTempCacheFile(uri) {
  const tempName = `compress_src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
  const tempFile = new File(Paths.cache, tempName);

  // Intento 1: API moderna File.copy
  for (const candidate of getCandidateFileUris(uri)) {
    try {
      await new File(candidate).copy(tempFile);
      if (tempFile.exists && tempFile.size > 0) {
        return tempFile;
      }
    } catch (e) {
      // continuar con siguiente intento
    }
  }

  // Intento 2: API Legacy copyAsync
  for (const candidate of getCandidateFileUris(uri)) {
    try {
      await FileSystem.copyAsync({ from: candidate, to: tempFile.uri });
      const info = await FileSystem.getInfoAsync(tempFile.uri);
      if (info?.exists && info?.size > 0) {
        return tempFile;
      }
    } catch (e) {
      // continuar con siguiente intento
    }
  }

  // Intento 3: Lectura de bytes y escritura directa en caché
  for (const candidate of getCandidateFileUris(uri)) {
    try {
      const bytes = await new File(candidate).bytes();
      if (bytes && bytes.byteLength > 0) {
        await tempFile.write(bytes);
        return tempFile;
      }
    } catch (e) {
      // continuar
    }
  }

  // Intento 4: Lectura y escritura Base64 (compatible con SAF content://)
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  await FileSystem.writeAsStringAsync(tempFile.uri, b64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return tempFile;
}

/**
 * Reemplaza el archivo original en su misma ubicación verificando que el nuevo tamaño en disco
 * realmente haya disminuido (elimina primero el archivo anterior para forzar el truncamiento en Android
 * y NUNCA genera copias duplicadas en otras carpetas).
 */
async function overwriteOriginalFile(sourceTempUri, targetUri, expectedSize = 0, oldSize = 0) {
  if (!sourceTempUri || !targetUri) return false;

  const targetSize = expectedSize || (await readRawSizeFromUri(sourceTempUri));
  const isSizeVerified = (diskSize) => {
    if (!diskSize || diskSize <= 0) return false;
    if (oldSize > 0 && diskSize >= oldSize) return false;
    if (targetSize > 0 && diskSize > targetSize * 1.15) return false;
    return true;
  };

  // 1. Intentar reemplazo directo por sistema de archivos físico (file://)
  // Incluso si targetUri es content:// de SAF en memoria interna, getCandidateFileUris extrae su ruta file:///storage/emulated/0/...
  const physicalCandidates = getCandidateFileUris(targetUri).filter((u) => u.startsWith('file://'));

  for (const candidate of physicalCandidates) {
    let backupFile = null;
    try {
      const existingInfo = await FileSystem.getInfoAsync(candidate).catch(() => null);
      if (existingInfo?.exists) {
        // Crear respaldo temporal en caché antes de borrar el original por seguridad total
        backupFile = new File(
          Paths.cache,
          `bkp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`
        );
        try {
          await FileSystem.copyAsync({ from: candidate, to: backupFile.uri });
        } catch (bkpErr) {
          backupFile = null;
        }

        // Borrar primero el archivo original para evitar que Android mantenga el tamaño viejo sin truncar
        try {
          await FileSystem.deleteAsync(candidate, { idempotent: true });
        } catch (delErr1) {
          try {
            new File(candidate).delete();
          } catch (delErr2) {
            // ignorar
          }
        }
      }

      // Escribir el archivo comprimido en la ruta exacta del original
      let wrote = false;
      try {
        await FileSystem.copyAsync({ from: sourceTempUri, to: candidate });
        wrote = true;
      } catch (copyErr) {
        try {
          const bytes = await new File(sourceTempUri).bytes();
          if (bytes && bytes.byteLength > 0) {
            await new File(candidate).write(bytes);
            wrote = true;
          }
        } catch (writeErr) {
          try {
            const b64 = await FileSystem.readAsStringAsync(sourceTempUri, {
              encoding: FileSystem.EncodingType.Base64,
            });
            await FileSystem.writeAsStringAsync(candidate, b64, {
              encoding: FileSystem.EncodingType.Base64,
            });
            wrote = true;
          } catch (b64Err) {
            wrote = false;
          }
        }
      }

      if (wrote) {
        const verifyDiskSize = await readRawSizeFromUri(candidate);
        if (isSizeVerified(verifyDiskSize)) {
          if (backupFile?.uri) {
            FileSystem.deleteAsync(backupFile.uri, { idempotent: true }).catch(() => {});
          }
          return true;
        }
      }

      // Si no se verificó el cambio de tamaño, restaurar respaldo si fue necesario
      if (backupFile?.uri) {
        const checkAfter = await FileSystem.getInfoAsync(candidate).catch(() => null);
        if (!checkAfter?.exists) {
          await FileSystem.copyAsync({ from: backupFile.uri, to: candidate }).catch(() => {});
        }
        FileSystem.deleteAsync(backupFile.uri, { idempotent: true }).catch(() => {});
      }
    } catch (e) {
      if (backupFile?.uri) {
        FileSystem.deleteAsync(backupFile.uri, { idempotent: true }).catch(() => {});
      }
    }
  }

  // 2. Si es ruta content:// (SAF o MediaProvider) y el acceso directo file:// no estuvo disponible
  if (targetUri.startsWith('content://')) {
    let b64Data = null;
    const getB64 = async () => {
      if (!b64Data) {
        b64Data = await FileSystem.readAsStringAsync(sourceTempUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
      }
      return b64Data;
    };

    // Intento 2A: Recrear el archivo dentro de la carpeta SAF (borrar original + crear con el mismo nombre)
    // Esto garantiza al 100% que Android trunque el tamaño del archivo en SAF y no deje bytes residuales.
    try {
      const treeMatch = targetUri.match(/^(content:\/\/[^/]+\/tree\/[^/]+)\/document\/([^/?#]+)$/i);
      if (treeMatch) {
        const treePrefix = treeMatch[1];
        const docId = decodeURIComponent(treeMatch[2]);
        const lastSlash = docId.lastIndexOf('/');
        const lastColon = docId.lastIndexOf(':');
        const splitIdx = Math.max(lastSlash, lastColon);

        if (splitIdx > 0) {
          const parentDocId =
            lastSlash > lastColon ? docId.slice(0, lastSlash) : docId.slice(0, lastColon + 1);
          const fileName = docId.slice(splitIdx + 1);
          const parentSafUri = `${treePrefix}/document/${encodeURIComponent(parentDocId)}`;

          const b64 = await getB64();
          // Borrar el archivo SAF original y recrearlo con el mismo nombre exacto
          await FileSystem.StorageAccessFramework.deleteAsync(targetUri);
          const dotIdx = fileName.lastIndexOf('.');
          const baseName = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
          const createdUri = await FileSystem.StorageAccessFramework.createFileAsync(
            parentSafUri,
            baseName,
            'image/jpeg'
          );
          await FileSystem.writeAsStringAsync(createdUri, b64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          return createdUri || true;
        }
      }
    } catch (safRecreateErr) {
      // Continuar con escritura directa sobre el descriptor content://
    }

    // Intento 2B: Escritura directa sobre content:// verificando tamaño real
    try {
      const bytes = await new File(sourceTempUri).bytes();
      if (bytes && bytes.byteLength > 0) {
        await new File(targetUri).write(bytes);
        const afterSz = await readRawSizeFromUri(targetUri);
        if (isSizeVerified(afterSz)) return true;
      }
    } catch (e1) {
      // probar con Base64
    }

    try {
      const b64 = await getB64();
      await FileSystem.writeAsStringAsync(targetUri, b64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const afterSz = await readRawSizeFromUri(targetUri);
      if (isSizeVerified(afterSz)) return true;
    } catch (e2) {
      return false;
    }
  }

  return false;
}

export const compressionService = {
  formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) {
      return `${mb.toFixed(2)} MB`;
    }
    const kb = bytes / 1024;
    return `${kb.toFixed(1)} KB`;
  },

  /**
   * Determina el nivel de peso y los colores visuales según los rangos del usuario:
   * - 0 a 2 MB: Verde
   * - 2 a 4 MB: Amarillo
   * - Más de 4 MB: Título en rojo sobre franja roja
   */
  getSizeLevel(bytes) {
    const mb = (bytes || 0) / (1024 * 1024);

    if (mb <= 2) {
      return {
        level: 'light',
        mb: mb.toFixed(2),
        color: '#10b981', // Verde
        titleColor: '#10b981',
        bannerBg: 'rgba(16, 185, 129, 0.18)',
        borderColor: '#10b981',
        tagText: 'Ligero',
        isHeavy: false,
      };
    }

    if (mb <= 4) {
      return {
        level: 'medium',
        mb: mb.toFixed(2),
        color: '#f59e0b', // Amarillo
        titleColor: '#f59e0b',
        bannerBg: 'rgba(245, 158, 11, 0.20)',
        borderColor: '#f59e0b',
        tagText: 'Medio',
        isHeavy: false,
      };
    }

    // Más de 4 MB
    return {
      level: 'heavy',
      mb: mb.toFixed(2),
      color: '#ef4444', // Rojo
      titleColor: '#ffffff',
      bannerBg: '#dc2626', // Franja roja sólida / llamativa
      borderColor: '#ef4444',
      tagText: 'Pesado (>4 MB)',
      isHeavy: true,
    };
  },

  overwriteOriginalFile,

  /**
   * Obtiene el tamaño real en bytes de un archivo multimedia (priorizando lectura física en disco para evitar caché de MediaStore/SAF)
   */
  async getFileSize(assetOrUri, { forceFresh = false } = {}) {
    const isObj = assetOrUri && typeof assetOrUri === 'object';
    const uri = isObj ? assetOrUri.uri : assetOrUri;
    if (!uri) return 0;

    if (!forceFresh && isObj && typeof assetOrUri.fileSize === 'number' && assetOrUri.fileSize > 0) {
      return assetOrUri.fileSize;
    }

    const candidates = getCandidateFileUris(uri);

    // 1. Primero verificar rutas físicas file:// (lectura directa del sistema de archivos sin caché)
    for (const candidate of candidates) {
      if (candidate.startsWith('file://')) {
        const sz = await readRawSizeFromUri(candidate);
        if (sz > 0) return sz;
      }
    }

    // 2. Verificar el resto de candidatos (content:// SAF o MediaStore)
    for (const candidate of candidates) {
      if (!candidate.startsWith('file://')) {
        const sz = await readRawSizeFromUri(candidate);
        if (sz > 0) return sz;
      }
    }

    // 3. Si es un asset de MediaLibrary con id, consultar localUri físico
    if (isObj && assetOrUri.id && !assetOrUri.fromFolder) {
      try {
        const assetInfo = await MediaLibrary.getAssetInfoAsync(assetOrUri.id);
        if (assetInfo?.localUri) {
          for (const candidate of getCandidateFileUris(assetInfo.localUri)) {
            const sz = await readRawSizeFromUri(candidate);
            if (sz > 0) return sz;
          }
        }
      } catch (e) {
        // continuar
      }
    }

    // 4. Último recurso: medir longitud del buffer de bytes
    try {
      const bytes = await new File(uri).bytes();
      if (bytes && bytes.byteLength > 0) return bytes.byteLength;
    } catch (e) {
      // ignorar
    }

    return 0;
  },

  /**
   * Comprime una foto SIN perder resolución (mantiene el ancho y alto al 100%)
   * ajustando de forma inteligente la compresión JPEG para garantizar ahorro real de espacio.
   */
  async compressPhoto(asset, { quality } = {}) {
    if (!asset?.uri) throw new Error('Archivo no válido');

    let uri = asset.uri;
    // Si es un asset de galería sin acceso directo, obtener su localUri real si está disponible
    if (asset.id && !asset.fromFolder && !uri.startsWith('file://')) {
      try {
        const info = await MediaLibrary.getAssetInfoAsync(asset.id);
        if (info?.localUri) uri = info.localUri;
      } catch (e) {
        // usar asset.uri
      }
    }

    let oldSize = await compressionService.getFileSize(asset, { forceFresh: true });
    let tempInputFile = null;
    let workUri = uri;

    // Para rutas content:// (SAF) o rutas con caracteres especiales, usar copia limpia en caché
    if (uri.startsWith('content://')) {
      tempInputFile = await copyToTempCacheFile(uri);
      workUri = tempInputFile.uri;
      if (!oldSize || oldSize <= 0) {
        oldSize = await compressionService.getFileSize(workUri, { forceFresh: true });
      }
    }

    let probeRef;
    try {
      const probeCtx = ImageManipulator.manipulate(workUri);
      probeRef = await probeCtx.renderAsync();
    } catch (firstErr) {
      // Si falló con file:// directo (por espacios o permisos), copiar a caché e intentar de nuevo
      if (!tempInputFile) {
        tempInputFile = await copyToTempCacheFile(uri);
        workUri = tempInputFile.uri;
        if (!oldSize || oldSize <= 0) {
          oldSize = await compressionService.getFileSize(workUri, { forceFresh: true });
        }
      }
      const retryCtx = ImageManipulator.manipulate(workUri);
      probeRef = await retryCtx.renderAsync();
    }

    const origWidth = probeRef.width;
    const origHeight = probeRef.height;

    // Forzar renderizado manteniendo el 100% de la resolución original (mismo ancho y alto)
    const renderCtx = ImageManipulator.manipulate(workUri);
    if (origWidth > 0 && origHeight > 0) {
      renderCtx.resize({ width: origWidth, height: origHeight });
    }
    const renderedRef = await renderCtx.renderAsync();

    // Escalonado inteligente de calidad para garantizar reducción real de peso
    // (Si pesa > 2 MB buscamos bajarlo a <= 1.9 MB [Verde] manteniendo 100% resolución)
    const TWO_MB = 1.92 * 1024 * 1024;
    const qualitySteps = quality
      ? [quality, Math.max(0.3, quality - 0.15), Math.max(0.25, quality - 0.3)]
      : oldSize > 4 * 1024 * 1024
      ? [0.70, 0.58, 0.48, 0.38, 0.30]
      : oldSize > 2 * 1024 * 1024
      ? [0.74, 0.62, 0.50, 0.40, 0.30]
      : [0.72, 0.58, 0.45, 0.34];

    let bestResult = null;
    let bestSize = Infinity;

    for (const q of qualitySteps) {
      const candidate = await renderedRef.saveAsync({
        format: SaveFormat.JPEG,
        compress: q,
      });
      const candidateSize = await compressionService.getFileSize(candidate.uri, { forceFresh: true });

      if (candidateSize > 0 && candidateSize < bestSize) {
        if (bestResult?.uri && bestResult.uri !== candidate.uri) {
          FileSystem.deleteAsync(bestResult.uri, { idempotent: true }).catch(() => {});
        }
        bestResult = candidate;
        bestSize = candidateSize;
      } else if (candidate?.uri && candidate.uri !== bestResult?.uri) {
        FileSystem.deleteAsync(candidate.uri, { idempotent: true }).catch(() => {});
      }

      // Verificar si ya alcanzamos una compresión óptima
      if (oldSize > 0) {
        const ratio = bestSize / oldSize;
        if (oldSize > 2 * 1024 * 1024) {
          // Si pesaba más de 2 MB y ya bajó a rango Ligero (< 1.92 MB) con al menos 20% de ahorro
          if (bestSize <= TWO_MB && ratio <= 0.80) break;
        } else {
          // Si ya era menor a 2 MB, con ahorrar >= 22% es suficiente para no degradar calidad visual
          if (ratio <= 0.78) break;
        }
      } else {
        break;
      }
    }

    // Limpiar archivo temporal de entrada si se creó
    if (tempInputFile?.uri) {
      FileSystem.deleteAsync(tempInputFile.uri, { idempotent: true }).catch(() => {});
    }

    if (!bestResult?.uri) {
      throw new Error('No se pudo generar la imagen comprimida.');
    }

    const newSize = bestSize < Infinity ? bestSize : await compressionService.getFileSize(bestResult.uri, { forceFresh: true });

    // Si el archivo original ya estaba al límite de compresión y el nuevo no es menor, conservar original
    if (oldSize > 0 && newSize >= oldSize) {
      FileSystem.deleteAsync(bestResult.uri, { idempotent: true }).catch(() => {});
      asset.fileSize = oldSize;
      return {
        success: true,
        alreadyOptimized: true,
        uri: asset.uri,
        oldSize,
        newSize: oldSize,
        savedBytes: 0,
        width: origWidth,
        height: origHeight,
      };
    }

    const savedBytes = oldSize > 0 ? Math.max(0, oldSize - newSize) : 0;

    // 1. Sobrescribir SIEMPRE el archivo original en su misma ubicación (NUNCA crear copias sueltas en la galería)
    const overwriteRes = await overwriteOriginalFile(bestResult.uri, asset.uri, newSize, oldSize);
    if (overwriteRes) {
      FileSystem.deleteAsync(bestResult.uri, { idempotent: true }).catch(() => {});
      if (typeof overwriteRes === 'string' && overwriteRes.startsWith('content://')) {
        asset.uri = overwriteRes;
      }
      const verifiedSize = await compressionService.getFileSize(asset, { forceFresh: true });
      const finalNewSize = verifiedSize > 0 && verifiedSize < oldSize ? verifiedSize : newSize;
      asset.fileSize = finalNewSize;
      return {
        success: true,
        overwritten: true,
        uri: asset.uri,
        oldSize,
        newSize: finalNewSize,
        savedBytes: Math.max(0, oldSize - finalNewSize),
        width: origWidth,
        height: origHeight,
      };
    }

    // 2. Si asset.uri era distinto de uri (ej. localUri físico de MediaLibrary), sobrescribir localUri físico
    if (uri !== asset.uri) {
      const overwrittenLocal = await overwriteOriginalFile(bestResult.uri, uri, newSize, oldSize);
      if (overwrittenLocal) {
        FileSystem.deleteAsync(bestResult.uri, { idempotent: true }).catch(() => {});
        const verifiedSize = await compressionService.getFileSize(uri, { forceFresh: true });
        const finalNewSize = verifiedSize > 0 && verifiedSize < oldSize ? verifiedSize : newSize;
        asset.fileSize = finalNewSize;
        return {
          success: true,
          overwritten: true,
          uri: asset.uri,
          oldSize,
          newSize: finalNewSize,
          savedBytes: Math.max(0, oldSize - finalNewSize),
          width: origWidth,
          height: origHeight,
        };
      }
    }

    // Limpiar el temporal para no dejar basura ni crear copias duplicadas
    FileSystem.deleteAsync(bestResult.uri, { idempotent: true }).catch(() => {});

    const permError = new Error(
      'Android bloqueó la modificación directa del archivo original. Para comprimir fotos sobre el archivo original sin crear copias, activa el permiso "Acceso a todos los archivos" en Configuración.'
    );
    permError.code = 'PERMISSION_REQUIRED';
    throw permError;
  },

  /**
   * Comprime todas las fotos de una carpeta o lista en lote sin perder resolución.
   */
  async compressFolderPhotos(assets = [], onProgress) {
    const photoAssets = assets.filter((a) => a && a.mediaType === 'photo');
    const total = photoAssets.length;
    if (total === 0) return { processed: 0, compressedCount: 0, totalSavedBytes: 0, errorsCount: 0 };

    let processed = 0;
    let compressedCount = 0;
    let errorsCount = 0;
    let totalSavedBytes = 0;

    for (const photo of photoAssets) {
      try {
        const res = await compressionService.compressPhoto(photo);
        if (res && res.success) {
          compressedCount++;
          totalSavedBytes += res.savedBytes || 0;
        }
      } catch (e) {
        errorsCount++;
        console.warn('Error al comprimir foto:', photo.filename, e);
      }
      processed++;
      if (onProgress) {
        onProgress({
          current: processed,
          total,
          compressedCount,
          errorsCount,
          percent: processed / total,
          savedBytes: totalSavedBytes,
          savedFormatted: compressionService.formatBytes(totalSavedBytes),
        });
      }
    }

    return { processed, compressedCount, totalSavedBytes, errorsCount };
  },
};
