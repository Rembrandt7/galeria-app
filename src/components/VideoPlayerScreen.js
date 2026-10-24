import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  PanResponder,
  ScrollView,
  StatusBar,
  SafeAreaView,
  BackHandler,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as MediaLibrary from 'expo-media-library';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { compressionService } from '../services/compressionService';
import { videoEngineService, VIDEO_QUALITY_PRESETS } from '../services/videoEngineService';
import { theme } from '../constants/theme';

const FRAME = 1 / 30;
const SPEEDS = [0.5, 1, 1.5, 2];
const THUMB_COUNT = 7;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function formatTime(sec, showTenths = false) {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (!showTenths) {
    return `${m}:${Math.floor(rem).toString().padStart(2, '0')}`;
  }
  const rest = rem.toFixed(1).padStart(4, '0');
  return `${m}:${rest}`;
}

export default function VideoPlayerScreen({
  asset,
  initialMode = 'play',
  onClose,
  onSaved,
  onShare,
  onDelete,
}) {
  const [fallbackUri, setFallbackUri] = useState(null);
  const triedFallbackRef = useRef(false);

  // 1. Obtener URI óptimo y memoizar videoSource para que ExoPlayer jamás se reinicie en re-renders
  const playableUri = useMemo(
    () => fallbackUri || videoEngineService.getPlayableVideoUri(asset),
    [asset?.uri, fallbackUri]
  );

  const videoSource = useMemo(
    () => (playableUri ? { uri: playableUri } : null),
    [playableUri]
  );

  const player = useVideoPlayer(videoSource, (p) => {
    p.timeUpdateEventInterval = 0.15;
    p.loop = false;
    p.muted = false;
    p.play();
  });

  // Estado de reproducción y metadatos
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(
    asset?.duration && asset.duration > 0 ? asset.duration : 0
  );
  const [playing, setPlaying] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [muted, setMuted] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [rate, setRate] = useState(1);
  const [videoMeta, setVideoMeta] = useState(null);
  const [currentFileSize, setCurrentFileSize] = useState(asset?.fileSize || 0);
  const [filmstripThumbs, setFilmstripThumbs] = useState([]);
  const [seekFeedback, setSeekFeedback] = useState(null);

  // Modo principal de la interfaz: 'play' (Reproductor limpio) | 'trim' (Recortar) | 'compress' (Comprimir)
  const [studioMode, setStudioMode] = useState(initialMode || 'play');

  // Submodo de recorte:
  // 'keep' = Dejar solo el tramo [Inicio, Fin]
  // 'cut_middle' = Borrar la parte central marcada y unir el principio con el final
  // 'multi' = Unir varios tramos del mismo video
  const [trimMode, setTrimMode] = useState('keep');
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [savedClips, setSavedClips] = useState([]);
  const [activeHandle, setActiveHandle] = useState('start'); // 'start' | 'end'
  const [previewingCut, setPreviewingCut] = useState(false);

  // Estado de compresión sin perder resolución
  const [selectedPresetId, setSelectedPresetId] = useState('balanced');
  const [applyTrimOnCompress, setApplyTrimOnCompress] = useState(false);

  // Estado de procesamiento
  const [busy, setBusy] = useState(false);
  const [progressInfo, setProgressInfo] = useState({ percent: 0, stage: '' });

  // Referencias para gestos fluidos sin saltos en Android
  const viewportWidthRef = useRef(360);
  const playScrubberWidthRef = useRef(1);
  const scrubberGrantXRef = useRef(0);
  const timelineWidthRef = useRef(1);
  const timelineDragModeRef = useRef('playhead'); // 'start' | 'end' | 'playhead'
  const timelineGrantXRef = useRef(0);
  const isScrubbingRef = useRef(false);
  const durationRef = useRef(duration);
  const trimStartRef = useRef(0);
  const trimEndRef = useRef(0);
  const dragInitialStartRef = useRef(0);
  const dragInitialEndRef = useRef(0);
  const singleTapTimerRef = useRef(null);
  const lastTapTimeRef = useRef(0);
  const loopEnabledRef = useRef(false);

  durationRef.current = duration;
  trimStartRef.current = trimStart;
  trimEndRef.current = trimEnd;
  loopEnabledRef.current = loopEnabled;

  // Limpiar archivo temporal de respaldo y timers al desmontar
  useEffect(() => {
    return () => {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
      }
      if (fallbackUri && fallbackUri.includes('vid_in_')) {
        try {
          new File(fallbackUri).delete();
        } catch (_e) {}
      }
    };
  }, [fallbackUri]);

  // Sincronizar modo inicial cuando cambia el asset o el modo pedido
  useEffect(() => {
    setStudioMode(initialMode || 'play');
    setFallbackUri(null);
    triedFallbackRef.current = false;
  }, [initialMode, asset?.uri]);

  // Leer metadatos del video sin copiar el archivo ni bloquear ExoPlayer
  useEffect(() => {
    let mounted = true;
    (async () => {
      const meta = await videoEngineService.getVideoMetadata(asset);
      if (!mounted || !meta) return;
      setVideoMeta(meta);
      if (meta.sizeBytes > 0) {
        setCurrentFileSize(meta.sizeBytes);
      }
      if (meta.durationMs > 0) {
        const dSec = meta.durationMs / 1000;
        if (dSec > 0 && (!durationRef.current || Math.abs(dSec - durationRef.current) > 0.2)) {
          setDuration(dSec);
          if (trimEndRef.current <= 0) {
            setTrimEnd(dSec);
          }
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [asset]);

  // Extraer miniaturas para el Filmstrip en hilo nativo SEPARADO únicamente cuando se abre "Recortar"
  useEffect(() => {
    let cancelled = false;
    if (studioMode !== 'trim' || filmstripThumbs.length > 0) return;

    (async () => {
      const thumbs = await videoEngineService.extractFilmstrip(asset, THUMB_COUNT);
      if (!cancelled && Array.isArray(thumbs) && thumbs.length > 0) {
        setFilmstripThumbs(thumbs);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [studioMode, asset, filmstripThumbs.length]);

  // Calcular los tramos efectivos que quedarán en el video final
  const effectiveSegments = useMemo(() => {
    const dur = duration || 0;
    if (dur <= 0) return [];

    const s = clamp(trimStart, 0, dur);
    const e = clamp(trimEnd > 0 ? trimEnd : dur, 0, dur);

    if (trimMode === 'cut_middle') {
      const parts = [];
      if (s > 0.12) {
        parts.push({ start: 0, end: s, label: 'Parte 1' });
      }
      if (dur - e > 0.12) {
        parts.push({ start: e, end: dur, label: 'Parte 2' });
      }
      return parts;
    }

    if (trimMode === 'multi' && savedClips.length > 0) {
      return savedClips.map((c, idx) => ({
        start: clamp(c.start, 0, dur),
        end: clamp(c.end, 0, dur),
        id: c.id,
        label: `Tramo ${idx + 1}`,
      }));
    }

    if (e > s + 0.1) {
      return [{ start: s, end: e, label: 'Tramo seleccionado' }];
    }
    return [{ start: 0, end: dur, label: 'Video completo' }];
  }, [duration, trimStart, trimEnd, trimMode, savedClips]);

  const effectiveSegmentsRef = useRef([]);
  effectiveSegmentsRef.current = effectiveSegments;
  const previewingCutRef = useRef(false);
  previewingCutRef.current = previewingCut;

  // Suscripción a eventos del reproductor ExoPlayer
  useEffect(() => {
    const subs = [
      player.addListener('timeUpdate', ({ currentTime }) => {
        if (!isScrubbingRef.current) {
          setTime(currentTime);
        }
        setIsReady(true);

        if (
          player.duration &&
          player.duration > 0 &&
          Math.abs(player.duration - durationRef.current) > 0.1
        ) {
          setDuration(player.duration);
          if (trimEndRef.current <= 0) {
            setTrimEnd(player.duration);
          }
        }

        // Vista previa inteligente del recorte: salta en tiempo real las partes descartadas
        if (previewingCutRef.current && effectiveSegmentsRef.current.length > 0) {
          const segs = effectiveSegmentsRef.current;
          const insideAny = segs.some(
            (seg) => currentTime >= seg.start - 0.1 && currentTime <= seg.end + 0.06
          );
          if (!insideAny) {
            const nextSeg = segs.find((seg) => seg.start > currentTime + 0.03);
            if (nextSeg) {
              player.currentTime = nextSeg.start;
              setTime(nextSeg.start);
            } else {
              player.currentTime = segs[0].start;
              setTime(segs[0].start);
            }
          }
        }
      }),
      player.addListener('playingChange', ({ isPlaying }) => {
        setPlaying(isPlaying);
        if (isPlaying) setIsReady(true);
      }),
      player.addListener('statusChange', ({ status }) => {
        if (status === 'readyToPlay') {
          setIsReady(true);
          if (player.duration && player.duration > 0) {
            setDuration(player.duration);
            if (trimEndRef.current <= 0) {
              setTrimEnd(player.duration);
            }
          }
        } else if (status === 'error' && !triedFallbackRef.current) {
          // Si ExoPlayer tuvo problema con un URI SAF o nombre especial, preparar copia limpia en caché automáticamente
          triedFallbackRef.current = true;
          videoEngineService.preparePlayableFallbackUri(asset).then((cleanUri) => {
            if (cleanUri) {
              setFallbackUri(cleanUri);
            }
          });
        }
      }),
      player.addListener('sourceLoad', ({ duration: d }) => {
        setIsReady(true);
        if (d && d > 0) {
          setDuration(d);
          if (trimEndRef.current <= 0) {
            setTrimEnd(d);
          }
        }
      }),
      player.addListener('playToEnd', () => {
        if (previewingCutRef.current && effectiveSegmentsRef.current.length > 0) {
          const first = effectiveSegmentsRef.current[0];
          player.currentTime = first.start;
          setTime(first.start);
          player.play();
        } else if (loopEnabledRef.current) {
          player.currentTime = 0;
          setTime(0);
          player.play();
        } else {
          setPlaying(false);
        }
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [player, asset]);

  useEffect(() => {
    const onBackPress = () => {
      if (busy) return true;
      if (studioMode !== 'play' && initialMode === 'play') {
        setPreviewingCut(false);
        setStudioMode('play');
        return true;
      }
      onClose();
      return true;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, [onClose, busy, studioMode, initialMode]);

  const seekTo = (t) => {
    const max = durationRef.current || t || 1;
    const target = clamp(t, 0, max);
    try {
      player.currentTime = target;
    } catch (_e) {}
    setTime(target);
  };

  const togglePlay = () => {
    try {
      if (playing) {
        setPreviewingCut(false);
        player.pause();
      } else {
        const dur = durationRef.current || player.duration || 0;
        if (dur > 0 && time >= dur - 0.15) {
          seekTo(0);
        }
        player.play();
      }
    } catch (_e) {}
  };

  const seekBy = (delta) => {
    setPreviewingCut(false);
    const current = Number.isFinite(player.currentTime) ? player.currentTime : time;
    seekTo(current + delta);
    const label = delta > 0 ? `+${Math.round(delta)}s` : `${Math.round(delta)}s`;
    setSeekFeedback(label);
    setTimeout(() => setSeekFeedback(null), 550);
  };

  // Toque en el área del video: 1 toque = Play/Pausa, Doble toque izquierda/derecha = -10s / +10s sin pausar por error
  const handleVideoPress = (evt) => {
    const now = Date.now();
    const locX = evt?.nativeEvent?.locationX ?? viewportWidthRef.current / 2;
    const width = viewportWidthRef.current || 360;

    if (now - lastTapTimeRef.current < 250) {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      if (locX < width * 0.38) {
        seekBy(-10);
      } else if (locX > width * 0.62) {
        seekBy(10);
      } else {
        togglePlay();
      }
      lastTapTimeRef.current = 0;
      return;
    }

    lastTapTimeRef.current = now;
    singleTapTimerRef.current = setTimeout(() => {
      togglePlay();
      singleTapTimerRef.current = null;
    }, 230);
  };

  const toggleMute = () => {
    const next = !muted;
    player.muted = next;
    setMuted(next);
  };

  const toggleLoop = () => {
    const next = !loopEnabled;
    player.loop = next;
    setLoopEnabled(next);
  };

  const cycleSpeed = () => {
    const idx = SPEEDS.indexOf(rate);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    player.playbackRate = next;
    setRate(next);
  };

  const stepFrame = (dir) => {
    setPreviewingCut(false);
    player.pause();
    const current = Number.isFinite(player.currentTime) ? player.currentTime : time;
    seekTo(current + dir * FRAME);
  };

  // PanResponder A: Barra de progreso en Modo Reproducir (usa grantX + dx para cero saltos en Android)
  const playScrubberPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        isScrubbingRef.current = true;
        setPreviewingCut(false);
        const w = playScrubberWidthRef.current || 1;
        scrubberGrantXRef.current = e.nativeEvent.locationX;
        const ratio = clamp(scrubberGrantXRef.current / w, 0, 1);
        seekTo(ratio * (durationRef.current || 1));
      },
      onPanResponderMove: (_, gestureState) => {
        const w = playScrubberWidthRef.current || 1;
        const x = scrubberGrantXRef.current + gestureState.dx;
        const ratio = clamp(x / w, 0, 1);
        seekTo(ratio * (durationRef.current || 1));
      },
      onPanResponderRelease: () => {
        isScrubbingRef.current = false;
      },
      onPanResponderTerminate: () => {
        isScrubbingRef.current = false;
      },
    })
  ).current;

  // PanResponder B UNIFICADO: Línea de tiempo en Modo Recortar
  // Detecta automáticamente si el usuario tocó cerca de [ Inicio, Fin ] o la aguja central,
  // funcionando al 100% incluso en los bordes 0% y 100% en Android.
  const timelinePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        isScrubbingRef.current = true;
        setPreviewingCut(false);
        const w = timelineWidthRef.current || 1;
        const dur = durationRef.current || 1;
        const touchX = e.nativeEvent.locationX;
        timelineGrantXRef.current = touchX;

        const startX = (trimStartRef.current / dur) * w;
        const currentEnd = trimEndRef.current > 0 ? trimEndRef.current : dur;
        const endX = (currentEnd / dur) * w;

        const distStart = Math.abs(touchX - startX);
        const distEnd = Math.abs(touchX - endX);
        const HANDLE_RADIUS = 30;

        if (distStart <= HANDLE_RADIUS && distStart <= distEnd) {
          timelineDragModeRef.current = 'start';
          player.pause();
          setActiveHandle('start');
          dragInitialStartRef.current = trimStartRef.current;
        } else if (distEnd <= HANDLE_RADIUS) {
          timelineDragModeRef.current = 'end';
          player.pause();
          setActiveHandle('end');
          dragInitialEndRef.current = currentEnd;
        } else {
          timelineDragModeRef.current = 'playhead';
          const ratio = clamp(touchX / w, 0, 1);
          seekTo(ratio * dur);
        }
      },
      onPanResponderMove: (_, gestureState) => {
        const w = timelineWidthRef.current || 1;
        const dur = durationRef.current || 1;
        const mode = timelineDragModeRef.current;

        if (mode === 'start') {
          const deltaSec = (gestureState.dx / w) * dur;
          const maxStart = Math.max(0, (trimEndRef.current || dur) - 0.25);
          const nextStart = clamp(dragInitialStartRef.current + deltaSec, 0, maxStart);
          setTrimStart(nextStart);
          seekTo(nextStart);
        } else if (mode === 'end') {
          const deltaSec = (gestureState.dx / w) * dur;
          const minEnd = Math.min(dur, (trimStartRef.current || 0) + 0.25);
          const nextEnd = clamp(dragInitialEndRef.current + deltaSec, minEnd, dur);
          setTrimEnd(nextEnd);
          seekTo(nextEnd);
        } else {
          const x = timelineGrantXRef.current + gestureState.dx;
          const ratio = clamp(x / w, 0, 1);
          seekTo(ratio * dur);
        }
      },
      onPanResponderRelease: () => {
        isScrubbingRef.current = false;
      },
      onPanResponderTerminate: () => {
        isScrubbingRef.current = false;
      },
    })
  ).current;

  // Probar en vivo cómo quedará el video con el recorte
  const handlePreviewSelection = () => {
    if (effectiveSegments.length === 0) return;
    if (previewingCut && playing) {
      setPreviewingCut(false);
      player.pause();
      return;
    }
    setPreviewingCut(true);
    const first = effectiveSegments[0];
    seekTo(first.start);
    player.play();
  };

  // Ajuste fino (±0.1s / ±0.5s) de la manija seleccionada
  const nudgeHandle = (deltaSec) => {
    player.pause();
    setPreviewingCut(false);
    const dur = duration || 1;
    if (activeHandle === 'start') {
      const next = clamp(trimStart + deltaSec, 0, Math.max(0, (trimEnd || dur) - 0.2));
      setTrimStart(next);
      seekTo(next);
    } else {
      const next = clamp((trimEnd || dur) + deltaSec, Math.min(dur, trimStart + 0.2), dur);
      setTrimEnd(next);
      seekTo(next);
    }
  };

  // Fijar Inicio o Fin exactamente en el segundo actual del video
  const setHandleToCurrentTime = (which) => {
    const t = Number.isFinite(player.currentTime) ? player.currentTime : time;
    const dur = duration || 1;
    setActiveHandle(which);
    if (which === 'start') {
      const maxS = Math.max(0, (trimEnd || dur) - 0.2);
      if (t > maxS) {
        setTrimEnd(dur);
        setTrimStart(clamp(t, 0, Math.max(0, dur - 0.2)));
      } else {
        setTrimStart(clamp(t, 0, maxS));
      }
    } else {
      const minE = Math.min(dur, trimStart + 0.2);
      if (t < minE) {
        setTrimStart(0);
        setTrimEnd(clamp(t, 0.2, dur));
      } else {
        setTrimEnd(clamp(t, minE, dur));
      }
    }
  };

  const handleAddClipSegment = () => {
    const dur = duration || 0;
    const s = clamp(trimStart, 0, dur);
    const e = clamp(trimEnd || dur, 0, dur);
    if (e - s < 0.2) {
      Alert.alert('Tramo muy corto', 'Selecciona un tramo de al menos 0.2 segundos.');
      return;
    }
    setSavedClips((prev) => [
      ...prev,
      { id: `${Date.now()}_${Math.random()}`, start: s, end: e },
    ]);
  };

  const handleRemoveSavedClip = (id) => {
    setSavedClips((prev) => prev.filter((c) => c.id !== id));
  };

  const handleResetTrim = () => {
    setPreviewingCut(false);
    setTrimStart(0);
    setTrimEnd(duration || 0);
    setSavedClips([]);
  };

  // Capturar fotograma actual como foto JPEG sin interrumpir el reproductor
  const handleCaptureFrame = async () => {
    player.pause();
    const captureTime = Number.isFinite(player.currentTime) ? player.currentTime : time;
    setBusy(true);
    setProgressInfo({ percent: 0.6, stage: 'Guardando captura en alta definición...' });
    try {
      let frameUri = await videoEngineService.captureFrame(asset, captureTime);
      if (!frameUri) {
        const thumbs = await player.generateThumbnailsAsync([captureTime]);
        if (!thumbs || !thumbs[0]) {
          throw new Error('No se pudo extraer el cuadro actual.');
        }
        const context = ImageManipulator.manipulate(thumbs[0]);
        const rendered = await context.renderAsync();
        const saved = await rendered.saveAsync({
          format: SaveFormat.JPEG,
          compress: 0.95,
        });
        frameUri = saved.uri;
      }
      await MediaLibrary.saveToLibraryAsync(frameUri);
      Alert.alert(
        '📸 Foto guardada',
        `Se guardó el cuadro (${formatTime(captureTime, true)}) como imagen en tu galería.`
      );
      if (onSaved) onSaved();
    } catch (e) {
      Alert.alert('Error al capturar cuadro', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  // Ejecutar recorte de video
  const handleExecuteTrim = async (replaceOriginal = false) => {
    if (effectiveSegments.length === 0) {
      Alert.alert('Recorte', 'Selecciona al menos un tramo válido.');
      return;
    }

    const totalFinalSec = effectiveSegments.reduce(
      (acc, s) => acc + Math.max(0, s.end - s.start),
      0
    );
    if (
      effectiveSegments.length === 1 &&
      effectiveSegments[0].start <= 0.05 &&
      Math.abs(effectiveSegments[0].end - duration) <= 0.1
    ) {
      Alert.alert(
        'Ajusta las manijas de recorte',
        'Arrastra las barras amarillas [ Inicio o Fin ] en la línea de tiempo (o usa los botones "[ Inicio aquí" / "Fin aquí ]") para marcar la parte que quieres recortar.'
      );
      return;
    }

    player.pause();
    setPreviewingCut(false);
    setBusy(true);
    setProgressInfo({ percent: 0.12, stage: 'Recortando video al 100% de resolución...' });

    try {
      const res = await videoEngineService.trimVideoSegments({
        asset,
        segments: effectiveSegments,
        replaceOriginal,
        onProgress: (prog) => setProgressInfo(prog),
      });

      if (res.newSizeBytes > 0 && replaceOriginal) {
        setCurrentFileSize(res.newSizeBytes);
      }

      if (replaceOriginal) {
        Alert.alert(
          '✅ Video recortado',
          `El video original fue actualizado (${formatTime(totalFinalSec, true)}) manteniendo el 100% de su calidad y resolución.\n\nNuevo peso: ${compressionService.formatBytes(res.newSizeBytes)}.`
        );
        if (onSaved) onSaved();
        onClose();
      } else {
        Alert.alert(
          '✅ Copia recortada guardada',
          `Se guardó el nuevo video (${formatTime(totalFinalSec, true)}) en tu galería (${compressionService.formatBytes(res.newSizeBytes)}).`
        );
        if (onSaved) onSaved();
      }
    } catch (e) {
      Alert.alert('No se pudo recortar el video', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  // Ejecutar compresión manteniendo el 100% de resolución
  const handleExecuteCompress = async (replaceOriginal = true) => {
    player.pause();
    setPreviewingCut(false);
    setBusy(true);
    setProgressInfo({
      percent: 0.06,
      stage: 'Comprimiendo video manteniendo 100% resolución...',
    });

    try {
      const hasCustomTrim =
        applyTrimOnCompress &&
        (effectiveSegments.length > 1 ||
          effectiveSegments[0]?.start > 0.1 ||
          (duration > 0 && duration - (effectiveSegments[0]?.end || duration) > 0.1));

      const res = await videoEngineService.compressVideo({
        asset,
        presetId: selectedPresetId,
        segments: hasCustomTrim ? effectiveSegments : null,
        replaceOriginal,
        onProgress: (prog) => setProgressInfo(prog),
      });

      if (res.alreadyOptimized) {
        Alert.alert(
          'Video ya optimizado',
          `Este video (${compressionService.formatBytes(res.oldSizeBytes)}) ya está en su peso óptimo para su resolución.`
        );
      } else if (replaceOriginal) {
        setCurrentFileSize(res.newSizeBytes);
        Alert.alert(
          '✨ ¡Video original comprimido!',
          `Resolución intacta: ${videoMeta?.resolutionText || '100% Original'}\n` +
            `Peso anterior: ${compressionService.formatBytes(res.oldSizeBytes)}\n` +
            `Peso nuevo: ${compressionService.formatBytes(res.newSizeBytes)}\n\n` +
            `Ahorraste: ${compressionService.formatBytes(res.savedBytes)}`
        );
        if (onSaved) onSaved();
      } else {
        Alert.alert(
          '✨ ¡Copia comprimida guardada!',
          `Se guardó una copia ligera al 100% de resolución.\n` +
            `Peso original: ${compressionService.formatBytes(res.oldSizeBytes)}\n` +
            `Peso nuevo: ${compressionService.formatBytes(res.newSizeBytes)}\n` +
            `Ahorro: ${compressionService.formatBytes(res.savedBytes)}`
        );
        if (onSaved) onSaved();
      }
    } catch (e) {
      Alert.alert('Aviso al comprimir video', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  if (!asset?.uri) return null;

  const dur = duration > 0 ? duration : 1;
  const playheadPct = clamp((time / dur) * 100, 0, 100);
  const startPct = clamp((trimStart / dur) * 100, 0, 100);
  const endPct = clamp(((trimEnd > 0 ? trimEnd : dur) / dur) * 100, 0, 100);
  const selectedSpanPct = Math.max(0, endPct - startPct);

  const totalResultDuration = effectiveSegments.reduce(
    (acc, seg) => acc + Math.max(0, seg.end - seg.start),
    0
  );
  const hasActiveTrim =
    effectiveSegments.length > 1 ||
    trimStart > 0.1 ||
    (duration > 0 && trimEnd > 0 && duration - trimEnd > 0.1);

  const durationRatio = dur > 0 ? clamp(totalResultDuration / dur, 0.05, 1) : 1;
  const activePreset = videoEngineService.getPresetById(selectedPresetId);
  const baseSizeForEstimate = applyTrimOnCompress
    ? Math.round(currentFileSize * durationRatio)
    : currentFileSize;
  const estimatedCompressedBytes = Math.round(baseSizeForEstimate * activePreset.estRatio);
  const estimatedSavedBytes = Math.max(0, currentFileSize - estimatedCompressedBytes);
  const sizeLevel = compressionService.getSizeLevel(currentFileSize);

  return (
    <View style={styles.fullscreenOverlay}>
      <StatusBar barStyle="light-content" backgroundColor="#06080d" />
      <SafeAreaView style={styles.container}>
        {/* 1. BARRA SUPERIOR LIMPIA Y PROFESIONAL */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} style={styles.iconCircleBtn} disabled={busy}>
            <Ionicons name="arrow-back" size={22} color="#ffffff" />
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.title} numberOfLines={1}>
              {asset.filename || 'Video'}
            </Text>
            <View style={styles.metaBadgesRow}>
              <View style={styles.resBadge}>
                <Text style={styles.resBadgeText}>
                  {videoMeta?.resolutionBadge || 'HD'}
                  {videoMeta?.displayWidth
                    ? ` • ${videoMeta.displayWidth}×${videoMeta.displayHeight}`
                    : ''}
                </Text>
              </View>
              {currentFileSize > 0 && (
                <View style={[styles.sizeBadge, { borderColor: sizeLevel.color }]}>
                  <View style={[styles.sizeDot, { backgroundColor: sizeLevel.color }]} />
                  <Text style={[styles.sizeBadgeText, { color: sizeLevel.color }]}>
                    {compressionService.formatBytes(currentFileSize)}
                  </Text>
                </View>
              )}
            </View>
          </View>

          <View style={styles.headerRightActions}>
            <TouchableOpacity
              style={styles.snapActionBtn}
              onPress={handleCaptureFrame}
              disabled={busy}
              activeOpacity={0.8}
            >
              <Ionicons name="camera-outline" size={17} color="#ffffff" />
              <Text style={styles.snapActionText}>Foto</Text>
            </TouchableOpacity>

            {onShare && (
              <TouchableOpacity
                style={styles.iconCircleBtn}
                onPress={onShare}
                disabled={busy}
                activeOpacity={0.75}
              >
                <Ionicons name="share-social-outline" size={19} color="#ffffff" />
              </TouchableOpacity>
            )}

            {onDelete && (
              <TouchableOpacity
                style={styles.iconCircleBtn}
                onPress={onDelete}
                disabled={busy}
                activeOpacity={0.75}
              >
                <Ionicons name="trash-outline" size={19} color="#f87171" />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* 2. VISOR DE VIDEO AMPLIO Y FLUIDO CON CAPA TÁCTIL SUPERIOR GARANTIZADA */}
        <View
          style={styles.videoViewport}
          onLayout={(e) => {
            viewportWidthRef.current = e.nativeEvent.layout.width || 360;
          }}
        >
          <VideoView
            player={player}
            style={styles.video}
            contentFit="contain"
            nativeControls={false}
            surfaceType="textureView"
          />

          {/* Capa táctil transparente sobre el TextureView para que Android nunca ignore el toque */}
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={handleVideoPress}
          />

          {/* Indicador de carga inicial */}
          {!isReady && duration <= 0 && (
            <View pointerEvents="none" style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color="#38bdf8" />
            </View>
          )}

          {/* Botón central de Play cuando está en pausa */}
          {!playing && (
            <View pointerEvents="none" style={styles.centerPlayOverlay}>
              <View style={styles.centerPlayCircle}>
                <Ionicons name="play" size={36} color="#ffffff" style={{ marginLeft: 4 }} />
              </View>
            </View>
          )}

          {/* Indicador de salto rápido (-10s / +10s) */}
          {seekFeedback && (
            <View pointerEvents="none" style={styles.seekFeedbackPill}>
              <Ionicons
                name={seekFeedback.startsWith('+') ? 'play-forward' : 'play-back'}
                size={18}
                color="#ffffff"
              />
              <Text style={styles.seekFeedbackText}>{seekFeedback}</Text>
            </View>
          )}

          {/* Banner flotante cuando se está probando el recorte */}
          {previewingCut && (
            <View pointerEvents="none" style={styles.previewBanner}>
              <Ionicons name="eye" size={14} color="#34d399" />
              <Text style={styles.previewBannerText}>
                Probando resultado del recorte ({formatTime(totalResultDuration, true)})
              </Text>
            </View>
          )}
        </View>

        {/* 3. BARRA INFERIOR PROFESIONAL CON 3 MODOS CLAROS (SIN SCROLL INNECESARIO) */}
        <View style={styles.bottomStudioDock}>
          {/* Selector principal de modo */}
          <View style={styles.modeSelectorBar}>
            <TouchableOpacity
              style={[
                styles.modeTabBtn,
                studioMode === 'play' && styles.modeTabBtnActivePlay,
              ]}
              onPress={() => {
                setPreviewingCut(false);
                setStudioMode('play');
              }}
              activeOpacity={0.85}
            >
              <Ionicons
                name={studioMode === 'play' ? 'play-circle' : 'play-circle-outline'}
                size={18}
                color={studioMode === 'play' ? '#ffffff' : '#94a3b8'}
              />
              <Text
                style={[
                  styles.modeTabText,
                  studioMode === 'play' && styles.modeTabTextActive,
                ]}
              >
                Reproducir
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.modeTabBtn,
                studioMode === 'trim' && styles.modeTabBtnActiveTrim,
              ]}
              onPress={() => setStudioMode('trim')}
              activeOpacity={0.85}
            >
              <Ionicons
                name="cut"
                size={17}
                color={studioMode === 'trim' ? '#ffffff' : '#94a3b8'}
              />
              <Text
                style={[
                  styles.modeTabText,
                  studioMode === 'trim' && styles.modeTabTextActive,
                ]}
              >
                Recortar
              </Text>
              {hasActiveTrim && <View style={styles.activeDotIndicator} />}
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.modeTabBtn,
                studioMode === 'compress' && styles.modeTabBtnActiveCompress,
              ]}
              onPress={() => setStudioMode('compress')}
              activeOpacity={0.85}
            >
              <Ionicons
                name="sparkles"
                size={16}
                color={studioMode === 'compress' ? '#ffffff' : '#94a3b8'}
              />
              <Text
                style={[
                  styles.modeTabText,
                  studioMode === 'compress' && styles.modeTabTextActive,
                ]}
              >
                Comprimir
              </Text>
            </TouchableOpacity>
          </View>

          {/* ================= MODO 1: REPRODUCTOR LIMPIO ================= */}
          {studioMode === 'play' && (
            <View style={styles.playModeContainer}>
              {/* Barra de progreso suave de lado a lado */}
              <View style={styles.scrubberRow}>
                <Text style={styles.scrubberTimeText}>{formatTime(time)}</Text>

                <View
                  style={styles.scrubberTrackHitArea}
                  onLayout={(e) => {
                    playScrubberWidthRef.current = e.nativeEvent.layout.width || 1;
                  }}
                  {...playScrubberPanResponder.panHandlers}
                >
                  <View pointerEvents="none" style={styles.scrubberTrackBg}>
                    <View
                      style={[styles.scrubberTrackFill, { width: `${playheadPct}%` }]}
                    />
                  </View>
                  <View
                    pointerEvents="none"
                    style={[styles.scrubberThumb, { left: `${playheadPct}%` }]}
                  />
                </View>

                <Text style={styles.scrubberTimeText}>{formatTime(duration)}</Text>
              </View>

              {/* Botonera principal de reproducción */}
              <View style={styles.playerMainControlsRow}>
                <TouchableOpacity
                  style={[styles.auxControlBtn, muted && styles.auxControlBtnActive]}
                  onPress={toggleMute}
                >
                  <Ionicons
                    name={muted ? 'volume-mute' : 'volume-high'}
                    size={19}
                    color={muted ? '#f87171' : '#e2e8f0'}
                  />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.skipControlBtn}
                  onPress={() => seekBy(-10)}
                >
                  <Ionicons name="play-back" size={18} color="#ffffff" />
                  <Text style={styles.skipControlLabel}>10s</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.frameControlBtn}
                  onPress={() => stepFrame(-1)}
                >
                  <Ionicons name="chevron-back" size={18} color="#cbd5e1" />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.bigPlayPauseBtn}
                  onPress={togglePlay}
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name={playing ? 'pause' : 'play'}
                    size={26}
                    color="#ffffff"
                    style={!playing ? { marginLeft: 3 } : undefined}
                  />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.frameControlBtn}
                  onPress={() => stepFrame(1)}
                >
                  <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.skipControlBtn}
                  onPress={() => seekBy(10)}
                >
                  <Ionicons name="play-forward" size={18} color="#ffffff" />
                  <Text style={styles.skipControlLabel}>10s</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.auxControlBtn, rate !== 1 && styles.auxControlBtnActive]}
                  onPress={cycleSpeed}
                >
                  <Text
                    style={[
                      styles.speedPillText,
                      rate !== 1 && { color: '#38bdf8' },
                    ]}
                  >
                    {rate}x
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.auxControlBtn, loopEnabled && styles.auxControlBtnActive]}
                  onPress={toggleLoop}
                >
                  <Ionicons
                    name="repeat"
                    size={18}
                    color={loopEnabled ? '#38bdf8' : '#94a3b8'}
                  />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ================= MODO 2: RECORTAR (ESTILO APP PRO SENCILLA) ================= */}
          {studioMode === 'trim' && (
            <View style={styles.trimModeContainer}>
              {/* 1. Selector simple de tipo de recorte en 1 fila */}
              <View style={styles.trimSubmodeRow}>
                <TouchableOpacity
                  style={[
                    styles.trimSubmodePill,
                    trimMode === 'keep' && styles.trimSubmodePillKeep,
                  ]}
                  onPress={() => setTrimMode('keep')}
                >
                  <Ionicons
                    name="cut-outline"
                    size={14}
                    color={trimMode === 'keep' ? '#fef3c7' : '#94a3b8'}
                  />
                  <Text
                    style={[
                      styles.trimSubmodeText,
                      trimMode === 'keep' && styles.trimSubmodeTextActive,
                    ]}
                  >
                    Dejar tramo
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.trimSubmodePill,
                    trimMode === 'cut_middle' && styles.trimSubmodePillDeleteCenter,
                  ]}
                  onPress={() => setTrimMode('cut_middle')}
                >
                  <Ionicons
                    name="trash-bin-outline"
                    size={14}
                    color={trimMode === 'cut_middle' ? '#fee2e2' : '#94a3b8'}
                  />
                  <Text
                    style={[
                      styles.trimSubmodeText,
                      trimMode === 'cut_middle' && styles.trimSubmodeTextActive,
                    ]}
                  >
                    Borrar centro
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.trimSubmodePill,
                    trimMode === 'multi' && styles.trimSubmodePillMulti,
                  ]}
                  onPress={() => setTrimMode('multi')}
                >
                  <Ionicons
                    name="layers-outline"
                    size={14}
                    color={trimMode === 'multi' ? '#d1fae5' : '#94a3b8'}
                  />
                  <Text
                    style={[
                      styles.trimSubmodeText,
                      trimMode === 'multi' && styles.trimSubmodeTextActive,
                    ]}
                  >
                    Unir varios
                  </Text>
                </TouchableOpacity>
              </View>

              {/* 2. Línea de tiempo interactiva unificada con manijas gruesas */}
              <View style={styles.timelineWrapper}>
                <View style={styles.timelineInfoHeader}>
                  <TouchableOpacity
                    onPress={() => {
                      setActiveHandle('start');
                      seekTo(trimStart);
                    }}
                    style={[
                      styles.timeTagChip,
                      activeHandle === 'start' && styles.timeTagChipActive,
                    ]}
                  >
                    <Text style={styles.timeTagLabel}>[ Inicio: </Text>
                    <Text style={styles.timeTagVal}>{formatTime(trimStart, true)}</Text>
                  </TouchableOpacity>

                  <View style={styles.resultDurationPill}>
                    <Text style={styles.resultDurationText}>
                      Quedará: {formatTime(totalResultDuration, true)}
                    </Text>
                  </View>

                  <TouchableOpacity
                    onPress={() => {
                      setActiveHandle('end');
                      seekTo(trimEnd || duration);
                    }}
                    style={[
                      styles.timeTagChip,
                      activeHandle === 'end' && styles.timeTagChipActive,
                    ]}
                  >
                    <Text style={styles.timeTagLabel}>Fin ]: </Text>
                    <Text style={styles.timeTagVal}>
                      {formatTime(trimEnd || duration, true)}
                    </Text>
                  </TouchableOpacity>
                </View>

                <View
                  style={styles.filmstripTrack}
                  onLayout={(e) => {
                    timelineWidthRef.current = e.nativeEvent.layout.width || 1;
                  }}
                  {...timelinePanResponder.panHandlers}
                >
                  {/* Fotogramas o bloques limpios de fondo */}
                  <View style={styles.filmstripRow} pointerEvents="none">
                    {filmstripThumbs.length > 0
                      ? filmstripThumbs.map((uri, idx) => (
                          <Image
                            key={idx}
                            source={{ uri }}
                            style={styles.filmstripThumb}
                            contentFit="cover"
                          />
                        ))
                      : Array.from({ length: THUMB_COUNT }).map((_, idx) => (
                          <View key={idx} style={styles.filmstripTickBlock}>
                            <View style={styles.filmstripTickLine} />
                          </View>
                        ))}
                  </View>

                  {/* Tramos guardados en modo "Unir varios" */}
                  {trimMode === 'multi' &&
                    savedClips.map((clip) => {
                      const l = clamp((clip.start / dur) * 100, 0, 100);
                      const w = clamp(((clip.end - clip.start) / dur) * 100, 1.5, 100);
                      return (
                        <View
                          key={clip.id}
                          pointerEvents="none"
                          style={[styles.savedClipHighlight, { left: `${l}%`, width: `${w}%` }]}
                        />
                      );
                    })}

                  {/* Máscaras según el modo de recorte */}
                  {trimMode !== 'cut_middle' ? (
                    <>
                      <View
                        pointerEvents="none"
                        style={[styles.dimMaskLeft, { width: `${startPct}%` }]}
                      />
                      <View
                        pointerEvents="none"
                        style={[
                          styles.dimMaskRight,
                          { width: `${Math.max(0, 100 - endPct)}%` },
                        ]}
                      />
                      <View
                        pointerEvents="none"
                        style={[
                          styles.selectionBoxKeep,
                          { left: `${startPct}%`, width: `${selectedSpanPct}%` },
                        ]}
                      />
                    </>
                  ) : (
                    <View
                      pointerEvents="none"
                      style={[
                        styles.selectionBoxDeleteCenter,
                        { left: `${startPct}%`, width: `${selectedSpanPct}%` },
                      ]}
                    >
                      <Ionicons name="close-circle" size={14} color="#fecaca" />
                      <Text style={styles.deleteCenterLabel}>SE BORRARÁ</Text>
                    </View>
                  )}

                  {/* Manija Izquierda [ */}
                  <View
                    pointerEvents="none"
                    style={[styles.handleHitBox, { left: `${startPct}%` }]}
                  >
                    <View
                      style={[
                        styles.handleBarVisual,
                        {
                          backgroundColor:
                            trimMode === 'cut_middle' ? '#ef4444' : '#f59e0b',
                        },
                      ]}
                    >
                      <View style={styles.handleGripInner} />
                    </View>
                  </View>

                  {/* Manija Derecha ] */}
                  <View
                    pointerEvents="none"
                    style={[styles.handleHitBox, { left: `${endPct}%` }]}
                  >
                    <View
                      style={[
                        styles.handleBarVisual,
                        {
                          backgroundColor:
                            trimMode === 'cut_middle' ? '#ef4444' : '#f59e0b',
                        },
                      ]}
                    >
                      <View style={styles.handleGripInner} />
                    </View>
                  </View>

                  {/* Aguja blanca del tiempo actual */}
                  <View
                    pointerEvents="none"
                    style={[styles.playheadNeedle, { left: `${playheadPct}%` }]}
                  >
                    <View style={styles.playheadTopKnob} />
                  </View>
                </View>
              </View>

              {/* 3. Barra rápida de fijación en 1 toque, Play/Pausa y ajuste fino */}
              <View style={styles.quickPrecisionRow}>
                <TouchableOpacity
                  style={styles.miniPlayToggleBtn}
                  onPress={togglePlay}
                >
                  <Ionicons name={playing ? 'pause' : 'play'} size={15} color="#ffffff" />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.setPointBtn}
                  onPress={() => setHandleToCurrentTime('start')}
                >
                  <Text style={styles.setPointBtnText}>[ Inicio aquí</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.microStepBtn}
                  onPress={() => nudgeHandle(-0.1)}
                >
                  <Text style={styles.microStepText}>-0.1s</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.microStepBtn}
                  onPress={() => nudgeHandle(0.1)}
                >
                  <Text style={styles.microStepText}>+0.1s</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.setPointBtn}
                  onPress={() => setHandleToCurrentTime('end')}
                >
                  <Text style={styles.setPointBtnText}>Fin aquí ]</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.previewTrimBtn,
                    previewingCut && styles.previewTrimBtnActive,
                  ]}
                  onPress={handlePreviewSelection}
                >
                  <Ionicons
                    name={previewingCut ? 'stop' : 'eye-outline'}
                    size={14}
                    color={previewingCut ? '#34d399' : '#38bdf8'}
                  />
                  <Text
                    style={[
                      styles.previewTrimBtnText,
                      previewingCut && { color: '#34d399' },
                    ]}
                  >
                    {previewingCut ? 'Parar' : 'Probar'}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* 4. Fila extra solo si eligió "Unir varios" */}
              {trimMode === 'multi' && (
                <View style={styles.multiClipsCompactRow}>
                  <TouchableOpacity
                    style={styles.addClipCompactBtn}
                    onPress={handleAddClipSegment}
                  >
                    <Ionicons name="add-circle" size={16} color="#10b981" />
                    <Text style={styles.addClipCompactText}>+ Añadir tramo</Text>
                  </TouchableOpacity>

                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.savedClipsScroll}
                  >
                    {savedClips.length === 0 ? (
                      <Text style={styles.multiEmptyHint}>
                        Marca un tramo y toca &quot;+ Añadir tramo&quot;
                      </Text>
                    ) : (
                      savedClips.map((clip, i) => (
                        <View key={clip.id} style={styles.savedClipChip}>
                          <TouchableOpacity
                            onPress={() => {
                              setTrimStart(clip.start);
                              setTrimEnd(clip.end);
                              seekTo(clip.start);
                            }}
                          >
                            <Text style={styles.savedClipChipText}>
                              #{i + 1}: {formatTime(clip.start)}→{formatTime(clip.end)}
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => handleRemoveSavedClip(clip.id)}>
                            <Ionicons name="close-circle" size={15} color="#f87171" />
                          </TouchableOpacity>
                        </View>
                      ))
                    )}
                  </ScrollView>
                </View>
              )}

              {/* 5. Botones principales de acción siempre visibles */}
              <View style={styles.bottomActionButtonsRow}>
                {hasActiveTrim && (
                  <TouchableOpacity
                    style={styles.resetIconBtn}
                    onPress={handleResetTrim}
                    disabled={busy}
                  >
                    <Ionicons name="refresh" size={18} color="#94a3b8" />
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={[styles.secondarySaveBtn, busy && { opacity: 0.5 }]}
                  onPress={() => handleExecuteTrim(false)}
                  disabled={busy}
                >
                  <Ionicons name="copy-outline" size={17} color="#ffffff" />
                  <Text style={styles.saveBtnText}>Guardar copia</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.primaryTrimSaveBtn, busy && { opacity: 0.5 }]}
                  onPress={() => handleExecuteTrim(true)}
                  disabled={busy}
                >
                  <Ionicons name="checkmark-circle" size={18} color="#ffffff" />
                  <Text style={styles.saveBtnText}>Reemplazar original</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ================= MODO 3: COMPRIMIR (100% RESOLUCIÓN) ================= */}
          {studioMode === 'compress' && (
            <View style={styles.compressModeContainer}>
              {/* 1. Tarjeta comparativa de ahorro en 1 sola línea clara */}
              <View style={styles.compressCompareBanner}>
                <View>
                  <Text style={styles.compareSmallLabel}>Peso actual</Text>
                  <Text style={styles.compareOldWeight}>
                    {compressionService.formatBytes(currentFileSize)}
                  </Text>
                </View>

                <Ionicons name="arrow-forward" size={18} color="#38bdf8" />

                <View>
                  <Text style={styles.compareSmallLabel}>Peso estimado</Text>
                  <Text style={styles.compareNewWeight}>
                    ~{compressionService.formatBytes(estimatedCompressedBytes)}
                  </Text>
                </View>

                <View style={styles.savingsBadgeBox}>
                  <Text style={styles.savingsBadgeMain}>
                    Ahorras ~{compressionService.formatBytes(estimatedSavedBytes)}
                  </Text>
                  <Text style={styles.savingsBadgeSub}>
                    100% Resolución ({videoMeta?.resolutionBadge || 'Intacta'})
                  </Text>
                </View>
              </View>

              {/* 2. Tres tarjetas horizontales compactas para elegir nivel en 1 toque */}
              <View style={styles.presetsHorizontalRow}>
                {VIDEO_QUALITY_PRESETS.map((preset) => {
                  const isSelected = selectedPresetId === preset.id;
                  return (
                    <TouchableOpacity
                      key={preset.id}
                      style={[
                        styles.presetCompactCard,
                        isSelected && {
                          borderColor: preset.color,
                          backgroundColor: 'rgba(56, 189, 248, 0.12)',
                        },
                      ]}
                      onPress={() => setSelectedPresetId(preset.id)}
                      activeOpacity={0.85}
                    >
                      <View style={styles.presetCardTop}>
                        <Ionicons
                          name={preset.icon}
                          size={15}
                          color={isSelected ? preset.color : '#94a3b8'}
                        />
                        <Text
                          style={[
                            styles.presetCompactDiscount,
                            { color: isSelected ? preset.color : '#cbd5e1' },
                          ]}
                        >
                          {preset.id === 'high'
                            ? '-40%'
                            : preset.id === 'balanced'
                            ? '-60%'
                            : '-72%'}
                        </Text>
                      </View>
                      <Text
                        style={[
                          styles.presetCompactTitle,
                          isSelected && { color: '#ffffff' },
                        ]}
                        numberOfLines={1}
                      >
                        {preset.label}
                      </Text>
                      <Text style={styles.presetCompactSub} numberOfLines={1}>
                        {preset.id === 'balanced' ? '⭐ Recomendado' : '100% Resolución'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* 3. Opción para aplicar también el recorte si el usuario movió las manijas */}
              {hasActiveTrim && (
                <TouchableOpacity
                  style={styles.combineTrimSwitchRow}
                  onPress={() => setApplyTrimOnCompress(!applyTrimOnCompress)}
                >
                  <Ionicons
                    name={applyTrimOnCompress ? 'checkbox' : 'square-outline'}
                    size={19}
                    color={applyTrimOnCompress ? '#38bdf8' : '#94a3b8'}
                  />
                  <Text style={styles.combineTrimSwitchText}>
                    Aplicar también el recorte marcado ({formatTime(totalResultDuration, true)})
                  </Text>
                </TouchableOpacity>
              )}

              {/* 4. Botones de acción de compresión */}
              <View style={styles.bottomActionButtonsRow}>
                <TouchableOpacity
                  style={[styles.secondarySaveBtn, busy && { opacity: 0.5 }]}
                  onPress={() => handleExecuteCompress(false)}
                  disabled={busy}
                >
                  <Ionicons name="copy-outline" size={17} color="#ffffff" />
                  <Text style={styles.saveBtnText}>Guardar copia</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.primaryCompressSaveBtn, busy && { opacity: 0.5 }]}
                  onPress={() => handleExecuteCompress(true)}
                  disabled={busy}
                >
                  <Ionicons name="sparkles" size={17} color="#ffffff" />
                  <Text style={styles.saveBtnText}>Comprimir original</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* MODAL DE PROGRESO EN VIVO */}
        {busy && (
          <View style={styles.busyOverlay}>
            <View style={styles.busyCard}>
              <ActivityIndicator size="large" color="#38bdf8" />
              <Text style={styles.busyTitle}>
                {progressInfo.stage || 'Procesando video...'}
              </Text>
              <View style={styles.busyBarBg}>
                <View
                  style={[
                    styles.busyBarFill,
                    {
                      width: `${Math.round(
                        clamp(progressInfo.percent || 0.08, 0.05, 1) * 100
                      )}%`,
                    },
                  ]}
                />
              </View>
              <Text style={styles.busyPctText}>
                {Math.round(clamp(progressInfo.percent || 0.08, 0.05, 1) * 100)}% • Manteniendo
                100% resolución original
              </Text>
            </View>
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fullscreenOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#06080d',
    zIndex: 9999,
    elevation: 9999,
  },
  container: {
    flex: 1,
    backgroundColor: '#06080d',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#0b0f19',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    gap: 8,
  },
  iconCircleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#172033',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
  },
  title: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
  },
  metaBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  resBadge: {
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
  },
  resBadgeText: {
    color: '#38bdf8',
    fontSize: 10,
    fontWeight: '700',
  },
  sizeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#111827',
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 5,
    borderWidth: 1,
  },
  sizeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  sizeBadgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  snapActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#172033',
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2d3d59',
  },
  snapActionText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },
  videoViewport: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  centerPlayOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  centerPlayCircle: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: 'rgba(15, 23, 42, 0.82)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  seekFeedbackPill: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(15, 23, 42, 0.88)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#38bdf8',
  },
  seekFeedbackText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  previewBanner: {
    position: 'absolute',
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(6, 78, 59, 0.92)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#10b981',
  },
  previewBannerText: {
    color: '#ecfdf5',
    fontSize: 11,
    fontWeight: '700',
  },
  bottomStudioDock: {
    backgroundColor: '#0b0f19',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 10,
  },
  modeSelectorBar: {
    flexDirection: 'row',
    backgroundColor: '#111827',
    borderRadius: 12,
    padding: 3,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  modeTabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 9,
  },
  modeTabBtnActivePlay: {
    backgroundColor: '#2563eb',
  },
  modeTabBtnActiveTrim: {
    backgroundColor: '#d97706',
  },
  modeTabBtnActiveCompress: {
    backgroundColor: '#0284c7',
  },
  modeTabText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  modeTabTextActive: {
    color: '#ffffff',
    fontWeight: '800',
  },
  activeDotIndicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#fde68a',
  },

  /* MODO REPRODUCIR */
  playModeContainer: {
    gap: 10,
    paddingVertical: 2,
  },
  scrubberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  scrubberTimeText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 38,
    textAlign: 'center',
  },
  scrubberTrackHitArea: {
    flex: 1,
    height: 30,
    justifyContent: 'center',
    position: 'relative',
  },
  scrubberTrackBg: {
    height: 5,
    borderRadius: 3,
    backgroundColor: '#1e293b',
    overflow: 'hidden',
  },
  scrubberTrackFill: {
    height: '100%',
    backgroundColor: '#3b82f6',
  },
  scrubberThumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    marginLeft: -8,
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: '#3b82f6',
    elevation: 4,
  },
  playerMainControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
    paddingVertical: 2,
  },
  auxControlBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#161f33',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#26334d',
  },
  auxControlBtnActive: {
    borderColor: '#38bdf8',
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
  },
  skipControlBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: '#161f33',
  },
  skipControlLabel: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '800',
  },
  frameControlBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#131b2e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigPlayPauseBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
  speedPillText: {
    color: '#e2e8f0',
    fontSize: 11.5,
    fontWeight: '800',
  },

  /* MODO RECORTAR */
  trimModeContainer: {
    gap: 9,
  },
  trimSubmodeRow: {
    flexDirection: 'row',
    gap: 6,
  },
  trimSubmodePill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 7,
    borderRadius: 9,
    backgroundColor: '#131b2e',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  trimSubmodePillKeep: {
    borderColor: '#f59e0b',
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
  },
  trimSubmodePillDeleteCenter: {
    borderColor: '#ef4444',
    backgroundColor: 'rgba(239, 68, 68, 0.18)',
  },
  trimSubmodePillMulti: {
    borderColor: '#10b981',
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
  },
  trimSubmodeText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  trimSubmodeTextActive: {
    color: '#ffffff',
    fontWeight: '800',
  },
  timelineWrapper: {
    gap: 6,
  },
  timelineInfoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  timeTagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#151d2e',
    borderWidth: 1,
    borderColor: '#26334d',
  },
  timeTagChipActive: {
    borderColor: '#f59e0b',
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
  },
  timeTagLabel: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '600',
  },
  timeTagVal: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  resultDurationPill: {
    paddingHorizontal: 9,
    paddingVertical: 2.5,
    borderRadius: 999,
    backgroundColor: '#172033',
  },
  resultDurationText: {
    color: '#fde68a',
    fontSize: 11,
    fontWeight: '800',
  },
  filmstripTrack: {
    height: 48,
    marginHorizontal: 8,
    borderRadius: 9,
    backgroundColor: '#151d2e',
    position: 'relative',
    justifyContent: 'center',
    overflow: 'visible',
  },
  filmstripRow: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    borderRadius: 9,
    overflow: 'hidden',
  },
  filmstripThumb: {
    flex: 1,
    height: '100%',
    opacity: 0.85,
  },
  filmstripTickBlock: {
    flex: 1,
    height: '100%',
    backgroundColor: '#172033',
    borderRightWidth: 1,
    borderRightColor: '#24324d',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filmstripTickLine: {
    width: 2,
    height: 14,
    borderRadius: 1,
    backgroundColor: '#334155',
  },
  savedClipHighlight: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(16, 185, 129, 0.30)',
    borderTopWidth: 2,
    borderBottomWidth: 2,
    borderColor: '#10b981',
  },
  dimMaskLeft: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(4, 7, 13, 0.72)',
    borderTopLeftRadius: 9,
    borderBottomLeftRadius: 9,
  },
  dimMaskRight: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(4, 7, 13, 0.72)',
    borderTopRightRadius: 9,
    borderBottomRightRadius: 9,
  },
  selectionBoxKeep: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderTopWidth: 2.5,
    borderBottomWidth: 2.5,
    borderColor: '#f59e0b',
  },
  selectionBoxDeleteCenter: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(220, 38, 38, 0.48)',
    borderTopWidth: 2.5,
    borderBottomWidth: 2.5,
    borderColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteCenterLabel: {
    color: '#fecaca',
    fontSize: 8.5,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  handleHitBox: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    width: 24,
    marginLeft: -12,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  handleBarVisual: {
    width: 14,
    height: '100%',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
  handleGripInner: {
    width: 3,
    height: 16,
    borderRadius: 1.5,
    backgroundColor: '#0f172a',
  },
  playheadNeedle: {
    position: 'absolute',
    top: -6,
    bottom: -6,
    width: 2.5,
    marginLeft: -1.25,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    zIndex: 25,
  },
  playheadTopKnob: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: '#ffffff',
    marginTop: -2,
  },
  quickPrecisionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  miniPlayToggleBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  setPointBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: 'rgba(245, 158, 11, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.45)',
  },
  setPointBtnText: {
    color: '#fde68a',
    fontSize: 10,
    fontWeight: '800',
  },
  microStepBtn: {
    paddingHorizontal: 7,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#161f33',
    borderWidth: 1,
    borderColor: '#26334d',
  },
  microStepText: {
    color: '#e2e8f0',
    fontSize: 10,
    fontWeight: '700',
  },
  previewTrimBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
  },
  previewTrimBtnActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    borderColor: '#10b981',
  },
  previewTrimBtnText: {
    color: '#38bdf8',
    fontSize: 10,
    fontWeight: '800',
  },
  multiClipsCompactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#111827',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  addClipCompactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#10b981',
  },
  addClipCompactText: {
    color: '#6ee7b7',
    fontSize: 10.5,
    fontWeight: '800',
  },
  savedClipsScroll: {
    alignItems: 'center',
    gap: 6,
  },
  multiEmptyHint: {
    color: '#64748b',
    fontSize: 10.5,
  },
  savedClipChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderWidth: 1,
    borderColor: '#10b981',
    paddingHorizontal: 8,
    paddingVertical: 3.5,
    borderRadius: 7,
  },
  savedClipChipText: {
    color: '#ecfdf5',
    fontSize: 10.5,
    fontWeight: '700',
  },

  /* MODO COMPRIMIR */
  compressModeContainer: {
    gap: 9,
  },
  compressCompareBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#121a2b',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.28)',
  },
  compareSmallLabel: {
    color: '#94a3b8',
    fontSize: 9.5,
    fontWeight: '600',
  },
  compareOldWeight: {
    color: '#f8fafc',
    fontSize: 12.5,
    fontWeight: '800',
  },
  compareNewWeight: {
    color: '#38bdf8',
    fontSize: 12.5,
    fontWeight: '900',
  },
  savingsBadgeBox: {
    alignItems: 'flex-end',
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.35)',
  },
  savingsBadgeMain: {
    color: '#34d399',
    fontSize: 11,
    fontWeight: '800',
  },
  savingsBadgeSub: {
    color: '#94a3b8',
    fontSize: 9,
    fontWeight: '700',
  },
  presetsHorizontalRow: {
    flexDirection: 'row',
    gap: 7,
  },
  presetCompactCard: {
    flex: 1,
    backgroundColor: '#121a2b',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#1e293b',
    gap: 2,
  },
  presetCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  presetCompactDiscount: {
    fontSize: 12,
    fontWeight: '900',
  },
  presetCompactTitle: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '800',
    marginTop: 2,
  },
  presetCompactSub: {
    color: '#64748b',
    fontSize: 9.5,
    fontWeight: '600',
  },
  combineTrimSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 2,
  },
  combineTrimSwitchText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '600',
  },

  /* BOTONES DE ACCIÓN FINALES */
  bottomActionButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  resetIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#161f33',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#26334d',
  },
  secondarySaveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#1b253b',
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  primaryTrimSaveBtn: {
    flex: 1.3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#d97706',
    paddingVertical: 11,
    borderRadius: 10,
  },
  primaryCompressSaveBtn: {
    flex: 1.3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0284c7',
    paddingVertical: 11,
    borderRadius: 10,
  },
  saveBtnText: {
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: '800',
  },

  /* OVERLAY DE PROCESAMIENTO */
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(6, 8, 13, 0.86)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    zIndex: 999,
  },
  busyCard: {
    width: '100%',
    maxWidth: 330,
    backgroundColor: '#111827',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1e293b',
    gap: 10,
  },
  busyTitle: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
  },
  busyBarBg: {
    width: '100%',
    height: 8,
    borderRadius: 4,
    backgroundColor: '#1e293b',
    overflow: 'hidden',
  },
  busyBarFill: {
    height: '100%',
    backgroundColor: '#38bdf8',
  },
  busyPctText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
});
