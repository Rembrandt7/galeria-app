import { NativeModules } from 'react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';

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
 * Reemplaza el archivo original en su misma ubicación truncando su contenido al nuevo tamaño
 * (IMPORTANTE: En Android/Expo NO se debe borrar el archivo file:// antes de escribir porque
 * FilePermissionService evalúa file.canWrite(), que devuelve false si el archivo no existe).
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

  let cachedBytes = null;
  const getBytes = async () => {
    if (!cachedBytes) {
      cachedBytes = await new File(sourceTempUri).bytes();
    }
    return cachedBytes;
  };

  let cachedB64 = null;
  const getB64 = async () => {
    if (!cachedB64) {
      cachedB64 = await FileSystem.readAsStringAsync(sourceTempUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
    return cachedB64;
  };

  // 1. Intentar truncar y sobrescribir directamente sobre el archivo físico (file://) SIN borrarlo antes
  // (para que java.io.File.canWrite() en FilePermissionService sea true)
  const physicalCandidates = getCandidateFileUris(targetUri).filter((u) => u.startsWith('file://'));

  for (const candidate of physicalCandidates) {
    // Intento 0 (Nativo Kotlin directo): FileOutputStream(destFile, false) + channel.truncate(0) + MediaScanner
    if (NativeModules?.VideoEngineModule?.overwriteFileNative) {
      try {
        await NativeModules.VideoEngineModule.overwriteFileNative(sourceTempUri, candidate);
        const verifyDiskSize = await readRawSizeFromUri(candidate);
        if (isSizeVerified(verifyDiskSize)) return true;
      } catch (eNative) {
        // continuar con siguiente método
      }
    }

    // Intento 1A: FileHandle en modo 'wt' (RandomAccessFile + channel.truncate(0) + writeBytes)
    try {
      const bytes = await getBytes();
      if (bytes && bytes.byteLength > 0) {
        const handle = new File(candidate).open('wt');
        try {
          if (typeof handle.writeBytes === 'function') {
            await handle.writeBytes(bytes);
          } else if (typeof handle.writeBytesSync === 'function') {
            handle.writeBytesSync(bytes);
          }
        } finally {
          try {
            handle.close();
          } catch (cErr) {
            // ignorar
          }
        }
        const verifyDiskSize = await readRawSizeFromUri(candidate);
        if (isSizeVerified(verifyDiskSize)) return true;
      }
    } catch (e1A) {
      // continuar con siguiente método sobre el archivo existente
    }

    // Intento 1B: new File(candidate).write(bytes) (usa FileOutputStream(javaFile, false) que trunca el archivo existente)
    try {
      const bytes = await getBytes();
      if (bytes && bytes.byteLength > 0) {
        await new File(candidate).write(bytes);
        const verifyDiskSize = await readRawSizeFromUri(candidate);
        if (isSizeVerified(verifyDiskSize)) return true;
      }
    } catch (e1B) {
      // continuar
    }

    // Intento 1C: FileSystem.copyAsync sobre el archivo existente (usa FileUtils.copyFile)
    try {
      await FileSystem.copyAsync({ from: sourceTempUri, to: candidate });
      const verifyDiskSize = await readRawSizeFromUri(candidate);
      if (isSizeVerified(verifyDiskSize)) return true;
    } catch (e1C) {
      // continuar
    }

    // Intento 1D: FileSystem.writeAsStringAsync Base64 sobre el archivo existente
    try {
      const b64 = await getB64();
      await FileSystem.writeAsStringAsync(candidate, b64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const verifyDiskSize = await readRawSizeFromUri(candidate);
      if (isSizeVerified(verifyDiskSize)) return true;
    } catch (e1D) {
      // continuar
    }
  }

  // 2. Si es ruta content:// (SAF o MediaProvider)
  if (targetUri.startsWith('content://')) {
    if (NativeModules?.VideoEngineModule?.overwriteFileNative) {
      try {
        await NativeModules.VideoEngineModule.overwriteFileNative(sourceTempUri, targetUri);
        return true;
      } catch (eNativeSaf) {
        // continuar
      }
    }

    // Intento 2A: FileHandle en modo 'wt' (usa contentResolver.openFileDescriptor(uri, "wt") que fuerza MODE_TRUNCATE en SAF)
    try {
      const bytes = await getBytes();
      if (bytes && bytes.byteLength > 0) {
        const handle = new File(targetUri).open('wt');
        try {
          if (typeof handle.writeBytes === 'function') {
            await handle.writeBytes(bytes);
          } else if (typeof handle.writeBytesSync === 'function') {
            handle.writeBytesSync(bytes);
          }
        } finally {
          try {
            handle.close();
          } catch (cErr) {
            // ignorar
          }
        }
        return true;
      }
    } catch (e2A) {
      // continuar con recreación SAF o escritura directa
    }

    // Intento 2B: Recrear el archivo dentro de la carpeta SAF (borrar original + crear con el mismo nombre)
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
      // continuar
    }

    // Intento 2C: Escritura directa por stream sobre content://
    try {
      const bytes = await getBytes();
      if (bytes && bytes.byteLength > 0) {
        await new File(targetUri).write(bytes);
        return true;
      }
    } catch (e2C) {
      // probar Base64
    }

    try {
      const b64 = await getB64();
      await FileSystem.writeAsStringAsync(targetUri, b64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return true;
    } catch (e2D) {
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
   * - Fotos: <= 2 MB Verde (muy poco que reducir), 2 a 4 MB Amarillo (reducción media), > 4 MB Rojo (mucha reducción)
   * - Videos (analizados en relación a su duración de tiempo `MB/s`):
   *   - Verde (No se pueden comprimir / ya optimizados): `<= 0.30 MB/s` (<= 18 MB/min, ~2.4 Mbps) o archivos muy cortos `<= 1.5 MB`
   *   - Amarillo (Se pueden comprimir un poco): `0.30 a 0.70 MB/s` (18 a 42 MB/min, ~2.4 a 5.6 Mbps)
   *   - Rojo (Se pueden comprimir mucho): `> 0.70 MB/s` (> 42 MB/min, > 5.6 Mbps)
   */
  getSizeLevel(bytesOrAsset, mediaType = 'photo', durationSec = 0) {
    const isAssetObj = bytesOrAsset && typeof bytesOrAsset === 'object';
    const rawBytes = Number(isAssetObj ? bytesOrAsset.fileSize : bytesOrAsset) || 0;
    const resolvedType = isAssetObj ? bytesOrAsset.mediaType || mediaType : mediaType;
    const rawDuration = Number(isAssetObj ? bytesOrAsset.duration : durationSec) || 0;
    // Normalizar si la duración viene en milisegundos (ej. > 100000)
    const durSec = rawDuration > 36000 ? rawDuration / 1000 : rawDuration;

    const mb = rawBytes / (1024 * 1024);
    const isVideo = resolvedType === 'video';

    if (isVideo) {
      const mbPerSec = durSec > 0 ? mb / durSec : 0;
      const mbPerMin = mbPerSec * 60;

      // 1. VERDE: En relación a su duración no se puede comprimir (bitrate ya óptimo <= 0.30 MB/s o <= 1.5 MB)
      const isVideoGreen =
        rawBytes <= 0 ||
        mb <= 1.5 ||
        (durSec > 0 ? mbPerSec <= 0.30 : mb <= 6);

      if (isVideoGreen) {
        return {
          level: 'light',
          mb: mb.toFixed(2),
          mbPerSec: mbPerSec.toFixed(2),
          mbPerMin: mbPerMin.toFixed(1),
          durationSec: durSec,
          color: '#10b981', // Verde: ya optimizado por su duración (no comprimible)
          titleColor: '#10b981',
          bannerBg: 'rgba(16, 185, 129, 0.18)',
          borderColor: '#10b981',
          tagText: 'En Verde (No comprimible)',
          reductionText: 'En Verde · Óptimo por su duración',
          canCompress: false,
          estimatedSavedBytes: 0,
          isHeavy: false,
        };
      }

      // 2. AMARILLO: Se puede comprimir un poco (0.30 < MB/s <= 0.70, o 6-20 MB si no hay duración)
      const isVideoYellow = durSec > 0 ? mbPerSec <= 0.70 : mb <= 20;
      if (isVideoYellow) {
        const targetBytes = durSec > 0 ? durSec * 0.28 * 1024 * 1024 : rawBytes * 0.68;
        const estSaved = Math.max(
          Math.round(rawBytes * 0.22),
          Math.min(Math.round(rawBytes * 0.42), Math.round(rawBytes - targetBytes))
        );
        return {
          level: 'medium',
          mb: mb.toFixed(2),
          mbPerSec: mbPerSec.toFixed(2),
          mbPerMin: mbPerMin.toFixed(1),
          durationSec: durSec,
          color: '#f59e0b', // Amarillo: se puede comprimir un poco
          titleColor: '#f59e0b',
          bannerBg: 'rgba(245, 158, 11, 0.22)',
          borderColor: '#f59e0b',
          tagText: 'Amarillo (Comprimir poco)',
          reductionText: `Amarillo · Ahorra ~${compressionService.formatBytes(estSaved)}`,
          canCompress: true,
          estimatedSavedBytes: estSaved,
          isHeavy: false,
        };
      }

      // 3. ROJO: Se puede comprimir mucho (> 0.70 MB/s en relación a su duración)
      const targetBytes = durSec > 0 ? durSec * 0.32 * 1024 * 1024 : rawBytes * 0.42;
      const estSaved = Math.max(
        Math.round(rawBytes * 0.45),
        Math.min(Math.round(rawBytes * 0.72), Math.round(rawBytes - targetBytes))
      );
      return {
        level: 'heavy',
        mb: mb.toFixed(2),
        mbPerSec: mbPerSec.toFixed(2),
        mbPerMin: mbPerMin.toFixed(1),
        durationSec: durSec,
        color: '#ef4444', // Rojo: se puede comprimir mucho
        titleColor: '#ffffff',
        bannerBg: '#dc2626',
        borderColor: '#ef4444',
        tagText: 'Rojo (Comprimir mucho)',
        reductionText: `Rojo · Ahorra ~${compressionService.formatBytes(estSaved)}`,
        canCompress: true,
        estimatedSavedBytes: estSaved,
        isHeavy: true,
      };
    }

    const greenThreshold = 2;
    const yellowThreshold = 4;

    if (mb <= greenThreshold) {
      const estSaved = Math.round(rawBytes * 0.32);
      return {
        level: 'light',
        mb: mb.toFixed(2),
        color: '#10b981', // Verde: peso ligero
        titleColor: '#10b981',
        bannerBg: 'rgba(16, 185, 129, 0.18)',
        borderColor: '#10b981',
        tagText: 'Ligero (Verde)',
        reductionText: rawBytes > 0 ? `Comprimir (-${compressionService.formatBytes(estSaved)})` : 'Comprimir',
        canCompress: true,
        estimatedSavedBytes: estSaved,
        isHeavy: false,
      };
    }

    if (mb <= yellowThreshold) {
      const estSaved = Math.round(rawBytes * 0.42);
      return {
        level: 'medium',
        mb: mb.toFixed(2),
        color: '#f59e0b', // Amarillo: se puede reducir más o menos
        titleColor: '#f59e0b',
        bannerBg: 'rgba(245, 158, 11, 0.22)',
        borderColor: '#f59e0b',
        tagText: 'Reducción Media',
        reductionText: `Ahorra ~${compressionService.formatBytes(estSaved)}`,
        canCompress: true,
        estimatedSavedBytes: estSaved,
        isHeavy: false,
      };
    }

    // Rojo: se puede reducir mucho
    const estSaved = Math.round(rawBytes * 0.65);
    return {
      level: 'heavy',
      mb: mb.toFixed(2),
      color: '#ef4444', // Rojo: se puede reducir mucho
      titleColor: '#ffffff',
      bannerBg: '#dc2626',
      borderColor: '#ef4444',
      tagText: 'Mucha Reducción',
      reductionText: `Ahorra ~${compressionService.formatBytes(estSaved)}`,
      canCompress: true,
      estimatedSavedBytes: estSaved,
      isHeavy: true,
    };
  },

  /**
   * Analiza una lista de fotos o videos y devuelve cuánto se puede reducir en conjunto
   * y el color correspondiente (Verde = ligero/no comprimible en video, Amarillo = poco, Rojo = mucho).
   */
  getBatchReductionSummary(assets = [], mediaType = 'photo') {
    const filtered = (assets || []).filter((a) => a && (!mediaType || a.mediaType === mediaType));
    let heavyCount = 0;
    let mediumCount = 0;
    let lightCount = 0;
    let unknownSizeCount = 0;
    let estimatedSavedBytes = 0;
    let lightEstimatedSavedBytes = 0;

    for (const item of filtered) {
      const sz = Number(item.fileSize) || 0;
      if (sz <= 0) {
        unknownSizeCount++;
        continue;
      }
      const info = compressionService.getSizeLevel(
        sz,
        item.mediaType || mediaType || 'photo',
        Number(item.duration) || 0
      );
      if (info.level === 'heavy') {
        heavyCount++;
        estimatedSavedBytes += info.estimatedSavedBytes;
      } else if (info.level === 'medium') {
        mediumCount++;
        estimatedSavedBytes += info.estimatedSavedBytes;
      } else {
        lightCount++;
        lightEstimatedSavedBytes += info.estimatedSavedBytes;
      }
    }

    const compressibleCount = heavyCount + mediumCount;
    const isVideoOnly = mediaType === 'video';
    const canCompress = isVideoOnly
      ? compressibleCount > 0 || unknownSizeCount > 0
      : filtered.length > 0;

    if (!canCompress) {
      return {
        canCompress: false,
        level: 'light',
        color: '#10b981',
        textColor: '#6ee7b7',
        bgColor: 'rgba(16, 185, 129, 0.14)',
        borderColor: 'rgba(16, 185, 129, 0.4)',
        compressibleCount: 0,
        heavyCount: 0,
        mediumCount: 0,
        lightCount,
        estimatedSavedBytes: 0,
        estimatedSavedFormatted: '0 B',
      };
    }

    // Si hay archivos en Rojo (>4MB fotos / >25MB videos) o el ahorro estimado supera 12 MB -> ROJO (se puede reducir mucho)
    if (heavyCount > 0 || estimatedSavedBytes >= 12 * 1024 * 1024) {
      return {
        canCompress: true,
        level: 'heavy',
        color: '#ef4444',
        textColor: '#fca5a5',
        bgColor: 'rgba(239, 68, 68, 0.20)',
        borderColor: '#ef4444',
        compressibleCount: compressibleCount || filtered.length,
        heavyCount,
        mediumCount,
        lightCount,
        estimatedSavedBytes,
        estimatedSavedFormatted:
          estimatedSavedBytes > 0 ? compressionService.formatBytes(estimatedSavedBytes) : '100% res.',
      };
    }

    // Si hay archivos en Amarillo (reducción media) -> AMARILLO
    if (mediumCount > 0) {
      return {
        canCompress: true,
        level: 'medium',
        color: '#f59e0b',
        textColor: '#fde68a',
        bgColor: 'rgba(245, 158, 11, 0.20)',
        borderColor: '#f59e0b',
        compressibleCount: compressibleCount || filtered.length,
        heavyCount,
        mediumCount,
        lightCount,
        estimatedSavedBytes,
        estimatedSavedFormatted:
          estimatedSavedBytes > 0 ? compressionService.formatBytes(estimatedSavedBytes) : '100% res.',
      };
    }

    // Si todos están en Verde o aún se están leyendo tamaños -> VERDE/ACTIVO (siempre permite comprimir)
    const totalEst = estimatedSavedBytes + lightEstimatedSavedBytes;
    return {
      canCompress: true,
      level: 'light',
      color: '#10b981',
      textColor: '#6ee7b7',
      bgColor: 'rgba(16, 185, 129, 0.18)',
      borderColor: '#10b981',
      compressibleCount: filtered.length,
      heavyCount,
      mediumCount,
      lightCount,
      estimatedSavedBytes: totalEst,
      estimatedSavedFormatted:
        totalEst > 0 ? compressionService.formatBytes(totalEst) : '100% res.',
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
  async compressPhoto(asset, { quality, skipIfGreen = false } = {}) {
    if (!asset?.uri) throw new Error('Archivo no válido');

    let uri = asset.uri;
    // Si es un asset de galería, consultar también localUri físico para lectura/escritura directa
    if (asset.id && !asset.fromFolder) {
      try {
        const info = await MediaLibrary.getAssetInfoAsync(asset.id);
        if (info?.localUri) uri = info.localUri;
      } catch (e) {
        // usar asset.uri
      }
    }

    // 0. Motor nativo de compresión directa en 2do plano (Kotlin + ExifInterface + WakeLock-friendly)
    // Funciona sin bloquear la interfaz ni detenerse cuando el usuario minimiza la app.
    const { VideoEngineModule } = NativeModules;
    if (!quality && VideoEngineModule?.compressPhotoInPlaceNative) {
      const candidates = [
        ...getCandidateFileUris(uri),
        ...getCandidateFileUris(asset.uri),
      ];
      const physCandidate = candidates.find((c) => c && c.startsWith('file://'));
      if (physCandidate) {
        try {
          const nativeRes = await VideoEngineModule.compressPhotoInPlaceNative(
            physCandidate,
            Boolean(skipIfGreen)
          );
          if (nativeRes && nativeRes.success) {
            const finalNewSize = Number(nativeRes.newSize) || 0;
            if (finalNewSize > 0) {
              asset.fileSize = finalNewSize;
            }
            return {
              success: true,
              overwritten: Boolean(nativeRes.overwritten),
              skippedGreen: Boolean(nativeRes.skippedGreen),
              alreadyOptimized: Boolean(nativeRes.alreadyOptimized),
              uri: asset.uri,
              oldSize: Number(nativeRes.oldSize) || 0,
              newSize: finalNewSize,
              savedBytes: Math.max(0, Number(nativeRes.savedBytes) || 0),
              width: nativeRes.width || 0,
              height: nativeRes.height || 0,
            };
          }
        } catch (_nativeErr) {
          // Si falla la vía nativa (ej. ruta restringida o formato especial), continuar con fallback
        }
      }
    }

    let oldSize = await compressionService.getFileSize(asset, { forceFresh: true });

    // Solo omitir por estar en Verde si se solicitó explícitamente (lotes mixtos) o si ya pesa menos de 150 KB
    if (
      oldSize > 0 &&
      ((skipIfGreen && compressionService.getSizeLevel(oldSize).level === 'light') ||
        oldSize <= 150 * 1024)
    ) {
      asset.fileSize = oldSize;
      return {
        success: true,
        skippedGreen: true,
        alreadyOptimized: true,
        uri: asset.uri,
        oldSize,
        newSize: oldSize,
        savedBytes: 0,
      };
    }

    let tempInputFile = null;
    let workUri = uri;

    // Para rutas content:// (SAF) o rutas con caracteres especiales, usar copia limpia en caché
    if (uri.startsWith('content://')) {
      tempInputFile = await copyToTempCacheFile(uri);
      workUri = tempInputFile.uri;
      if (!oldSize || oldSize <= 0) {
        oldSize = await compressionService.getFileSize(workUri, { forceFresh: true });
      }
      if (
        oldSize > 0 &&
        ((skipIfGreen && compressionService.getSizeLevel(oldSize).level === 'light') ||
          oldSize <= 150 * 1024)
      ) {
        FileSystem.deleteAsync(tempInputFile.uri, { idempotent: true }).catch(() => {});
        asset.fileSize = oldSize;
        return {
          success: true,
          skippedGreen: true,
          alreadyOptimized: true,
          uri: asset.uri,
          oldSize,
          newSize: oldSize,
          savedBytes: 0,
        };
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
   * Omite automáticamente las fotos que ya están en Verde (<= 2 MB) y solo comprime Naranja o Rojo.
   * Soporta pausa y cancelación mediante `control`.
   */
  async compressFolderPhotos(assets = [], onProgress, control, { manageKeepAlive = true } = {}) {
    const photoAssets = assets.filter((a) => a && a.mediaType === 'photo');
    const total = photoAssets.length;
    if (total === 0) {
      return {
        processed: 0,
        compressedCount: 0,
        skippedGreenCount: 0,
        totalSavedBytes: 0,
        errorsCount: 0,
        permissionRequired: false,
        cancelled: false,
      };
    }

    // Revisar si en el lote hay fotos pesadas (> 2 MB).
    // Si TODAS las fotos seleccionadas/de la carpeta pesan <= 2 MB, las comprimimos todas sin saltarlas.
    const hasHeavyOrMediumInBatch = photoAssets.some(
      (p) => Number(p?.fileSize || 0) > 2 * 1024 * 1024
    );

    let processed = 0;
    let compressedCount = 0;
    let skippedGreenCount = 0;
    let errorsCount = 0;
    let permissionRequired = false;
    let totalSavedBytes = 0;

    const { VideoEngineModule } = NativeModules;
    if (manageKeepAlive && VideoEngineModule?.setCompressionKeepAliveNative) {
      VideoEngineModule.setCompressionKeepAliveNative(
        true,
        `Comprimiendo fotos (0/${total})`,
        'Optimizando al 100% de resolución en 2do plano...',
        2
      ).catch(() => {});
    }

    const isCancelled = () => Boolean(control?.isCancelled || control?.cancelled);

    try {
      for (const photo of photoAssets) {
        if (control?.waitIfPaused) {
          await control.waitIfPaused();
        }
        if (isCancelled()) {
          return {
            processed,
            compressedCount,
            skippedGreenCount,
            totalSavedBytes,
            errorsCount,
            permissionRequired,
            cancelled: true,
          };
        }

        const startPct = Math.max(0.02, processed / total);
        const startSavedFmt = compressionService.formatBytes(totalSavedBytes);
        if (manageKeepAlive && VideoEngineModule?.setCompressionKeepAliveNative) {
          VideoEngineModule.setCompressionKeepAliveNative(
            true,
            `Comprimiendo ${processed + 1} de ${total} (${Math.round(startPct * 100)}%)`,
            `${photo.filename || 'Fotografía'} · Ahorrado: -${startSavedFmt}`,
            Math.round(startPct * 100)
          ).catch(() => {});
        }

        if (onProgress) {
          onProgress({
            current: processed + 1,
            total,
            currentFile: photo.filename || 'Fotografía',
            compressedCount,
            skippedGreenCount,
            errorsCount,
            percent: startPct,
            savedBytes: totalSavedBytes,
            savedFormatted: startSavedFmt,
          });
        }

        try {
          const skipLightInMixedBatch = Boolean(hasHeavyOrMediumInBatch && total > 1);
          const currentSize = await compressionService.getFileSize(photo, { forceFresh: true });
          const isLight =
            currentSize > 0 && compressionService.getSizeLevel(currentSize).level === 'light';

          // Solo saltar las Verdes si el lote tiene fotos > 2 MB y hay más de 1 foto en el lote
          if (isLight && skipLightInMixedBatch) {
            skippedGreenCount++;
          } else {
            const res = await compressionService.compressPhoto(photo, {
              skipIfGreen: skipLightInMixedBatch,
            });
            if (res?.skippedGreen) {
              skippedGreenCount++;
            } else if (res && res.success) {
              compressedCount++;
              totalSavedBytes += res.savedBytes || 0;
            }
          }
        } catch (e) {
          errorsCount++;
          if (e?.code === 'PERMISSION_REQUIRED') {
            permissionRequired = true;
          }
          console.warn('Error al comprimir foto:', photo.filename, e);
        }
        processed++;
        if (onProgress) {
          onProgress({
            current: processed,
            total,
            currentFile: photo.filename || 'Fotografía',
            compressedCount,
            skippedGreenCount,
            errorsCount,
            percent: processed / total,
            savedBytes: totalSavedBytes,
            savedFormatted: compressionService.formatBytes(totalSavedBytes),
          });
        }
      }
    } finally {
      if (manageKeepAlive && VideoEngineModule?.setCompressionKeepAliveNative) {
        VideoEngineModule.setCompressionKeepAliveNative(false, '', '', 0).catch(() => {});
      }
    }

    return {
      processed,
      compressedCount,
      skippedGreenCount,
      totalSavedBytes,
      errorsCount,
      permissionRequired,
      cancelled: isCancelled(),
    };
  },

  // ============================================================================
  // GESTOR GLOBAL DE COMPRESIÓN EN SEGUNDO PLANO (Permite navegar por toda la app
  // o minimizarla mientras sigue comprimiendo fotos y videos sin interrupción)
  // ============================================================================
  _jobState: {
    isRunning: false,
    isPaused: false,
    current: 0,
    total: 0,
    percent: 0,
    currentFile: '',
    savedBytes: 0,
    savedFormatted: '0 B',
    compressedCount: 0,
    skippedGreenCount: 0,
    errorsCount: 0,
    label: '',
  },
  _jobListeners: new Set(),
  _completionListeners: new Set(),
  _jobController: null,
  _queuedPhotos: [],
  _queuedVideos: [],

  getJobState() {
    return compressionService._jobState;
  },

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    compressionService._jobListeners.add(listener);
    try {
      listener(compressionService._jobState);
    } catch (_e) {}
    return () => {
      compressionService._jobListeners.delete(listener);
    };
  },

  onJobCompleted(listener) {
    if (typeof listener !== 'function') return () => {};
    compressionService._completionListeners.add(listener);
    return () => {
      compressionService._completionListeners.delete(listener);
    };
  },

  _emitJobState(patch = {}) {
    compressionService._jobState = {
      ...compressionService._jobState,
      ...patch,
    };
    for (const fn of compressionService._jobListeners) {
      try {
        fn(compressionService._jobState);
      } catch (_e) {}
    }
  },

  pauseJob() {
    if (compressionService._jobController) {
      compressionService._jobController.pause();
    }
  },

  resumeJob() {
    if (compressionService._jobController) {
      compressionService._jobController.resume();
    }
  },

  togglePauseJob() {
    if (!compressionService._jobController) return;
    if (compressionService._jobState.isPaused) {
      compressionService._jobController.resume();
    } else {
      compressionService._jobController.pause();
    }
  },

  cancelJob() {
    if (compressionService._jobController) {
      compressionService._jobController.cancel();
    }
  },

  /**
   * Inicia (o agrega a la cola activa) un trabajo de compresión en segundo plano.
   * No bloquea la navegación entre carpetas/pestañas ni se detiene al minimizar la app.
   */
  async startBackgroundCompressionJob({
    photos = [],
    videos = [],
    label = '',
    presetId = 'balanced',
    onComplete,
  } = {}) {
    const cleanPhotos = (photos || []).filter((a) => a && a.mediaType === 'photo');
    const cleanVideos = (videos || []).filter((a) => a && a.mediaType === 'video');
    const addedCount = cleanPhotos.length + cleanVideos.length;
    if (addedCount === 0) return null;

    // Si ya hay una compresión corriendo en 2do plano, encolar los nuevos archivos al lote activo
    if (compressionService._jobState.isRunning && compressionService._jobController) {
      compressionService._queuedPhotos.push(...cleanPhotos);
      compressionService._queuedVideos.push(...cleanVideos);
      const newTotal = compressionService._jobState.total + addedCount;
      compressionService._emitJobState({
        total: newTotal,
        percent:
          newTotal > 0 ? Math.min(0.99, compressionService._jobState.current / newTotal) : 0,
      });
      if (typeof onComplete === 'function') {
        const unsub = compressionService.onJobCompleted((summary) => {
          unsub();
          onComplete(summary);
        });
      }
      return compressionService._jobState;
    }

    compressionService._queuedPhotos = [...cleanPhotos];
    compressionService._queuedVideos = [...cleanVideos];

    let paused = false;
    let cancelled = false;
    let pauseResolvers = [];

    const controller = {
      get isPaused() {
        return paused;
      },
      get isCancelled() {
        return cancelled;
      },
      get cancelled() {
        return cancelled;
      },
      pause() {
        paused = true;
        compressionService._emitJobState({ isPaused: true });
      },
      resume() {
        paused = false;
        compressionService._emitJobState({ isPaused: false });
        const list = pauseResolvers;
        pauseResolvers = [];
        list.forEach((r) => r());
      },
      cancel() {
        cancelled = true;
        paused = false;
        compressionService._emitJobState({ isPaused: false });
        const list = pauseResolvers;
        pauseResolvers = [];
        list.forEach((r) => r());
      },
      async waitIfPaused() {
        while (paused && !cancelled) {
          await new Promise((resolve) => pauseResolvers.push(resolve));
        }
      },
    };

    compressionService._jobController = controller;

    const initialTotal = cleanPhotos.length + cleanVideos.length;
    compressionService._emitJobState({
      isRunning: true,
      isPaused: false,
      current: 0,
      total: initialTotal,
      percent: 0.02,
      currentFile: (cleanPhotos[0] || cleanVideos[0])?.filename || 'Preparando archivos...',
      savedBytes: 0,
      savedFormatted: '0 B',
      compressedCount: 0,
      skippedGreenCount: 0,
      errorsCount: 0,
      label: label || '2do plano',
    });

    const { VideoEngineModule } = NativeModules;
    const updateNativeKeepAlive = (active, titleStr = '', subStr = '', pctInt = 0) => {
      if (VideoEngineModule?.setCompressionKeepAliveNative) {
        VideoEngineModule.setCompressionKeepAliveNative(
          Boolean(active),
          titleStr,
          subStr,
          Math.max(0, Math.min(100, Math.round(pctInt || 0)))
        ).catch(() => {});
      }
    };

    updateNativeKeepAlive(
      true,
      `Comprimiendo 1 de ${initialTotal}`,
      'Optimizando al 100% de resolución en 2do plano...',
      2
    );

    let processed = 0;
    let compressedCount = 0;
    let skippedGreenCount = 0;
    let errorsCount = 0;
    let permissionRequired = false;
    let totalSavedBytes = 0;

    try {
      // 1. Procesar cola de fotos (incluyendo cualquier foto que se agregue mientras corre)
      const hasHeavyOrMediumInBatch = compressionService._queuedPhotos.some(
        (p) => Number(p?.fileSize || 0) > 2 * 1024 * 1024
      );

      while (compressionService._queuedPhotos.length > 0 && !cancelled) {
        await controller.waitIfPaused();
        if (cancelled) break;

        const photo = compressionService._queuedPhotos.shift();
        if (!photo) continue;

        const dynamicTotal =
          processed +
          1 +
          compressionService._queuedPhotos.length +
          compressionService._queuedVideos.length;
        const startPct = Math.max(0.02, processed / Math.max(1, dynamicTotal));
        const startSavedFmt = compressionService.formatBytes(totalSavedBytes);

        compressionService._emitJobState({
          current: processed + 1,
          total: dynamicTotal,
          percent: startPct,
          currentFile: photo.filename || 'Fotografía',
          savedBytes: totalSavedBytes,
          savedFormatted: startSavedFmt,
          compressedCount,
          skippedGreenCount,
          errorsCount,
        });

        updateNativeKeepAlive(
          true,
          `Comprimiendo ${processed + 1} de ${dynamicTotal} (${Math.round(startPct * 100)}%)`,
          `${photo.filename || 'Fotografía'} · Ahorrado: -${startSavedFmt}`,
          Math.round(startPct * 100)
        );

        try {
          const skipLight = Boolean(hasHeavyOrMediumInBatch && dynamicTotal > 1);
          const currentSize = await compressionService.getFileSize(photo, { forceFresh: true });
          const isLight =
            currentSize > 0 && compressionService.getSizeLevel(currentSize).level === 'light';

          if (isLight && skipLight) {
            skippedGreenCount++;
          } else {
            const res = await compressionService.compressPhoto(photo, {
              skipIfGreen: skipLight,
            });
            if (res?.skippedGreen) {
              skippedGreenCount++;
            } else if (res && res.success) {
              compressedCount++;
              totalSavedBytes += res.savedBytes || 0;
            }
          }
        } catch (e) {
          errorsCount++;
          if (e?.code === 'PERMISSION_REQUIRED') {
            permissionRequired = true;
          }
          console.warn('Error al comprimir foto en 2do plano:', photo?.filename, e);
        }

        processed++;
        const afterTotal =
          processed +
          compressionService._queuedPhotos.length +
          compressionService._queuedVideos.length;
        const afterPct = processed / Math.max(1, afterTotal);
        const afterSavedFmt = compressionService.formatBytes(totalSavedBytes);

        compressionService._emitJobState({
          current: processed,
          total: afterTotal,
          percent: afterPct,
          currentFile: photo.filename || 'Fotografía',
          savedBytes: totalSavedBytes,
          savedFormatted: afterSavedFmt,
          compressedCount,
          skippedGreenCount,
          errorsCount,
        });
      }

      // 2. Procesar cola de videos
      if (compressionService._queuedVideos.length > 0 && !cancelled) {
        const { videoEngineService } = require('./videoEngineService');
        while (compressionService._queuedVideos.length > 0 && !cancelled) {
          await controller.waitIfPaused();
          if (cancelled) break;

          const video = compressionService._queuedVideos.shift();
          if (!video) continue;

          const dynamicTotal =
            processed +
            1 +
            compressionService._queuedPhotos.length +
            compressionService._queuedVideos.length;

          try {
            const vSize =
              Number(video.fileSize) ||
              (await compressionService.getFileSize(video, { forceFresh: true }));
            const vLevelInfo = compressionService.getSizeLevel(
              vSize,
              'video',
              Number(video.duration) || 0
            );
            // Si el video está en VERDE en relación a su duración (no se puede comprimir), omitirlo
            if (vSize > 0 && Number(video.duration) > 0 && vLevelInfo.level === 'light') {
              skippedGreenCount++;
              processed++;
              const afterTotalSkip =
                processed +
                compressionService._queuedPhotos.length +
                compressionService._queuedVideos.length;
              compressionService._emitJobState({
                current: processed,
                total: afterTotalSkip,
                percent: processed / Math.max(1, afterTotalSkip),
                currentFile: `${video.filename || 'Video'} (En verde · Omitido)`,
                savedBytes: totalSavedBytes,
                savedFormatted: compressionService.formatBytes(totalSavedBytes),
                compressedCount,
                skippedGreenCount,
                errorsCount,
              });
              continue;
            }

            const res = await videoEngineService.compressVideo({
              asset: video,
              presetId,
              replaceOriginal: true,
              onProgress: (prog) => {
                const overall = (processed + (prog.percent || 0)) / Math.max(1, dynamicTotal);
                const savedFmt = compressionService.formatBytes(totalSavedBytes);
                compressionService._emitJobState({
                  current: processed + 1,
                  total: dynamicTotal,
                  percent: overall,
                  currentFile: `${video.filename || 'Video'} (${Math.round((prog.percent || 0) * 100)}%)`,
                  savedBytes: totalSavedBytes,
                  savedFormatted: savedFmt,
                  compressedCount,
                  skippedGreenCount,
                  errorsCount,
                });
                updateNativeKeepAlive(
                  true,
                  `Comprimiendo video ${processed + 1} de ${dynamicTotal} (${Math.round(overall * 100)}%)`,
                  `${video.filename || 'Video'} · Ahorrado: -${savedFmt}`,
                  Math.round(overall * 100)
                );
              },
            });
            if (res?.success && !res?.alreadyOptimized && (res?.savedBytes || 0) > 0) {
              totalSavedBytes += res.savedBytes;
              compressedCount++;
            }
          } catch (e) {
            errorsCount++;
            console.warn('Error al comprimir video en 2do plano:', video?.filename, e);
          }

          processed++;
          const afterTotal =
            processed +
            compressionService._queuedPhotos.length +
            compressionService._queuedVideos.length;
          compressionService._emitJobState({
            current: processed,
            total: afterTotal,
            percent: processed / Math.max(1, afterTotal),
            currentFile: video.filename || 'Video',
            savedBytes: totalSavedBytes,
            savedFormatted: compressionService.formatBytes(totalSavedBytes),
            compressedCount,
            skippedGreenCount,
            errorsCount,
          });
        }
      }
    } finally {
      updateNativeKeepAlive(false, '', '', 0);
      compressionService._jobController = null;
      compressionService._queuedPhotos = [];
      compressionService._queuedVideos = [];
      compressionService._emitJobState({
        isRunning: false,
        isPaused: false,
      });
    }

    const summary = {
      processed,
      total: processed,
      compressedCount,
      skippedGreenCount,
      totalSavedBytes,
      savedFormatted: compressionService.formatBytes(totalSavedBytes),
      errorsCount,
      permissionRequired,
      cancelled,
      label,
    };

    if (typeof onComplete === 'function') {
      try {
        onComplete(summary);
      } catch (_e) {}
    }

    for (const fn of compressionService._completionListeners) {
      try {
        fn(summary);
      } catch (_e) {}
    }

    return summary;
  },
};
