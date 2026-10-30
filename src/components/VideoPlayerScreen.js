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
  Vibration,
  Animated,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as MediaLibrary from 'expo-media-library';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { compressionService } from '../services/compressionService';
import { videoEngineService, VIDEO_QUALITY_PRESETS } from '../services/videoEngineService';
import { theme } from '../constants/theme';

const SPEEDS = [0.5, 1, 1.5, 2];
const THUMB_COUNT = 6;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function formatTime(sec, showTenths = false, showCentis = false) {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (showCentis) {
    return `${m}:${rem.toFixed(2).padStart(5, '0')}`;
  }
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
  // 1. Resolver URI reproducible óptimo (convierte SAF primary: a file:// directo cuando existe para carga instantánea)
  const playableUri = useMemo(
    () => videoEngineService.getPlayableVideoUri(asset) || asset?.uri || null,
    [asset]
  );

  const videoSource = useMemo(
    () => (playableUri ? { uri: playableUri } : null),
    [playableUri]
  );

  const player = useVideoPlayer(videoSource, (p) => {
    try {
      p.timeUpdateEventInterval = 0.1;
      p.loop = false;
      p.play();
    } catch (_e) {}
  });

  // Estados de reproducción
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(
    asset?.duration && asset.duration > 0 ? asset.duration : 0
  );
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [useNativeControls, setUseNativeControls] = useState(false);
  const [videoMeta, setVideoMeta] = useState(null);
  const [currentFileSize, setCurrentFileSize] = useState(asset?.fileSize || 0);
  const [filmstripThumbs, setFilmstripThumbs] = useState([]);
  const [seekFeedback, setSeekFeedback] = useState(null);
  const [capturedPreview, setCapturedPreview] = useState(null); // { uri, timeText }
  const [isCapturing, setIsCapturing] = useState(false);
  const flashAnim = useRef(new Animated.Value(0)).current;

  // Modo amigable: 'play' (Ver Video) | 'trim' (Recortar) | 'compress' (Bajar Peso)
  const [studioMode, setStudioMode] = useState(
    initialMode === 'frame' ? 'play' : initialMode || 'play'
  );
  const [showFrameByFrameBar, setShowFrameByFrameBar] = useState(true);
  const holdStepTimerRef = useRef(null);
  const holdStepIntervalRef = useRef(null);
  const jogGrantXRef = useRef(0);
  const jogStartFrameTimeRef = useRef(0);

  // Estado de Recorte
  // 'keep' = Dejar solo esta parte | 'cut_middle' = Borrar parte de en medio | 'multi' = Unir varios tramos
  const [trimMode, setTrimMode] = useState('keep');
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [savedClips, setSavedClips] = useState([]);
  const [activeHandle, setActiveHandle] = useState('start');
  const [previewingCut, setPreviewingCut] = useState(false);

  // Estado de Compresión
  const [selectedPresetId, setSelectedPresetId] = useState('balanced');
  const [applyTrimOnCompress, setApplyTrimOnCompress] = useState(false);

  // Estado de progreso en operaciones
  const [busy, setBusy] = useState(false);
  const [progressInfo, setProgressInfo] = useState({ percent: 0, stage: '' });

  // Referencias para barras deslizables suaves
  const playScrubberWidthRef = useRef(1);
  const scrubberGrantXRef = useRef(0);
  const timelineWidthRef = useRef(1);
  const timelineDragModeRef = useRef('playhead');
  const timelineGrantXRef = useRef(0);
  const isScrubbingRef = useRef(false);
  const durationRef = useRef(duration);
  const trimStartRef = useRef(0);
  const trimEndRef = useRef(0);
  const dragInitialStartRef = useRef(0);
  const dragInitialEndRef = useRef(0);

  durationRef.current = duration;
  trimStartRef.current = trimStart;
  trimEndRef.current = trimEnd;

  useEffect(() => {
    if (initialMode === 'frame') {
      setStudioMode('play');
      setShowFrameByFrameBar(true);
      try {
        player.pause();
      } catch (_e) {}
    } else {
      setStudioMode(initialMode || 'play');
    }
  }, [initialMode, asset?.uri]);

  useEffect(() => {
    return () => {
      if (holdStepTimerRef.current) clearTimeout(holdStepTimerRef.current);
      if (holdStepIntervalRef.current) clearInterval(holdStepIntervalRef.current);
    };
  }, []);

  // Obtener peso y resolución sin bloquear el reproductor
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
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
      } catch (_e) {}
    })();
    return () => {
      mounted = false;
    };
  }, [asset]);

  // Extraer miniaturas solo si el usuario entra a "Recortar"
  useEffect(() => {
    let cancelled = false;
    if (studioMode !== 'trim' || filmstripThumbs.length > 0) return;
    (async () => {
      try {
        const thumbs = await videoEngineService.extractFilmstrip(asset, THUMB_COUNT);
        if (!cancelled && Array.isArray(thumbs) && thumbs.length > 0) {
          setFilmstripThumbs(thumbs);
        }
      } catch (_e) {}
    })();
    return () => {
      cancelled = true;
    };
  }, [studioMode, asset, filmstripThumbs.length]);

  // Tramos efectivos del recorte
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

  // Suscripción segura únicamente a los 3 eventos nativos soportados por expo-video
  useEffect(() => {
    if (!player) return;
    const subs = [];

    try {
      subs.push(
        player.addListener('timeUpdate', ({ currentTime }) => {
          if (!isScrubbingRef.current) {
            setTime(currentTime);
          }
          if (player.duration && player.duration > 0) {
            if (Math.abs(player.duration - durationRef.current) > 0.1) {
              setDuration(player.duration);
            }
            if (trimEndRef.current <= 0) {
              setTrimEnd(player.duration);
            }
          }

          // Si está en modo "Ver cómo queda el recorte", saltar partes recortadas automáticamente
          if (previewingCutRef.current && effectiveSegmentsRef.current.length > 0) {
            const segs = effectiveSegmentsRef.current;
            const insideAny = segs.some(
              (seg) => currentTime >= seg.start - 0.1 && currentTime <= seg.end + 0.06
            );
            if (!insideAny) {
              const nextSeg = segs.find((seg) => seg.start > currentTime + 0.03);
              try {
                if (nextSeg) {
                  player.currentTime = nextSeg.start;
                  setTime(nextSeg.start);
                } else {
                  player.currentTime = segs[0].start;
                  setTime(segs[0].start);
                }
              } catch (_e) {}
            }
          }
        })
      );
    } catch (_e) {}

    try {
      subs.push(
        player.addListener('playingChange', ({ isPlaying }) => {
          setPlaying(Boolean(isPlaying));
        })
      );
    } catch (_e) {}

    try {
      subs.push(
        player.addListener('sourceLoad', ({ duration: d }) => {
          if (d && d > 0) {
            setDuration(d);
            if (trimEndRef.current <= 0) {
              setTrimEnd(d);
            }
          }
        })
      );
    } catch (_e) {}

    return () => {
      subs.forEach((s) => {
        try {
          s?.remove?.();
        } catch (_e) {}
      });
    };
  }, [player]);

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
        if (dur > 0 && time >= dur - 0.1) {
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
    const label = delta > 0 ? `+${Math.round(delta)} seg` : `${Math.round(delta)} seg`;
    setSeekFeedback(label);
    setTimeout(() => setSeekFeedback(null), 650);
  };

  const fps = useMemo(() => {
    const rawFps = Number(videoMeta?.fps || asset?.fps || 30);
    return rawFps >= 15 && rawFps <= 240 ? rawFps : 30;
  }, [videoMeta?.fps, asset?.fps]);

  const frameDuration = useMemo(() => 1 / fps, [fps]);
  const currentFrameNumber = useMemo(
    () => Math.max(1, Math.round((time || 0) * fps) + 1),
    [time, fps]
  );
  const totalFrames = useMemo(
    () => Math.max(1, Math.round((duration || 0) * fps)),
    [duration, fps]
  );

  // Salto exacto de N cuadros / frames (por defecto 1 cuadro ~0.033 seg a 30fps)
  const stepFrame = (framesDelta = 1) => {
    try {
      player.pause();
    } catch (_e) {}
    setPreviewingCut(false);
    const current = Number.isFinite(player.currentTime) ? player.currentTime : time;
    const delta = framesDelta * frameDuration;
    const nextTime = clamp(current + delta, 0, durationRef.current || duration || current + 1);
    seekTo(nextTime);
    try {
      Vibration.vibrate(14);
    } catch (_e) {}
    const nextFrameNum = Math.max(1, Math.round(nextTime * fps) + 1);
    const sign = framesDelta > 0 ? '+' : '';
    setSeekFeedback(
      `${sign}${framesDelta} ${Math.abs(framesDelta) === 1 ? 'cuadro' : 'cuadros'} · #${nextFrameNum}`
    );
    setTimeout(() => setSeekFeedback(null), 550);
  };

  const startHoldStepFrame = (framesDelta = 1) => {
    stopHoldStepFrame();
    stepFrame(framesDelta);
    holdStepTimerRef.current = setTimeout(() => {
      holdStepIntervalRef.current = setInterval(() => {
        stepFrame(framesDelta);
      }, 95);
    }, 280);
  };

  const stopHoldStepFrame = () => {
    if (holdStepTimerRef.current) {
      clearTimeout(holdStepTimerRef.current);
      holdStepTimerRef.current = null;
    }
    if (holdStepIntervalRef.current) {
      clearInterval(holdStepIntervalRef.current);
      holdStepIntervalRef.current = null;
    }
  };

  // Rueda / Deslizador táctil (Jog Shuttle) para avanzar o retroceder cuadro por cuadro deslizando el dedo
  const frameJogPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        isScrubbingRef.current = true;
        setPreviewingCut(false);
        try {
          player.pause();
        } catch (_e) {}
        jogGrantXRef.current = 0;
        jogStartFrameTimeRef.current = Number.isFinite(player.currentTime)
          ? player.currentTime
          : time;
      },
      onPanResponderMove: (_, gestureState) => {
        // Cada 10px de arrastre horizontal equivale a 1 cuadro (frame)
        const framesMoved = Math.trunc(gestureState.dx / 10);
        if (framesMoved !== jogGrantXRef.current) {
          jogGrantXRef.current = framesMoved;
          const nextT = clamp(
            jogStartFrameTimeRef.current + framesMoved * (1 / 30),
            0,
            durationRef.current || 1
          );
          seekTo(nextT);
          try {
            Vibration.vibrate(10);
          } catch (_e) {}
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

  const triggerShutterFlash = () => {
    try {
      Vibration.vibrate([0, 30, 20, 35]);
    } catch (_e) {}
    flashAnim.setValue(0.85);
    Animated.timing(flashAnim, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  };

  const toggleMute = () => {
    const next = !muted;
    try {
      player.muted = next;
    } catch (_e) {}
    setMuted(next);
  };

  const cycleSpeed = () => {
    const idx = SPEEDS.indexOf(rate);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    try {
      player.playbackRate = next;
    } catch (_e) {}
    setRate(next);
  };

  // Barra de progreso en modo "Ver Video"
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

  // Manija dedicada para INICIO (arrastre directo 100% preciso)
  const startHandlePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        isScrubbingRef.current = true;
        setPreviewingCut(false);
        try {
          player.pause();
        } catch (_e) {}
        setActiveHandle('start');
        dragInitialStartRef.current = trimStartRef.current || 0;
      },
      onPanResponderMove: (_, gestureState) => {
        const w = timelineWidthRef.current || 1;
        const dur = durationRef.current || 1;
        const deltaSec = (gestureState.dx / w) * dur;
        const currentEnd = trimEndRef.current > 0 ? trimEndRef.current : dur;
        const maxStart = Math.max(0, currentEnd - 0.2);
        const nextStart = clamp(dragInitialStartRef.current + deltaSec, 0, maxStart);
        setTrimStart(nextStart);
        seekTo(nextStart);
      },
      onPanResponderRelease: () => {
        isScrubbingRef.current = false;
      },
      onPanResponderTerminate: () => {
        isScrubbingRef.current = false;
      },
    })
  ).current;

  // Manija dedicada para FIN (arrastre directo 100% preciso)
  const endHandlePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        isScrubbingRef.current = true;
        setPreviewingCut(false);
        try {
          player.pause();
        } catch (_e) {}
        setActiveHandle('end');
        const dur = durationRef.current || 1;
        dragInitialEndRef.current = trimEndRef.current > 0 ? trimEndRef.current : dur;
      },
      onPanResponderMove: (_, gestureState) => {
        const w = timelineWidthRef.current || 1;
        const dur = durationRef.current || 1;
        const deltaSec = (gestureState.dx / w) * dur;
        const minEnd = Math.min(dur, (trimStartRef.current || 0) + 0.2);
        const nextEnd = clamp(dragInitialEndRef.current + deltaSec, minEnd, dur);
        setTrimEnd(nextEnd);
        seekTo(nextEnd);
      },
      onPanResponderRelease: () => {
        isScrubbingRef.current = false;
      },
      onPanResponderTerminate: () => {
        isScrubbingRef.current = false;
      },
    })
  ).current;

  const nudgeTrimPoint = (which, deltaSec) => {
    const dur = durationRef.current || duration || 1;
    setPreviewingCut(false);
    try {
      player.pause();
    } catch (_e) {}
    if (which === 'start') {
      const currentEnd = trimEnd > 0 ? trimEnd : dur;
      const maxS = Math.max(0, currentEnd - 0.2);
      const nextS = clamp((trimStart || 0) + deltaSec, 0, maxS);
      setTrimStart(nextS);
      seekTo(nextS);
    } else {
      const currentEnd = trimEnd > 0 ? trimEnd : dur;
      const minE = Math.min(dur, (trimStart || 0) + 0.2);
      const nextE = clamp(currentEnd + deltaSec, minE, dur);
      setTrimEnd(nextE);
      seekTo(nextE);
    }
  };

  // Barra interactiva de Recorte (manijas Inicio / Fin y aguja)
  const timelinePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
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
        const HANDLE_RADIUS = 38;

        if (distStart <= HANDLE_RADIUS && distStart <= distEnd) {
          timelineDragModeRef.current = 'start';
          try {
            player.pause();
          } catch (_e) {}
          setActiveHandle('start');
          dragInitialStartRef.current = trimStartRef.current;
        } else if (distEnd <= HANDLE_RADIUS) {
          timelineDragModeRef.current = 'end';
          try {
            player.pause();
          } catch (_e) {}
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

  const handlePreviewSelection = () => {
    if (effectiveSegments.length === 0) return;
    if (previewingCut && playing) {
      setPreviewingCut(false);
      try {
        player.pause();
      } catch (_e) {}
      return;
    }
    setPreviewingCut(true);
    const first = effectiveSegments[0];
    seekTo(first.start);
    try {
      player.play();
    } catch (_e) {}
  };

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
      Alert.alert('Tramo muy corto', 'Selecciona una parte de al menos medio segundo.');
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

  // Capturar foto del momento / fotograma actual con efecto flash y miniatura
  const handleCaptureFrame = async () => {
    try {
      player.pause();
    } catch (_e) {}
    const captureTime = Number.isFinite(player.currentTime) ? player.currentTime : time;
    const formatted = formatTime(captureTime, false, true);

    triggerShutterFlash();
    setIsCapturing(true);

    try {
      let frameUri = await videoEngineService.captureFrame(asset, captureTime);
      if (!frameUri) {
        const thumbs = await player.generateThumbnailsAsync([captureTime]);
        if (!thumbs || !thumbs[0]) {
          throw new Error('No se pudo extraer la imagen del video.');
        }
        const context = ImageManipulator.manipulate(thumbs[0]);
        const rendered = await context.renderAsync();
        const saved = await rendered.saveAsync({
          format: SaveFormat.JPEG,
          compress: 0.96,
        });
        frameUri = saved.uri;
      }
      await MediaLibrary.saveToLibraryAsync(frameUri);

      // Mostrar previsualización flotante y feedback táctil sin interrumpir la reproducción con Alert
      setCapturedPreview({ uri: frameUri, timeText: formatted });
      setTimeout(() => {
        setCapturedPreview(null);
      }, 3200);

      if (onSaved) onSaved();
    } catch (e) {
      Alert.alert('Error al capturar foto', String(e?.message || e));
    } finally {
      setIsCapturing(false);
    }
  };

  // Ejecutar recorte
  const handleExecuteTrim = async (replaceOriginal = false) => {
    if (effectiveSegments.length === 0) {
      Alert.alert('Recortar', 'Selecciona al menos una parte del video.');
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
        'Marca primero qué parte recortar',
        'Mueve las barritas amarillas de INICIO o FIN en la barra de abajo (o toca "Empezar aquí" / "Terminar aquí") antes de guardar.'
      );
      return;
    }

    try {
      player.pause();
    } catch (_e) {}
    setPreviewingCut(false);
    setBusy(true);
    setProgressInfo({ percent: 0.15, stage: 'Recortando tu video sin perder calidad...' });

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
          '✅ ¡Video recortado!',
          `El video original fue actualizado (${formatTime(totalFinalSec)}) manteniendo toda su calidad.\n\nNuevo peso: ${compressionService.formatBytes(res.newSizeBytes)}.`
        );
        if (onSaved) onSaved();
        onClose();
      } else {
        Alert.alert(
          '✅ ¡Copia nueva guardada!',
          `Se guardó el video recortado (${formatTime(totalFinalSec)}) en tu galería (${compressionService.formatBytes(res.newSizeBytes)}).`
        );
        if (onSaved) onSaved();
      }
    } catch (e) {
      Alert.alert('No se pudo recortar el video', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  // Ejecutar compresión
  const handleExecuteCompress = async (replaceOriginal = true) => {
    try {
      player.pause();
    } catch (_e) {}
    setPreviewingCut(false);
    setBusy(true);
    setProgressInfo({
      percent: 0.08,
      stage: 'Reduciendo el peso del video sin perder calidad...',
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
          'Video ya ligero',
          `Este video (${compressionService.formatBytes(res.oldSizeBytes)}) ya tiene un peso muy bajo y óptimo.`
        );
      } else if (replaceOriginal) {
        setCurrentFileSize(res.newSizeBytes);
        Alert.alert(
          '🎉 ¡Video mucho más ligero!',
          `Peso anterior: ${compressionService.formatBytes(res.oldSizeBytes)}\n` +
            `Peso nuevo: ${compressionService.formatBytes(res.newSizeBytes)}\n\n` +
            `¡Ahorraste ${compressionService.formatBytes(res.savedBytes)} manteniendo la misma resolución!`
        );
        if (onSaved) onSaved();
      } else {
        Alert.alert(
          '🎉 ¡Copia ligera guardada!',
          `Se guardó una copia ligera en tu galería.\n` +
            `Antes: ${compressionService.formatBytes(res.oldSizeBytes)} → Ahora: ${compressionService.formatBytes(res.newSizeBytes)}\n` +
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
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <SafeAreaView style={styles.container}>
        {/* 1. CABECERA AMIGABLE Y CLARA */}
        <View style={styles.topBar}>
          <TouchableOpacity
            onPress={onClose}
            style={styles.backBtn}
            disabled={busy}
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-back" size={22} color="#ffffff" />
            <Text style={styles.backBtnText}>Volver</Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.title} numberOfLines={1}>
              {asset.filename || 'Mi Video'}
            </Text>
            <View style={styles.metaBadgesRow}>
              {currentFileSize > 0 && (
                <View style={[styles.sizeBadge, { borderColor: sizeLevel.color }]}>
                  <View style={[styles.sizeDot, { backgroundColor: sizeLevel.color }]} />
                  <Text style={[styles.sizeBadgeText, { color: sizeLevel.color }]}>
                    {compressionService.formatBytes(currentFileSize)}
                  </Text>
                </View>
              )}
              {videoMeta?.resolutionBadge ? (
                <View style={styles.resBadge}>
                  <Text style={styles.resBadgeText}>{videoMeta.resolutionBadge}</Text>
                </View>
              ) : null}
            </View>
          </View>

          <View style={styles.headerRightActions}>
            <TouchableOpacity
              style={[
                styles.iconCircleBtn,
                {
                  backgroundColor: 'rgba(56, 189, 248, 0.22)',
                  borderColor: '#38bdf8',
                  borderWidth: 1,
                },
              ]}
              onPress={handleCaptureFrame}
              disabled={isCapturing || busy}
              activeOpacity={0.75}
            >
              {isCapturing ? (
                <ActivityIndicator size="small" color="#38bdf8" />
              ) : (
                <Ionicons name="camera" size={19} color="#38bdf8" />
              )}
            </TouchableOpacity>

            {onShare && (
              <TouchableOpacity
                style={styles.iconCircleBtn}
                onPress={onShare}
                disabled={busy}
                activeOpacity={0.75}
              >
                <Ionicons name="share-social-outline" size={20} color="#ffffff" />
              </TouchableOpacity>
            )}
            {onDelete && (
              <TouchableOpacity
                style={styles.iconCircleBtn}
                onPress={onDelete}
                disabled={busy}
                activeOpacity={0.75}
              >
                <Ionicons name="trash-outline" size={20} color="#f87171" />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* 2. ÁREA DEL VIDEO (Contenedor View real con dimensiones absolutas explícitas para ExoPlayer) */}
        <View style={styles.videoArea}>
          <VideoView
            player={player}
            style={styles.video}
            contentFit="contain"
            nativeControls={useNativeControls}
          />

          {/* Flash blanco de obturador al tomar foto */}
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: '#ffffff', opacity: flashAnim, zIndex: 99 },
            ]}
          />

          {!useNativeControls && (
            <TouchableOpacity
              style={StyleSheet.absoluteFill}
              activeOpacity={1}
              onPress={togglePlay}
            />
          )}

          {!playing && !useNativeControls && (
            <View pointerEvents="none" style={styles.centerPlayOverlay}>
              <View style={styles.centerPlayCircle}>
                <Ionicons name="play" size={42} color="#ffffff" style={{ marginLeft: 4 }} />
              </View>
              <Text style={styles.centerPlayHint}>Toca para reproducir</Text>
            </View>
          )}

          {/* Toast / Miniatura flotante de captura exitosa */}
          {capturedPreview && (
            <View style={styles.capturePreviewPill}>
              <Image
                source={{ uri: capturedPreview.uri }}
                style={styles.capturePreviewThumb}
                contentFit="cover"
              />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Ionicons name="checkmark-circle" size={15} color="#22c55e" />
                  <Text style={styles.capturePreviewTitle}>¡Foto guardada!</Text>
                </View>
                <Text style={styles.capturePreviewSubtitle}>
                  Momento {capturedPreview.timeText} en Galería
                </Text>
              </View>
            </View>
          )}

          {/* Botón flotante de captura rápida en la esquina del video */}
          <TouchableOpacity
            style={styles.floatingCaptureBtn}
            onPress={handleCaptureFrame}
            disabled={isCapturing || busy}
            activeOpacity={0.8}
          >
            {isCapturing ? (
              <ActivityIndicator size="small" color="#38bdf8" />
            ) : (
              <>
                <Ionicons name="camera" size={17} color="#38bdf8" />
                <Text style={styles.floatingCaptureText}>Capturar</Text>
              </>
            )}
          </TouchableOpacity>

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

          {previewingCut && (
            <View pointerEvents="none" style={styles.previewBanner}>
              <Ionicons name="eye" size={15} color="#34d399" />
              <Text style={styles.previewBannerText}>
                Viendo cómo queda tu recorte ({formatTime(totalResultDuration)})
              </Text>
            </View>
          )}
        </View>

        {/* 3. PANEL INFERIOR SÚPER AMIGABLE CON BOTONES GRANDES Y TEXTO CLARO */}
        <View style={styles.bottomStudioDock}>
          {/* Pestañas grandes y fáciles de entender */}
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
                size={20}
                color={studioMode === 'play' ? '#ffffff' : '#94a3b8'}
              />
              <Text
                style={[
                  styles.modeTabText,
                  studioMode === 'play' && styles.modeTabTextActive,
                ]}
              >
                Ver Video
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
                size={19}
                color={studioMode === 'trim' ? '#ffffff' : '#fbbf24'}
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
                name="flash"
                size={18}
                color={studioMode === 'compress' ? '#ffffff' : '#38bdf8'}
              />
              <Text
                style={[
                  styles.modeTabText,
                  studioMode === 'compress' && styles.modeTabTextActive,
                ]}
              >
                Bajar Peso
              </Text>
            </TouchableOpacity>
          </View>

          {/* ================= MODO 1: VER VIDEO (REPRODUCTOR AMIGABLE) ================= */}
          {studioMode === 'play' && (
            <View style={styles.playModeContainer}>
              {/* Barra de tiempo grande y fácil de mover con el dedo (muestra centésimas al estar en pausa para precisión de cuadro) */}
              <View style={styles.scrubberRow}>
                <Text style={[styles.scrubberTimeText, !playing && styles.scrubberTimeTextPrecision]}>
                  {formatTime(time, false, !playing)}
                </Text>

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

              {/* Controles de reproducción principales con Avance/Retroceso Cuadro por Cuadro (Frame by Frame) y saltos de 10s */}
              <View style={styles.friendlyControlsMasterRow}>
                {/* 1. Salto -10 segundos */}
                <TouchableOpacity
                  style={styles.friendlySkipBtnCompact}
                  onPress={() => seekBy(-10)}
                  activeOpacity={0.8}
                >
                  <Ionicons name="play-back" size={16} color="#cbd5e1" />
                  <Text style={styles.friendlySkipTextCompact}>-10s</Text>
                </TouchableOpacity>

                {/* 2. Paso fino: -1 Cuadro (Frame anterior, soporta mantener presionado) */}
                <TouchableOpacity
                  style={styles.frameStepBtn}
                  onPressIn={() => startHoldStepFrame(-1)}
                  onPressOut={stopHoldStepFrame}
                  activeOpacity={0.78}
                >
                  <Ionicons name="play-skip-back" size={15} color="#38bdf8" />
                  <Text style={styles.frameStepBtnText}>-1 Cuadro</Text>
                </TouchableOpacity>

                {/* 3. Botón central grande: Reproducir / Pausar */}
                <TouchableOpacity
                  style={styles.friendlyPlayPauseBtn}
                  onPress={togglePlay}
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name={playing ? 'pause' : 'play'}
                    size={26}
                    color="#ffffff"
                  />
                  <Text style={styles.friendlyPlayPauseText}>
                    {playing ? 'Pausar' : 'Reproducir'}
                  </Text>
                </TouchableOpacity>

                {/* 4. Paso fino: +1 Cuadro (Frame siguiente, soporta mantener presionado) */}
                <TouchableOpacity
                  style={styles.frameStepBtn}
                  onPressIn={() => startHoldStepFrame(1)}
                  onPressOut={stopHoldStepFrame}
                  activeOpacity={0.78}
                >
                  <Text style={styles.frameStepBtnText}>+1 Cuadro</Text>
                  <Ionicons name="play-skip-forward" size={15} color="#38bdf8" />
                </TouchableOpacity>

                {/* 5. Salto +10 segundos */}
                <TouchableOpacity
                  style={styles.friendlySkipBtnCompact}
                  onPress={() => seekBy(10)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.friendlySkipTextCompact}>+10s</Text>
                  <Ionicons name="play-forward" size={16} color="#cbd5e1" />
                </TouchableOpacity>
              </View>

              {/* PANEL DEDICADO DE AVANCE CUADRO POR CUADRO (Botones rápidos + Rueda deslizable Jog) */}
              {showFrameByFrameBar && (
                <View style={styles.frameByFramePanel}>
                  <View style={styles.frameByFrameTopRow}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Ionicons name="film-outline" size={15} color="#38bdf8" />
                      <Text style={styles.frameByFrameTitle}>
                        Cuadro #{currentFrameNumber}{' '}
                        <Text style={{ color: '#64748b', fontWeight: '600' }}>
                          / {totalFrames} ({Math.round(fps)} fps)
                        </Text>
                      </Text>
                    </View>
                    <Text style={styles.frameByFrameHint}>
                      Mantén presionado o desliza la rueda
                    </Text>
                  </View>

                  <View style={styles.frameButtonsStrip}>
                    <TouchableOpacity
                      style={styles.frameMultiBtn}
                      onPress={() => stepFrame(-5)}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.frameMultiBtnText}>-5</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.frameSingleActionBtn}
                      onPressIn={() => startHoldStepFrame(-1)}
                      onPressOut={stopHoldStepFrame}
                      activeOpacity={0.75}
                    >
                      <Ionicons name="chevron-back" size={16} color="#ffffff" />
                      <Text style={styles.frameSingleActionText}>Cuadro ant.</Text>
                    </TouchableOpacity>

                    {/* Rueda táctil central para deslizar cuadro por cuadro */}
                    <View
                      style={styles.frameJogWheel}
                      {...frameJogPanResponder.panHandlers}
                    >
                      <Ionicons name="swap-horizontal" size={14} color="#38bdf8" />
                      <Text style={styles.frameJogWheelText}>Deslizar cuadros</Text>
                    </View>

                    <TouchableOpacity
                      style={styles.frameSingleActionBtn}
                      onPressIn={() => startHoldStepFrame(1)}
                      onPressOut={stopHoldStepFrame}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.frameSingleActionText}>Sig. cuadro</Text>
                      <Ionicons name="chevron-forward" size={16} color="#ffffff" />
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.frameMultiBtn}
                      onPress={() => stepFrame(5)}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.frameMultiBtnText}>+5</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* Botón de Captura Rápida de Fotograma Prominente y accesible */}
              <TouchableOpacity
                style={styles.prominentCaptureBtn}
                onPress={handleCaptureFrame}
                disabled={isCapturing}
                activeOpacity={0.82}
              >
                {isCapturing ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <>
                    <Ionicons name="camera" size={20} color="#ffffff" />
                    <Text style={styles.prominentCaptureBtnText}>
                      Capturar Foto de este Cuadro ({formatTime(time, false, true)})
                    </Text>
                  </>
                )}
              </TouchableOpacity>

              {/* Fila de opciones útiles: Sonido, Velocidad */}
              <View style={styles.friendlyToolsRow}>
                <TouchableOpacity
                  style={[
                    styles.friendlyToolChip,
                    muted && styles.friendlyToolChipMuted,
                  ]}
                  onPress={toggleMute}
                >
                  <Ionicons
                    name={muted ? 'volume-mute' : 'volume-high'}
                    size={18}
                    color={muted ? '#f87171' : '#34d399'}
                  />
                  <Text style={styles.friendlyToolChipText}>
                    {muted ? 'Sin sonido' : 'Sonido'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.friendlyToolChip,
                    rate !== 1 && styles.friendlyToolChipActive,
                  ]}
                  onPress={cycleSpeed}
                >
                  <Ionicons name="speedometer-outline" size={18} color="#fbbf24" />
                  <Text style={styles.friendlyToolChipText}>Velocidad {rate}x</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.friendlyToolChip,
                    useNativeControls && styles.friendlyToolChipActive,
                  ]}
                  onPress={() => setUseNativeControls((v) => !v)}
                >
                  <Ionicons name="options-outline" size={18} color="#cbd5e1" />
                  <Text style={styles.friendlyToolChipText}>
                    {useNativeControls ? 'Modo simple' : 'Barra nativa'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ================= MODO 2: RECORTAR (GUIADO PASO A PASO) ================= */}
          {studioMode === 'trim' && (
            <View style={styles.trimModeContainer}>
              {/* Paso 1: Elegir qué hacer con palabras sencillas */}
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
                    size={16}
                    color={trimMode === 'keep' ? '#fef3c7' : '#94a3b8'}
                  />
                  <Text
                    style={[
                      styles.trimSubmodeText,
                      trimMode === 'keep' && styles.trimSubmodeTextActive,
                    ]}
                  >
                    Dejar solo esta parte
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.trimSubmodePill,
                    trimMode === 'cut_middle' && styles.trimSubmodePillDeleteCenter,
                  ]}
                  onPress={() => {
                    setTrimMode('cut_middle');
                    const d = duration || 0;
                    if (d > 0.6 && trimStart <= 0.1 && (!trimEnd || Math.abs(trimEnd - d) <= 0.1)) {
                      setTrimStart(Number((d * 0.3).toFixed(1)));
                      setTrimEnd(Number((d * 0.7).toFixed(1)));
                    }
                  }}
                >
                  <Ionicons
                    name="trash-outline"
                    size={16}
                    color={trimMode === 'cut_middle' ? '#fee2e2' : '#94a3b8'}
                  />
                  <Text
                    style={[
                      styles.trimSubmodeText,
                      trimMode === 'cut_middle' && styles.trimSubmodeTextActive,
                    ]}
                  >
                    Borrar parte central
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.trimSubmodePillSmall,
                    trimMode === 'multi' && styles.trimSubmodePillMulti,
                  ]}
                  onPress={() => setTrimMode('multi')}
                >
                  <Ionicons
                    name="layers-outline"
                    size={15}
                    color={trimMode === 'multi' ? '#d1fae5' : '#94a3b8'}
                  />
                  <Text
                    style={[
                      styles.trimSubmodeText,
                      trimMode === 'multi' && styles.trimSubmodeTextActive,
                    ]}
                  >
                    Varios
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Paso 2: Barra visual grande con INICIO y FIN claros + botones rápidos -1s / +1s */}
              <View style={styles.timelineWrapper}>
                <View style={styles.timelineInfoHeader}>
                  <View style={styles.timeStepperGroup}>
                    <TouchableOpacity
                      style={styles.microStepBtn}
                      onPress={() => nudgeTrimPoint('start', -1)}
                    >
                      <Text style={styles.microStepBtnText}>-1s</Text>
                    </TouchableOpacity>
                    <Text style={styles.friendlyTimeInfo}>
                      Inicio: <Text style={styles.friendlyTimeBold}>{formatTime(trimStart, true)}</Text>
                    </Text>
                    <TouchableOpacity
                      style={styles.microStepBtn}
                      onPress={() => nudgeTrimPoint('start', 1)}
                    >
                      <Text style={styles.microStepBtnText}>+1s</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={styles.resultDurationPill}>
                    <Text style={styles.resultDurationText}>
                      {formatTime(totalResultDuration, true)}
                    </Text>
                  </View>

                  <View style={styles.timeStepperGroup}>
                    <TouchableOpacity
                      style={styles.microStepBtn}
                      onPress={() => nudgeTrimPoint('end', -1)}
                    >
                      <Text style={styles.microStepBtnText}>-1s</Text>
                    </TouchableOpacity>
                    <Text style={styles.friendlyTimeInfo}>
                      Fin:{' '}
                      <Text style={styles.friendlyTimeBold}>
                        {formatTime(trimEnd || duration, true)}
                      </Text>
                    </Text>
                    <TouchableOpacity
                      style={styles.microStepBtn}
                      onPress={() => nudgeTrimPoint('end', 1)}
                    >
                      <Text style={styles.microStepBtnText}>+1s</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <View
                  style={styles.filmstripTrack}
                  onLayout={(e) => {
                    timelineWidthRef.current = e.nativeEvent.layout.width || 1;
                  }}
                  {...timelinePanResponder.panHandlers}
                >
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
                      <Text style={styles.deleteCenterLabel}>SE BORRARÁ ESTA PARTE</Text>
                    </View>
                  )}

                  {/* Manija Izquierda INICIO (Arrastrable directamente) */}
                  <View
                    style={[styles.handleHitBox, { left: `${startPct}%` }]}
                    hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
                    {...startHandlePanResponder.panHandlers}
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

                  {/* Manija Derecha FIN (Arrastrable directamente) */}
                  <View
                    style={[styles.handleHitBox, { left: `${endPct}%` }]}
                    hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
                    {...endHandlePanResponder.panHandlers}
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

                  {/* Aguja blanca */}
                  <View
                    pointerEvents="none"
                    style={[styles.playheadNeedle, { left: `${playheadPct}%` }]}
                  >
                    <View style={styles.playheadTopKnob} />
                  </View>
                </View>
              </View>

              {/* Botones amigables para marcar inicio/fin con 1 toque mientras ves el video */}
              <View style={styles.quickPrecisionRow}>
                <TouchableOpacity
                  style={styles.miniPlayToggleBtn}
                  onPress={togglePlay}
                >
                  <Ionicons name={playing ? 'pause' : 'play'} size={18} color="#ffffff" />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.setPointBtn}
                  onPress={() => setHandleToCurrentTime('start')}
                >
                  <Ionicons name="flag-outline" size={14} color="#fde68a" />
                  <Text style={styles.setPointBtnText}>Empezar aquí</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.setPointBtn}
                  onPress={() => setHandleToCurrentTime('end')}
                >
                  <Ionicons name="flag" size={14} color="#fde68a" />
                  <Text style={styles.setPointBtnText}>Terminar aquí</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.previewTrimBtn,
                    previewingCut && styles.previewTrimBtnActive,
                  ]}
                  onPress={handlePreviewSelection}
                >
                  <Ionicons
                    name={previewingCut ? 'stop-circle' : 'eye-outline'}
                    size={16}
                    color={previewingCut ? '#34d399' : '#38bdf8'}
                  />
                  <Text
                    style={[
                      styles.previewTrimBtnText,
                      previewingCut && { color: '#34d399' },
                    ]}
                  >
                    {previewingCut ? 'Detener' : 'Ver cómo queda'}
                  </Text>
                </TouchableOpacity>
              </View>

              {trimMode === 'multi' && (
                <View style={styles.multiClipsCompactRow}>
                  <TouchableOpacity
                    style={styles.addClipCompactBtn}
                    onPress={handleAddClipSegment}
                  >
                    <Ionicons name="add-circle" size={16} color="#10b981" />
                    <Text style={styles.addClipCompactText}>+ Agregar tramo</Text>
                  </TouchableOpacity>

                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.savedClipsScroll}
                  >
                    {savedClips.length === 0 ? (
                      <Text style={styles.multiEmptyHint}>
                        Marca una parte y toca &quot;+ Agregar tramo&quot;
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
                              Parte {i + 1}: {formatTime(clip.start)} a {formatTime(clip.end)}
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => handleRemoveSavedClip(clip.id)}>
                            <Ionicons name="close-circle" size={16} color="#f87171" />
                          </TouchableOpacity>
                        </View>
                      ))
                    )}
                  </ScrollView>
                </View>
              )}

              {/* Paso 3: Guardar */}
              <View style={styles.bottomActionButtonsRow}>
                {hasActiveTrim && (
                  <TouchableOpacity
                    style={styles.resetIconBtn}
                    onPress={handleResetTrim}
                    disabled={busy}
                  >
                    <Ionicons name="refresh" size={19} color="#cbd5e1" />
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={[styles.secondarySaveBtn, busy && { opacity: 0.5 }]}
                  onPress={() => handleExecuteTrim(false)}
                  disabled={busy}
                >
                  <Ionicons name="copy-outline" size={18} color="#ffffff" />
                  <Text style={styles.saveBtnText}>Guardar copia nueva</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.primaryTrimSaveBtn, busy && { opacity: 0.5 }]}
                  onPress={() => handleExecuteTrim(true)}
                  disabled={busy}
                >
                  <Ionicons name="checkmark-circle" size={19} color="#ffffff" />
                  <Text style={styles.saveBtnText}>Reemplazar original</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ================= MODO 3: BAJAR PESO (COMPRESOR AMIGABLE) ================= */}
          {studioMode === 'compress' && (
            <View style={styles.compressModeContainer}>
              {/* Comparación clara de Antes vs Después */}
              <View style={styles.compressCompareBanner}>
                <View>
                  <Text style={styles.compareSmallLabel}>Pesa ahora</Text>
                  <Text style={styles.compareOldWeight}>
                    {compressionService.formatBytes(currentFileSize)}
                  </Text>
                </View>

                <Ionicons name="arrow-forward-circle" size={24} color="#38bdf8" />

                <View>
                  <Text style={styles.compareSmallLabel}>Quedará en</Text>
                  <Text style={styles.compareNewWeight}>
                    ~{compressionService.formatBytes(estimatedCompressedBytes)}
                  </Text>
                </View>

                <View style={styles.savingsBadgeBox}>
                  <Text style={styles.savingsBadgeMain}>
                    ¡Ahorras ~{compressionService.formatBytes(estimatedSavedBytes)}!
                  </Text>
                  <Text style={styles.savingsBadgeSub}>Sin perder calidad</Text>
                </View>
              </View>

              {/* 3 Botones grandes y amigables para elegir cuánto bajar */}
              <View style={styles.presetsHorizontalRow}>
                {VIDEO_QUALITY_PRESETS.map((preset) => {
                  const isSelected = selectedPresetId === preset.id;
                  const friendlyTitle =
                    preset.id === 'high'
                      ? 'Calidad Alta'
                      : preset.id === 'balanced'
                      ? 'Recomendado'
                      : 'Súper Ligero';
                  const friendlySub =
                    preset.id === 'high'
                      ? 'Ahorra 40%'
                      : preset.id === 'balanced'
                      ? '⭐ Ahorra 60%'
                      : 'Ahorra 72%';
                  return (
                    <TouchableOpacity
                      key={preset.id}
                      style={[
                        styles.presetCompactCard,
                        isSelected && {
                          borderColor: preset.color,
                          backgroundColor: 'rgba(56, 189, 248, 0.15)',
                        },
                      ]}
                      onPress={() => setSelectedPresetId(preset.id)}
                      activeOpacity={0.85}
                    >
                      <Ionicons
                        name={preset.icon}
                        size={20}
                        color={isSelected ? preset.color : '#94a3b8'}
                      />
                      <Text
                        style={[
                          styles.presetCompactTitle,
                          isSelected && { color: '#ffffff' },
                        ]}
                        numberOfLines={1}
                      >
                        {friendlyTitle}
                      </Text>
                      <Text
                        style={[
                          styles.presetCompactSub,
                          isSelected && { color: preset.color, fontWeight: '800' },
                        ]}
                        numberOfLines={1}
                      >
                        {friendlySub}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {hasActiveTrim && (
                <TouchableOpacity
                  style={styles.combineTrimSwitchRow}
                  onPress={() => setApplyTrimOnCompress(!applyTrimOnCompress)}
                >
                  <Ionicons
                    name={applyTrimOnCompress ? 'checkbox' : 'square-outline'}
                    size={20}
                    color={applyTrimOnCompress ? '#38bdf8' : '#94a3b8'}
                  />
                  <Text style={styles.combineTrimSwitchText}>
                    Aplicar también el recorte que marqué ({formatTime(totalResultDuration)})
                  </Text>
                </TouchableOpacity>
              )}

              <View style={styles.bottomActionButtonsRow}>
                <TouchableOpacity
                  style={[styles.secondarySaveBtn, busy && { opacity: 0.5 }]}
                  onPress={() => handleExecuteCompress(false)}
                  disabled={busy}
                >
                  <Ionicons name="copy-outline" size={18} color="#ffffff" />
                  <Text style={styles.saveBtnText}>Guardar copia</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.primaryCompressSaveBtn, busy && { opacity: 0.5 }]}
                  onPress={() => handleExecuteCompress(true)}
                  disabled={busy}
                >
                  <Ionicons name="flash" size={18} color="#ffffff" />
                  <Text style={styles.saveBtnText}>Bajar peso al original</Text>
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
                {progressInfo.stage || 'Procesando tu video...'}
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
                {Math.round(clamp(progressInfo.percent || 0.08, 0.05, 1) * 100)}% completado
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
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#000000',
  },
  container: {
    flex: 1,
    width: '100%',
    backgroundColor: '#06080d',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#0b0f19',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    gap: 10,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#172033',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#293548',
  },
  backBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  headerCenter: {
    flex: 1,
  },
  title: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '700',
  },
  metaBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
  },
  sizeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#111827',
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
    fontSize: 11,
    fontWeight: '800',
  },
  resBadge: {
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  resBadgeText: {
    color: '#38bdf8',
    fontSize: 10.5,
    fontWeight: '700',
  },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconCircleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#172033',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoArea: {
    flex: 1,
    width: '100%',
    backgroundColor: '#000000',
    minHeight: 220,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  video: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  centerPlayOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  centerPlayCircle: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: 'rgba(37, 99, 235, 0.90)',
    borderWidth: 2,
    borderColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
  },
  centerPlayHint: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  seekFeedbackPill: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#38bdf8',
  },
  seekFeedbackText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
  },
  previewBanner: {
    position: 'absolute',
    bottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(6, 78, 59, 0.94)',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#10b981',
  },
  previewBannerText: {
    color: '#ecfdf5',
    fontSize: 12,
    fontWeight: '700',
  },
  bottomStudioDock: {
    backgroundColor: '#0b0f19',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 14,
    gap: 12,
  },
  modeSelectorBar: {
    flexDirection: 'row',
    backgroundColor: '#111827',
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: '#1f2937',
    gap: 4,
  },
  modeTabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
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
    color: '#cbd5e1',
    fontSize: 13,
    fontWeight: '700',
  },
  modeTabTextActive: {
    color: '#ffffff',
    fontWeight: '800',
  },
  activeDotIndicator: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#fde68a',
  },

  /* MODO 1: VER VIDEO AMIGABLE */
  playModeContainer: {
    gap: 12,
  },
  scrubberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  scrubberTimeText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 40,
    textAlign: 'center',
  },
  scrubberTrackHitArea: {
    flex: 1,
    height: 34,
    justifyContent: 'center',
    position: 'relative',
  },
  scrubberTrackBg: {
    height: 7,
    borderRadius: 4,
    backgroundColor: '#1e293b',
    overflow: 'hidden',
  },
  scrubberTrackFill: {
    height: '100%',
    backgroundColor: '#3b82f6',
  },
  scrubberThumb: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    marginLeft: -10,
    backgroundColor: '#ffffff',
    borderWidth: 3,
    borderColor: '#2563eb',
    elevation: 4,
  },
  friendlyMainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  friendlySkipBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#172033',
    paddingVertical: 13,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#293548',
  },
  friendlySkipText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  friendlyPlayPauseBtn: {
    flex: 1.4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#2563eb',
    paddingVertical: 13,
    borderRadius: 14,
    elevation: 4,
  },
  friendlyPlayPauseText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
  },
  friendlyToolsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  friendlyToolChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#131b2e',
    paddingVertical: 9,
    paddingHorizontal: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  friendlyToolChipActive: {
    borderColor: '#38bdf8',
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
  },
  friendlyToolChipMuted: {
    borderColor: '#f87171',
    backgroundColor: 'rgba(248, 113, 113, 0.14)',
  },
  friendlyToolChipText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '700',
  },

  /* MODO 2: RECORTAR AMIGABLE */
  trimModeContainer: {
    gap: 10,
  },
  trimSubmodeRow: {
    flexDirection: 'row',
    gap: 6,
  },
  trimSubmodePill: {
    flex: 1.3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: '#131b2e',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  trimSubmodePillSmall: {
    flex: 0.75,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 9,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: '#131b2e',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  trimSubmodePillKeep: {
    borderColor: '#f59e0b',
    backgroundColor: 'rgba(245, 158, 11, 0.18)',
  },
  trimSubmodePillDeleteCenter: {
    borderColor: '#ef4444',
    backgroundColor: 'rgba(239, 68, 68, 0.18)',
  },
  trimSubmodePillMulti: {
    borderColor: '#10b981',
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
  },
  trimSubmodeText: {
    color: '#94a3b8',
    fontSize: 11.5,
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
    paddingHorizontal: 2,
  },
  timeStepperGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  microStepBtn: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  microStepBtnText: {
    color: '#fde68a',
    fontSize: 10.5,
    fontWeight: '800',
  },
  friendlyTimeInfo: {
    color: '#94a3b8',
    fontSize: 11.5,
    fontWeight: '600',
  },
  friendlyTimeBold: {
    color: '#ffffff',
    fontWeight: '800',
  },
  resultDurationPill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: '#172033',
    borderWidth: 1,
    borderColor: '#f59e0b',
  },
  resultDurationText: {
    color: '#fde68a',
    fontSize: 12,
    fontWeight: '800',
  },
  filmstripTrack: {
    height: 52,
    marginHorizontal: 8,
    borderRadius: 10,
    backgroundColor: '#151d2e',
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
    height: 16,
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
    borderTopLeftRadius: 10,
    borderBottomLeftRadius: 10,
  },
  dimMaskRight: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(4, 7, 13, 0.72)',
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
  },
  selectionBoxKeep: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderTopWidth: 3,
    borderBottomWidth: 3,
    borderColor: '#f59e0b',
  },
  selectionBoxDeleteCenter: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(220, 38, 38, 0.48)',
    borderTopWidth: 3,
    borderBottomWidth: 3,
    borderColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteCenterLabel: {
    color: '#fecaca',
    fontSize: 9,
    fontWeight: '900',
  },
  handleHitBox: {
    position: 'absolute',
    top: -6,
    bottom: -6,
    width: 38,
    marginLeft: -19,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 35,
  },
  handleBarVisual: {
    width: 16,
    height: '100%',
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
  handleGripInner: {
    width: 3,
    height: 18,
    borderRadius: 1.5,
    backgroundColor: '#0f172a',
  },
  playheadNeedle: {
    position: 'absolute',
    top: -6,
    bottom: -6,
    width: 3,
    marginLeft: -1.5,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    zIndex: 25,
  },
  playheadTopKnob: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ffffff',
    marginTop: -2,
  },
  quickPrecisionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  miniPlayToggleBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  setPointBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.45)',
  },
  setPointBtnText: {
    color: '#fde68a',
    fontSize: 11.5,
    fontWeight: '800',
  },
  previewTrimBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 10,
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
    fontSize: 11.5,
    fontWeight: '800',
  },
  multiClipsCompactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addClipCompactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderWidth: 1,
    borderColor: '#10b981',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 9,
  },
  addClipCompactText: {
    color: '#d1fae5',
    fontSize: 11.5,
    fontWeight: '800',
  },
  savedClipsScroll: {
    alignItems: 'center',
    gap: 6,
  },
  multiEmptyHint: {
    color: '#64748b',
    fontSize: 11.5,
  },
  savedClipChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#172033',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2d3d59',
  },
  savedClipChipText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '700',
  },

  /* MODO 3: BAJAR PESO AMIGABLE */
  compressModeContainer: {
    gap: 10,
  },
  compressCompareBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#131b2e',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  compareSmallLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  compareOldWeight: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '800',
  },
  compareNewWeight: {
    color: '#34d399',
    fontSize: 15,
    fontWeight: '900',
  },
  savingsBadgeBox: {
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.35)',
    alignItems: 'flex-end',
  },
  savingsBadgeMain: {
    color: '#34d399',
    fontSize: 12,
    fontWeight: '800',
  },
  savingsBadgeSub: {
    color: '#94a3b8',
    fontSize: 10,
    fontWeight: '600',
  },
  presetsHorizontalRow: {
    flexDirection: 'row',
    gap: 8,
  },
  presetCompactCard: {
    flex: 1,
    backgroundColor: '#131b2e',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#1e293b',
    alignItems: 'center',
    gap: 3,
  },
  presetCompactTitle: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 2,
  },
  presetCompactSub: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '700',
  },
  combineTrimSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  combineTrimSwitchText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '600',
  },
  bottomActionButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  resetIconBtn: {
    width: 42,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#172033',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#293548',
  },
  secondarySaveBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  primaryTrimSaveBtn: {
    flex: 1.25,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#d97706',
  },
  primaryCompressSaveBtn: {
    flex: 1.25,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#0284c7',
  },
  saveBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(4, 7, 13, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    zIndex: 200,
  },
  busyCard: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#111827',
    borderRadius: 18,
    padding: 22,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1e293b',
    gap: 12,
  },
  busyTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'center',
  },
  busyBarBg: {
    width: '100%',
    height: 8,
    backgroundColor: '#1e293b',
    borderRadius: 4,
    overflow: 'hidden',
  },
  busyBarFill: {
    height: '100%',
    backgroundColor: '#38bdf8',
  },
  busyPctText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
  },
  scrubberTimeTextPrecision: {
    color: '#38bdf8',
    fontWeight: '800',
  },
  friendlyControlsMasterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
    marginVertical: 6,
  },
  friendlySkipBtnCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 12,
  },
  friendlySkipTextCompact: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '700',
  },
  frameStepBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderColor: 'rgba(56, 189, 248, 0.35)',
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 12,
  },
  frameStepBtnText: {
    color: '#7dd3fc',
    fontSize: 11,
    fontWeight: '800',
  },
  frameByFramePanel: {
    backgroundColor: '#111827',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
    gap: 7,
  },
  frameByFrameTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  frameByFrameTitle: {
    color: '#e0f2fe',
    fontSize: 12,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  frameByFrameHint: {
    color: '#94a3b8',
    fontSize: 10.5,
    fontWeight: '600',
  },
  frameButtonsStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  frameMultiBtn: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 8,
    paddingHorizontal: 9,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frameMultiBtnText: {
    color: '#cbd5e1',
    fontSize: 11.5,
    fontWeight: '800',
  },
  frameSingleActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    backgroundColor: '#0284c7',
    paddingVertical: 8,
    paddingHorizontal: 9,
    borderRadius: 10,
  },
  frameSingleActionText: {
    color: '#ffffff',
    fontSize: 11.5,
    fontWeight: '800',
  },
  frameJogWheel: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.45)',
    borderStyle: 'dashed',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 10,
  },
  frameJogWheelText: {
    color: '#7dd3fc',
    fontSize: 11,
    fontWeight: '800',
  },
  prominentCaptureBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#0284c7',
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 14,
    marginVertical: 4,
    shadowColor: '#0284c7',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 3,
  },
  prominentCaptureBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  floatingCaptureBtn: {
    position: 'absolute',
    top: 14,
    right: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    borderColor: '#38bdf8',
    borderWidth: 1.5,
    paddingVertical: 6,
    paddingHorizontal: 11,
    borderRadius: 20,
    zIndex: 10,
  },
  floatingCaptureText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
  },
  capturePreviewPill: {
    position: 'absolute',
    bottom: 16,
    left: 14,
    right: 14,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#18181b',
    borderColor: '#22c55e',
    borderWidth: 1.5,
    padding: 8,
    borderRadius: 14,
    zIndex: 30,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 8,
  },
  capturePreviewThumb: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: '#27272a',
  },
  capturePreviewTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  capturePreviewSubtitle: {
    color: '#a1a1aa',
    fontSize: 11,
    marginTop: 1,
  },
});
