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
} from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';

const MAX_DURATION_SECONDS = 600; // 10 minutos exactos

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
  const [stealthMode, setStealthMode] = useState(false); // Modo pantalla oculta (grabar sin ver)

  const timerRef = useRef(null);

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

  const handleStartRecording = async () => {
    if (!cameraRef.current || isRecording) return;
    try {
      setIsRecording(true);
      // recordAsync inicia y se queda pendiente hasta stopRecording() o maxDuration
      const videoPromise = cameraRef.current.recordAsync({
        maxDuration: MAX_DURATION_SECONDS,
      });

      const video = await videoPromise;
      if (video?.uri) {
        setSaving(true);
        try {
          await MediaLibrary.saveToLibraryAsync(video.uri);
          Alert.alert(
            'Grabación completada',
            'El video se guardó automáticamente en tu galería.',
            [{ text: 'Entendido' }]
          );
          if (onVideoSaved) onVideoSaved();
        } catch (saveErr) {
          Alert.alert('Aviso', 'El video se grabó pero hubo un problema al guardarlo en el álbum.');
        }
        setSaving(false);
      }
    } catch (e) {
      console.error('Error al grabar video:', e);
      Alert.alert('Error', 'No se pudo iniciar o procesar la grabación.');
    } finally {
      setIsRecording(false);
      setStealthMode(false);
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
      setStealthMode(false);
    }
  };

  const handleToggleFacing = () => {
    if (!isRecording) {
      setFacing((prev) => (prev === 'back' ? 'front' : 'back'));
    }
  };

  const handleClose = () => {
    if (isRecording) {
      Alert.alert(
        'Grabación en curso',
        '¿Deseas detener la grabación y salir?',
        [
          { text: 'Continuar grabando', style: 'cancel' },
          {
            text: 'Detener y salir',
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

  // Si no hay permisos concedidos
  const permissionsGranted = cameraPermission?.granted && micPermission?.granted;

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={handleClose} statusBarTranslucent>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
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

            {/* Capa de Modo Oculto / Pantalla Negra Discreta ("sin estar viendo") */}
            {stealthMode && (
              <TouchableOpacity
                style={styles.stealthOverlay}
                activeOpacity={1}
                onPress={() => setStealthMode(false)}
              >
                <View style={styles.stealthIndicator}>
                  <View style={styles.recDot} />
                  <Text style={styles.stealthText}>
                    Grabando discretamente… {formatTimer(elapsed)} / 10:00
                  </Text>
                  <Text style={styles.stealthHint}>Toca en cualquier parte para ver los controles</Text>
                </View>
              </TouchableOpacity>
            )}

            {/* Controles de la cámara (cuando no está en modo pantalla negra) */}
            {!stealthMode && (
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
                      <Ionicons name="time-outline" size={14} color="#ffffff" />
                      <Text style={styles.limitText}>Máx. 10 min</Text>
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

                {/* Botón para entrar a Modo Pantalla Oculta durante la grabación */}
                {isRecording && (
                  <View style={styles.stealthBtnContainer}>
                    <TouchableOpacity
                      style={styles.stealthToggleBtn}
                      onPress={() => setStealthMode(true)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="eye-off-outline" size={18} color="#ffffff" />
                      <Text style={styles.stealthToggleText}>Ocultar pantalla (grabar discreto)</Text>
                    </TouchableOpacity>
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
    backgroundColor: 'rgba(239, 68, 68, 0.85)',
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
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 5,
  },
  limitText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  stealthBtnContainer: {
    alignItems: 'center',
  },
  stealthToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 8,
  },
  stealthToggleText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
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
  stealthOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 99,
  },
  stealthIndicator: {
    alignItems: 'center',
    gap: 10,
    padding: 24,
  },
  stealthText: {
    color: '#666666',
    fontSize: 14,
    fontWeight: '600',
  },
  stealthHint: {
    color: '#444444',
    fontSize: 12,
  },
});
