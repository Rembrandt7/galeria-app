import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  StatusBar,
  SafeAreaView,
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

const { VideoEngineModule } = NativeModules;
const HAS_NATIVE_BG_RECORDER =
  Platform.OS === 'android' &&
  Boolean(VideoEngineModule?.startBackgroundVideoRecordNative);

const MAX_DURATION_SECONDS = 600; // 10 minutos exactos
const ALBUM_NAME = 'Grabaciones';

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

  const [facing, setFacing] = useState('back');
  const [cameraMode, setCameraMode] = useState('video'); // 'video' | 'picture'
  const [torchOn, setTorchOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);

  // Motor nativo BVR 3.0.1 (RecordService1)
  const [usingNativeBgService, setUsingNativeBgService] = useState(false);
  const [showFloatingPreview, setShowFloatingPreview] = useState(false);
  const [hasOverlayPermission, setHasOverlayPermission] = useState(true);

  // Modo pantalla bloqueada / oculta total (pantalla 100% negra simulando estar apagada)
  const [stealthLocked, setStealthLocked] = useState(false);
  const stealthLockedRef = useRef(false);
  stealthLockedRef.current = stealthLocked;
  const [stealthHintVisible, setStealthHintVisible] = useState(false);

  // Modo grabación en segundo plano mientras usas el resto de la app
  const [isMinimized, setIsMinimized] = useState(false);
  const isMinimizedRef = useRef(false);
  isMinimizedRef.current = isMinimized;

  const timerRef = useRef(null);
  const lastTapRef = useRef(0);

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
        setTorchOn(Boolean(st.torchOn));
        setShowFloatingPreview(Boolean(st.showFloatingPreview));
      }
    } catch (_e) {}
  }, []);

  const ensureCameraAndMicPermissions = useCallback(async (openSettingsIfBlocked = false) => {
    if (Platform.OS === 'android') {
      try {
        const camAlready = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
        const micAlready = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
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
          res[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === PermissionsAndroid.RESULTS.GRANTED ||
          micAlready;
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
          res[PermissionsAndroid.PERMISSIONS.CAMERA] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
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
  }, [cameraPermission?.granted, micPermission?.granted, requestCameraPermission, requestMicPermission]);

  // Solicitar permisos al abrir de forma secuencial / unificada sin colisión en Android
  useEffect(() => {
    if (visible) {
      setIsMinimized(false);
      ensureCameraAndMicPermissions(false);
      checkOverlayStatus();
      syncNativeRecorderState();
    }
  }, [visible]);

  // Sincronizar al volver del segundo plano (ej. tras activar permiso de superposición o desbloquear teléfono)
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

  const registerFileInGalleryAlbum = useCallback(
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
      if (typeof evt.showFloatingPreview === 'boolean') {
        setShowFloatingPreview(evt.showFloatingPreview);
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
          await registerFileInGalleryAlbum(savedUri);
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
        if (isMinimizedRef.current) {
          setIsMinimized(false);
          onClose();
        }
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
  }, [registerFileInGalleryAlbum, onVideoSaved, onClose, syncNativeRecorderState]);

  // Botón físico Atrás de Android: si está grabando, minimiza a 2do plano en lugar de cortar la grabación
  useEffect(() => {
    if (!visible || isMinimized) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stealthLocked) {
        setStealthLocked(false);
        return true;
      }
      if (isRecording) {
        setIsMinimized(true);
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, isMinimized, stealthLocked, isRecording, onClose]);

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

  const saveMediaFileToGallery = async (fileUri, prefix = 'IMG', ext = 'jpg') => {
    let savedPhys = false;
    try {
      const targetDir = 'file:///storage/emulated/0/DCIM/Grabaciones';
      await FileSystem.makeDirectoryAsync(targetDir, { intermediates: true }).catch(() => {});
      const destUri = `${targetDir}/${prefix}_${Date.now()}.${ext}`;
      await FileSystem.copyAsync({ from: fileUri, to: destUri });
      savedPhys = true;
    } catch (_ePhys) {}

    try {
      const asset = await MediaLibrary.createAssetAsync(fileUri);
      let album = await MediaLibrary.getAlbumAsync(ALBUM_NAME);
      if (!album) {
        await MediaLibrary.createAlbumAsync(ALBUM_NAME, asset, false);
      } else {
        await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
      }
    } catch (err) {
      try {
        await MediaLibrary.saveToLibraryAsync(fileUri);
      } catch (_e2) {
        if (!savedPhys) throw err;
      }
    }
  };

  // Tomar foto 100% silenciosa (sin sonido de obturador ni destello de pantalla)
  const handleTakePhoto = async () => {
    if (!cameraRef.current || saving) return;
    setSaving(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.92,
        shutterSound: false,
      });
      if (photo?.uri) {
        await saveMediaFileToGallery(photo.uri, 'IMG', 'jpg');
        if (onVideoSaved) onVideoSaved();
      }
    } catch (e) {
      Alert.alert('Error', 'No se pudo tomar la fotografía.');
    }
    setSaving(false);
  };

  const handleStartRecording = async () => {
    if (isRecording || saving) return;

    // Usar el motor nativo BackgroundVideoRecordService (BVR 3.0.1 RecordService1) en Android
    if (HAS_NATIVE_BG_RECORDER) {
      try {
        setUsingNativeBgService(true);
        setIsRecording(true);
        setIsPaused(false);
        setElapsed(0);
        // Dar 420ms para que CameraView desmonte y libere la cámara física antes de que el Servicio la tome
        setTimeout(async () => {
          try {
            await VideoEngineModule.startBackgroundVideoRecordNative(
              facing,
              torchOn,
              showFloatingPreview,
              MAX_DURATION_SECONDS
            );
          } catch (err) {
            setUsingNativeBgService(false);
            setIsRecording(false);
            Alert.alert('Error', 'No se pudo iniciar la grabación en 2do plano.');
          }
        }, 420);
        return;
      } catch (e) {
        setUsingNativeBgService(false);
        setIsRecording(false);
      }
    }

    if (!cameraRef.current) return;
    try {
      setIsRecording(true);
      const videoPromise = cameraRef.current.recordAsync({
        maxDuration: MAX_DURATION_SECONDS,
      });

      const video = await videoPromise;
      const wasStealth = stealthLockedRef.current;
      const wasMinimized = isMinimizedRef.current;
      if (video?.uri) {
        setSaving(true);
        try {
          await saveMediaFileToGallery(video.uri, 'VID', 'mp4');
          if (!wasStealth && !wasMinimized) {
            Alert.alert(
              'Grabación guardada',
              `El video se guardó en "${ALBUM_NAME}".`,
              [{ text: 'Entendido' }]
            );
          }
          if (onVideoSaved) onVideoSaved();
        } catch (saveErr) {
          if (!wasStealth) {
            Alert.alert('Aviso', 'No se pudo guardar el archivo de video.');
          }
        }
        setSaving(false);
      }
      if (wasMinimized) {
        setIsMinimized(false);
        onClose();
      }
    } catch (e) {
      console.error('Error al grabar video:', e);
      if (!stealthLockedRef.current && !isMinimizedRef.current) {
        Alert.alert('Error', 'No se pudo procesar la grabación.');
      }
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
      } catch (err) {
        console.error('Error al detener grabación:', err);
      }
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

  const handleToggleFloatingPreview = async () => {
    if (!HAS_NATIVE_BG_RECORDER) return;
    if (!hasOverlayPermission) {
      Alert.alert(
        'Permiso de Superposición (BVR 3.0.1)',
        'Para mostrar la ventana flotante o garantizar grabación con pantalla apagada usando WindowManager (1x1 px), activa el permiso "Aparecer encima" para Mi Galería.',
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
    const nextVal = !showFloatingPreview;
    setShowFloatingPreview(nextVal);
    if (usingNativeBgService) {
      VideoEngineModule.setBackgroundFloatingPreviewNative(nextVal).catch(() => {});
    }
  };

  const handleToggleTorch = () => {
    const nextTorch = !torchOn;
    setTorchOn(nextTorch);
    if (usingNativeBgService && HAS_NATIVE_BG_RECORDER) {
      VideoEngineModule.setBackgroundTorchNative(nextTorch).catch(() => {});
    }
  };

  const handleToggleFacing = () => {
    if (!isRecording) {
      setFacing((prev) => (prev === 'back' ? 'front' : 'back'));
    }
  };

  // Doble toque para salir de la pantalla bloqueada / oculta
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

  const handleClose = () => {
    if (isRecording) {
      Alert.alert(
        'Grabación en 2do plano activa',
        'El motor BVR sigue grabando aunque cierres la cámara, salgas de la app o apagues la pantalla con el botón físico.',
        [
          {
            text: 'Seguir en 2do plano',
            onPress: () => setIsMinimized(true),
          },
          {
            text: 'Detener y guardar',
            style: 'destructive',
            onPress: () => {
              handleStopRecording();
              onClose();
            },
          },
          { text: 'Cancelar', style: 'cancel' },
        ]
      );
    } else {
      onClose();
    }
  };

  if (!visible && !isRecording) return null;

  const permissionsGranted = Boolean(hasCamPerm || cameraPermission?.granted);

  // Si está minimizada en segundo plano mientras graba, mostrar únicamente la píldora flotante inferior
  if (isMinimized || !visible) {
    return (
      <View style={styles.minimizedRootOverlay} pointerEvents="box-none">
        <SafeAreaView style={styles.minimizedSafeWrap} pointerEvents="box-none">
          <View style={styles.minimizedCameraContainer} pointerEvents="box-none">
            {!usingNativeBgService && permissionsGranted && (
              <CameraView
                ref={cameraRef}
                style={styles.hiddenTinyCamera}
                facing={facing}
                mode={cameraMode}
                enableTorch={torchOn}
                animateShutter={false}
                mute={cameraMode === 'picture' || !hasMicPerm}
              />
            )}
            <View style={styles.bgRecordingFloatingPill}>
              <TouchableOpacity
                style={styles.bgRecLeftInfo}
                onPress={() => setIsMinimized(false)}
                activeOpacity={0.8}
              >
                <View
                  style={[
                    styles.recDot,
                    { backgroundColor: isPaused ? '#f59e0b' : '#ef4444' },
                  ]}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.bgRecTitle} numberOfLines={1}>
                    {isPaused ? 'En pausa' : 'Grabando 2do plano'} ({formatTimer(elapsed)})
                  </Text>
                  <Text style={styles.bgRecSub} numberOfLines={1}>
                    Motor BVR 3.0.1 · Toca para abrir controles
                  </Text>
                </View>
              </TouchableOpacity>

              {usingNativeBgService && (
                <TouchableOpacity
                  style={styles.bgRecPauseBtn}
                  onPress={handleTogglePauseResume}
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name={isPaused ? 'play' : 'pause'}
                    size={14}
                    color="#ffffff"
                  />
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={styles.bgRecStopBtn}
                onPress={handleStopRecording}
                activeOpacity={0.85}
              >
                <Ionicons name="stop" size={14} color="#ffffff" />
                <Text style={styles.bgRecStopText}>Detener</Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <Modal
      visible={Boolean(visible && !isMinimized)}
      animationType="slide"
      transparent={false}
      statusBarTranslucent={true}
      onRequestClose={handleClose}
    >
      <View style={styles.fullScreenOverlay}>
        <StatusBar
          barStyle="light-content"
          backgroundColor="#000000"
          hidden={stealthLocked}
        />
        <SafeAreaView style={styles.container}>
          {!permissionsGranted ? (
            <View style={styles.permissionBox}>
              <Ionicons name="videocam-outline" size={64} color={theme.colors.primary} />
              <Text style={styles.permissionTitle}>Permiso de Cámara y Micrófono</Text>
              <Text style={styles.permissionDesc}>
                Para usar la cámara y grabar video en segundo plano, autoriza el acceso a la cámara y al micrófono.
              </Text>
              <TouchableOpacity
                style={styles.permissionBtn}
                onPress={() => {
                  ensureCameraAndMicPermissions(true);
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.permissionBtnText}>Conceder permisos</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
                <Text style={styles.cancelBtnText}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.cameraWrapper}>
              {/* Vista nativa de Expo Camera: se desmonta automáticamente cuando el Servicio Nativo BVR 3.0.1 toma la cámara */}
              {!usingNativeBgService ? (
                <CameraView
                  ref={cameraRef}
                  style={StyleSheet.absoluteFillObject}
                  facing={facing}
                  mode={cameraMode}
                  enableTorch={torchOn}
                  animateShutter={false}
                  mute={cameraMode === 'picture' || !hasMicPerm}
                />
              ) : (
                !stealthLocked && (
                  <View style={styles.nativeBgActiveBackdrop}>
                    <View style={styles.nativeBgPulseCircle}>
                      <Ionicons
                        name={isPaused ? 'pause-circle' : 'radio-button-on'}
                        size={54}
                        color={isPaused ? '#f59e0b' : '#ef4444'}
                      />
                    </View>
                    <Text style={styles.nativeBgActiveTitle}>
                      {isPaused
                        ? 'Grabación en Pausa (Motor BVR 3.0.1)'
                        : 'Motor BVR 3.0.1 Grabando en 2do Plano'}
                    </Text>
                    <Text style={styles.nativeBgActiveSub}>
                      Puedes bloquear el celular con el botón físico de encendido, cambiar a otra aplicación o usar tu Galería sin que se corte el video.
                    </Text>
                    <View style={styles.nativeBgBadgesRow}>
                      <View style={styles.nativeBgFeatureBadge}>
                        <Ionicons name="lock-closed-outline" size={14} color="#38bdf8" />
                        <Text style={styles.nativeBgFeatureText}>Pantalla apagada OK</Text>
                      </View>
                      <View style={styles.nativeBgFeatureBadge}>
                        <Ionicons name="apps-outline" size={14} color="#10b981" />
                        <Text style={styles.nativeBgFeatureText}>Fuera de la app OK</Text>
                      </View>
                      <View style={styles.nativeBgFeatureBadge}>
                        <Ionicons
                          name={showFloatingPreview ? 'eye-outline' : 'eye-off-outline'}
                          size={14}
                          color="#a855f7"
                        />
                        <Text style={styles.nativeBgFeatureText}>
                          {showFloatingPreview ? 'Preview flotante' : 'Oculto 1×1 px'}
                        </Text>
                      </View>
                    </View>
                  </View>
                )
              )}

            {/* PANTALLA BLOQUEADA TOTAL (100% NEGRA, SIMULA TELÉFONO APAGADO) */}
            {!isMinimized && stealthLocked && (
              <TouchableOpacity
                style={styles.fullBlackScreen}
                activeOpacity={1}
                onPress={handleStealthScreenTap}
              >
                {stealthHintVisible && (
                  <View style={styles.stealthHintBox}>
                    <Ionicons name="lock-closed" size={24} color="#666666" />
                    <Text style={styles.stealthHintText}>
                      Grabando en segundo plano ({formatTimer(elapsed)} / 10:00)
                    </Text>
                    <Text style={styles.stealthHintSub}>
                      Toca 2 veces rápido para desbloquear controles
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            )}

            {/* Controles de la cámara */}
            {!isMinimized && !stealthLocked && (
              <View style={styles.overlayControls} pointerEvents="box-none">
                {/* Barra Superior */}
                <View>
                  <View style={styles.topRow}>
                    <TouchableOpacity
                      style={styles.circleBtn}
                      onPress={handleClose}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Ionicons name="close" size={24} color="#ffffff" />
                    </TouchableOpacity>

                    {/* Indicador de tiempo de grabación */}
                    {isRecording ? (
                      <View
                        style={[
                          styles.recTimerBadge,
                          isPaused && { backgroundColor: 'rgba(245, 158, 11, 0.92)' },
                        ]}
                      >
                        <View style={styles.recDot} />
                        <Text style={styles.recTimerText}>
                          {isPaused ? 'PAUSA' : 'REC'} {formatTimer(elapsed)} / 10:00
                        </Text>
                      </View>
                    ) : (
                      <View style={styles.limitBadge}>
                        <Ionicons
                          name={cameraMode === 'picture' ? 'volume-mute' : 'shield-checkmark'}
                          size={13}
                          color="#38bdf8"
                        />
                        <Text style={styles.limitText}>
                          {cameraMode === 'picture'
                            ? 'Foto silenciosa · Sin ruido'
                            : 'Motor BVR 3.0.1 · 2do Plano Real'}
                        </Text>
                      </View>
                    )}

                    {/* Linterna y Cambiar cámara frontal/trasera */}
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      <TouchableOpacity
                        style={[
                          styles.circleBtn,
                          torchOn && { backgroundColor: theme.colors.warning },
                        ]}
                        onPress={handleToggleTorch}
                      >
                        <Ionicons
                          name={torchOn ? 'flash' : 'flash-off-outline'}
                          size={22}
                          color="#ffffff"
                        />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.circleBtn, isRecording && { opacity: 0.4 }]}
                        onPress={handleToggleFacing}
                        disabled={isRecording}
                      >
                        <Ionicons name="camera-reverse-outline" size={24} color="#ffffff" />
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* Barra de opciones del Motor BVR 3.0.1 (Permiso Superposición y Vista Previa Flotante) */}
                  {HAS_NATIVE_BG_RECORDER && cameraMode === 'video' && (
                    <View style={styles.bvrOptionsRow}>
                      {!hasOverlayPermission ? (
                        <TouchableOpacity
                          style={styles.overlayPermBanner}
                          onPress={() => {
                            VideoEngineModule.requestOverlayPermissionNative().catch(() => {});
                          }}
                          activeOpacity={0.85}
                        >
                          <Ionicons name="layers-outline" size={14} color="#fbbf24" />
                          <Text style={styles.overlayPermBannerText}>
                            Activar permiso "Aparecer encima" (Overlay 1×1 BVR)
                          </Text>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          style={[
                            styles.floatingPreviewPill,
                            showFloatingPreview && styles.floatingPreviewPillActive,
                          ]}
                          onPress={handleToggleFloatingPreview}
                          activeOpacity={0.85}
                        >
                          <Ionicons
                            name={showFloatingPreview ? 'eye-outline' : 'eye-off-outline'}
                            size={14}
                            color="#ffffff"
                          />
                          <Text style={styles.floatingPreviewPillText}>
                            {showFloatingPreview
                              ? 'Vista flotante activa (Arrastrable)'
                              : 'Modo oculto 1×1 px (Toca para vista flotante)'}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </View>

                {/* Botones de 2do plano y Pantalla Bloqueada durante la grabación */}
                {isRecording && (
                  <View style={styles.stealthBtnContainer}>
                    <TouchableOpacity
                      style={[
                        styles.stealthToggleBtn,
                        {
                          borderColor: '#38bdf8',
                          backgroundColor: 'rgba(15, 23, 42, 0.92)',
                        },
                      ]}
                      onPress={() => setIsMinimized(true)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="albums-outline" size={18} color="#38bdf8" />
                      <Text style={[styles.stealthToggleText, { color: '#38bdf8' }]}>
                        Minimizar cámara y usar Mi Galería / otras apps
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.stealthToggleBtn}
                      onPress={() => setStealthLocked(true)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="phone-portrait-outline" size={18} color="#ffffff" />
                      <Text style={styles.stealthToggleText}>
                        Pantalla 100% negra (o usa el botón físico de bloqueo)
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}

                {/* Barra Inferior con Selector Foto/Video y Botón de Disparo */}
                <View style={styles.bottomArea}>
                  {!isRecording && (
                    <View style={styles.modeSwitchRow}>
                      <TouchableOpacity
                        style={[
                          styles.modePill,
                          cameraMode === 'picture' && styles.modePillActive,
                        ]}
                        onPress={() => setCameraMode('picture')}
                      >
                        <Ionicons name="camera-outline" size={15} color="#fff" />
                        <Text style={styles.modePillText}>Foto (Sin ruido)</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.modePill,
                          cameraMode === 'video' && styles.modePillActive,
                        ]}
                        onPress={() => setCameraMode('video')}
                      >
                        <Ionicons name="videocam-outline" size={15} color="#fff" />
                        <Text style={styles.modePillText}>Video BVR (2do plano)</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  <View style={styles.bottomRow}>
                    {/* Botón izquierdo: Pausar / Reanudar cuando está grabando con el motor BVR */}
                    {isRecording && usingNativeBgService ? (
                      <TouchableOpacity
                        style={styles.pauseResumeCircleBtn}
                        onPress={handleTogglePauseResume}
                        activeOpacity={0.8}
                      >
                        <Ionicons
                          name={isPaused ? 'play' : 'pause'}
                          size={24}
                          color="#ffffff"
                        />
                        <Text style={styles.pauseResumeLabel}>
                          {isPaused ? 'Reanudar' : 'Pausar'}
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      <View style={{ width: 64 }} />
                    )}

                    {/* Botón FOTO o REC / STOP */}
                    <TouchableOpacity
                      style={[
                        styles.recordBtnOuter,
                        isRecording && styles.recordBtnOuterActive,
                      ]}
                      onPress={
                        cameraMode === 'picture'
                          ? handleTakePhoto
                          : isRecording
                          ? handleStopRecording
                          : handleStartRecording
                      }
                      disabled={saving}
                      activeOpacity={0.8}
                    >
                      {saving ? (
                        <ActivityIndicator color="#ffffff" />
                      ) : (
                        <View
                          style={[
                            styles.recordBtnInner,
                            cameraMode === 'picture' && styles.photoBtnInner,
                            isRecording && styles.recordBtnInnerActive,
                          ]}
                        />
                      )}
                    </TouchableOpacity>

                    {/* Botón derecho: Minimizar rápido cuando está grabando */}
                    {isRecording ? (
                      <TouchableOpacity
                        style={styles.pauseResumeCircleBtn}
                        onPress={() => setIsMinimized(true)}
                        activeOpacity={0.8}
                      >
                        <Ionicons name="chevron-down" size={24} color="#38bdf8" />
                        <Text style={[styles.pauseResumeLabel, { color: '#38bdf8' }]}>
                          2do plano
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      <View style={{ width: 64 }} />
                    )}
                  </View>
                </View>
              </View>
            )}
          </View>
        )}
      </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fullScreenOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    zIndex: 9999,
    elevation: 9999,
  },
  minimizedRootOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
    justifyContent: 'flex-end',
  },
  minimizedSafeWrap: {
    width: '100%',
    justifyContent: 'flex-end',
  },
  minimizedCameraContainer: {
    width: '100%',
    paddingHorizontal: 14,
    paddingBottom: 16,
  },
  hiddenTinyCamera: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0.01,
    right: 0,
    bottom: 0,
  },
  nativeBgActiveBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#090d16',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 12,
  },
  nativeBgPulseCircle: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderWidth: 1.5,
    borderColor: 'rgba(239, 68, 68, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  nativeBgActiveTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  nativeBgActiveSub: {
    color: '#94a3b8',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  nativeBgBadgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginTop: 6,
  },
  nativeBgFeatureBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(30, 41, 59, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.25)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
  nativeBgFeatureText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '700',
  },
  bvrOptionsRow: {
    alignItems: 'center',
    marginTop: 10,
  },
  overlayPermBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(120, 53, 15, 0.88)',
    borderWidth: 1,
    borderColor: '#f59e0b',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  overlayPermBannerText: {
    color: '#fef3c7',
    fontSize: 11,
    fontWeight: '700',
  },
  floatingPreviewPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.35)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  floatingPreviewPillActive: {
    backgroundColor: 'rgba(147, 51, 234, 0.85)',
    borderColor: '#c084fc',
  },
  floatingPreviewPillText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },
  bgRecordingFloatingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(15, 23, 42, 0.96)',
    borderWidth: 1.5,
    borderColor: '#ef4444',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    elevation: 14,
  },
  bgRecLeftInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  bgRecTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  bgRecSub: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 1,
  },
  bgRecPauseBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bgRecStopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#ef4444',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  bgRecStopText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  permissionBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 16,
  },
  permissionTitle: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  permissionDesc: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  permissionBtn: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
    marginTop: 8,
  },
  permissionBtnText: {
    color: '#ffffff',
    fontWeight: '700',
  },
  cancelBtn: {
    padding: 10,
  },
  cancelBtnText: {
    color: theme.colors.textMuted,
    fontSize: 14,
  },
  cameraWrapper: {
    flex: 1,
    backgroundColor: '#000000',
  },
  overlayControls: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    padding: 20,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 10,
  },
  circleBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recTimerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.9)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 6,
  },
  recDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ffffff',
  },
  recTimerText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  limitBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 6,
  },
  limitText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  stealthBtnContainer: {
    alignItems: 'center',
    gap: 8,
  },
  stealthToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.35)',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
    gap: 8,
  },
  stealthToggleText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  bottomArea: {
    alignItems: 'center',
    gap: 14,
  },
  modeSwitchRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    borderRadius: 20,
    padding: 3,
    gap: 4,
  },
  modePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 17,
  },
  modePillActive: {
    backgroundColor: theme.colors.primary,
  },
  modePillText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingBottom: 24,
    width: '100%',
  },
  pauseResumeCircleBtn: {
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  pauseResumeLabel: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },
  recordBtnOuter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordBtnOuterActive: {
    borderColor: '#ef4444',
  },
  recordBtnInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#ef4444',
  },
  photoBtnInner: {
    backgroundColor: '#ffffff',
  },
  recordBtnInnerActive: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: '#ef4444',
  },
  fullBlackScreen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },
  stealthHintBox: {
    alignItems: 'center',
    gap: 8,
    padding: 20,
    backgroundColor: 'rgba(20, 20, 20, 0.9)',
    borderRadius: 16,
  },
  stealthHintText: {
    color: '#888888',
    fontSize: 13,
    fontWeight: '600',
  },
  stealthHintSub: {
    color: '#555555',
    fontSize: 11,
  },
});
