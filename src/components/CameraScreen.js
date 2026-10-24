import React, { useState, useRef, useEffect } from 'react';
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
} from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';

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

  const [facing, setFacing] = useState('back');
  const [cameraMode, setCameraMode] = useState('video'); // 'video' | 'picture'
  const [torchOn, setTorchOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);

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

  // Solicitar permisos al abrir si no están concedidos
  useEffect(() => {
    if (visible) {
      setIsMinimized(false);
      if (!cameraPermission?.granted) requestCameraPermission();
      if (!micPermission?.granted) requestMicPermission();
    }
  }, [visible, cameraPermission, micPermission]);

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

  // Manejar cronómetro y corte automático a los 10 minutos
  useEffect(() => {
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
  }, [isRecording]);

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
    if (!cameraRef.current || isRecording) return;
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

  const handleStopRecording = () => {
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

  const handleToggleFacing = () => {
    if (!isRecording) {
      setFacing((prev) => (prev === 'back' ? 'front' : 'back'));
    }
  };

  // Doble toque para salir de la pantalla bloqueada / oculta
  const handleStealthScreenTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 400) {
      // Doble toque detectado: desbloquear pantalla
      setStealthLocked(false);
      setStealthHintVisible(false);
    } else {
      // Primer toque: mostrar recordatorio sutil
      setStealthHintVisible(true);
      setTimeout(() => setStealthHintVisible(false), 2500);
    }
    lastTapRef.current = now;
  };

  const handleClose = () => {
    if (isRecording) {
      Alert.alert(
        'Grabación en curso',
        '¿Quieres seguir grabando en segundo plano mientras usas la app o detener la grabación?',
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

  const permissionsGranted = cameraPermission?.granted && micPermission?.granted;

  return (
    <View
      style={isMinimized ? styles.minimizedRootOverlay : styles.fullScreenOverlay}
      pointerEvents={isMinimized ? 'box-none' : 'auto'}
    >
      {!isMinimized && (
        <StatusBar
          barStyle="light-content"
          backgroundColor="#000000"
          hidden={stealthLocked}
        />
      )}
      <SafeAreaView
        style={isMinimized ? styles.minimizedSafeWrap : styles.container}
        pointerEvents={isMinimized ? 'box-none' : 'auto'}
      >
        {!permissionsGranted ? (
          <View style={styles.permissionBox}>
            <Ionicons name="videocam-outline" size={64} color={theme.colors.primary} />
            <Text style={styles.permissionTitle}>Permiso de Cámara y Micrófono</Text>
            <Text style={styles.permissionDesc}>
              Para poder grabar video y audio, es necesario autorizar los permisos de cámara y micrófono de tu dispositivo.
            </Text>
            <TouchableOpacity
              style={styles.permissionBtn}
              onPress={() => {
                requestCameraPermission();
                requestMicPermission();
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
          <View
            style={isMinimized ? styles.minimizedCameraContainer : styles.cameraWrapper}
            pointerEvents={isMinimized ? 'box-none' : 'auto'}
          >
            {/* Vista nativa de la cámara (permanece montada 1x1 cuando está en 2do plano para no cortar la grabación) */}
            <CameraView
              ref={cameraRef}
              style={isMinimized ? styles.hiddenTinyCamera : StyleSheet.absoluteFillObject}
              facing={facing}
              mode={cameraMode}
              enableTorch={torchOn}
              animateShutter={false}
              mute={cameraMode === 'picture'}
            />

            {/* PÍLDORA FLOTANTE CUANDO ESTÁ GRABANDO EN SEGUNDO PLANO */}
            {isMinimized && (
              <View style={styles.bgRecordingFloatingPill}>
                <TouchableOpacity
                  style={styles.bgRecLeftInfo}
                  onPress={() => setIsMinimized(false)}
                  activeOpacity={0.8}
                >
                  <View style={styles.recDot} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.bgRecTitle} numberOfLines={1}>
                      Grabando en 2do plano ({formatTimer(elapsed)})
                    </Text>
                    <Text style={styles.bgRecSub} numberOfLines={1}>
                      Toca aquí para abrir la cámara
                    </Text>
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.bgRecStopBtn}
                  onPress={handleStopRecording}
                  activeOpacity={0.85}
                >
                  <Ionicons name="stop" size={14} color="#ffffff" />
                  <Text style={styles.bgRecStopText}>Detener</Text>
                </TouchableOpacity>
              </View>
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
                      Toca 2 veces rápido para desbloquear y detener
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            )}

            {/* Controles de la cámara */}
            {!isMinimized && !stealthLocked && (
              <View style={styles.overlayControls} pointerEvents="box-none">
                {/* Barra Superior */}
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
                    <View style={styles.recTimerBadge}>
                      <View style={styles.recDot} />
                      <Text style={styles.recTimerText}>
                        REC {formatTimer(elapsed)} / 10:00
                      </Text>
                    </View>
                  ) : (
                    <View style={styles.limitBadge}>
                      <Ionicons name="volume-mute" size={13} color="#38bdf8" />
                      <Text style={styles.limitText}>
                        {cameraMode === 'picture' ? 'Foto silenciosa · Sin ruido' : `Guarda en "${ALBUM_NAME}"`}
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
                      onPress={() => setTorchOn((t) => !t)}
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

                {/* Botones de 2do plano y Pantalla Bloqueada durante la grabación */}
                {isRecording && (
                  <View style={styles.stealthBtnContainer}>
                    <TouchableOpacity
                      style={[styles.stealthToggleBtn, { borderColor: '#38bdf8', backgroundColor: 'rgba(15, 23, 42, 0.9)' }]}
                      onPress={() => setIsMinimized(true)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="albums-outline" size={18} color="#38bdf8" />
                      <Text style={[styles.stealthToggleText, { color: '#38bdf8' }]}>
                        Grabar en 2do plano (usar la app mientras graba)
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.stealthToggleBtn}
                      onPress={() => setStealthLocked(true)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="phone-portrait-outline" size={18} color="#ffffff" />
                      <Text style={styles.stealthToggleText}>
                        Bloquear pantalla (100% negra)
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
                        <Text style={styles.modePillText}>Video (2do plano)</Text>
                      </TouchableOpacity>
                    </View>
                  )}

                  <View style={styles.bottomRow}>
                    <View style={{ width: 56 }} />

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

                    <View style={{ width: 56 }} />
                  </View>
                </View>
              </View>
            )}
          </View>
        )}
      </SafeAreaView>
    </View>
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
    gap: 10,
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
    gap: 6,
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
    fontSize: 13,
    fontWeight: '700',
  },
  stealthInfoText: {
    color: 'rgba(255, 255, 255, 0.65)',
    fontSize: 11,
    textAlign: 'center',
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
  // Pantalla 100% negra (OLED apagado total)
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
