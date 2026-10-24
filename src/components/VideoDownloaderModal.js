import React, { useState, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  ScrollView,
  SafeAreaView,
  StatusBar,
  Linking,
  Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import {
  videoDownloadService,
  detectPlatform,
  extractUrlFromText,
} from '../services/videoDownloadService';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${mb.toFixed(1)} MB`;
}

export default function VideoDownloaderModal({ visible, onClose, onVideoDownloaded }) {
  const [urlInput, setUrlInput] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [progressInfo, setProgressInfo] = useState({
    percent: 0,
    writtenBytes: 0,
    totalBytes: 0,
  });
  const [history, setHistory] = useState([]);
  const [lastError, setLastError] = useState(null);

  const controllerRef = useRef(null);

  const extractedUrl = extractUrlFromText(urlInput);
  const detectedPlatform = extractedUrl ? detectPlatform(extractedUrl) : null;

  const handleStartDownload = async () => {
    const cleanUrl = extractUrlFromText(urlInput);
    if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) {
      Alert.alert(
        'Enlace inválido',
        'Por favor pega un enlace válido de video (que empiece con http:// o https://).'
      );
      return;
    }

    Keyboard.dismiss();
    setDownloading(true);
    setIsPaused(false);
    setLastError(null);
    setStatusText('Analizando enlace…');
    setProgressInfo({ percent: 0, writtenBytes: 0, totalBytes: 0 });

    try {
      const result = await videoDownloadService.downloadVideoFromUrl(cleanUrl, {
        onStatus: (msg) => setStatusText(msg),
        onProgress: (prog) => setProgressInfo(prog),
        onController: (ctrl) => {
          controllerRef.current = ctrl;
        },
      });

      if (result && result.success) {
        setHistory((prev) => [
          {
            id: `${Date.now()}`,
            filename: result.filename,
            title: result.title,
            platform: result.platform,
            sizeBytes: result.sizeBytes,
            albumName: result.albumName,
            url: cleanUrl,
            date: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
          ...prev,
        ]);
        setUrlInput('');
        if (onVideoDownloaded) onVideoDownloaded(result);
        Alert.alert(
          '¡Video descargado!',
          `El video se guardó en el álbum "${result.albumName}" (${formatBytes(result.sizeBytes)}).`
        );
      }
    } catch (err) {
      if (err?.message === 'CANCELLED') {
        // Cancelado por el usuario: no mostrar error
      } else {
        const msg = err?.message || 'No se pudo descargar el video desde este enlace.';
        setLastError({ message: msg, url: cleanUrl });
      }
    } finally {
      setDownloading(false);
      setIsPaused(false);
      setStatusText('');
      controllerRef.current = null;
    }
  };

  const handleTogglePause = async () => {
    if (!controllerRef.current) return;
    if (isPaused) {
      setIsPaused(false);
      await controllerRef.current.resume();
    } else {
      setIsPaused(true);
      await controllerRef.current.pause();
    }
  };

  const handleCancelDownload = async () => {
    if (controllerRef.current) {
      await controllerRef.current.cancel();
    }
    setDownloading(false);
    setIsPaused(false);
    setStatusText('');
  };

  const handleClose = () => {
    if (downloading) {
      Alert.alert(
        'Descarga en progreso',
        '¿Deseas cancelar la descarga actual y cerrar?',
        [
          { text: 'Continuar descargando', style: 'cancel' },
          {
            text: 'Cancelar y salir',
            style: 'destructive',
            onPress: () => {
              handleCancelDownload();
              onClose();
            },
          },
        ]
      );
      return;
    }
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose} statusBarTranslucent>
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
      <SafeAreaView style={styles.container}>
        {/* Barra superior */}
        <View style={styles.topBar}>
          <TouchableOpacity
            onPress={handleClose}
            style={styles.iconBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="close" size={26} color="#ffffff" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Ionicons name="cloud-download" size={20} color={theme.colors.primaryLight} />
            <Text style={styles.headerTitle}>Descargar Video por Enlace</Text>
          </View>
          <View style={styles.iconBtn} />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Tarjeta principal de entrada de enlace */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Pega el enlace del video</Text>
            <Text style={styles.sectionSub}>
              Compatible con enlaces directos (.mp4, .mov), TikTok (sin marca de agua), X/Twitter, Reddit, Pinterest, Instagram, Facebook y páginas web públicas.
            </Text>

            <View style={styles.inputWrapper}>
              <Ionicons
                name={detectedPlatform ? detectedPlatform.icon : 'link-outline'}
                size={20}
                color={detectedPlatform ? detectedPlatform.color : theme.colors.textMuted}
                style={styles.inputIcon}
              />
              <TextInput
                style={styles.textInput}
                value={urlInput}
                onChangeText={(t) => {
                  setUrlInput(t);
                  if (lastError) setLastError(null);
                }}
                placeholder="https://..."
                placeholderTextColor={theme.colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                editable={!downloading}
                returnKeyType="go"
                onSubmitEditing={handleStartDownload}
              />
              {urlInput.length > 0 && !downloading && (
                <TouchableOpacity
                  onPress={() => {
                    setUrlInput('');
                    setLastError(null);
                  }}
                  style={styles.clearBtn}
                >
                  <Ionicons name="close-circle" size={20} color={theme.colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>

            {/* Etiqueta de plataforma detectada */}
            {detectedPlatform && extractedUrl.startsWith('http') && (
              <View style={styles.platformBadgeRow}>
                <View
                  style={[
                    styles.platformPill,
                    { borderColor: detectedPlatform.color },
                  ]}
                >
                  <Ionicons
                    name={detectedPlatform.icon}
                    size={14}
                    color={detectedPlatform.color}
                  />
                  <Text style={[styles.platformPillText, { color: detectedPlatform.color }]}>
                    Detectado: {detectedPlatform.name}
                  </Text>
                </View>
                <Text style={styles.albumDestText}>
                  Se guardará en Álbum "Descargas"
                </Text>
              </View>
            )}

            {/* Estado de descarga y barra de progreso con Pausar / Reanudar y Cancelar */}
            {downloading ? (
              <View style={styles.progressBox}>
                <View style={styles.progressHeader}>
                  {isPaused ? (
                    <Ionicons name="pause-circle" size={20} color={theme.colors.warning} />
                  ) : (
                    <ActivityIndicator size="small" color={theme.colors.primaryLight} />
                  )}
                  <Text
                    style={[
                      styles.progressStatusText,
                      isPaused && { color: theme.colors.warning },
                    ]}
                    numberOfLines={1}
                  >
                    {isPaused ? 'En pausa — puedes reanudar o cancelar' : statusText || 'Descargando video…'}
                  </Text>
                </View>

                <View style={styles.progressBarBg}>
                  <View
                    style={[
                      styles.progressBarFill,
                      {
                        width: `${
                          progressInfo.percent > 0
                            ? Math.round(progressInfo.percent * 100)
                            : 15
                        }%`,
                        backgroundColor: isPaused ? theme.colors.warning : theme.colors.primary,
                      },
                    ]}
                  />
                </View>

                <View style={styles.progressStatsRow}>
                  <Text style={styles.progressStatsText}>
                    {progressInfo.writtenBytes > 0
                      ? `${formatBytes(progressInfo.writtenBytes)}${
                          progressInfo.totalBytes > 0
                            ? ` / ${formatBytes(progressInfo.totalBytes)}`
                            : ''
                        }`
                      : isPaused
                      ? 'Proceso en pausa'
                      : 'Conectando con el servidor…'}
                  </Text>
                  {progressInfo.percent > 0 && (
                    <Text style={styles.progressPercentText}>
                      {Math.round(progressInfo.percent * 100)}%
                    </Text>
                  )}
                </View>

                <View style={styles.processControlsRow}>
                  <TouchableOpacity
                    style={[
                      styles.pauseProcessBtn,
                      isPaused && styles.resumeProcessBtn,
                    ]}
                    onPress={handleTogglePause}
                    activeOpacity={0.8}
                  >
                    <Ionicons
                      name={isPaused ? 'play' : 'pause'}
                      size={17}
                      color={isPaused ? '#ffffff' : theme.colors.warning}
                    />
                    <Text
                      style={[
                        styles.pauseProcessText,
                        isPaused && styles.resumeProcessText,
                      ]}
                    >
                      {isPaused ? 'Reanudar' : 'Pausar'}
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.cancelDownloadBtn}
                    onPress={handleCancelDownload}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="close-circle-outline" size={18} color={theme.colors.danger} />
                    <Text style={styles.cancelDownloadText}>Cancelar</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={[
                  styles.downloadButton,
                  !extractedUrl.startsWith('http') && styles.downloadButtonDisabled,
                ]}
                onPress={handleStartDownload}
                disabled={!extractedUrl.startsWith('http')}
                activeOpacity={0.8}
              >
                <Ionicons name="download-outline" size={20} color="#ffffff" />
                <Text style={styles.downloadButtonText}>Descargar y guardar en Galería</Text>
              </TouchableOpacity>
            )}

            {/* Mensaje de error con opción de respaldo en navegador */}
            {lastError && !downloading && (
              <View style={styles.errorBox}>
                <View style={styles.errorHeader}>
                  <Ionicons name="alert-circle" size={20} color={theme.colors.warning} />
                  <Text style={styles.errorTitle}>No se pudo extraer directamente</Text>
                </View>
                <Text style={styles.errorDesc}>{lastError.message}</Text>
                <TouchableOpacity
                  style={styles.browserFallbackBtn}
                  onPress={() => Linking.openURL(lastError.url)}
                  activeOpacity={0.8}
                >
                  <Ionicons name="globe-outline" size={16} color={theme.colors.primaryLight} />
                  <Text style={styles.browserFallbackText}>
                    Abrir enlace en el navegador externo
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Plataformas soportadas */}
          <View style={styles.supportedCard}>
            <Text style={styles.supportedTitle}>Sitios y formatos compatibles</Text>
            <View style={styles.chipsWrap}>
              {[
                { name: 'TikTok HD', icon: 'musical-notes', color: '#00F2FE' },
                { name: 'X / Twitter', icon: 'logo-twitter', color: '#1DA1F2' },
                { name: 'Reddit', icon: 'logo-reddit', color: '#FF4500' },
                { name: 'Instagram', icon: 'logo-instagram', color: '#E1306C' },
                { name: 'Facebook', icon: 'logo-facebook', color: '#1877F2' },
                { name: 'Pinterest', icon: 'logo-pinterest', color: '#E60023' },
                { name: 'Enlaces .MP4 / Web', icon: 'videocam', color: '#10B981' },
              ].map((item) => (
                <View key={item.name} style={styles.supportedChip}>
                  <Ionicons name={item.icon} size={14} color={item.color} />
                  <Text style={styles.supportedChipText}>{item.name}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* Historial de descargas en la sesión actual */}
          {history.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Descargados recientemente ({history.length})</Text>
              <View style={styles.historyList}>
                {history.map((item) => (
                  <View key={item.id} style={styles.historyItem}>
                    <View style={styles.historyIconBox}>
                      <Ionicons
                        name={item.platform?.icon || 'videocam'}
                        size={20}
                        color={item.platform?.color || theme.colors.primaryLight}
                      />
                    </View>
                    <View style={styles.historyInfo}>
                      <Text style={styles.historyFilename} numberOfLines={1}>
                        {item.filename}
                      </Text>
                      <Text style={styles.historyMeta}>
                        {item.platform?.name || 'Video'} · {formatBytes(item.sizeBytes)} · Álbum "{item.albumName}" · {item.date}
                      </Text>
                    </View>
                    <Ionicons name="checkmark-circle" size={22} color="#10B981" />
                  </View>
                ))}
              </View>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 16,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  sectionTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  sectionSub: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 14,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 50,
  },
  inputIcon: {
    marginRight: 8,
  },
  textInput: {
    flex: 1,
    color: '#ffffff',
    fontSize: 14,
    paddingVertical: 12,
  },
  clearBtn: {
    padding: 6,
  },
  platformBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    marginTop: 10,
    gap: 8,
  },
  platformPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  platformPillText: {
    fontSize: 12,
    fontWeight: '700',
  },
  albumDestText: {
    color: theme.colors.textMuted,
    fontSize: 12,
  },
  downloadButton: {
    marginTop: 16,
    backgroundColor: theme.colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 12,
    gap: 8,
  },
  downloadButtonDisabled: {
    opacity: 0.45,
  },
  downloadButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  progressBox: {
    marginTop: 16,
    backgroundColor: theme.colors.background,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    gap: 10,
  },
  progressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  progressStatusText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  progressBarBg: {
    height: 8,
    backgroundColor: theme.colors.surfaceHover,
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: theme.colors.primary,
    borderRadius: 4,
  },
  progressStatsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  progressStatsText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
  },
  progressPercentText: {
    color: theme.colors.primaryLight,
    fontSize: 12,
    fontWeight: '700',
  },
  processControlsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  pauseProcessBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(245, 158, 11, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.4)',
  },
  resumeProcessBtn: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  pauseProcessText: {
    color: theme.colors.warning,
    fontSize: 13,
    fontWeight: '700',
  },
  resumeProcessText: {
    color: '#ffffff',
  },
  cancelDownloadBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  cancelDownloadText: {
    color: theme.colors.danger,
    fontSize: 13,
    fontWeight: '700',
  },
  errorBox: {
    marginTop: 14,
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  errorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  errorTitle: {
    color: theme.colors.warning,
    fontSize: 13,
    fontWeight: '700',
  },
  errorDesc: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  browserFallbackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: theme.colors.surfaceHover,
    paddingVertical: 9,
    borderRadius: 8,
    marginTop: 4,
  },
  browserFallbackText: {
    color: theme.colors.primaryLight,
    fontSize: 13,
    fontWeight: '600',
  },
  supportedCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  supportedTitle: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 10,
  },
  chipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  supportedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.surfaceHover,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  supportedChipText: {
    color: theme.colors.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  historyList: {
    marginTop: 8,
    gap: 10,
  },
  historyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.background,
    padding: 12,
    borderRadius: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  historyIconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: theme.colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyInfo: {
    flex: 1,
  },
  historyFilename: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  historyMeta: {
    color: theme.colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
});
