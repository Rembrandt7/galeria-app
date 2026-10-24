import { NativeModules, DeviceEventEmitter } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { trim as fallbackTrimSingle } from 'react-native-video-trim';
import { compressionService } from './compressionService';

const { VideoEngineModule } = NativeModules;

export const VIDEO_QUALITY_PRESETS = [
  {
    id: 'high',
    label: 'Alta Fidelidad',
    shortLabel: 'Alta (~40% ahorro)',
    desc: 'Máxima nitidez visual manteniendo el 100% de la resolución y FPS originales.',
    factor: 0.60,
    estRatio: 0.60,
    badge: '-40% peso',
    icon: 'diamond-outline',
    color: '#38bdf8',
  },
  {
    id: 'balanced',
    label: 'Equilibrado Pro',
    shortLabel: 'Equilibrado (~60% ahorro)',
    desc: 'Recomendado. Reduce más de la mitad del peso sin pérdida perceptible ni cambio de resolución.',
    factor: 0.40,
    estRatio: 0.42,
    badge: '-58% peso • Recomendado',
    icon: 'sparkles',
    color: '#10b981',
  },
  {
    id: 'max',
    label: 'Máximo Ahorro',
    shortLabel: 'Máximo (~72% ahorro)',
    desc: 'Ideal para liberar mucho espacio en videos largos o 4K conservando su resolución original.',
    factor: 0.27,
    estRatio: 0.28,
    badge: '-72% peso',
    icon: 'flash-outline',
    color: '#f59e0b',
  },
];

function normalizeFileUri(uri) {
  if (!uri || typeof uri !== 'string') return uri;
  if (!uri.startsWith('file://')) return uri;
  const rawPath = uri.replace(/^file:\/+/i, '');
  const segments = rawPath
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      try {
        return encodeURIComponent(decodeURIComponent(seg));
      } catch (_e) {
        return encodeURIComponent(seg);
      }
    });
  return `file:///${segments.join('/')}`;
}

function extractPhysicalFilePath(uri) {
  if (!uri || typeof uri !== 'string') return null;
  if (uri.startsWith('file://')) return normalizeFileUri(uri);
  if (uri.startsWith('/')) return normalizeFileUri(`file://${uri}`);
  if (uri.startsWith('content://')) {
    try {
      const docMatch = uri.match(/\/document\/([^/?#]+)/i);
      if (docMatch && docMatch[1]) {
        const docId = decodeURIComponent(docMatch[1]);
        if (/^primary:/i.test(docId)) {
          const relPath = docId.replace(/^primary:/i, '').replace(/^\/+/, '');
          return normalizeFileUri(`file:///storage/emulated/0/${relPath}`);
        }
        const sdMatch = docId.match(/^([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}):(.+)$/);
        if (sdMatch) {
          return normalizeFileUri(`file:///storage/${sdMatch[1]}/${sdMatch[2].replace(/^\/+/, '')}`);
        }
      }
    } catch (e) {
      // continuar
    }
  }
  return null;
}

async function resolveVideoInputFile(uri) {
  const phys = extractPhysicalFilePath(uri);
  if (phys) {
    try {
      const info = await LegacyFS.getInfoAsync(phys);
      if (info?.exists && info?.size > 0) {
        return { path: phys, isTemp: false };
      }
    } catch (e) {
      // continuar
    }
  }

  const tempDest = new File(Paths.cache, `vid_in_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp4`);
  if (VideoEngineModule?.copyToCacheNative) {
    try {
      const copiedUri = await VideoEngineModule.copyToCacheNative(uri, tempDest.uri);
      return { path: copiedUri || tempDest.uri, isTemp: true };
    } catch (e) {
      // fallback
    }
  }

  try {
    await new File(uri).copy(tempDest);
    return { path: tempDest.uri, isTemp: true };
  } catch (e) {
    await LegacyFS.copyAsync({ from: uri, to: tempDest.uri });
    return { path: tempDest.uri, isTemp: true };
  }
}

function getResolutionBadge(width, height) {
  const maxDim = Math.max(width || 0, height || 0);
  if (maxDim >= 3800) return '4K UHD';
  if (maxDim >= 2500) return '2K QHD';
  if (maxDim >= 1900) return '1080p Full HD';
  if (maxDim >= 1200) return '720p HD';
  if (maxDim > 0) return `${width}×${height}`;
  return 'Original 100%';
}

export const videoEngineService = {
  getPresetById(id) {
    return VIDEO_QUALITY_PRESETS.find((p) => p.id === id) || VIDEO_QUALITY_PRESETS[1];
  },

  /**
   * Obtiene el URI óptimo y más rápido para reproducir el video en ExoPlayer sin tirones ni bloqueos SAF
   */
  getPlayableVideoUri(asset) {
    if (!asset?.uri) return null;
    const rawUri = asset.uri;
    if (rawUri.startsWith('file://')) {
      return normalizeFileUri(rawUri);
    }
    // Si es un URI SAF (content://.../document/primary:...), preferir la ruta física file:// para lectura directa de kernel
    if (rawUri.startsWith('content://') && rawUri.includes('/document/')) {
      const phys = extractPhysicalFilePath(rawUri);
      if (phys) {
        try {
          if (new File(phys).exists) {
            return phys;
          }
        } catch (_e) {
          // usar rawUri
        }
      }
    }
    return rawUri;
  },

  /**
   * Respaldo automático si un URI SAF o especial falla al abrirse en ExoPlayer: prepara copia temporal limpia
   */
  async preparePlayableFallbackUri(asset) {
    if (!asset?.uri) return null;
    try {
      const res = await resolveVideoInputFile(asset.uri);
      return res?.path || null;
    } catch (_e) {
      return null;
    }
  },

  async getVideoMetadata(asset) {
    if (!asset?.uri) return null;
    const diskSize = await compressionService.getFileSize(asset, { forceFresh: false });
    let meta = {
      width: asset.width || 0,
      height: asset.height || 0,
      rotation: 0,
      durationMs: (asset.duration || 0) * 1000,
      bitrate: 0,
      sizeBytes: diskSize || asset.fileSize || 0,
    };

    if (VideoEngineModule?.getVideoMetadata) {
      try {
        const directTarget = extractPhysicalFilePath(asset.uri) || asset.uri;
        const nativeMeta = await VideoEngineModule.getVideoMetadata(directTarget);
        if (nativeMeta) {
          meta = {
            width: nativeMeta.width || meta.width,
            height: nativeMeta.height || meta.height,
            rotation: nativeMeta.rotation || 0,
            durationMs: nativeMeta.durationMs || meta.durationMs,
            bitrate: nativeMeta.bitrate || 0,
            sizeBytes: nativeMeta.sizeBytes || diskSize || meta.sizeBytes,
          };
        }
      } catch (e) {
        // Si falló con ruta física, intentar con el URI original (content:// soportado nativamente)
        if (asset.uri.startsWith('content://')) {
          try {
            const nativeMeta = await VideoEngineModule.getVideoMetadata(asset.uri);
            if (nativeMeta) {
              meta = {
                width: nativeMeta.width || meta.width,
                height: nativeMeta.height || meta.height,
                rotation: nativeMeta.rotation || 0,
                durationMs: nativeMeta.durationMs || meta.durationMs,
                bitrate: nativeMeta.bitrate || 0,
                sizeBytes: nativeMeta.sizeBytes || diskSize || meta.sizeBytes,
              };
            }
          } catch (_e2) {}
        }
      }
    }

    if (!meta.sizeBytes) {
      const freshSize = await compressionService.getFileSize(asset, { forceFresh: true });
      if (freshSize > 0) meta.sizeBytes = freshSize;
    }

    const displayW = meta.rotation === 90 || meta.rotation === 270 ? meta.height : meta.width;
    const displayH = meta.rotation === 90 || meta.rotation === 270 ? meta.width : meta.height;

    return {
      ...meta,
      displayWidth: displayW,
      displayHeight: displayH,
      resolutionBadge: getResolutionBadge(displayW, displayH),
      resolutionText: displayW > 0 && displayH > 0 ? `${displayW}×${displayH}` : '100% Original',
    };
  },

  /**
   * Extrae miniaturas para la línea de tiempo usando un hilo nativo independiente sin interrumpir ExoPlayer
   */
  async extractFilmstrip(asset, count = 7) {
    if (!asset?.uri || !VideoEngineModule?.extractFilmstripNative) return [];
    try {
      const target = extractPhysicalFilePath(asset.uri) || asset.uri;
      const thumbs = await VideoEngineModule.extractFilmstripNative(target, count);
      if (Array.isArray(thumbs) && thumbs.length > 0) return thumbs;
      if (target !== asset.uri) {
        const fallbackThumbs = await VideoEngineModule.extractFilmstripNative(asset.uri, count);
        if (Array.isArray(fallbackThumbs)) return fallbackThumbs;
      }
    } catch (_e) {
      // retornar vacío si falla para mostrar barra limpia
    }
    return [];
  },

  /**
   * Captura un fotograma en alta definición en el segundo indicado sin trabar el reproductor
   */
  async captureFrame(asset, timeSec = 0) {
    if (!asset?.uri || !VideoEngineModule?.captureFrameNative) return null;
    const outTemp = new File(Paths.cache, `snap_${Date.now()}.jpg`);
    const target = extractPhysicalFilePath(asset.uri) || asset.uri;
    try {
      return await VideoEngineModule.captureFrameNative(target, Math.max(0, timeSec * 1000), outTemp.uri);
    } catch (_e) {
      if (target !== asset.uri) {
        return await VideoEngineModule.captureFrameNative(asset.uri, Math.max(0, timeSec * 1000), outTemp.uri);
      }
      return null;
    }
  },

  /**
   * Recorta uno o varios tramos (o elimina un tramo intermedio) y los une sin perder resolución
   */
  async trimVideoSegments({ asset, segments, replaceOriginal = false, onProgress }) {
    if (!asset?.uri) throw new Error('Video no válido.');
    if (!segments || segments.length === 0) throw new Error('Selecciona al menos un tramo válido.');

    let inputObj = null;
    let outTempFile = null;
    let sub = null;

    try {
      if (onProgress) {
        sub = DeviceEventEmitter.addListener('VideoEngineProgress', (evt) => {
          onProgress({
            percent: evt?.percent ?? 0.5,
            stage: evt?.stage || 'Procesando tramos...',
          });
        });
      }

      inputObj = await resolveVideoInputFile(asset.uri);
      outTempFile = new File(Paths.cache, `vid_trim_${Date.now()}.mp4`);

      const normalizedSegments = segments.map((s) => ({
        startMs: Math.max(0, Math.round((s.start ?? 0) * 1000)),
        endMs: Math.max(100, Math.round((s.end ?? 0) * 1000)),
      }));

      let outputUri = null;
      let newSizeBytes = 0;

      if (VideoEngineModule?.trimSegments) {
        try {
          const res = await VideoEngineModule.trimSegments(
            inputObj.path,
            outTempFile.uri,
            normalizedSegments
          );
          outputUri = res?.outputPath || outTempFile.uri;
          newSizeBytes = res?.sizeBytes || (await compressionService.getFileSize(outputUri, { forceFresh: true }));
        } catch (nativeTrimErr) {
          if (normalizedSegments.length === 1) {
            const fallbackRes = await fallbackTrimSingle(inputObj.path, {
              startTime: normalizedSegments[0].startMs,
              endTime: normalizedSegments[0].endMs,
            });
            outputUri = fallbackRes.outputPath.startsWith('file://')
              ? fallbackRes.outputPath
              : `file://${fallbackRes.outputPath}`;
            newSizeBytes = await compressionService.getFileSize(outputUri, { forceFresh: true });
          } else {
            throw nativeTrimErr;
          }
        }
      } else {
        const fallbackRes = await fallbackTrimSingle(inputObj.path, {
          startTime: normalizedSegments[0].startMs,
          endTime: normalizedSegments[0].endMs,
        });
        outputUri = fallbackRes.outputPath.startsWith('file://')
          ? fallbackRes.outputPath
          : `file://${fallbackRes.outputPath}`;
        newSizeBytes = await compressionService.getFileSize(outputUri, { forceFresh: true });
      }

      if (replaceOriginal) {
        const replaced = await compressionService.overwriteOriginalFile(outputUri, asset.uri, newSizeBytes, 0);
        if (!replaced) {
          throw new Error('No se pudo sobrescribir el video original. Verifica el permiso de Acceso a Todos los Archivos.');
        }
        asset.fileSize = newSizeBytes;
        return {
          success: true,
          replacedOriginal: true,
          newSizeBytes,
          outputUri: asset.uri,
        };
      } else {
        await MediaLibrary.saveToLibraryAsync(outputUri);
        return {
          success: true,
          replacedOriginal: false,
          newSizeBytes,
          outputUri,
        };
      }
    } finally {
      if (sub) sub.remove();
      if (inputObj?.isTemp && inputObj.path) {
        try { new File(inputObj.path).delete(); } catch (_e) {}
      }
      if (outTempFile?.exists) {
        try { outTempFile.delete(); } catch (_e) {}
      }
    }
  },

  /**
   * Comprime un video manteniendo el 100% de su resolución original (y opcionalmente recortando tramos a la vez)
   */
  async compressVideo({
    asset,
    presetId = 'balanced',
    segments = null,
    replaceOriginal = true,
    onProgress,
  }) {
    if (!asset?.uri) throw new Error('Video no válido.');
    if (!VideoEngineModule?.compressVideo) {
      throw new Error('El motor nativo de compresión de video requiere actualizar el APK a la última compilación.');
    }

    const preset = videoEngineService.getPresetById(presetId);
    const oldSizeBytes = await compressionService.getFileSize(asset, { forceFresh: true });

    let inputObj = null;
    let outTempFile = null;
    let sub = null;

    try {
      if (onProgress) {
        sub = DeviceEventEmitter.addListener('VideoEngineProgress', (evt) => {
          onProgress({
            percent: evt?.percent ?? 0.1,
            stage: evt?.stage || 'Comprimiendo video a 100% resolución...',
          });
        });
      }

      inputObj = await resolveVideoInputFile(asset.uri);
      outTempFile = new File(Paths.cache, `vid_comp_${Date.now()}.mp4`);

      const normalizedSegments =
        segments && segments.length > 0
          ? segments.map((s) => ({
              startMs: Math.max(0, Math.round((s.start ?? 0) * 1000)),
              endMs: Math.max(100, Math.round((s.end ?? 0) * 1000)),
            }))
          : null;

      const res = await VideoEngineModule.compressVideo(
        inputObj.path,
        outTempFile.uri,
        preset.factor,
        normalizedSegments
      );

      const outputUri = res?.outputPath || outTempFile.uri;
      const newSizeBytes = res?.sizeBytes || (await compressionService.getFileSize(outputUri, { forceFresh: true }));

      if (!newSizeBytes || newSizeBytes <= 0) {
        throw new Error('El archivo comprimido generado no es válido.');
      }

      // Si no hubo recorte de tramos y el video ya estaba ultra comprimido (nuevo peso >= peso original)
      if (!normalizedSegments && oldSizeBytes > 0 && newSizeBytes >= oldSizeBytes * 0.97) {
        return {
          success: true,
          alreadyOptimized: true,
          oldSizeBytes,
          newSizeBytes: oldSizeBytes,
          savedBytes: 0,
        };
      }

      const savedBytes = Math.max(0, oldSizeBytes - newSizeBytes);

      if (replaceOriginal) {
        const replaced = await compressionService.overwriteOriginalFile(
          outputUri,
          asset.uri,
          newSizeBytes,
          normalizedSegments ? 0 : oldSizeBytes
        );
        if (!replaced) {
          throw new Error(
            'No se pudo sobrescribir el video original en almacenamiento. Activa el permiso de Acceso a Todos los Archivos en Ajustes.'
          );
        }
        const verifiedDiskSize = await compressionService.getFileSize(asset.uri, { forceFresh: true });
        const finalSize = verifiedDiskSize > 0 ? verifiedDiskSize : newSizeBytes;
        asset.fileSize = finalSize;

        return {
          success: true,
          alreadyOptimized: false,
          replacedOriginal: true,
          oldSizeBytes,
          newSizeBytes: finalSize,
          savedBytes: Math.max(0, oldSizeBytes - finalSize),
          width: res?.width,
          height: res?.height,
        };
      } else {
        await MediaLibrary.saveToLibraryAsync(outputUri);
        return {
          success: true,
          alreadyOptimized: false,
          replacedOriginal: false,
          oldSizeBytes,
          newSizeBytes,
          savedBytes,
          width: res?.width,
          height: res?.height,
        };
      }
    } finally {
      if (sub) sub.remove();
      if (inputObj?.isTemp && inputObj.path) {
        try { new File(inputObj.path).delete(); } catch (_e) {}
      }
      if (outTempFile?.exists) {
        try { outTempFile.delete(); } catch (_e) {}
      }
    }
  },

  /**
   * Comprime un lote de videos manteniendo 100% su resolución original y reemplazando cada original en su sitio
   */
  async compressVideosBatch(videos, { presetId = 'balanced', onProgress, control } = {}) {
    if (!videos || videos.length === 0) {
      return { processed: 0, compressedCount: 0, totalSavedBytes: 0, cancelled: false };
    }

    let totalSavedBytes = 0;
    let processed = 0;
    let compressedCount = 0;
    const total = videos.length;

    const waitIfPaused = async () => {
      while (control?.isPaused && !control?.isCancelled) {
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    for (const video of videos) {
      if (control?.isCancelled) break;
      await waitIfPaused();
      if (control?.isCancelled) break;

      try {
        const res = await videoEngineService.compressVideo({
          asset: video,
          presetId,
          replaceOriginal: true,
          onProgress: (prog) => {
            if (onProgress) {
              const overall = (processed + (prog.percent || 0)) / total;
              onProgress({
                current: processed + 1,
                total,
                percent: overall,
                savedBytes: totalSavedBytes,
                savedFormatted: compressionService.formatBytes(totalSavedBytes),
                stage: `${video.filename || 'Video'}: ${prog.stage || 'Comprimiendo...'}`,
              });
            }
          },
        });
        if (res.success && !res.alreadyOptimized && res.savedBytes > 0) {
          totalSavedBytes += res.savedBytes;
          compressedCount++;
        }
      } catch (e) {
        console.warn('Error comprimiendo video en lote:', video?.filename, e);
      }
      processed++;
      if (onProgress) {
        onProgress({
          current: processed,
          total,
          percent: processed / total,
          savedBytes: totalSavedBytes,
          savedFormatted: compressionService.formatBytes(totalSavedBytes),
        });
      }
    }

    return {
      processed,
      compressedCount,
      totalSavedBytes,
      cancelled: !!control?.isCancelled,
    };
  },
};
