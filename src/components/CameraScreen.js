import React, { useState, useRef, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  StatusBar,
  SafeAreaView,
  Dimensions,
} from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
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
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);

  // Modo pantalla bloqueada / oculta total (pantalla 100% negra simulando estar apagada)
  const [stealthLocked, setStealthLocked] = useState(false);
  const [stealthHintVisible, setStealthHintVisible] = useState(false);

  const timerRef = useRef(null);
  const lastTapRef = useRef(0);

  // Solicitar permisos al abrir si no están concedidos
  useEffect(() => {
    if (visible) {
      if (!cameraPermission?.granted) requestCameraPermission();
      if (!micPermission?.granted) requestMicPermission();
    }
  }, [visible, cameraPermission, micPermission]);

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

  // Manejar KeepAwake cuando entra a pantalla bloqueada
  useEffect(() => {
    if (stealthLocked) {
      activateKeepAwakeAsync('stealth-recording').catch(() => {});
    } else {
      deactivateKeepAwake('stealth-recording').catch(() => {});
    }
    return () => {
      deactivateKeepAwake('stealth-recording').catch(() => {});
    };
  }, [stealthLocked]);

  const handleStartRecording = async () => {
    if (!cameraRef.current || isRecording) return;
    try {
      setIsRecording(true);
      const videoPromise = cameraRef.current.recordAsync({
        maxDuration: MAX_DURATION_SECONDS,
      });

      const video = await videoPromise;
      if (video?.uri) {
        setSaving(true);
        try {
          // Guardar directamente en el álbum "Grabaciones"
          const asset = await MediaLibrary.createAssetAsync(video.uri);
          let album = await MediaLibrary.getAlbumAsync(ALBUM_NAME);
          if (!album) {
            await MediaLibrary.createAlbumAsync(ALBUM_NAME, asset, false);
          } else {
            await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
          }

          Alert.alert(
            'Grabación guardada',
            `El video se guardó en la carpeta "${ALBUM_NAME}". Puedes encontrarlo en la pestaña Álbumes de esta app o en tu galería.`,
            [{ text: 'Entendido' }]
          );
          if (onVideoSaved) onVideoSaved();
        } catch (saveErr) {
          // Fallback a galería general si falla el álbum
          try {
            await MediaLibrary.saveToLibraryAsync(video.uri);
            Alert.alert('Grabación guardada', 'El video se guardó en la galería.');
            if (onVideoSaved) onVideoSaved();
          } catch (e2) {
            Alert.alert('Aviso', 'No se pudo guardar el archivo de video.');
          }
        }
        setSaving(false);
      }
    } catch (e) {
      console.error('Error al grabar video:', e);
      Alert.alert('Error', 'No se pudo procesar la grabación.');
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
        '¿Deseas detener la grabación y salir?',
        [
          { text: 'Continuar grabando', style: 'cancel' },
          {
            text: 'Detener y guardar',
            style: 'destructive',
            onPress: () => {
              handleStopRecording();
              onClose();
            },
          },
        ]
      );
    } else {
      onClose();
    }
  };

  if (!visible) return null;

  const permissionsGranted = cameraPermission?.granted && micPermission?.granted;

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={handleClose} statusBarTranslucent>
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
          <View style={styles.cameraWrapper}>
            {/* Vista nativa de la cámara */}
            <CameraView
              ref={cameraRef}
              style={StyleSheet.absoluteFillObject}
              facing={facing}
              mode="video"
            />

            {/* PANTALLA BLOQUEADA TOTAL (100% NEGRA, SIMULA TELÉFONO APAGADO) */}
            {stealthLocked && (
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
            {!stealthLocked && (
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
                      <Ionicons name="folder-outline" size={13} color="#ffffff" />
                      <Text style={styles.limitText}>Guarda en "{ALBUM_NAME}"</Text>
                    </View>
                  )}

                  {/* Cambiar cámara frontal/trasera */}
                  <TouchableOpacity
                    style={[styles.circleBtn, isRecording && { opacity: 0.4 }]}
                    onPress={handleToggleFacing}
                    disabled={isRecording}
                  >
                    <Ionicons name="camera-reverse-outline" size={24} color="#ffffff" />
                  </TouchableOpacity>
                </View>

                {/* Botón para entrar al Modo Pantalla Bloqueada / Oculta durante la grabación */}
                {isRecording && (
                  <View style={styles.stealthBtnContainer}>
                    <TouchableOpacity
                      style={styles.stealthToggleBtn}
                      onPress={() => setStealthLocked(true)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="phone-portrait-outline" size={18} color="#ffffff" />
                      <Text style={styles.stealthToggleText}>
                        Bloquear pantalla (grabar sin que se vea nada)
                      </Text>
                    </TouchableOpacity>
                    <Text style={styles.stealthInfoText}>
                      La pantalla se pondrá 100% negra como si estuviera apagada.
                    </Text>
                  </View>
                )}

                {/* Barra Inferior con Botón de Disparo */}
                <View style={styles.bottomRow}>
                  <View style={{ width: 56 }} />

                  {/* Botón REC / STOP */}
                  <TouchableOpacity
                    style={[styles.recordBtnOuter, isRecording && styles.recordBtnOuterActive]}
                    onPress={isRecording ? handleStopRecording : handleStartRecording}
                    disabled={saving}
                    activeOpacity={0.8}
                  >
                    {saving ? (
                      <ActivityIndicator color="#ffffff" />
                    ) : (
                      <View style={[styles.recordBtnInner, isRecording && styles.recordBtnInnerActive]} />
                    )}
                  </TouchableOpacity>

                  <View style={{ width: 56 }} />
                </View>
              </View>
            )}
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingBottom: 24,
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
