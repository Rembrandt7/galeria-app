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
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { compressionService } from '../services/compressionService';
import { videoEngineService, VIDEO_QUALITY_PRESETS } from '../services/videoEngineService';
import { theme } from '../constants/theme';

const FRAME = 1 / 30;
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];
const THUMB_COUNT = 8;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function formatTime(sec, showTenths = true) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (!showTenths) {
    return `${m}:${Math.floor(rem).toString().padStart(2, '0')}`;
  }
  const rest = rem.toFixed(1).padStart(4, '0');
  return `${m}:${rest}`;
}

export default function VideoPlayerScreen({ asset, onClose, onSaved }) {
  const videoSource = asset?.uri ? { uri: asset.uri } : null;

  const player = useVideoPlayer(videoSource, (p) => {
    p.timeUpdateEventInterval = 0.06;
    p.loop = false;
    p.play();
  });

  // Estado de reproducción y metadatos
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(asset?.duration || 0);
  const [playing, setPlaying] = useState(true);
  const [rate, setRate] = useState(1);
  const [videoMeta, setVideoMeta] = useState(null);
  const [currentFileSize, setCurrentFileSize] = useState(asset?.fileSize || 0);
  const [filmstripThumbs, setFilmstripThumbs] = useState([]);

  // Pestaña activa del estudio: 'trim' | 'compress' | 'controls'
  const [activeTab, setActiveTab] = useState('trim');

  // Modo de recorte de tramitos:
  // 'keep' = Conservar el tramo (o lista de tramos) seleccionados
  // 'cut_middle' = Eliminar el tramo intermedio marcado y unir lo anterior con lo posterior
  const [trimMode, setTrimMode] = useState('keep');
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [savedClips, setSavedClips] = useState([]); // tramos adicionales guardados en modo multi-tramo
  const [activeHandle, setActiveHandle] = useState('start'); // 'start' | 'end' para micro-ajuste
  const [previewingCut, setPreviewingCut] = useState(false);

  // Estado de compresión de video sin perder resolución
  const [selectedPresetId, setSelectedPresetId] = useState('balanced');
  const [applyTrimOnCompress, setApplyTrimOnCompress] = useState(false);

  // Estado de procesamiento
  const [busy, setBusy] = useState(false);
  const [progressInfo, setProgressInfo] = useState({ percent: 0, stage: '' });

  // Referencias para los gestos de la línea de tiempo (Filmstrip + Manijas)
  const timelineWidthRef = useRef(1);
  const durationRef = useRef(0);
  const trimStartRef = useRef(0);
  const trimEndRef = useRef(0);
  const dragInitialStartRef = useRef(0);
  const dragInitialEndRef = useRef(0);

  durationRef.current = duration;
  trimStartRef.current = trimStart;
  trimEndRef.current = trimEnd;

  // Inicializar metadatos reales del video
  useEffect(() => {
    let mounted = true;
    (async () => {
      const meta = await videoEngineService.getVideoMetadata(asset);
      if (mounted && meta) {
        setVideoMeta(meta);
        if (meta.sizeBytes > 0) setCurrentFileSize(meta.sizeBytes);
        if (meta.durationMs > 0 && !durationRef.current) {
          const dSec = meta.durationMs / 1000;
          setDuration(dSec);
          setTrimEnd(dSec);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [asset]);

  // Calcular los tramos efectivos que quedarán en el video final según el modo elegido
  const effectiveSegments = useMemo(() => {
    const dur = duration || 0;
    if (dur <= 0) return [];

    const s = clamp(trimStart, 0, dur);
    const e = clamp(trimEnd > 0 ? trimEnd : dur, 0, dur);

    if (trimMode === 'cut_middle') {
      // Eliminar el tramo [s, e] y conservar [0, s] + [e, dur]
      const parts = [];
      if (s > 0.15) {
        parts.push({ start: 0, end: s, label: 'Parte 1 (Antes del corte)' });
      }
      if (dur - e > 0.15) {
        parts.push({ start: e, end: dur, label: 'Parte 2 (Después del corte)' });
      }
      return parts;
    }

    // Modo 'keep': si el usuario agregó varios tramitos a la lista, incluirlos junto con el tramo actual
    if (savedClips.length > 0) {
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

  // Escuchar eventos del reproductor y manejar el Modo "Vista Previa de Recorte" (salta partes eliminadas en vivo)
  useEffect(() => {
    const subs = [
      player.addListener('timeUpdate', ({ currentTime }) => {
        setTime(currentTime);
        if (player.duration && player.duration > 0 && Math.abs(player.duration - durationRef.current) > 0.05) {
          setDuration(player.duration);
          if (trimEndRef.current <= 0) {
            setTrimEnd(player.duration);
          }
        }

        // Si el usuario activó "Probar recorte", saltar automáticamente cualquier parte fuera de los tramos activos
        if (previewingCutRef.current && effectiveSegmentsRef.current.length > 0) {
          const segs = effectiveSegmentsRef.current;
          const insideAny = segs.some((seg) => currentTime >= seg.start - 0.08 && currentTime <= seg.end + 0.05);
          if (!insideAny) {
            const nextSeg = segs.find((seg) => seg.start > currentTime + 0.02);
            if (nextSeg) {
              player.currentTime = nextSeg.start;
              setTime(nextSeg.start);
            } else {
              // Volver al inicio del primer tramo
              player.currentTime = segs[0].start;
              setTime(segs[0].start);
            }
          }
        }
      }),
      player.addListener('playingChange', ({ isPlaying }) => {
        setPlaying(isPlaying);
        if (!isPlaying) setPreviewingCut(false);
      }),
      player.addListener('sourceLoad', ({ duration: d }) => {
        if (d && d > 0) {
          setDuration(d);
          if (trimEndRef.current <= 0) {
            setTrimEnd(d);
          }
        }
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [player]);

  // Generar tira visual de fotogramas (Filmstrip) cuando conocemos la duración
  useEffect(() => {
    let cancelled = false;
    if (!duration || duration <= 0.2 || filmstripThumbs.length > 0) return;

    (async () => {
      try {
        const times = [];
        for (let i = 0; i < THUMB_COUNT; i++) {
          const t = ((i + 0.5) / THUMB_COUNT) * duration;
          times.push(Number(t.toFixed(2)));
        }
        const generated = await player.generateThumbnailsAsync(times);
        if (!cancelled && Array.isArray(generated) && generated.length > 0) {
          setFilmstripThumbs(generated);
        }
      } catch (e) {
        // continuar con filmstrip estilizado si el dispositivo no soporta miniaturas rápidas
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [duration, player, filmstripThumbs.length]);

  useEffect(() => {
    const onBackPress = () => {
      if (busy) return true;
      onClose();
      return true;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, [onClose, busy]);

  const seekTo = (t) => {
    const max = durationRef.current || t || 1;
    const target = clamp(t, 0, max);
    player.currentTime = target;
    setTime(target);
  };

  // PanResponder 1: Pista de reproducción general (Playhead scrubbing)
  const trackPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        setPreviewingCut(false);
        const ratio = clamp(e.nativeEvent.locationX / (timelineWidthRef.current || 1), 0, 1);
        seekTo(ratio * durationRef.current);
      },
      onPanResponderMove: (e) => {
        const ratio = clamp(e.nativeEvent.locationX / (timelineWidthRef.current || 1), 0, 1);
        seekTo(ratio * durationRef.current);
      },
    })
  ).current;

  // PanResponder 2: Manija Izquierda [ (Inicio del tramo)
  const leftHandlePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        player.pause();
        setPreviewingCut(false);
        setActiveHandle('start');
        dragInitialStartRef.current = trimStartRef.current;
      },
      onPanResponderMove: (_, gestureState) => {
        const dur = durationRef.current || 1;
        const deltaSec = (gestureState.dx / (timelineWidthRef.current || 1)) * dur;
        const maxStart = Math.max(0, (trimEndRef.current || dur) - 0.25);
        const nextStart = clamp(dragInitialStartRef.current + deltaSec, 0, maxStart);
        setTrimStart(nextStart);
        seekTo(nextStart);
      },
    })
  ).current;

  // PanResponder 3: Manija Derecha ] (Fin del tramo)
  const rightHandlePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        player.pause();
        setPreviewingCut(false);
        setActiveHandle('end');
        dragInitialEndRef.current = trimEndRef.current || durationRef.current;
      },
      onPanResponderMove: (_, gestureState) => {
        const dur = durationRef.current || 1;
        const deltaSec = (gestureState.dx / (timelineWidthRef.current || 1)) * dur;
        const minEnd = Math.min(dur, (trimStartRef.current || 0) + 0.25);
        const nextEnd = clamp(dragInitialEndRef.current + deltaSec, minEnd, dur);
        setTrimEnd(nextEnd);
        seekTo(nextEnd);
      },
    })
  ).current;

  const togglePlay = () => {
    setPreviewingCut(false);
    if (playing) {
      player.pause();
    } else {
      if (duration && time >= duration - 0.08) seekTo(0);
      player.play();
    }
  };

  // Reproducir únicamente los tramos que se van a conservar (saltando cortes automáticamente)
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

  const seekBy = (delta) => {
    setPreviewingCut(false);
    seekTo(player.currentTime + delta);
  };

  const stepFrame = (dir) => {
    setPreviewingCut(false);
    player.pause();
    seekTo(player.currentTime + dir * FRAME);
  };

  const changeSpeed = (r) => {
    player.playbackRate = r;
    setRate(r);
  };

  // Ajustar con precisión quirúrgica (±0.1s o ±0.5s) el inicio o el final del tramo
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

  const setHandleToCurrentTime = (which) => {
    const t = player.currentTime;
    const dur = duration || 1;
    setActiveHandle(which);
    if (which === 'start') {
      setTrimStart(clamp(t, 0, Math.max(0, (trimEnd || dur) - 0.2)));
    } else {
      setTrimEnd(clamp(t, Math.min(dur, trimStart + 0.2), dur));
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

  // Capturar fotograma actual como foto JPEG
  const handleCaptureFrame = async () => {
    player.pause();
    setBusy(true);
    setProgressInfo({ percent: 0.5, stage: 'Extrayendo fotograma en alta definición...' });
    try {
      const thumbs = await player.generateThumbnailsAsync([player.currentTime]);
      if (!thumbs || !thumbs[0]) {
        throw new Error('No se pudo extraer el cuadro actual.');
      }
      const context = ImageManipulator.manipulate(thumbs[0]);
      const rendered = await context.renderAsync();
      const saved = await rendered.saveAsync({
        format: SaveFormat.JPEG,
        compress: 0.95,
      });
      await MediaLibrary.saveToLibraryAsync(saved.uri);
      Alert.alert(
        '📸 Fotograma guardado',
        `Se guardó el cuadro (${formatTime(player.currentTime)}) como foto en tu galería.`
      );
      if (onSaved) onSaved();
    } catch (e) {
      Alert.alert('Error al capturar cuadro', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  // Ejecutar recorte de tramos (1 tramo, múltiples tramos unidos, o corte intermedio)
  const handleExecuteTrim = async (replaceOriginal = false) => {
    if (effectiveSegments.length === 0) {
      Alert.alert('Recorte', 'Selecciona al menos un tramo válido.');
      return;
    }

    const totalFinalSec = effectiveSegments.reduce((acc, s) => acc + Math.max(0, s.end - s.start), 0);
    if (
      effectiveSegments.length === 1 &&
      effectiveSegments[0].start <= 0.05 &&
      Math.abs(effectiveSegments[0].end - duration) <= 0.1
    ) {
      Alert.alert(
        'Mueve las manijas de recorte',
        'Arrastra las manijas [ Inicio o Fin ] en la tira de fotogramas (o usa los botones ±0.1s) para elegir el tramo que deseas recortar.'
      );
      return;
    }

    player.pause();
    setPreviewingCut(false);
    setBusy(true);
    setProgressInfo({ percent: 0.1, stage: 'Preparando recorte sin pérdida de resolución...' });

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
          '¡Video recortado en su sitio!',
          `El video original fue actualizado con ${effectiveSegments.length} tramo(s) (${formatTime(totalFinalSec)} en total) conservando el 100% de su resolución.\n\nNuevo tamaño: ${compressionService.formatBytes(res.newSizeBytes)}.`
        );
        if (onSaved) onSaved();
        onClose();
      } else {
        Alert.alert(
          '¡Copia recortada guardada!',
          `Se guardó el nuevo video (${formatTime(totalFinalSec)}) en tu galería con el 100% de la resolución original (${compressionService.formatBytes(res.newSizeBytes)}).`
        );
        if (onSaved) onSaved();
      }
    } catch (e) {
      Alert.alert('No se pudo recortar el video', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  // Ejecutar compresión por hardware a 100% resolución original
  const handleExecuteCompress = async (replaceOriginal = true) => {
    player.pause();
    setPreviewingCut(false);
    setBusy(true);
    setProgressInfo({
      percent: 0.05,
      stage: 'Iniciando compresión por hardware (100% resolución original)...',
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
          `Este video (${compressionService.formatBytes(res.oldSizeBytes)}) ya tiene un bitrate muy eficiente para su resolución y no requiere mayor compresión.`
        );
      } else if (replaceOriginal) {
        setCurrentFileSize(res.newSizeBytes);
        Alert.alert(
          '✨ ¡Video comprimido sin perder resolución!',
          `Resolución intacta: ${videoMeta?.resolutionText || '100% Original'}\n` +
            `Peso anterior: ${compressionService.formatBytes(res.oldSizeBytes)}\n` +
            `Peso nuevo: ${compressionService.formatBytes(res.newSizeBytes)}\n\n` +
            `Espacio ahorrado en el archivo original: ${compressionService.formatBytes(res.savedBytes)}`
        );
        if (onSaved) onSaved();
      } else {
        Alert.alert(
          '✨ ¡Copia comprimida guardada!',
          `Se creó una copia comprimida al 100% de resolución.\n` +
            `Peso original: ${compressionService.formatBytes(res.oldSizeBytes)}\n` +
            `Peso copia comprimida: ${compressionService.formatBytes(res.newSizeBytes)}\n` +
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

  const dur = duration || 1;
  const playheadPct = clamp((time / dur) * 100, 0, 100);
  const startPct = clamp((trimStart / dur) * 100, 0, 100);
  const endPct = clamp(((trimEnd > 0 ? trimEnd : dur) / dur) * 100, 0, 100);
  const selectedSpanPct = Math.max(0, endPct - startPct);

  const totalResultDuration = effectiveSegments.reduce(
    (acc, seg) => acc + Math.max(0, seg.end - seg.start),
    0
  );
  const durationRatio = dur > 0 ? clamp(totalResultDuration / dur, 0.05, 1) : 1;

  const activePreset = videoEngineService.getPresetById(selectedPresetId);
  const baseSizeForEstimate =
    applyTrimOnCompress ? Math.round(currentFileSize * durationRatio) : currentFileSize;
  const estimatedCompressedBytes = Math.round(baseSizeForEstimate * activePreset.estRatio);
  const estimatedSavedBytes = Math.max(0, currentFileSize - estimatedCompressedBytes);
  const sizeLevel = compressionService.getSizeLevel(currentFileSize);

  return (
    <View style={styles.fullscreenOverlay}>
      <StatusBar barStyle="light-content" backgroundColor="#07090e" />
      <SafeAreaView style={styles.container}>
        {/* 1. CABECERA DE ESTUDIO CON METADATOS EN VIVO */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} disabled={busy}>
            <Ionicons name="chevron-back" size={24} color="#fff" />
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.title} numberOfLines={1}>
              {asset.filename || 'Estudio de Video'}
            </Text>
            <View style={styles.metaBadgesRow}>
              <View style={styles.resBadge}>
                <Ionicons name="tv-outline" size={11} color="#38bdf8" />
                <Text style={styles.resBadgeText}>
                  {videoMeta?.resolutionBadge || '100% Res'}
                  {videoMeta?.displayWidth ? ` (${videoMeta.displayWidth}×${videoMeta.displayHeight})` : ''}
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

          <TouchableOpacity
            style={styles.quickSnapBtn}
            onPress={handleCaptureFrame}
            disabled={busy}
            activeOpacity={0.8}
          >
            <Ionicons name="camera-outline" size={18} color="#fff" />
            <Text style={styles.quickSnapText}>Foto</Text>
          </TouchableOpacity>
        </View>

        {/* 2. VISOR DE VIDEO AMPLIO */}
        <TouchableOpacity style={styles.videoArea} activeOpacity={1} onPress={togglePlay}>
          <VideoView
            player={player}
            style={styles.video}
            contentFit="contain"
            nativeControls={false}
            surfaceType="textureView"
          />
          {!playing && (
            <View pointerEvents="none" style={styles.centerPlayIconOverlay}>
              <View style={styles.centerPlayCircle}>
                <Ionicons name="play" size={34} color="#ffffff" style={{ marginLeft: 3 }} />
              </View>
            </View>
          )}
          {previewingCut && (
            <View style={styles.previewModeBanner}>
              <Ionicons name="eye" size={14} color="#10b981" />
              <Text style={styles.previewModeText}>
                Vista previa en vivo de tu recorte (saltando partes descartadas)
              </Text>
            </View>
          )}
        </TouchableOpacity>

        {/* 3. BARRA RÁPIDA DE TRANSPORTE + CRONÓMETRO */}
        <View style={styles.transportBar}>
          <View style={styles.timeReadoutBox}>
            <Text style={styles.currentTimeText}>{formatTime(time)}</Text>
            <Text style={styles.totalTimeText}> / {formatTime(duration)}</Text>
          </View>

          <View style={styles.transportIconsRow}>
            <TouchableOpacity style={styles.transportBtn} onPress={() => seekBy(-5)}>
              <Ionicons name="play-back" size={17} color="#cbd5e1" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.transportBtn} onPress={() => stepFrame(-1)}>
              <Ionicons name="chevron-back" size={18} color="#cbd5e1" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.mainPlayPill} onPress={togglePlay}>
              <Ionicons name={playing ? 'pause' : 'play'} size={20} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.transportBtn} onPress={() => stepFrame(1)}>
              <Ionicons name="chevron-forward" size={18} color="#cbd5e1" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.transportBtn} onPress={() => seekBy(5)}>
              <Ionicons name="play-forward" size={17} color="#cbd5e1" />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.previewLoopBtn, previewingCut && styles.previewLoopBtnActive]}
            onPress={handlePreviewSelection}
            activeOpacity={0.8}
          >
            <Ionicons
              name={previewingCut ? 'stop-circle' : 'play-circle-outline'}
              size={16}
              color={previewingCut ? '#10b981' : '#38bdf8'}
            />
            <Text
              style={[
                styles.previewLoopText,
                previewingCut && { color: '#10b981', fontWeight: '800' },
              ]}
            >
              {previewingCut ? 'Probando' : 'Probar corte'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* 4. LÍNEA DE TIEMPO INTERACTIVA CON TIRA DE FOTOGRAMAS (FILMSTRIP) Y MANIJAS DE AGARRE */}
        <View style={styles.timelineSection}>
          <View
            style={styles.filmstripContainer}
            onLayout={(e) => {
              timelineWidthRef.current = e.nativeEvent.layout.width || 1;
            }}
          >
            {/* Fondo de fotogramas reales del video */}
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
                    <View key={idx} style={styles.filmstripPlaceholder} />
                  ))}
            </View>

            {/* Tramos adicionales guardados en modo multi-tramo */}
            {trimMode === 'keep' &&
              savedClips.map((clip) => {
                const l = clamp((clip.start / dur) * 100, 0, 100);
                const w = clamp(((clip.end - clip.start) / dur) * 100, 1, 100);
                return (
                  <View
                    key={clip.id}
                    pointerEvents="none"
                    style={[styles.savedClipOverlay, { left: `${l}%`, width: `${w}%` }]}
                  />
                );
              })}

            {/* Sombras de descarte y recuadro del tramo activo según el modo */}
            {trimMode === 'keep' ? (
              <>
                <View
                  pointerEvents="none"
                  style={[styles.dimMaskLeft, { width: `${startPct}%` }]}
                />
                <View
                  pointerEvents="none"
                  style={[styles.dimMaskRight, { width: `${Math.max(0, 100 - endPct)}%` }]}
                />
                <View
                  pointerEvents="none"
                  style={[
                    styles.activeSelectionWindow,
                    {
                      left: `${startPct}%`,
                      width: `${selectedSpanPct}%`,
                      borderColor: '#f59e0b',
                    },
                  ]}
                />
              </>
            ) : (
              /* En modo "Quitar tramo intermedio", la parte central seleccionada se marca en rojo con ícono de tijera */
              <View
                pointerEvents="none"
                style={[
                  styles.cutOutMiddleWindow,
                  {
                    left: `${startPct}%`,
                    width: `${selectedSpanPct}%`,
                  },
                ]}
              >
                <Ionicons name="cut" size={14} color="#fecaca" />
                <Text style={styles.cutOutLabel}>SE ELIMINARÁ</Text>
              </View>
            )}

            {/* Zona táctil central para mover el Playhead */}
            <View style={styles.scrubHitArea} {...trackPanResponder.panHandlers} />

            {/* Manija Izquierda [ (Inicio) */}
            <View
              style={[
                styles.trimHandleWrap,
                styles.trimHandleLeft,
                { left: `${startPct}%` },
                activeHandle === 'start' && styles.trimHandleFocused,
              ]}
              {...leftHandlePanResponder.panHandlers}
            >
              <View
                style={[
                  styles.trimHandlePill,
                  { backgroundColor: trimMode === 'cut_middle' ? '#ef4444' : '#f59e0b' },
                ]}
              >
                <View style={styles.handleGripBar} />
              </View>
            </View>

            {/* Manija Derecha ] (Fin) */}
            <View
              style={[
                styles.trimHandleWrap,
                styles.trimHandleRight,
                { left: `${endPct}%` },
                activeHandle === 'end' && styles.trimHandleFocused,
              ]}
              {...rightHandlePanResponder.panHandlers}
            >
              <View
                style={[
                  styles.trimHandlePill,
                  { backgroundColor: trimMode === 'cut_middle' ? '#ef4444' : '#f59e0b' },
                ]}
              >
                <View style={styles.handleGripBar} />
              </View>
            </View>

            {/* Aguja blanca del Playhead */}
            <View
              pointerEvents="none"
              style={[styles.playheadLine, { left: `${playheadPct}%` }]}
            >
              <View style={styles.playheadCap} />
            </View>
          </View>

          {/* Indicadores rápidos debajo de la tira de fotogramas */}
          <View style={styles.timelineLegendRow}>
            <TouchableOpacity
              onPress={() => {
                setActiveHandle('start');
                seekTo(trimStart);
              }}
              style={[
                styles.handleTimeBadge,
                activeHandle === 'start' && styles.handleTimeBadgeActive,
              ]}
            >
              <Text style={styles.handleTimeLabel}>[ Inicio: </Text>
              <Text style={styles.handleTimeValue}>{formatTime(trimStart)}</Text>
            </TouchableOpacity>

            <Text style={styles.finalDurationSummary}>
              Resultado: {formatTime(totalResultDuration)} ({effectiveSegments.length}{' '}
              {effectiveSegments.length === 1 ? 'tramo' : 'tramos'})
            </Text>

            <TouchableOpacity
              onPress={() => {
                setActiveHandle('end');
                seekTo(trimEnd || duration);
              }}
              style={[
                styles.handleTimeBadge,
                activeHandle === 'end' && styles.handleTimeBadgeActive,
              ]}
            >
              <Text style={styles.handleTimeLabel}>Fin ]: </Text>
              <Text style={styles.handleTimeValue}>{formatTime(trimEnd || duration)}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 5. PESTAÑAS DEL ESTUDIO DE VIDEO */}
        <View style={styles.studioTabsBar}>
          <TouchableOpacity
            style={[styles.studioTab, activeTab === 'trim' && styles.studioTabActive]}
            onPress={() => setActiveTab('trim')}
          >
            <Ionicons
              name="cut-outline"
              size={16}
              color={activeTab === 'trim' ? '#f59e0b' : theme.colors.textMuted}
            />
            <Text style={[styles.studioTabText, activeTab === 'trim' && styles.studioTabTextActive]}>
              Recortar Tramitos
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.studioTab, activeTab === 'compress' && styles.studioTabActive]}
            onPress={() => setActiveTab('compress')}
          >
            <Ionicons
              name="sparkles"
              size={16}
              color={activeTab === 'compress' ? '#38bdf8' : theme.colors.textMuted}
            />
            <Text
              style={[
                styles.studioTabText,
                activeTab === 'compress' && { color: '#38bdf8', fontWeight: '700' },
              ]}
            >
              Comprimir (100% Res)
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.studioTab, activeTab === 'controls' && styles.studioTabActive]}
            onPress={() => setActiveTab('controls')}
          >
            <Ionicons
              name="speedometer-outline"
              size={16}
              color={activeTab === 'controls' ? '#10b981' : theme.colors.textMuted}
            />
            <Text
              style={[
                styles.studioTabText,
                activeTab === 'controls' && { color: '#10b981', fontWeight: '700' },
              ]}
            >
              Velocidad
            </Text>
          </TouchableOpacity>
        </View>

        {/* 6. PANEL DE HERRAMIENTAS SEGÚN PESTAÑA ACTIVA */}
        <ScrollView style={styles.panel} contentContainerStyle={styles.panelContent}>
          {activeTab === 'trim' && (
            <View style={styles.tabBody}>
              {/* Selector orgánico: ¿Conservar tramos o quitar un tramito de en medio? */}
              <View style={styles.modeSwitchRow}>
                <TouchableOpacity
                  style={[styles.modeCard, trimMode === 'keep' && styles.modeCardKeepActive]}
                  onPress={() => setTrimMode('keep')}
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name="checkmark-circle"
                    size={18}
                    color={trimMode === 'keep' ? '#f59e0b' : theme.colors.textMuted}
                  />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.modeCardTitle,
                        trimMode === 'keep' && { color: '#ffffff' },
                      ]}
                    >
                      Conservar Tramo(s)
                    </Text>
                    <Text style={styles.modeCardSub}>
                      Quédate con la zona marcada o une varios tramitos
                    </Text>
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.modeCard,
                    trimMode === 'cut_middle' && styles.modeCardCutMiddleActive,
                  ]}
                  onPress={() => setTrimMode('cut_middle')}
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name="remove-circle"
                    size={18}
                    color={trimMode === 'cut_middle' ? '#ef4444' : theme.colors.textMuted}
                  />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.modeCardTitle,
                        trimMode === 'cut_middle' && { color: '#ffffff' },
                      ]}
                    >
                      Quitar Tramo Intermedio
                    </Text>
                    <Text style={styles.modeCardSub}>
                      Borra la parte marcada y une el resto automáticamente
                    </Text>
                  </View>
                </TouchableOpacity>
              </View>

              {/* Micro-ajuste quirúrgico para no batallar con el dedo */}
              <View style={styles.precisionBox}>
                <View style={styles.precisionHeader}>
                  <Text style={styles.precisionTitle}>
                    Ajuste de precisión ({activeHandle === 'start' ? 'Manija [ Inicio' : 'Manija Fin ]'})
                  </Text>
                  <View style={styles.handleSwitchPills}>
                    <TouchableOpacity
                      style={[
                        styles.miniHandleSwitch,
                        activeHandle === 'start' && styles.miniHandleSwitchActive,
                      ]}
                      onPress={() => setActiveHandle('start')}
                    >
                      <Text style={styles.miniHandleSwitchText}>[ Inicio</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.miniHandleSwitch,
                        activeHandle === 'end' && styles.miniHandleSwitchActive,
                      ]}
                      onPress={() => setActiveHandle('end')}
                    >
                      <Text style={styles.miniHandleSwitchText}>Fin ]</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={styles.nudgeButtonsRow}>
                  <TouchableOpacity style={styles.nudgeBtn} onPress={() => nudgeHandle(-0.5)}>
                    <Text style={styles.nudgeBtnText}>-0.5s</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.nudgeBtn} onPress={() => nudgeHandle(-0.1)}>
                    <Text style={styles.nudgeBtnText}>-0.1s</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.markHereBtn}
                    onPress={() => setHandleToCurrentTime(activeHandle)}
                  >
                    <Ionicons name="locate" size={14} color="#f59e0b" />
                    <Text style={styles.markHereText}>
                      Fijar {activeHandle === 'start' ? 'Inicio' : 'Fin'} en {formatTime(time)}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.nudgeBtn} onPress={() => nudgeHandle(0.1)}>
                    <Text style={styles.nudgeBtnText}>+0.1s</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.nudgeBtn} onPress={() => nudgeHandle(0.5)}>
                    <Text style={styles.nudgeBtnText}>+0.5s</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Lista de multi-tramos (permite agregar varios "tramitos" del mismo video y unirlos) */}
              {trimMode === 'keep' && (
                <View style={styles.multiClipsBox}>
                  <View style={styles.multiClipsHeader}>
                    <Text style={styles.multiClipsTitle}>
                      Tramitos a unir ({savedClips.length > 0 ? savedClips.length : 1})
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TouchableOpacity
                        style={styles.addClipBtn}
                        onPress={handleAddClipSegment}
                        activeOpacity={0.8}
                      >
                        <Ionicons name="add-circle" size={15} color="#10b981" />
                        <Text style={styles.addClipBtnText}>
                          + Añadir tramo ({formatTime(trimStart)} - {formatTime(trimEnd || duration)})
                        </Text>
                      </TouchableOpacity>
                      {(savedClips.length > 0 || trimStart > 0 || (trimEnd > 0 && trimEnd < duration)) && (
                        <TouchableOpacity style={styles.resetClipsBtn} onPress={handleResetTrim}>
                          <Ionicons name="refresh" size={14} color={theme.colors.textSecondary} />
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>

                  {savedClips.length > 0 ? (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.savedClipsScroll}
                    >
                      {savedClips.map((clip, i) => (
                        <View key={clip.id} style={styles.savedClipChip}>
                          <TouchableOpacity
                            onPress={() => {
                              setTrimStart(clip.start);
                              setTrimEnd(clip.end);
                              seekTo(clip.start);
                            }}
                          >
                            <Text style={styles.savedClipChipText}>
                              #{i + 1}: {formatTime(clip.start)} → {formatTime(clip.end)}
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => handleRemoveSavedClip(clip.id)}>
                            <Ionicons name="close-circle" size={16} color="#f87171" />
                          </TouchableOpacity>
                        </View>
                      ))}
                    </ScrollView>
                  ) : (
                    <Text style={styles.multiClipsHint}>
                      Tip: Si quieres sacar varios pedacitos de este video y unirlos en uno solo, marca cada tramo y toca &quot;+ Añadir tramo&quot;.
                    </Text>
                  )}
                </View>
              )}

              {/* Botones de Acción de Recorte */}
              <View style={styles.actionButtonsRow}>
                <TouchableOpacity
                  style={[styles.secondaryActionBtn, busy && { opacity: 0.5 }]}
                  onPress={() => handleExecuteTrim(false)}
                  disabled={busy}
                >
                  <Ionicons name="copy-outline" size={18} color="#fff" />
                  <Text style={styles.actionBtnText}>Guardar copia</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.primaryTrimBtn, busy && { opacity: 0.5 }]}
                  onPress={() => handleExecuteTrim(true)}
                  disabled={busy}
                >
                  <Ionicons name="cut" size={18} color="#fff" />
                  <Text style={styles.actionBtnText}>Reemplazar original</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {activeTab === 'compress' && (
            <View style={styles.tabBody}>
              {/* Tarjeta comparativa de peso y garantía de 100% resolución */}
              <View style={styles.compressSummaryCard}>
                <View style={styles.compressSummaryCol}>
                  <Text style={styles.compressSummaryLabel}>Peso Actual</Text>
                  <Text style={styles.compressSummaryOldVal}>
                    {compressionService.formatBytes(currentFileSize)}
                  </Text>
                </View>

                <Ionicons name="arrow-forward" size={20} color="#38bdf8" />

                <View style={styles.compressSummaryCol}>
                  <Text style={styles.compressSummaryLabel}>Peso Estimado</Text>
                  <Text style={styles.compressSummaryNewVal}>
                    ~{compressionService.formatBytes(estimatedCompressedBytes)}
                  </Text>
                </View>

                <View style={styles.compressSavingsPill}>
                  <Text style={styles.compressSavingsText}>
                    Ahorras ~{compressionService.formatBytes(estimatedSavedBytes)}
                  </Text>
                  <Text style={styles.compressResGuarantee}>
                    100% Resolución ({videoMeta?.resolutionText || 'Intacta'})
                  </Text>
                </View>
              </View>

              {/* Selector de nivel de compresión sin perder resolución */}
              <Text style={styles.sectionLabel}>
                Nivel de optimización de bitrate (mantiene 100% resolución):
              </Text>
              <View style={styles.presetsColumn}>
                {VIDEO_QUALITY_PRESETS.map((preset) => {
                  const selected = selectedPresetId === preset.id;
                  return (
                    <TouchableOpacity
                      key={preset.id}
                      style={[
                        styles.presetOptionCard,
                        selected && {
                          borderColor: preset.color,
                          backgroundColor: 'rgba(56, 189, 248, 0.10)',
                        },
                      ]}
                      onPress={() => setSelectedPresetId(preset.id)}
                      activeOpacity={0.85}
                    >
                      <Ionicons
                        name={selected ? 'radio-button-on' : 'radio-button-off'}
                        size={20}
                        color={selected ? preset.color : theme.colors.textMuted}
                      />
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <Text style={styles.presetTitle}>{preset.label}</Text>
                          <View
                            style={[
                              styles.presetBadge,
                              { backgroundColor: `${preset.color}22`, borderColor: preset.color },
                            ]}
                          >
                            <Text style={[styles.presetBadgeText, { color: preset.color }]}>
                              {preset.badge}
                            </Text>
                          </View>
                        </View>
                        <Text style={styles.presetDesc}>{preset.desc}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Opción de aplicar también el recorte de tramos durante la compresión */}
              <TouchableOpacity
                style={styles.combineTrimCheckRow}
                onPress={() => setApplyTrimOnCompress(!applyTrimOnCompress)}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={applyTrimOnCompress ? 'checkbox' : 'square-outline'}
                  size={20}
                  color={applyTrimOnCompress ? '#38bdf8' : theme.colors.textSecondary}
                />
                <Text style={styles.combineTrimCheckText}>
                  Aplicar también el recorte de tramos marcado ({formatTime(totalResultDuration)})
                </Text>
              </TouchableOpacity>

              {/* Botones de Acción de Compresión */}
              <View style={styles.actionButtonsRow}>
                <TouchableOpacity
                  style={[styles.secondaryActionBtn, busy && { opacity: 0.5 }]}
                  onPress={() => handleExecuteCompress(false)}
                  disabled={busy}
                >
                  <Ionicons name="copy-outline" size={18} color="#fff" />
                  <Text style={styles.actionBtnText}>Guardar copia</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.primaryCompressBtn, busy && { opacity: 0.5 }]}
                  onPress={() => handleExecuteCompress(true)}
                  disabled={busy}
                >
                  <Ionicons name="sparkles" size={18} color="#fff" />
                  <Text style={styles.actionBtnText}>Comprimir original</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {activeTab === 'controls' && (
            <View style={styles.tabBody}>
              <Text style={styles.sectionLabel}>Velocidad de reproducción (Cámara lenta / rápida)</Text>
              <View style={styles.speedRow}>
                {SPEEDS.map((r) => (
                  <TouchableOpacity
                    key={r}
                    style={[styles.speedChip, rate === r && styles.speedChipActive]}
                    onPress={() => changeSpeed(r)}
                  >
                    <Text style={[styles.speedText, rate === r && styles.speedTextActive]}>
                      {r}x
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.sectionLabel}>Navegación cuadro por cuadro y capturas</Text>
              <View style={styles.actionButtonsRow}>
                <TouchableOpacity style={styles.secondaryActionBtn} onPress={() => stepFrame(-1)}>
                  <Ionicons name="play-skip-back-outline" size={18} color="#fff" />
                  <Text style={styles.actionBtnText}>-1 Cuadro</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.secondaryActionBtn} onPress={() => stepFrame(1)}>
                  <Ionicons name="play-skip-forward-outline" size={18} color="#fff" />
                  <Text style={styles.actionBtnText}>+1 Cuadro</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.primaryCaptureBtn, busy && { opacity: 0.5 }]}
                  onPress={handleCaptureFrame}
                  disabled={busy}
                >
                  <Ionicons name="camera" size={18} color="#fff" />
                  <Text style={styles.actionBtnText}>Guardar foto</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </ScrollView>

        {/* MODAL DE PROGRESO EN VIVO PARA RECORTE Y COMPRESIÓN */}
        {busy && (
          <View style={styles.busyOverlay}>
            <View style={styles.busyCard}>
              <ActivityIndicator size="large" color="#38bdf8" />
              <Text style={styles.busyTitle}>{progressInfo.stage || 'Procesando video...'}</Text>
              <View style={styles.busyBarBg}>
                <View
                  style={[
                    styles.busyBarFill,
                    { width: `${Math.round(clamp(progressInfo.percent || 0, 0.05, 1) * 100)}%` },
                  ]}
                />
              </View>
              <Text style={styles.busyPctText}>
                {Math.round(clamp(progressInfo.percent || 0, 0.05, 1) * 100)}% • Manteniendo 100% resolución original
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
    backgroundColor: '#07090e',
    zIndex: 9999,
    elevation: 9999,
  },
  container: {
    flex: 1,
    backgroundColor: '#07090e',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#0d111a',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    gap: 8,
  },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#1e293b',
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
    marginTop: 3,
    flexWrap: 'wrap',
  },
  resBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
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
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
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
  quickSnapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  quickSnapText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  videoArea: {
    flex: 1,
    minHeight: 190,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  centerPlayIconOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.20)',
  },
  centerPlayCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewModeBanner: {
    position: 'absolute',
    bottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(6, 78, 59, 0.92)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#10b981',
  },
  previewModeText: {
    color: '#ecfdf5',
    fontSize: 11,
    fontWeight: '700',
  },
  transportBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#0f1420',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
  },
  timeReadoutBox: {
    flexDirection: 'row',
    alignItems: 'baseline',
    minWidth: 92,
  },
  currentTimeText: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  totalTimeText: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  transportIconsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  transportBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#172033',
  },
  mainPlayPill: {
    width: 42,
    height: 34,
    borderRadius: 10,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 2,
  },
  previewLoopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
  },
  previewLoopBtnActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderColor: '#10b981',
  },
  previewLoopText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700',
  },
  timelineSection: {
    backgroundColor: '#0f1420',
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  filmstripContainer: {
    height: 54,
    borderRadius: 10,
    backgroundColor: '#161e2e',
    position: 'relative',
    justifyContent: 'center',
    overflow: 'visible',
  },
  filmstripRow: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    borderRadius: 10,
    overflow: 'hidden',
  },
  filmstripThumb: {
    flex: 1,
    height: '100%',
    opacity: 0.85,
  },
  filmstripPlaceholder: {
    flex: 1,
    height: '100%',
    backgroundColor: '#1e293b',
    borderRightWidth: 1,
    borderRightColor: '#0f172a',
  },
  savedClipOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(16, 185, 129, 0.28)',
    borderTopWidth: 2,
    borderBottomWidth: 2,
    borderColor: '#10b981',
  },
  dimMaskLeft: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(5, 8, 15, 0.72)',
    borderTopLeftRadius: 10,
    borderBottomLeftRadius: 10,
  },
  dimMaskRight: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(5, 8, 15, 0.72)',
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
  },
  activeSelectionWindow: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderTopWidth: 2.5,
    borderBottomWidth: 2.5,
  },
  cutOutMiddleWindow: {
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
  cutOutLabel: {
    color: '#fecaca',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
    marginTop: 1,
  },
  scrubHitArea: {
    ...StyleSheet.absoluteFillObject,
  },
  trimHandleWrap: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    width: 30,
    marginLeft: -15,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  trimHandleLeft: {},
  trimHandleRight: {},
  trimHandleFocused: {
    transform: [{ scaleY: 1.04 }],
  },
  trimHandlePill: {
    width: 14,
    height: '100%',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 4,
    elevation: 5,
  },
  handleGripBar: {
    width: 3,
    height: 18,
    borderRadius: 2,
    backgroundColor: '#0f172a',
  },
  playheadLine: {
    position: 'absolute',
    top: -6,
    bottom: -6,
    width: 2.5,
    marginLeft: -1.25,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    zIndex: 25,
  },
  playheadCap: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ffffff',
    marginTop: -2,
  },
  timelineLegendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  handleTimeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#172033',
    borderWidth: 1,
    borderColor: '#26334d',
  },
  handleTimeBadgeActive: {
    borderColor: '#f59e0b',
    backgroundColor: 'rgba(245, 158, 11, 0.14)',
  },
  handleTimeLabel: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '600',
  },
  handleTimeValue: {
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  finalDurationSummary: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '700',
  },
  studioTabsBar: {
    flexDirection: 'row',
    backgroundColor: '#0d111a',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    paddingHorizontal: 8,
  },
  studioTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  studioTabActive: {
    borderBottomColor: '#f59e0b',
  },
  studioTabText: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  studioTabTextActive: {
    color: '#f59e0b',
    fontWeight: '800',
  },
  panel: {
    flex: 1,
    maxHeight: 270,
    backgroundColor: '#0b0e16',
  },
  panelContent: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    paddingBottom: 20,
  },
  tabBody: {
    gap: 10,
  },
  modeSwitchRow: {
    flexDirection: 'row',
    gap: 8,
  },
  modeCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 9,
    borderRadius: 10,
    backgroundColor: '#131926',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  modeCardKeepActive: {
    borderColor: '#f59e0b',
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
  },
  modeCardCutMiddleActive: {
    borderColor: '#ef4444',
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
  },
  modeCardTitle: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '800',
  },
  modeCardSub: {
    color: '#94a3b8',
    fontSize: 10,
    marginTop: 1,
  },
  precisionBox: {
    backgroundColor: '#121826',
    borderRadius: 10,
    padding: 9,
    borderWidth: 1,
    borderColor: '#1e293b',
    gap: 7,
  },
  precisionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  precisionTitle: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '700',
  },
  handleSwitchPills: {
    flexDirection: 'row',
    gap: 6,
  },
  miniHandleSwitch: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#1e293b',
  },
  miniHandleSwitchActive: {
    backgroundColor: '#f59e0b',
  },
  miniHandleSwitchText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
  },
  nudgeButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  nudgeBtn: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  nudgeBtnText: {
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: '700',
  },
  markHereBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderWidth: 1,
    borderColor: '#f59e0b',
  },
  markHereText: {
    color: '#fde68a',
    fontSize: 11,
    fontWeight: '800',
  },
  multiClipsBox: {
    backgroundColor: '#121826',
    borderRadius: 10,
    padding: 9,
    borderWidth: 1,
    borderColor: '#1e293b',
    gap: 6,
  },
  multiClipsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  multiClipsTitle: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '700',
  },
  addClipBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#10b981',
  },
  addClipBtnText: {
    color: '#6ee7b7',
    fontSize: 10,
    fontWeight: '800',
  },
  resetClipsBtn: {
    padding: 4,
    borderRadius: 6,
    backgroundColor: '#1e293b',
  },
  savedClipsScroll: {
    gap: 6,
    paddingTop: 2,
  },
  savedClipChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderWidth: 1,
    borderColor: '#10b981',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
  },
  savedClipChipText: {
    color: '#ecfdf5',
    fontSize: 11,
    fontWeight: '700',
  },
  multiClipsHint: {
    color: '#64748b',
    fontSize: 10,
  },
  actionButtonsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  secondaryActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#1e293b',
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  primaryTrimBtn: {
    flex: 1.25,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#d97706',
    paddingVertical: 11,
    borderRadius: 10,
  },
  primaryCompressBtn: {
    flex: 1.35,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0284c7',
    paddingVertical: 11,
    borderRadius: 10,
  },
  primaryCaptureBtn: {
    flex: 1.2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#059669',
    paddingVertical: 11,
    borderRadius: 10,
  },
  actionBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  compressSummaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#121826',
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
  },
  compressSummaryCol: {
    alignItems: 'flex-start',
  },
  compressSummaryLabel: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '600',
  },
  compressSummaryOldVal: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '800',
  },
  compressSummaryNewVal: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '900',
  },
  compressSavingsPill: {
    alignItems: 'flex-end',
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  compressSavingsText: {
    color: '#34d399',
    fontSize: 11,
    fontWeight: '800',
  },
  compressResGuarantee: {
    color: '#94a3b8',
    fontSize: 9,
    fontWeight: '700',
  },
  sectionLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  presetsColumn: {
    gap: 6,
  },
  presetOptionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    borderRadius: 10,
    backgroundColor: '#121826',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  presetTitle: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '800',
  },
  presetBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 5,
    borderWidth: 1,
  },
  presetBadgeText: {
    fontSize: 9,
    fontWeight: '800',
  },
  presetDesc: {
    color: '#94a3b8',
    fontSize: 10,
    marginTop: 1,
  },
  combineTrimCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
  },
  combineTrimCheckText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '600',
  },
  speedRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  speedChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#131926',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  speedChipActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primaryLight,
  },
  speedText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  speedTextActive: {
    color: '#ffffff',
  },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(7, 9, 14, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    zIndex: 999,
  },
  busyCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: '#121826',
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
