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
} from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import {
  SEGUNDO_PLANO_FOLDER_NAME,
  SEGUNDO_PLANO_FOLDER_URI,
} from '../services/folderService';

const { VideoEngineModule } = NativeModules;
const HAS_NATIVE_BG_RECORDER =
  Platform.OS === 'android' &&
  Boolean(VideoEngineModule?.startBackgroundVideoRecordNative);

const MAX_DURATION_SECONDS = 600; // 10 minutos exactos
const ALBUM_NAME = SEGUNDO_PLANO_FOLDER_NAME || '2do plano';
const TARGET_DIR_URI = SEGUNDO_PLANO_FOLDER_URI || 'file:///storage/emulated/0/Movies/2do plano';

function formatTimer(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default function CameraScreen({ visible, onClose, onVideoSaved }) {
  const cameraRef = useRef(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const [hasCamPerm, setHasCamPerm] = useState(false);
  const [hasMicPerm, setHasMicPerm] = useState(false);

  // Selección de cámara con la que guarda ('back' | 'front' | 'id:...')
  const [facing, setFacing] = useState('back');
  const [cameraSpec, setCameraSpec] = useState('back');
  const [availableCameras, setAvailableCameras] = useState([
    { cameraId: '0', facing: 'back', label: 'Trasera', spec: 'back' },
    { cameraId: '1', facing: 'front', label: 'Frontal', spec: 'front' },
  ]);

  const [cameraMode, setCameraMode] = useState('video'); // 'video' | 'picture'
  const [torchOn, setTorchOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);

  // Control de "Prender Vista / Apagar Vista" (por defecto apagada para discreción, prendible con 1 toque)
  const [previewEnabled, setPreviewEnabled] = useState(false);

  // Motor nativo BVR 3.0.1 (RecordService1)
  const [usingNativeBgService, setUsingNativeBgService] = useState(false);
  const [hasOverlayPermission, setHasOverlayPermission] = useState(true);

  // Modo pantalla bloqueada / oculta total (pantalla 100% negra simulando estar apagada)
  const [stealthLocked, setStealthLocked] = useState(false);
  const stealthLockedRef = useRef(false);
  stealthLockedRef.current = stealthLocked;
  const [stealthHintVisible, setStealthHintVisible] = useState(false);

  // Modo compacto: cuando isIconCollapsed === true se muestra únicamente el Icono Flotante de cámara
  const [isIconCollapsed, setIsIconCollapsed] = useState(false);
  const isIconCollapsedRef = useRef(false);
  isIconCollapsedRef.current = isIconCollapsed;

  const timerRef = useRef(null);
  const lastTapRef = useRef(0);

  const loadAvailableCameras = useCallback(async () => {
    if (!VideoEngineModule?.getAvailableCamerasNative) return;
    try {
      const list = await VideoEngineModule.getAvailableCamerasNative();
      if (Array.isArray(list) && list.length > 0) {
        const formatted = [
          { cameraId: 'back_main', facing: 'back', label: 'Trasera', spec: 'back' },
          { cameraId: 'front_main', facing: 'front', label: 'Frontal', spec: 'front' },
        ];
        // Agregar lentes adicionales si el teléfono expone más de 2 cámaras en Camera2
        for (const cam of list) {
          if (!cam || !cam.cameraId) continue;
          if (cam.cameraId !== '0' && cam.cameraId !== '1') {
            formatted.push({
              cameraId: String(cam.cameraId),
              facing: cam.facing === 'front' ? 'front' : 'back',
              label: cam.label || `Lente ${cam.cameraId}`,
              spec: `id:${cam.cameraId}`,
            });
          }
        }
        setAvailableCameras(formatted);
      }
    } catch (_e) {}
  }, []);

  const checkOverlayStatus = useCallback(async () => {
    if (!HAS_NATIVE_BG_RECORDER || !VideoEngineModule?.canDrawOverlaysNative) return;
    try {
      const ok = await VideoEngineModule.canDrawOverlaysNative();
      setHasOverlayPermission(Boolean(ok));
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
          if (camOk && !cameraPermission?.granted) {
            requestCameraPermission().catch(() => {});
          }
          if (micOk && !micPermission?.granted) {
            requestMicPermission().catch(() => {});
          }
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
    [cameraPermission?.granted, micPermission?.granted, requestCameraPermission, requestMicPermission]
  );

  // Asegurar carpeta "2do plano" y permisos al abrir
  useEffect(() => {
    if (visible) {
      setIsIconCollapsed(false);
      ensureCameraAndMicPermissions(false);
      checkOverlayStatus();
      loadAvailableCameras();
      syncNativeRecorderState();
      FileSystem.makeDirectoryAsync(TARGET_DIR_URI, { intermediates: true }).catch(() => {});
    }
  }, [visible, ensureCameraAndMicPermissions, checkOverlayStatus, loadAvailableCameras, syncNativeRecorderState]);

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
        checkOverlayStatus();
        syncNativeRecorderState();
      }
    });
    return () => sub.remove();
  }, [checkOverlayStatus, syncNativeRecorderState]);

  const registerFileInSegundoPlanoAlbum = useCallback(
    async (fileUri) => {
      try {
        const asset = await MediaLibrary.createAssetAsync(fileUri);
        let album = await MediaLibrary.getAlbumAsync(ALBUM_NAME);
        if (!album) {
          await MediaLibrary.createAlbumAsync(ALBUM_NAME, asset, false);
        } else {
          await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
        }
      } catch (_err) {
        try {
          await MediaLibrary.saveToLibraryAsync(fileUri);
        } catch (_e2) {}
      }
      if (onVideoSaved) onVideoSaved();
    },
    [onVideoSaved]
  );

  // Suscripción a eventos del motor nativo BackgroundVideoRecordService (BVR 3.0.1)
  useEffect(() => {
    if (!HAS_NATIVE_BG_RECORDER) return;

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
      setSaving(true);
      try {
        const savedUri = evt?.uri;
        if (savedUri) {
          await registerFileInSegundoPlanoAlbum(savedUri);
        } else if (onVideoSaved) {
          onVideoSaved();
        }
      } catch (_e) {
      } finally {
        setSaving(false);
        setIsRecording(false);
        setIsPaused(false);
        setUsingNativeBgService(false);
        setStealthLocked(false);
      }
    });

    const subError = DeviceEventEmitter.addListener('BackgroundRecordingError', (evt) => {
      setIsRecording(false);
      setIsPaused(false);
      setUsingNativeBgService(false);
      setStealthLocked(false);
      if (!stealthLockedRef.current && evt?.message) {
        Alert.alert('Aviso de Grabación 2do Plano', evt.message);
      }
    });

    syncNativeRecorderState();

    return () => {
      subStatus.remove();
      subSaved.remove();
      subError.remove();
    };
  }, [registerFileInSegundoPlanoAlbum, onVideoSaved, syncNativeRecorderState]);

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

  const saveMediaFileToSegundoPlano = async (fileUri, prefix = 'IMG', ext = 'jpg') => {
    let destUri = fileUri;
    try {
      await FileSystem.makeDirectoryAsync(TARGET_DIR_URI, { intermediates: true }).catch(() => {});
      destUri = `${TARGET_DIR_URI}/${prefix}_2DO_${Date.now()}.${ext}`;
      await FileSystem.copyAsync({ from: fileUri, to: destUri });
    } catch (_ePhys) {
      destUri = fileUri;
    }
    await registerFileInSegundoPlanoAlbum(destUri);
  };

  // Tomar foto 100% silenciosa y guardarla en "2do plano"
  const handleTakePhoto = async () => {
    if (saving) return;
    if (!previewEnabled) {
      setPreviewEnabled(true);
      setTimeout( async () => {
        if (!cameraRef.current) return;
        setSaving(true);
        try {
          const photo = await cameraRef.current.takePictureAsync({
            quality: 0.92,
            shutterSound: false,
          });
          if (photo?.uri) {
            await saveMediaFileToSegundoPlano(photo.uri, 'IMG', 'jpg');
          }
        } catch (_e) {}
        setSaving(false);
      }, 450);
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
        await saveMediaFileToSegundoPlano(photo.uri, 'IMG', 'jpg');
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

    if (HAS_NATIVE_BG_RECORDER) {
      try {
        setUsingNativeBgService(true);
        setIsRecording(true);
        setIsPaused(false);
        setElapsed(0);
        // Dar tiempo breve si la vista previa local estaba activa para liberar la cámara antes del Servicio Nativo
        const waitMs = previewEnabled ? 380 : 60;
        setTimeout(async () => {
          try {
            await VideoEngineModule.startBackgroundVideoRecordNative(
              cameraSpec || facing,
              torchOn,
              previewEnabled,
              MAX_DURATION_SECONDS
            );
          } catch (_err) {
            setUsingNativeBgService(false);
            setIsRecording(false);
            Alert.alert('Error', 'No se pudo iniciar la grabación en 2do plano.');
          }
        }, waitMs);
        return;
      } catch (_e) {
        setUsingNativeBgService(false);
        setIsRecording(false);
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
          await saveMediaFileToSegundoPlano(video.uri, 'VID', 'mp4');
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
    if (usingNativeBgService && HAS_NATIVE_BG_RECORDER) {
      try {
        await VideoEngineModule.stopBackgroundVideoRecordNative();
      } catch (_e) {}
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
    const nextVal = !previewEnabled;
    if (usingNativeBgService && HAS_NATIVE_BG_RECORDER) {
      if (nextVal && !hasOverlayPermission) {
        Alert.alert(
          'Activar Vista en 2do Plano',
          'Para prender la vista flotante mientras graba en 2do plano, activa una sola vez el permiso "Aparecer encima" para Mi Galería.',
          [
            { text: 'Cancelar', style: 'cancel' },
            {
              text: 'Activar permiso',
              onPress: () => {
                VideoEngineModule.requestOverlayPermissionNative().catch(() => {});
              },
            },
          ]
        );
        return;
      }
      setPreviewEnabled(nextVal);
      VideoEngineModule.setBackgroundFloatingPreviewNative(nextVal).catch(() => {});
      return;
    }
    setPreviewEnabled(nextVal);
  };

  // Escoger con qué cámara guarda (Trasera / Frontal / Lente adicional), incluso mientras graba
  const handleSelectCamera = (camItem) => {
    if (!camItem) return;
    const nextFacing = camItem.facing === 'front' ? 'front' : 'back';
    const nextSpec = camItem.spec || nextFacing;
    setFacing(nextFacing);
    setCameraSpec(nextSpec);
    if (nextFacing === 'front' && torchOn) {
      setTorchOn(false);
    }
    if (usingNativeBgService && HAS_NATIVE_BG_RECORDER && VideoEngineModule?.switchBackgroundCameraNative) {
      VideoEngineModule.switchBackgroundCameraNative(nextSpec).catch(() => {});
    }
  };

  const handleToggleTorch = () => {
    if (facing === 'front') return;
    const nextTorch = !torchOn;
    setTorchOn(nextTorch);
    if (usingNativeBgService && HAS_NATIVE_BG_RECORDER) {
      VideoEngineModule.setBackgroundTorchNative(nextTorch).catch(() => {});
    }
  };

  // Doble toque para salir de la pantalla 100% negra
  const handleStealthScreenTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 400) {
      setStealthLocked(false);
      setStealthHintVisible(false);
    } else {
      setStealthHintVisible(true);
      setTimeout(() => setStealthHintVisible(false), 2500);
    }
    lastTapRef.current = now;
  };

  if (!visible && !isRecording) return null;

  const permissionsGranted = Boolean(hasCamPerm || cameraPermission?.granted);

  // Si el usuario activó "Pantalla 100% Negra" (simula celular apagado mientras graba)
  if (stealthLocked) {
    return (
      <Modal
        visible={true}
        animationType="fade"
        transparent={false}
        statusBarTranslucent={true}
        onRequestClose={() => setStealthLocked(false)}
      >
        <StatusBar hidden={true} backgroundColor="#000000" />
        <TouchableOpacity
          style={styles.fullBlackScreen}
          activeOpacity={1}
          onPress={handleStealthScreenTap}
        >
          {stealthHintVisible && (
            <View style={styles.stealthHintBox}>
              <Ionicons name="lock-closed" size={22} color="#666666" />
              <Text style={styles.stealthHintText}>
                Grabando en "2do plano" ({formatTimer(elapsed)})
              </Text>
              <Text style={styles.stealthHintSub}>
                Toca 2 veces rápido para mostrar el icono
              </Text>
            </View>
          )}
        </TouchableOpacity>
      </Modal>
    );
  }

  return (
    <View style={styles.floatingOverlayRoot} pointerEvents="box-none">
      {/* 1. BOTÓN ICONO FLOTANTE DE CÁMARA (Siempre visible cuando está activo o minimizado) */}
      <View style={styles.floatingAnchorWrap} pointerEvents="box-none">
        <TouchableOpacity
          style={[
            styles.cameraFloatingIconBtn,
            isRecording && styles.cameraFloatingIconBtnRec,
            isPaused && styles.cameraFloatingIconBtnPaused,
          ]}
          onPress={() => setIsIconCollapsed((prev) => !prev)}
          onLongPress={() => {
            if (isRecording) {
              handleStopRecording();
            }
          }}
          activeOpacity={0.85}
        >
          <Ionicons
            name={isRecording ? 'videocam' : 'camera'}
            size={24}
            color="#ffffff"
          />
          {/* Punto indicador de estado */}
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

        {/* 2. MINI PANEL COMPACTO DESPLEGABLE AL TOCAR EL ICONO */}
        {!isIconCollapsed && visible && (
          <View style={styles.compactCameraCard}>
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
                {/* Dejar solo como icono */}
                <TouchableOpacity
                  style={styles.headerMiniIconBtn}
                  onPress={() => setIsIconCollapsed(true)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="contract-outline" size={15} color="#38bdf8" />
                </TouchableOpacity>

                {/* Cerrar si no está grabando (o minimizar si graba) */}
                <TouchableOpacity
                  style={styles.headerMiniIconBtn}
                  onPress={() => {
                    if (isRecording) {
                      setIsIconCollapsed(true);
                    } else {
                      setPreviewEnabled(false);
                      onClose();
                    }
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close" size={16} color="#94a3b8" />
                </TouchableOpacity>
              </View>
            </View>

            {/* Insignia de carpeta destino: Archivos > 2do plano */}
            <View style={styles.folderTargetBadge}>
              <Ionicons name="pin" size={11} color="#f87171" />
              <Text style={styles.folderTargetText} numberOfLines={1}>
                Guarda en: Archivos › 2do plano
              </Text>
            </View>

            {!permissionsGranted ? (
              <TouchableOpacity
                style={styles.grantPermBtn}
                onPress={() => ensureCameraAndMicPermissions(true)}
                activeOpacity={0.85}
              >
                <Ionicons name="shield-checkmark-outline" size={15} color="#ffffff" />
                <Text style={styles.grantPermBtnText}>Activar permiso de Cámara</Text>
              </TouchableOpacity>
            ) : (
              <>
                {/* VISTA PREVIA EN VIVO (Solo se prende cuando el usuario pulsa "Prender Vista") */}
                {previewEnabled && !usingNativeBgService && (
                  <View style={styles.livePreviewBox}>
                    <CameraView
                      ref={cameraRef}
                      style={StyleSheet.absoluteFillObject}
                      facing={facing}
                      mode={cameraMode}
                      enableTorch={torchOn}
                      animateShutter={false}
                      mute={cameraMode === 'picture' || !hasMicPerm}
                    />
                    <View style={styles.previewOverlayBadge}>
                      <Ionicons name="eye" size={11} color="#10b981" />
                      <Text style={styles.previewOverlayBadgeText}>
                        {facing === 'front' ? 'Frontal en vivo' : 'Trasera en vivo'}
                      </Text>
                    </View>
                  </View>
                )}

                {previewEnabled && usingNativeBgService && (
                  <View style={styles.nativePreviewActiveNotice}>
                    <Ionicons name="eye" size={14} color="#c084fc" />
                    <Text style={styles.nativePreviewActiveText}>
                      Vista flotante prendida (puedes arrastrarla en pantalla)
                    </Text>
                  </View>
                )}

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
                    name={previewEnabled ? 'eye' : 'eye-off-outline'}
                    size={16}
                    color={previewEnabled ? '#ffffff' : '#e2e8f0'}
                  />
                  <Text style={styles.toggleViewBtnText}>
                    {previewEnabled ? 'Vista Prendida (Toca para ocultar)' : 'Prender Vista de Cámara'}
                  </Text>
                </TouchableOpacity>

                {/* SELECTOR: CON QUÉ CÁMARA GUARDA */}
                <View style={styles.cameraSelectorSection}>
                  <Text style={styles.sectionMiniLabel}>¿Con qué cámara guarda?</Text>
                  <View style={styles.cameraChipsRow}>
                    {availableCameras.map((cam) => {
                      const isSelected =
                        cameraSpec === cam.spec ||
                        (cameraSpec === cam.facing && (cam.spec === 'back' || cam.spec === 'front'));
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
                        isPaused && { backgroundColor: '#d97706', borderColor: '#fbbf24' },
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
                      torchOn && { backgroundColor: '#d97706', borderColor: '#fbbf24' },
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
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  floatingOverlayRoot: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
  },
  floatingAnchorWrap: {
    position: 'absolute',
    top: Platform.OS === 'android' ? 104 : 98,
    right: 12,
    alignItems: 'flex-end',
  },
  cameraFloatingIconBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    borderWidth: 1.8,
    borderColor: '#38bdf8',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 8,
    elevation: 14,
  },
  cameraFloatingIconBtnRec: {
    backgroundColor: 'rgba(28, 12, 16, 0.96)',
    borderColor: '#ef4444',
  },
  cameraFloatingIconBtnPaused: {
    borderColor: '#f59e0b',
  },
  floatingIconStatusDot: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: '#090d16',
  },
  floatingIconTimerPill: {
    position: 'absolute',
    bottom: -8,
    backgroundColor: '#dc2626',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  floatingIconTimerText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '800',
  },
  compactCameraCard: {
    marginTop: 10,
    width: 268,
    backgroundColor: 'rgba(12, 16, 26, 0.97)',
    borderRadius: 18,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.55,
    shadowRadius: 14,
    elevation: 18,
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
    fontSize: 13,
    fontWeight: '800',
  },
  headerMiniIconBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(30, 41, 59, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  folderTargetBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(248, 113, 113, 0.3)',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 9,
  },
  folderTargetText: {
    color: '#fecaca',
    fontSize: 10.5,
    fontWeight: '700',
  },
  grantPermBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#2563eb',
    paddingVertical: 9,
    borderRadius: 10,
  },
  grantPermBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  livePreviewBox: {
    width: '100%',
    height: 176,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000000',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.5)',
  },
  previewOverlayBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.68)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
  },
  previewOverlayBadgeText: {
    color: '#ecfdf5',
    fontSize: 10,
    fontWeight: '700',
  },
  nativePreviewActiveNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(147, 51, 234, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(192, 132, 252, 0.4)',
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 10,
  },
  nativePreviewActiveText: {
    color: '#e9d5ff',
    fontSize: 10.5,
    fontWeight: '700',
    flex: 1,
  },
  toggleViewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.3)',
    paddingVertical: 7.5,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  toggleViewBtnActive: {
    backgroundColor: '#059669',
    borderColor: '#34d399',
  },
  toggleViewBtnText: {
    color: '#ffffff',
    fontSize: 11.5,
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
    minWidth: 74,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#18181b',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    paddingVertical: 6.5,
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
    paddingVertical: 9.5,
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
    backgroundColor: 'rgba(24, 24, 27, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    paddingVertical: 6,
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
