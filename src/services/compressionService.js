import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';

/**
 * Normaliza una ruta file:// con caracteres codificados (%20, acentos, etc.)
 */
function getCandidateFileUris(uri) {
  if (!uri || typeof uri !== 'string') return [];
  const list = [uri];
  if (uri.startsWith('file://')) {
    try {
      const decoded = decodeURIComponent(uri);
      if (!list.includes(decoded)) list.push(decoded);
    } catch (e) {
      // ignorar
    }
    try {
      const encoded = encodeURI(decodeURIComponent(uri));
      if (!list.includes(encoded)) list.push(encoded);
    } catch (e) {
      // ignorar
    }
  }
  return list;
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
 * Escribe el archivo comprimido de vuelta sobre el archivo original (file:// o content:// SAF)
 */
async function overwriteOriginalFile(sourceTempUri, targetUri) {
  if (!sourceTempUri || !targetUri) return false;

  // 1. Si es ruta content:// (SAF o MediaProvider con permiso)
  if (targetUri.startsWith('content://')) {
    try {
      const bytes = await new File(sourceTempUri).bytes();
      if (bytes && bytes.byteLength > 0) {
        await new File(targetUri).write(bytes);
        return true;
      }
    } catch (e1) {
      // Fallback con Base64 (usa ContentResolver.openOutputStream(uri, "w"))
      try {
        const b64 = await FileSystem.readAsStringAsync(sourceTempUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await FileSystem.writeAsStringAsync(targetUri, b64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  // 2. Si es ruta file://
  if (targetUri.startsWith('file://')) {
    const candidates = getCandidateFileUris(targetUri);

    // Intento A: copyAsync de LegacyFS
    for (const candidate of candidates) {
      try {
        await FileSystem.copyAsync({ from: sourceTempUri, to: candidate });
        return true;
      } catch (e) {
        // probar siguiente
      }
    }

    // Intento B: escritura directa de bytes con File
    for (const candidate of candidates) {
      try {
        const bytes = await new File(sourceTempUri).bytes();
        if (bytes && bytes.byteLength > 0) {
          await new File(candidate).write(bytes);
          return true;
        }
      } catch (e) {
        // probar siguiente
      }
    }

    // Intento C: Base64 writeAsStringAsync
    for (const candidate of candidates) {
      try {
        const b64 = await FileSystem.readAsStringAsync(sourceTempUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await FileSystem.writeAsStringAsync(candidate, b64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        return true;
      } catch (e) {
        // probar siguiente
      }
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

  /**
   * Obtiene el tamaño real en bytes de un archivo multimedia (compatible con file://, content:// SAF y MediaLibrary)
   */
  async getFileSize(assetOrUri, { forceFresh = false } = {}) {
    const isObj = assetOrUri && typeof assetOrUri === 'object';
    const uri = isObj ? assetOrUri.uri : assetOrUri;
    if (!uri) return 0;

    if (!forceFresh && isObj && typeof assetOrUri.fileSize === 'number' && assetOrUri.fileSize > 0) {
      return assetOrUri.fileSize;
    }

    const candidates = getCandidateFileUris(uri);

    // 1. API moderna File.size (soporta SAF DocumentFile.length(), ContentProvider OpenableColumns.SIZE y JavaFile.length())
    for (const candidate of candidates) {
      try {
        const sz = new File(candidate).size;
        if (typeof sz === 'number' && sz > 0) {
          return sz;
        }
      } catch (e) {
        // continuar
      }
    }

    // 2. API Legacy FileSystem.getInfoAsync
    for (const candidate of candidates) {
      try {
        const info = await FileSystem.getInfoAsync(candidate);
        if (info?.exists && typeof info.size === 'number' && info.size > 0) {
          return info.size;
        }
      } catch (e) {
        // continuar
      }
    }

    // 3. Si es un asset de MediaLibrary con id, consultar localUri
    if (isObj && assetOrUri.id && !assetOrUri.fromFolder) {
      try {
        const assetInfo = await MediaLibrary.getAssetInfoAsync(assetOrUri.id);
        if (assetInfo?.localUri) {
          for (const candidate of getCandidateFileUris(assetInfo.localUri)) {
            try {
              const sz = new File(candidate).size;
              if (typeof sz === 'number' && sz > 0) return sz;
            } catch (e) {
              // continuar
            }
            try {
              const info = await FileSystem.getInfoAsync(candidate);
              if (info?.exists && info?.size > 0) return info.size;
            } catch (e) {
              // continuar
            }
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

    // 1. Intentar sobrescribir el archivo original en su misma ubicación (tanto file:// como content:// SAF)
    const overwritten = await overwriteOriginalFile(bestResult.uri, asset.uri);
    if (overwritten) {
      FileSystem.deleteAsync(bestResult.uri, { idempotent: true }).catch(() => {});
      asset.fileSize = newSize;
      return {
        success: true,
        overwritten: true,
        uri: asset.uri,
        oldSize,
        newSize,
        savedBytes,
        width: origWidth,
        height: origHeight,
      };
    }

    // Si asset.uri era distinto de uri (ej. localUri de MediaLibrary), intentar sobrescribir localUri
    if (uri !== asset.uri) {
      const overwrittenLocal = await overwriteOriginalFile(bestResult.uri, uri);
      if (overwrittenLocal) {
        FileSystem.deleteAsync(bestResult.uri, { idempotent: true }).catch(() => {});
        asset.fileSize = newSize;
        return {
          success: true,
          overwritten: true,
          uri: asset.uri,
          oldSize,
          newSize,
          savedBytes,
          width: origWidth,
          height: origHeight,
        };
      }
    }

    // 2. Si Android Scoped Storage impide sobrescribir directamente un archivo de MediaLibrary,
    // guardar la versión comprimida en la galería y actualizar la referencia del asset.
    try {
      const savedAsset = await MediaLibrary.createAssetAsync(bestResult.uri);
      FileSystem.deleteAsync(bestResult.uri, { idempotent: true }).catch(() => {});
      const finalUri = savedAsset?.uri || bestResult.uri;
      asset.uri = finalUri;
      asset.fileSize = newSize;
      if (savedAsset?.id) asset.id = savedAsset.id;
      return {
        success: true,
        overwritten: false,
        uri: finalUri,
        oldSize,
        newSize,
        savedBytes,
        width: origWidth,
        height: origHeight,
      };
    } catch (e) {
      try {
        await MediaLibrary.saveToLibraryAsync(bestResult.uri);
      } catch (e2) {
        // conservar en caché si no hay permiso de galería
      }
      asset.uri = bestResult.uri;
      asset.fileSize = newSize;
      return {
        success: true,
        overwritten: false,
        uri: bestResult.uri,
        oldSize,
        newSize,
        savedBytes,
        width: origWidth,
        height: origHeight,
      };
    }
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
