import { NativeModules, DeviceEventEmitter } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
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
      return rawUri;
    }
    if (rawUri.startsWith('/')) {
      return `file://${rawUri}`;
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
      if (asset.id && !String(asset.id).startsWith('file://') && !String(asset.id).startsWith('content://')) {
        try {
          const info = await MediaLibrary.getAssetInfoAsync(asset.id);
          if (info?.localUri) return info.localUri;
        } catch (_e) {}
      }
      const res = await resolveVideoInputFile(asset.uri);
      return res?.path || null;
    } catch (_e) {
      return null;
    }
  },

  /**
   * Analiza el video de forma inteligente para detectar pedazos totalmente negros, sin ningún movimiento
   * e intros/cierres (bumpers), devolviendo los tramos óptimos a conservar y los tramos descartados.
   */
  async analyzeSmartTrim({
    asset,
    detectBlack = true,
    detectStatic = true,
    detectIntro = true,
    sensitivity = 1.0,
    onProgress,
  }) {
    if (!asset?.uri) throw new Error('Video no válido.');
    if (!VideoEngineModule?.analyzeSmartTrimNative) {
      throw new Error('El motor nativo de Recorte Inteligente no está disponible en esta compilación.');
    }

    let sub = null;
    try {
      if (onProgress) {
        sub = DeviceEventEmitter.addListener('VideoEngineProgress', (evt) => {
          onProgress({
            percent: evt?.percent ?? 0.5,
            stage: evt?.stage || 'Analizando cuadros negros, pausas e intros...',
          });
        });
      }

      const target = extractPhysicalFilePath(asset.uri) || asset.uri;
      let rawRes = null;
      try {
        rawRes = await VideoEngineModule.analyzeSmartTrimNative(
          target,
          Boolean(detectBlack),
          Boolean(detectStatic),
          Boolean(detectIntro),
          Number(sensitivity) || 1.0
        );
      } catch (_firstErr) {
        if (target !== asset.uri) {
          rawRes = await VideoEngineModule.analyzeSmartTrimNative(
            asset.uri,
            Boolean(detectBlack),
            Boolean(detectStatic),
            Boolean(detectIntro),
            Number(sensitivity) || 1.0
          );
        } else {
          const fallbackInput = await resolveVideoInputFile(asset.uri);
          rawRes = await VideoEngineModule.analyzeSmartTrimNative(
            fallbackInput.path,
            Boolean(detectBlack),
            Boolean(detectStatic),
            Boolean(detectIntro),
            Number(sensitivity) || 1.0
          );
        }
      }

      const durationSec = (rawRes?.durationMs || 0) / 1000;
      const keepSegments = Array.isArray(rawRes?.keepSegments)
        ? rawRes.keepSegments.map((s, idx) => ({
            id: `smart_keep_${idx}_${ Math.round(s.startMs || 0)}`,
            start: Math.max(0, (s.startMs || 0) / 1000),
            end: Math.max(0.1, (s.endMs || 0) / 1000),
            label: `Óptimo ${idx + 1}`,
          }))
        : [];

      const removedSegments = Array.isArray(rawRes?.removedSegments)
        ? rawRes.removedSegments.map((s, idx) => {
            const rawReason = String(s.reason || 'static');
            const reason =
              rawReason === 'black'
                ? 'black'
                : rawReason === 'intro'
                ? 'intro'
                : rawReason === 'outro'
                ? 'outro'
                : 'static';
            const label =
              reason === 'black'
                ? 'Todo negro'
                : reason === 'intro'
                ? 'Intro'
                : reason === 'outro'
                ? 'Cierre'
                : 'Sin movimiento';
            return {
              id: `smart_rem_${idx}_${Math.round(s.startMs || 0)}`,
              start: Math.max(0, (s.startMs || 0) / 1000),
              end: Math.max(0.1, (s.endMs || 0) / 1000),
              reason,
              label,
            };
          })
        : [];

      return {
        durationSec,
        optimizedDurationSec: (rawRes?.optimizedDurationMs || 0) / 1000,
        savedDurationSec: (rawRes?.savedDurationMs || 0) / 1000,
        blackRemovedSec: (rawRes?.blackRemovedMs || 0) / 1000,
        staticRemovedSec: (rawRes?.staticRemovedMs || 0) / 1000,
        introRemovedSec: (rawRes?.introRemovedMs || 0) / 1000,
        keepSegments,
        removedSegments,
      };
    } finally {
      if (sub) sub.remove();
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
          if (!newSizeBytes || newSizeBytes <= 0) {
            throw new Error('Archivo recortado vacío, usando motor alternativo.');
          }
        } catch (nativeTrimErr) {
          if (VideoEngineModule?.compressVideo) {
            const transRes = await VideoEngineModule.compressVideo(
              inputObj.path,
              outTempFile.uri,
              0.78,
              normalizedSegments
            );
            outputUri = transRes?.outputPath || outTempFile.uri;
            newSizeBytes =
              transRes?.sizeBytes || (await compressionService.getFileSize(outputUri, { forceFresh: true }));
          } else if (normalizedSegments.length === 1) {
            const fallbackRes = await fallbackTrimSingle(inputObj.path, {
              startTime: normalizedSegments[0].startMs,
              endTime: normalizedSegments[0].endMs,
            });
            const rawOut = typeof fallbackRes === 'string' ? fallbackRes : fallbackRes?.outputPath;
            if (!rawOut) throw nativeTrimErr;
            outputUri = rawOut.startsWith('file://') ? rawOut : `file://${rawOut}`;
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
        const rawOut = typeof fallbackRes === 'string' ? fallbackRes : fallbackRes?.outputPath;
        if (!rawOut) throw new Error('No se pudo recortar el video.');
        outputUri = rawOut.startsWith('file://') ? rawOut : `file://${rawOut}`;
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
        let savedCopyUri = outputUri;
        // Si el video pertenece a una carpeta física, guardar también la copia en la misma carpeta para que sea visible de inmediato
        const origPhys = extractPhysicalFilePath(asset.uri);
        if (origPhys) {
          try {
            const cleanOrig = decodeURIComponent(origPhys.replace(/^file:\/+/i, '/'));
            const lastSlash = cleanOrig.lastIndexOf('/');
            if (lastSlash > 0) {
              const parentDir = cleanOrig.substring(0, lastSlash);
              const baseName = (asset.filename || 'video.mp4').replace(/\.[^.]+$/, '');
              const copyName = `${baseName}_recorte_${Date.now().toString().slice(-4)}.mp4`;
              if (VideoEngineModule?.moveFileNative) {
                const tempForMove = new File(Paths.cache, copyName);
                await LegacyFS.copyAsync({ from: outputUri, to: tempForMove.uri });
                savedCopyUri = await VideoEngineModule.moveFileNative(tempForMove.uri, parentDir, copyName);
              }
            }
          } catch (_e) {}
        }
        try {
          await MediaLibrary.createAssetAsync(outputUri);
        } catch (_e1) {
          try {
            await MediaLibrary.saveToLibraryAsync(outputUri);
          } catch (_e2) {}
        }
        return {
          success: true,
          replacedOriginal: false,
          newSizeBytes,
          outputUri: savedCopyUri,
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
  async compressVideosBatch(videos, { presetId = 'balanced', onProgress, control, manageKeepAlive = true } = {}) {
    if (!videos || videos.length === 0) {
      return { processed: 0, compressedCount: 0, totalSavedBytes: 0, cancelled: false };
    }

    let totalSavedBytes = 0;
    let processed = 0;
    let compressedCount = 0;
    const total = videos.length;

    const isCancelled = () => Boolean(control?.isCancelled || control?.cancelled);

    const waitIfPaused = async () => {
      if (control?.waitIfPaused) {
        await control.waitIfPaused();
        return;
      }
      while (control?.isPaused && !isCancelled()) {
        await new Promise((r) => setTimeout(r, 250));
      }
    };

    if (manageKeepAlive && VideoEngineModule?.setCompressionKeepAliveNative) {
      VideoEngineModule.setCompressionKeepAliveNative(
        true,
        `Comprimiendo videos (0/${total})`,
        'Optimizando al 100% de resolución en 2do plano...',
        2
      ).catch(() => {});
    }

    try {
      for (const video of videos) {
        if (isCancelled()) break;
        await waitIfPaused();
        if (isCancelled()) break;

        try {
          const res = await videoEngineService.compressVideo({
            asset: video,
            presetId,
            replaceOriginal: true,
            onProgress: (prog) => {
              const overall = (processed + (prog.percent || 0)) / total;
              const pctInt = Math.round(overall * 100);
              const savedFmt = compressionService.formatBytes(totalSavedBytes);
              if (manageKeepAlive && VideoEngineModule?.setCompressionKeepAliveNative) {
                VideoEngineModule.setCompressionKeepAliveNative(
                  true,
                  `Comprimiendo video ${processed + 1} de ${total} (${pctInt}%)`,
                  `${video.filename || 'Video'} · Ahorrado: -${savedFmt}`,
                  pctInt
                ).catch(() => {});
              }
              if (onProgress) {
                onProgress({
                  current: processed + 1,
                  total,
                  currentFile: video.filename || 'Video',
                  compressedCount,
                  percent: overall,
                  savedBytes: totalSavedBytes,
                  savedFormatted: savedFmt,
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
            currentFile: video.filename || 'Video',
            compressedCount,
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
      totalSavedBytes,
      cancelled: isCancelled(),
    };
  },
};
