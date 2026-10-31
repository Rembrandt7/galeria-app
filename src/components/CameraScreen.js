import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  StatusBar,
  BackHandler,
  NativeModules,
  DeviceEventEmitter,
  Platform,
  PermissionsAndroid,
  AppState,
  Modal,
  Linking,
  ScrollView,
  Image,
  requireNativeComponent,
  UIManager,
} from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Ionicons } from '@expo/vector-icons';
import { SEGUNDO_PLANO_FOLDER_URI } from '../services/folderService';

const { VideoEngineModule } = NativeModules;
const HAS_NATIVE_BG_RECORDER =
  Platform.OS === 'android' &&
  Boolean(VideoEngineModule?.startBackgroundVideoRecordNative);

const NativeBgCameraPreviewView =
  Platform.OS === 'android' &&
  UIManager.getViewManagerConfig &&
  UIManager.getViewManagerConfig('BgCameraPreviewView')
    ? requireNativeComponent('BgCameraPreviewView')
    : null;

const MAX_DURATION_SECONDS = 600; // 10 minutos exactos
const TARGET_DIR_URI = SEGUNDO_PLANO_FOLDER_URI || 'file:///storage/emulated/0/Movies/2do plano';

function formatTimer(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default function CameraScreen({
  visible,
  onClose,
  onOpen,
  onVideoSaved,
  onOpenSegundoPlano,
}) {
  const cameraRef = useRef(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [, requestMicPermission] = useMicrophonePermissions();
  const [hasCamPerm, setHasCamPerm] = useState(false);
  const [hasMicPerm, setHasMicPerm] = useState(false);

  // Selección de cámara con la que guarda ('ultrawide' | 'back' | 'front' | 'id:...')
  const [facing, setFacing] = useState('back');
  const [cameraSpec, setCameraSpec] = useState('ultrawide');
  const [availableCameras, setAvailableCameras] = useState([
    { cameraId: 'back_ultrawide', facing: 'back', label: 'Gran Angular', spec: 'ultrawide' },
    { cameraId: '0', facing: 'back', label: 'Trasera 1x', spec: 'back' },
    { cameraId: '1', facing: 'front', label: 'Frontal', spec: 'front' },
  ]);

  const [cameraMode] = useState('video');
  const [torchOn, setTorchOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);

  // Vista de cámara ENCENDIDA por defecto al abrir para que el usuario siempre vea el previo en vivo
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [previewFrameUri, setPreviewFrameUri] = useState(null);
  const [lastSavedBanner, setLastSavedBanner] = useState(null);

  // Motor nativo BVR (BackgroundVideoRecordService)
  const [usingNativeBgService, setUsingNativeBgService] = useState(false);

  // Modo pantalla bloqueada / oculta total (pantalla 100% negra simulando estar apagada)
  const [stealthLocked, setStealthLocked] = useState(false);
  const stealthLockedRef = useRef(false);
  stealthLockedRef.current = stealthLocked;
  const [stealthHintVisible, setStealthHintVisible] = useState(false);

  // Modo compacto: cuando isIconCollapsed === true se cierra el Modal y queda el Icono Flotante
  const [isIconCollapsed, setIsIconCollapsed] = useState(false);

  const timerRef = useRef(null);
  const lastTapRef = useRef(0);

  const loadAvailableCameras = useCallback(async () => {
    if (!VideoEngineModule?.getAvailableCamerasNative) return;
    try {
      const list = await VideoEngineModule.getAvailableCamerasNative();
      if (Array.isArray(list) && list.length > 0) {
        const formatted = [
          { cameraId: 'back_ultrawide', facing: 'back', label: 'Gran Angular', spec: 'ultrawide' },
          { cameraId: 'back_main', facing: 'back', label: 'Trasera 1x', spec: 'back' },
          { cameraId: 'front_main', facing: 'front', label: 'Frontal', spec: 'front' },
        ];
        for (const cam of list) {
          if (!cam || !cam.cameraId) continue;
          if (cam.cameraId !== '0' && cam.cameraId !== '1') {
            const lbl = String(cam.label || '');
            if (lbl.toLowerCase().includes('gran angular')) {
              continue;
            }
            formatted.push({
              cameraId: String(cam.cameraId),
              facing: cam.facing === 'front' ? 'front' : 'back',
              label: lbl || `Lente ${cam.cameraId}`,
              spec: `id:${cam.cameraId}`,
            });
          }
        }
        setAvailableCameras(formatted);
      }
    } catch (_e) {}
  }, []);

  const syncNativeRecorderState = useCallback(async () => {
    if (!HAS_NATIVE_BG_RECORDER || !VideoEngineModule?.getBackgroundVideoRecordStatusNative) return;
    try {
      const st = await VideoEngineModule.getBackgroundVideoRecordStatusNative();
      if (st && st.isRecording) {
        setUsingNativeBgService(true);
        setIsRecording(true);
        setIsPaused(Boolean(st.isPaused));
        setElapsed(st.elapsedSeconds || 0);
        if (st.facing) setFacing(st.facing);
        if (st.cameraSpec) setCameraSpec(st.cameraSpec);
        setTorchOn(Boolean(st.torchOn));
        setPreviewEnabled(Boolean(st.showFloatingPreview));
      }
    } catch (_e) {}
  }, []);

  const ensureCameraAndMicPermissions = useCallback(
    async (openSettingsIfBlocked = false) => {
      if (Platform.OS === 'android') {
        try {
          const camAlready = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
          const micAlready = await PermissionsAndroid.check(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
          );
          if (camAlready && micAlready) {
            setHasCamPerm(true);
            setHasMicPerm(true);
            return true;
          }
          const permsToRequest = [
            PermissionsAndroid.PERMISSIONS.CAMERA,
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          ];
          if (Platform.Version >= 33) {
            permsToRequest.push('android.permission.POST_NOTIFICATIONS');
          }
          const res = await PermissionsAndroid.requestMultiple(permsToRequest);
          const camOk =
            res[PermissionsAndroid.PERMISSIONS.CAMERA] === PermissionsAndroid.RESULTS.GRANTED ||
            camAlready;
          const micOk =
            res[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] ===
              PermissionsAndroid.RESULTS.GRANTED || micAlready;
          setHasCamPerm(camOk);
          setHasMicPerm(micOk);
          if (
            !camOk &&
            openSettingsIfBlocked &&
            res[PermissionsAndroid.PERMISSIONS.CAMERA] ===
              PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
          ) {
            Linking.openSettings();
          }
          return camOk;
        } catch (_e) {
          return false;
        }
      } else {
        const c = await requestCameraPermission();
        const m = await requestMicPermission();
        setHasCamPerm(Boolean(c?.granted));
        setHasMicPerm(Boolean(m?.granted));
        return Boolean(c?.granted);
      }
    },
    [requestCameraPermission, requestMicPermission]
  );

  // Revisar permisos silenciosamente al montar
  useEffect(() => {
    if (Platform.OS === 'android') {
      PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA)
        .then((ok) => setHasCamPerm(Boolean(ok)))
        .catch(() => {});
      PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
        .then((ok) => setHasMicPerm(Boolean(ok)))
        .catch(() => {});
    }
    loadAvailableCameras();
    syncNativeRecorderState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Al abrir el panel de cámara, descolapsar el icono
  useEffect(() => {
    if (visible) {
      setIsIconCollapsed(false);
    }
  }, [visible]);

  // Encender vista previa nativa cuando el panel modal está visible y la vista previa está activa
  useEffect(() => {
    const panelOpen = Boolean(visible && !isIconCollapsed);
    if (panelOpen) {
      loadAvailableCameras();
      syncNativeRecorderState();
      FileSystem.makeDirectoryAsync(TARGET_DIR_URI, { intermediates: true }).catch(() => {});
      ensureCameraAndMicPermissions(false).then((camOk) => {
        if (!camOk || !HAS_NATIVE_BG_RECORDER) return;
        if (previewEnabled) {
          VideoEngineModule.getBackgroundVideoRecordStatusNative?.()
            .then((st) => {
              if (st && st.isRecording) {
                VideoEngineModule.setBackgroundFloatingPreviewNative?.(true).catch(() => {});
              } else {
                VideoEngineModule.startCameraPreviewNative?.(
                  cameraSpec || facing,
                  torchOn
                ).catch(() => {});
              }
            })
            .catch(() => {
              VideoEngineModule.startCameraPreviewNative?.(
                cameraSpec || facing,
                torchOn
              ).catch(() => {});
            });
        }
      });
    } else {
      // Si se cierra el panel y NO está grabando, apagar la vista previa de cámara para liberar batería
      if (!isRecording && HAS_NATIVE_BG_RECORDER && VideoEngineModule?.stopCameraPreviewNative) {
        VideoEngineModule.stopCameraPreviewNative().catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, isIconCollapsed]);

  // Sincronizar al volver del segundo plano
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        if (Platform.OS === 'android') {
          PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA)
            .then((ok) => setHasCamPerm(Boolean(ok)))
            .catch(() => {});
          PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
            .then((ok) => setHasMicPerm(Boolean(ok)))
            .catch(() => {});
        }
        syncNativeRecorderState();
      }
    });
    return () => sub.remove();
  }, [syncNativeRecorderState]);

  // Suscripción a eventos del motor nativo BackgroundVideoRecordService
  useEffect(() => {
    if (!HAS_NATIVE_BG_RECORDER) return;

    const subFrame = DeviceEventEmitter.addListener('BackgroundRecordingPreviewFrame', (evt) => {
      if (evt && typeof evt.frame === 'string' && evt.frame.length > 0) {
        setPreviewFrameUri(evt.frame);
      }
    });

    const subStatus = DeviceEventEmitter.addListener('BackgroundRecordingStatus', (evt) => {
      if (!evt) return;
      const active = Boolean(evt.isRecording);
      setIsRecording(active);
      setIsPaused(Boolean(evt.isPaused));
      if (typeof evt.elapsedSeconds === 'number') {
        setElapsed(evt.elapsedSeconds);
      }
      if (typeof evt.facing === 'string') {
        setFacing(evt.facing);
      }
      if (typeof evt.cameraSpec === 'string' && evt.cameraSpec.length > 0) {
        setCameraSpec(evt.cameraSpec);
      }
      if (typeof evt.showFloatingPreview === 'boolean') {
        setPreviewEnabled(evt.showFloatingPreview);
      }
      if (typeof evt.torchOn === 'boolean') {
        setTorchOn(evt.torchOn);
      }
      if (!active) {
        setUsingNativeBgService(false);
        setStealthLocked(false);
      } else {
        setUsingNativeBgService(true);
      }
    });

    const subSaved = DeviceEventEmitter.addListener('BackgroundRecordingSaved', async (evt) => {
      setSaving(false);
      setIsRecording(false);
      setIsPaused(false);
      setUsingNativeBgService(false);

      const savedPath = evt?.path || evt?.uri || '';
      const fileName = savedPath.split('/').pop() || 'Video guardado';
      setLastSavedBanner({
        fileName,
        mediaType: evt?.mediaType || 'video',
        timestamp: Date.now(),
      });

      if (onVideoSaved) {
        onVideoSaved();
      }

      // Si el modal sigue abierto y el usuario tenía la vista prendida, reanudar vista previa en vivo
      if (visible && previewEnabled && VideoEngineModule?.startCameraPreviewNative) {
        setTimeout(() => {
          VideoEngineModule.startCameraPreviewNative(
            cameraSpec || facing,
            torchOn
          ).catch(() => {});
        }, 250);
      }
    });

    const subError = DeviceEventEmitter.addListener('BackgroundRecordingError', (evt) => {
      setSaving(false);
      setIsRecording(false);
      setIsPaused(false);
      setUsingNativeBgService(false);
      if (!stealthLockedRef.current && evt?.message) {
        Alert.alert('Aviso de Cámara 2do Plano', evt.message);
      }
    });

    syncNativeRecorderState();

    return () => {
      subFrame.remove();
      subStatus.remove();
      subSaved.remove();
      subError.remove();
    };
  }, [onVideoSaved, syncNativeRecorderState, visible, previewEnabled, cameraSpec, facing, torchOn]);

  // Botón físico Atrás de Android: colapsa a solo icono si está abierto
  useEffect(() => {
    if (!visible || isIconCollapsed) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stealthLocked) {
        setStealthLocked(false);
        return true;
      }
      if (isRecording) {
        setIsIconCollapsed(true);
        return true;
      }
      if (HAS_NATIVE_BG_RECORDER && VideoEngineModule?.stopCameraPreviewNative) {
        VideoEngineModule.stopCameraPreviewNative().catch(() => {});
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, isIconCollapsed, stealthLocked, isRecording, onClose]);

  // Cronómetro de respaldo solo cuando NO se usa el servicio nativo
  useEffect(() => {
    if (usingNativeBgService) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (isRecording) {
      setElapsed(0);
      timerRef.current = setInterval(() => {
        setElapsed((prev) => {
          if (prev >= MAX_DURATION_SECONDS - 1) {
            handleStopRecording();
            return MAX_DURATION_SECONDS;
          }
          return prev + 1;
        });
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording, usingNativeBgService]);

  // Manejar KeepAwake cuando está grabando o en pantalla bloqueada
  useEffect(() => {
    if (stealthLocked || isRecording) {
      activateKeepAwakeAsync('stealth-recording').catch(() => {});
    } else {
      deactivateKeepAwake('stealth-recording').catch(() => {});
    }
    return () => {
      deactivateKeepAwake('stealth-recording').catch(() => {});
    };
  }, [stealthLocked, isRecording]);

  // Tomar foto silenciosa y guardarla en "Archivos › 2do plano"
  const handleTakePhoto = async () => {
    if (saving) return;
    const granted = await ensureCameraAndMicPermissions(true);
    if (!granted) return;

    if (HAS_NATIVE_BG_RECORDER && VideoEngineModule?.takeCameraPhotoNative) {
      setSaving(true);
      try {
        if (!previewEnabled) {
          setPreviewEnabled(true);
          await VideoEngineModule.startCameraPreviewNative?.(cameraSpec || facing, torchOn);
          setTimeout(() => {
            VideoEngineModule.takeCameraPhotoNative().catch(() => setSaving(false));
          }, 450);
        } else {
          await VideoEngineModule.takeCameraPhotoNative();
        }
      } catch (_e) {
        setSaving(false);
      }
      return;
    }

    if (!cameraRef.current) return;
    setSaving(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.92,
        shutterSound: false,
      });
      if (photo?.uri) {
        await FileSystem.makeDirectoryAsync(TARGET_DIR_URI, { intermediates: true }).catch(() => {});
        const destUri = `${TARGET_DIR_URI}/IMG_2DO_${Date.now()}.jpg`;
        await FileSystem.copyAsync({ from: photo.uri, to: destUri }).catch(() => {});
        if (onVideoSaved) onVideoSaved();
      }
    } catch (_e) {
      Alert.alert('Error', 'No se pudo tomar la fotografía.');
    }
    setSaving(false);
  };

  const handleStartRecording = async () => {
    if (isRecording || saving) return;

    const granted = await ensureCameraAndMicPermissions(true);
    if (!granted) return;

    setLastSavedBanner(null);

    if (HAS_NATIVE_BG_RECORDER) {
      try {
        setUsingNativeBgService(true);
        setIsRecording(true);
        setIsPaused(false);
        setElapsed(0);
        await VideoEngineModule.startBackgroundVideoRecordNative(
          cameraSpec || facing,
          torchOn,
          previewEnabled,
          MAX_DURATION_SECONDS
        );
        return;
      } catch (_e) {
        setUsingNativeBgService(false);
        setIsRecording(false);
        Alert.alert('Error', 'No se pudo iniciar la grabación en 2do plano.');
        return;
      }
    }

    if (!cameraRef.current) return;
    try {
      setIsRecording(true);
      const video = await cameraRef.current.recordAsync({
        maxDuration: MAX_DURATION_SECONDS,
      });
      if (video?.uri) {
        setSaving(true);
        try {
          await FileSystem.makeDirectoryAsync(TARGET_DIR_URI, { intermediates: true }).catch(() => {});
          const destUri = `${TARGET_DIR_URI}/VID_2DO_${Date.now()}.mp4`;
          await FileSystem.copyAsync({ from: video.uri, to: destUri }).catch(() => {});
          if (onVideoSaved) onVideoSaved();
        } catch (_saveErr) {}
        setSaving(false);
      }
    } catch (_e) {
    } finally {
      setIsRecording(false);
      setStealthLocked(false);
    }
  };

  const handleStopRecording = async () => {
    if ((usingNativeBgService || isRecording) && HAS_NATIVE_BG_RECORDER) {
      setSaving(true);
      try {
        await VideoEngineModule.stopBackgroundVideoRecordNative();
      } catch (_e) {
        setSaving(false);
      }
      return;
    }
    if (cameraRef.current && isRecording) {
      try {
        cameraRef.current.stopRecording();
      } catch (_err) {}
      setIsRecording(false);
      setStealthLocked(false);
    }
  };

  const handleTogglePauseResume = async () => {
    if (!usingNativeBgService || !HAS_NATIVE_BG_RECORDER) return;
    try {
      if (isPaused) {
        await VideoEngineModule.resumeBackgroundVideoRecordNative();
        setIsPaused(false);
      } else {
        await VideoEngineModule.pauseBackgroundVideoRecordNative();
        setIsPaused(true);
      }
    } catch (_e) {}
  };

  // Prender o apagar la vista de cámara en cualquier momento (antes o durante la grabación)
  const handleTogglePreview = async () => {
    const granted = await ensureCameraAndMicPermissions(true);
    if (!granted) return;

    const nextVal = !previewEnabled;
    setPreviewEnabled(nextVal);

    if (HAS_NATIVE_BG_RECORDER) {
      if (isRecording || usingNativeBgService) {
        VideoEngineModule.setBackgroundFloatingPreviewNative?.(nextVal).catch(() => {});
      } else if (nextVal) {
        VideoEngineModule.startCameraPreviewNative?.(cameraSpec || facing, torchOn).catch(() => {});
      } else {
        VideoEngineModule.stopCameraPreviewNative?.().catch(() => {});
      }
    }
  };

  // Escoger con qué cámara guarda (Trasera / Frontal / Lente adicional), incluso mientras graba
  const handleSelectCamera = (camItem) => {
    if (!camItem) return;
    const nextFacing = camItem.facing === 'front' ? 'front' : 'back';
    const nextSpec = camItem.spec || nextFacing;
    setFacing(nextFacing);
    setCameraSpec(nextSpec);
    const nextTorch = nextFacing === 'front' ? false : torchOn;
    if (nextFacing === 'front' && torchOn) {
      setTorchOn(false);
    }
    if (HAS_NATIVE_BG_RECORDER) {
      if (isRecording || usingNativeBgService) {
        VideoEngineModule.switchBackgroundCameraNative?.(nextSpec).catch(() => {});
      } else if (previewEnabled) {
        VideoEngineModule.startCameraPreviewNative?.(nextSpec, nextTorch).catch(() => {});
      }
    }
  };

  const handleToggleTorch = () => {
    if (facing === 'front') return;
    const nextTorch = !torchOn;
    setTorchOn(nextTorch);
    if (HAS_NATIVE_BG_RECORDER) {
      VideoEngineModule.setBackgroundTorchNative?.(nextTorch).catch(() => {});
    }
  };

  const singleTapTimerRef = useRef(null);
  const [stealthActionDot, setStealthActionDot] = useState(null);

  // Modo Sigilo (Pantalla Negra Falsa):
  // - 1 toque: Toma foto silenciosa
  // - 2 toques rápidos: Inicia / Detiene grabación de video
  // - Dejar presionado: Salir de Pantalla Negra
  const handleStealthScreenTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 360) {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      lastTapRef.current = 0;
      if (isRecording) {
        setStealthActionDot('stop');
        handleStopRecording();
      } else {
        setStealthActionDot('rec');
        handleStartRecording();
      }
      setTimeout(() => setStealthActionDot(null), 900);
      return;
    }
    lastTapRef.current = now;
    if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
    singleTapTimerRef.current = setTimeout(() => {
      singleTapTimerRef.current = null;
      if (!isRecording && !saving) {
        setStealthActionDot('photo');
        handleTakePhoto();
        setTimeout(() => setStealthActionDot(null), 800);
      } else {
        setStealthHintVisible(true);
        setTimeout(() => setStealthHintVisible(false), 1800);
      }
    }, 365);
  };

  const handleFloatingIconPress = () => {
    setIsIconCollapsed(false);
    if (!visible && onOpen) {
      onOpen();
    }
  };

  const handleCloseOrCollapse = () => {
    if (isRecording) {
      setIsIconCollapsed(true);
    } else {
      if (HAS_NATIVE_BG_RECORDER && VideoEngineModule?.stopCameraPreviewNative) {
        VideoEngineModule.stopCameraPreviewNative().catch(() => {});
      }
      setIsIconCollapsed(false);
      onClose();
    }
  };

  const permissionsGranted = Boolean(hasCamPerm || cameraPermission?.granted);
  const isModalPanelOpen = Boolean(visible && !isIconCollapsed);

  return (
    <>
      {/* 1. ICONO FLOTANTE DE CÁMARA EN PANTALLA (Siempre accesible para abrir/controlar la cámara) */}
      <View style={styles.floatingQuickIconContainer} pointerEvents="box-none">
        <TouchableOpacity
          style={[
            styles.cameraFloatingIconBtn,
            isRecording && styles.cameraFloatingIconBtnRec,
            isPaused && styles.cameraFloatingIconBtnPaused,
          ]}
          onPress={handleFloatingIconPress}
          onLongPress={() => {
            if (isRecording) {
              handleStopRecording();
            }
          }}
          activeOpacity={0.85}
        >
          <Ionicons
            name={isRecording ? 'videocam' : 'camera'}
            size={23}
            color="#ffffff"
          />
          <View
            style={[
              styles.floatingIconStatusDot,
              {
                backgroundColor: isRecording
                  ? isPaused
                    ? '#f59e0b'
                    : '#ef4444'
                  : previewEnabled
                  ? '#10b981'
                  : '#38bdf8',
              },
            ]}
          />
          {isRecording && (
            <View style={styles.floatingIconTimerPill}>
              <Text style={styles.floatingIconTimerText}>{formatTimer(elapsed)}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* 2. MODAL NATIVO GARANTIZADO EN ANDROID AL ABRIR EL ICONO DE CÁMARA */}
      <Modal
        visible={isModalPanelOpen || stealthLocked}
        animationType="fade"
        transparent={!stealthLocked}
        statusBarTranslucent={true}
        onRequestClose={() => {
          if (stealthLocked) {
            setStealthLocked(false);
          } else {
            handleCloseOrCollapse();
          }
        }}
      >
        {stealthLocked ? (
          <View style={styles.fullBlackScreen}>
            <StatusBar hidden={true} backgroundColor="#000000" />
            <TouchableOpacity
              style={styles.fullBlackScreen}
              activeOpacity={1}
              onPress={handleStealthScreenTap}
              onLongPress={() => {
                setStealthLocked(false);
                setStealthHintVisible(false);
              }}
              delayLongPress={650}
            >
              {/* Reloj tenue tipo Always-On Display para parecer pantalla bloqueada */}
              <View style={{ alignItems: 'center', gap: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ color: '#1c1c21', fontSize: 38, fontWeight: '300', letterSpacing: 2 }}>
                    {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                  <View
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 2.5,
                      backgroundColor:
                        stealthActionDot === 'photo'
                          ? '#064e3b'
                          : isRecording
                          ? '#3f1515'
                          : '#18181b',
                    }}
                  />
                </View>
                {isRecording && (
                  <Text style={{ color: '#18181c', fontSize: 10 }}>
                    {formatTimer(elapsed)}
                  </Text>
                )}
              </View>

              {stealthHintVisible && (
                <View style={[styles.stealthHintBox, { marginTop: 24 }]}>
                  <Text style={styles.stealthHintText}>
                    1 toque: Foto · 2 toques: {isRecording ? 'Detener video' : 'Grabar video'}
                  </Text>
                  <Text style={styles.stealthHintSub}>
                    Mantén presionado para salir de Pantalla Negra
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.modalBackdrop}>
            {/* Toque fuera de la tarjeta para minimizar a icono o cerrar */}
            <TouchableOpacity
              style={StyleSheet.absoluteFillObject}
              activeOpacity={1}
              onPress={handleCloseOrCollapse}
            />

            <View style={styles.modalFloatingRightColumn} pointerEvents="box-none">
              {/* Icono superior derecho activo */}
              <TouchableOpacity
                style={[
                  styles.cameraFloatingIconBtn,
                  isRecording && styles.cameraFloatingIconBtnRec,
                  isPaused && styles.cameraFloatingIconBtnPaused,
                ]}
                onPress={() => setIsIconCollapsed(true)}
                activeOpacity={0.85}
              >
                <Ionicons
                  name={isRecording ? 'videocam' : 'camera'}
                  size={23}
                  color="#ffffff"
                />
                <View
                  style={[
                    styles.floatingIconStatusDot,
                    {
                      backgroundColor: isRecording
                        ? isPaused
                          ? '#f59e0b'
                          : '#ef4444'
                        : previewEnabled
                        ? '#10b981'
                        : '#38bdf8',
                    },
                  ]}
                />
              </TouchableOpacity>

              {/* Tarjeta desplegable de Cámara 2do Plano */}
              <View style={styles.compactCameraCard}>
                <ScrollView
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.cardScrollContent}
                >
                  {/* Encabezado del mini panel */}
                  <View style={styles.compactHeaderRow}>
                    <View style={styles.compactTitleWrap}>
                      <View
                        style={[
                          styles.headerStatusDot,
                          {
                            backgroundColor: isRecording
                              ? isPaused
                                ? '#f59e0b'
                                : '#ef4444'
                              : '#38bdf8',
                          },
                        ]}
                      />
                      <Text style={styles.compactTitleText} numberOfLines={1}>
                        {isRecording
                          ? isPaused
                            ? `Pausa · ${formatTimer(elapsed)}`
                            : `Grabando · ${formatTimer(elapsed)}`
                          : 'Cámara 2do Plano'}
                      </Text>
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {/* Minimizar a solo icono */}
                      <TouchableOpacity
                        style={styles.headerMiniIconBtn}
                        onPress={() => setIsIconCollapsed(true)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="contract-outline" size={15} color="#38bdf8" />
                      </TouchableOpacity>

                      {/* Cerrar */}
                      <TouchableOpacity
                        style={styles.headerMiniIconBtn}
                        onPress={handleCloseOrCollapse}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="close" size={16} color="#94a3b8" />
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* Insignia de carpeta destino (tocable para ir directo a Archivos > 2do plano) */}
                  <TouchableOpacity
                    style={styles.folderTargetBadge}
                    activeOpacity={0.8}
                    onPress={() => {
                      if (onOpenSegundoPlano) {
                        handleCloseOrCollapse();
                        onOpenSegundoPlano();
                      }
                    }}
                  >
                    <Ionicons name="pin" size={11} color="#f87171" />
                    <Text style={styles.folderTargetText} numberOfLines={1}>
                      Guarda en: Archivos › 2do plano
                    </Text>
                    <Ionicons name="open-outline" size={12} color="#fca5a5" />
                  </TouchableOpacity>

                  {/* Banner de confirmación al guardar un video o foto */}
                  {lastSavedBanner && (
                    <TouchableOpacity
                      style={styles.savedSuccessBanner}
                      activeOpacity={0.85}
                      onPress={() => {
                        if (onOpenSegundoPlano) {
                          handleCloseOrCollapse();
                          onOpenSegundoPlano();
                        }
                      }}
                    >
                      <Ionicons name="checkmark-circle" size={16} color="#34d399" />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.savedSuccessTitle} numberOfLines={1}>
                          ¡Guardado en 2do plano!
                        </Text>
                        <Text style={styles.savedSuccessSub} numberOfLines={1}>
                          Toca aquí para abrir la carpeta 2do plano ›
                        </Text>
                      </View>
                    </TouchableOpacity>
                  )}

                  {!permissionsGranted ? (
                    <TouchableOpacity
                      style={styles.grantPermBtn}
                      onPress={() => ensureCameraAndMicPermissions(true)}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="shield-checkmark-outline" size={16} color="#ffffff" />
                      <Text style={styles.grantPermBtnText}>Conceder permiso de Cámara</Text>
                    </TouchableOpacity>
                  ) : (
                    <>
                      {/* RECUADRO DE VISTA EN VIVO DE CÁMARA (SOLO SALE SI ESTÁ PRENDIDO, NUNCA CUANDO ESTÁ APAGADO) */}
                      {previewEnabled ? (
                        <View style={styles.livePreviewBox}>
                          {HAS_NATIVE_BG_RECORDER ? (
                            <>
                              {NativeBgCameraPreviewView ? (
                                <NativeBgCameraPreviewView style={StyleSheet.absoluteFillObject} />
                              ) : previewFrameUri ? (
                                <Image
                                  source={{ uri: previewFrameUri }}
                                  style={StyleSheet.absoluteFillObject}
                                  resizeMode="cover"
                                  fadeDuration={0}
                                />
                              ) : null}
                              {!previewFrameUri && (
                                <View
                                  style={[
                                    StyleSheet.absoluteFillObject,
                                    styles.previewLoadingCenter,
                                  ]}
                                  pointerEvents="none"
                                >
                                  <ActivityIndicator size="small" color="#34d399" />
                                  <Text style={styles.previewLoadingText}>
                                    Abriendo lente{' '}
                                    {facing === 'front'
                                      ? 'Frontal'
                                      : cameraSpec === 'ultrawide'
                                      ? 'Gran Angular'
                                      : 'Trasera'}
                                    ...
                                  </Text>
                                </View>
                              )}
                            </>
                          ) : (
                            <CameraView
                              ref={cameraRef}
                              style={StyleSheet.absoluteFillObject}
                              facing={facing}
                              mode={cameraMode}
                              enableTorch={torchOn}
                              animateShutter={false}
                              mute={!hasMicPerm}
                            />
                          )}
                          <View style={styles.previewOverlayBadge}>
                            <Ionicons
                              name={isRecording ? 'radio-button-on' : 'eye'}
                              size={11}
                              color={isRecording ? '#ef4444' : '#10b981'}
                            />
                            <Text style={styles.previewOverlayBadgeText}>
                              {isRecording
                                ? `Grabando (${
                                    facing === 'front'
                                      ? 'Frontal'
                                      : cameraSpec === 'ultrawide'
                                      ? 'Gran Angular'
                                      : 'Trasera'
                                  }) · ${formatTimer(elapsed)}`
                                : facing === 'front'
                                ? 'Frontal en vivo'
                                : cameraSpec === 'ultrawide'
                                ? 'Gran Angular en vivo'
                                : 'Trasera 1x en vivo'}
                            </Text>
                          </View>
                        </View>
                      ) : null}

                      {/* BOTÓN PRENDER / APAGAR LA VISTA */}
                      <TouchableOpacity
                        style={[
                          styles.toggleViewBtn,
                          previewEnabled && styles.toggleViewBtnActive,
                        ]}
                        onPress={handleTogglePreview}
                        activeOpacity={0.82}
                      >
                        <Ionicons
                          name={previewEnabled ? 'eye' : 'eye-outline'}
                          size={16}
                          color="#ffffff"
                        />
                        <Text style={styles.toggleViewBtnText}>
                          {previewEnabled
                            ? 'Apagar Vista (Seguir Oculto)'
                            : 'Prender Vista de Cámara'}
                        </Text>
                      </TouchableOpacity>

                      {/* SELECTOR: CON QUÉ CÁMARA GUARDA */}
                      <View style={styles.cameraSelectorSection}>
                        <Text style={styles.sectionMiniLabel}>¿Con qué cámara guarda?</Text>
                        <View style={styles.cameraChipsRow}>
                          {availableCameras.map((cam) => {
                            const isSelected = cameraSpec === cam.spec;
                            return (
                              <TouchableOpacity
                                key={`cam_opt_${cam.spec}`}
                                style={[
                                  styles.cameraSelectChip,
                                  isSelected && styles.cameraSelectChipActive,
                                ]}
                                onPress={() => handleSelectCamera(cam)}
                                activeOpacity={0.8}
                              >
                                <Ionicons
                                  name={
                                    cam.facing === 'front'
                                      ? 'person-circle-outline'
                                      : 'camera-outline'
                                  }
                                  size={14}
                                  color={isSelected ? '#ffffff' : '#94a3b8'}
                                />
                                <Text
                                  style={[
                                    styles.cameraSelectChipText,
                                    isSelected && styles.cameraSelectChipTextActive,
                                  ]}
                                  numberOfLines={1}
                                >
                                  {cam.label}
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </View>

                      {/* CONTROLES PRINCIPALES DE GRABACIÓN Y FOTO */}
                      <View style={styles.mainControlsRow}>
                        {/* Grabar / Detener Video 2do Plano */}
                        <TouchableOpacity
                          style={[
                            styles.primaryRecordBtn,
                            isRecording && styles.primaryRecordBtnStop,
                          ]}
                          onPress={isRecording ? handleStopRecording : handleStartRecording}
                          disabled={saving}
                          activeOpacity={0.85}
                        >
                          {saving ? (
                            <ActivityIndicator size="small" color="#ffffff" />
                          ) : (
                            <>
                              <Ionicons
                                name={isRecording ? 'stop' : 'radio-button-on'}
                                size={16}
                                color="#ffffff"
                              />
                              <Text style={styles.primaryRecordBtnText}>
                                {isRecording ? 'Detener y Guardar' : 'Grabar 2do Plano'}
                              </Text>
                            </>
                          )}
                        </TouchableOpacity>

                        {/* Pausar / Reanudar (cuando está grabando) o Foto Silenciosa (cuando está libre) */}
                        {isRecording && usingNativeBgService ? (
                          <TouchableOpacity
                            style={[
                              styles.secondaryIconBtn,
                              isPaused && {
                                backgroundColor: '#d97706',
                                borderColor: '#fbbf24',
                              },
                            ]}
                            onPress={handleTogglePauseResume}
                            activeOpacity={0.82}
                          >
                            <Ionicons
                              name={isPaused ? 'play' : 'pause'}
                              size={16}
                              color="#ffffff"
                            />
                          </TouchableOpacity>
                        ) : (
                          <TouchableOpacity
                            style={styles.secondaryIconBtn}
                            onPress={handleTakePhoto}
                            disabled={saving}
                            activeOpacity={0.82}
                          >
                            <Ionicons name="camera" size={16} color="#38bdf8" />
                          </TouchableOpacity>
                        )}

                        {/* Linterna / Flash */}
                        <TouchableOpacity
                          style={[
                            styles.secondaryIconBtn,
                            torchOn && {
                              backgroundColor: '#d97706',
                              borderColor: '#fbbf24',
                            },
                            facing === 'front' && { opacity: 0.35 },
                          ]}
                          onPress={handleToggleTorch}
                          disabled={facing === 'front'}
                          activeOpacity={0.82}
                        >
                          <Ionicons
                            name={torchOn ? 'flash' : 'flash-off-outline'}
                            size={16}
                            color="#ffffff"
                          />
                        </TouchableOpacity>
                      </View>

                      {/* FILA DE DISCRECIÓN: Dejar solo Icono | Pantalla 100% Negra */}
                      <View style={styles.discreetFooterRow}>
                        <TouchableOpacity
                          style={styles.discreetFooterBtn}
                          onPress={() => setIsIconCollapsed(true)}
                          activeOpacity={0.8}
                        >
                          <Ionicons name="radio-button-off" size={13} color="#38bdf8" />
                          <Text style={styles.discreetFooterBtnText}>Solo Icono</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.discreetFooterBtn}
                          onPress={() => setStealthLocked(true)}
                          activeOpacity={0.8}
                        >
                          <Ionicons name="moon-outline" size={13} color="#a1a1aa" />
                          <Text style={styles.discreetFooterBtnText}>Pantalla Negra</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </ScrollView>
              </View>
            </View>
          </View>
        )}
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  floatingQuickIconContainer: {
    position: 'absolute',
    bottom: Platform.OS === 'android' ? 104 : 90,
    right: 14,
    zIndex: 999,
    elevation: 24,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
    paddingTop: Platform.OS === 'android' ? Math.max((StatusBar.currentHeight || 36) + 14, 52) : 54,
    paddingBottom: Platform.OS === 'android' ? 52 : 34,
    paddingHorizontal: 12,
  },
  modalFloatingRightColumn: {
    flex: 1,
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
    marginTop: 42,
  },
  cameraFloatingIconBtn: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#0f172a',
    borderWidth: 2,
    borderColor: '#38bdf8',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 20,
  },
  cameraFloatingIconBtnRec: {
    backgroundColor: '#2a0a10',
    borderColor: '#ef4444',
  },
  cameraFloatingIconBtnPaused: {
    borderColor: '#f59e0b',
  },
  floatingIconStatusDot: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: '#090d16',
  },
  floatingIconTimerPill: {
    position: 'absolute',
    bottom: -9,
    backgroundColor: '#dc2626',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  floatingIconTimerText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '800',
  },
  compactCameraCard: {
    marginTop: 10,
    width: 286,
    maxHeight: '82%',
    backgroundColor: '#0c101a',
    borderRadius: 18,
    padding: 13,
    borderWidth: 1.2,
    borderColor: 'rgba(56, 189, 248, 0.42)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.65,
    shadowRadius: 16,
    elevation: 24,
  },
  cardScrollContent: {
    gap: 9,
  },
  compactHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  compactTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flex: 1,
  },
  headerStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  compactTitleText: {
    color: '#ffffff',
    fontSize: 13.5,
    fontWeight: '800',
  },
  headerMiniIconBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  folderTargetBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.35)',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 9,
  },
  folderTargetText: {
    color: '#fecaca',
    fontSize: 10.5,
    fontWeight: '700',
    flex: 1,
  },
  savedSuccessBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(52, 211, 153, 0.5)',
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 9,
  },
  savedSuccessTitle: {
    color: '#d1fae5',
    fontSize: 11,
    fontWeight: '800',
  },
  savedSuccessSub: {
    color: '#6ee7b7',
    fontSize: 10,
    fontWeight: '700',
  },
  grantPermBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#2563eb',
    paddingVertical: 11,
    borderRadius: 10,
  },
  grantPermBtnText: {
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: '700',
  },
  livePreviewBox: {
    width: '100%',
    height: 196,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#050811',
    borderWidth: 1.5,
    borderColor: '#10b981',
  },
  previewLoadingCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  previewLoadingText: {
    color: '#a7f3d0',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  previewOffBox: {
    width: '100%',
    paddingVertical: 16,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.28)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  previewOffTitle: {
    color: '#e2e8f0',
    fontSize: 11.5,
    fontWeight: '800',
  },
  previewOffSub: {
    color: '#38bdf8',
    fontSize: 10.5,
    fontWeight: '700',
  },
  previewOverlayBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
  },
  previewOverlayBadgeText: {
    color: '#ecfdf5',
    fontSize: 10,
    fontWeight: '700',
  },
  toggleViewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#0284c7',
    borderWidth: 1,
    borderColor: '#38bdf8',
    paddingVertical: 8.5,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  toggleViewBtnActive: {
    backgroundColor: '#059669',
    borderColor: '#34d399',
  },
  toggleViewBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  cameraSelectorSection: {
    gap: 5,
  },
  sectionMiniLabel: {
    color: '#94a3b8',
    fontSize: 10.5,
    fontWeight: '700',
  },
  cameraChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  cameraSelectChip: {
    flex: 1,
    minWidth: 78,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#18181b',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderRadius: 9,
  },
  cameraSelectChipActive: {
    backgroundColor: '#2563eb',
    borderColor: '#60a5fa',
  },
  cameraSelectChipText: {
    color: '#a1a1aa',
    fontSize: 11,
    fontWeight: '700',
  },
  cameraSelectChipTextActive: {
    color: '#ffffff',
    fontWeight: '800',
  },
  mainControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  primaryRecordBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#dc2626',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 11,
  },
  primaryRecordBtnStop: {
    backgroundColor: '#b91c1c',
    borderWidth: 1,
    borderColor: '#fca5a5',
  },
  primaryRecordBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  secondaryIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 11,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  discreetFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  discreetFooterBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#18181b',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    paddingVertical: 6.5,
    borderRadius: 9,
  },
  discreetFooterBtnText: {
    color: '#cbd5e1',
    fontSize: 10.5,
    fontWeight: '700',
  },
  fullBlackScreen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  stealthHintBox: {
    alignItems: 'center',
    gap: 6,
    padding: 18,
    backgroundColor: 'rgba(18, 18, 18, 0.92)',
    borderRadius: 14,
  },
  stealthHintText: {
    color: '#888888',
    fontSize: 12.5,
    fontWeight: '700',
  },
  stealthHintSub: {
    color: '#555555',
    fontSize: 11,
  },
});
