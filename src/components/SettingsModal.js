import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  Linking,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { updateService, CURRENT_VERSION } from '../services/updateService';

export default function SettingsModal({ visible, onClose }) {
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleCheckUpdates = async () => {
    setChecking(true);
    setUpdateInfo(null);
    setProgress(0);
    try {
      const result = await updateService.checkForUpdates();
      setUpdateInfo(result);
      if (!result.hasUpdate && !result.latestRunUrl) {
        Alert.alert('Al día', result.message || 'Tu aplicación tiene la última versión disponible.');
      }
    } catch (e) {
      Alert.alert(
        'Error de conexión',
        'No se pudo conectar con GitHub. Comprueba tu conexión a Internet e inténtalo de nuevo.'
      );
    }
    setChecking(false);
  };

  const handleDownloadAndInstall = async () => {
    if (!updateInfo?.apkUrl) return;
    setDownloading(true);
    setProgress(0);
    try {
      await updateService.downloadAndInstallApk(updateInfo.apkUrl, (pct) => {
        setProgress(pct);
      });
    } catch (e) {
      Alert.alert(
        'Error en la actualización',
        'No se pudo completar la descarga o instalación: ' + (e?.message || String(e))
      );
    }
    setDownloading(false);
  };

  const handleOpenGitHub = (url) => {
    if (url) {
      Linking.openURL(url);
    } else {
      Linking.openURL('https://github.com/Rembrandt7/galeria-app');
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
      <SafeAreaView style={styles.container}>
        {/* Cabecera */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={26} color="#ffffff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Configuración</Text>
          <View style={styles.iconBtn} />
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {/* Tarjeta de Actualizaciones */}
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <View style={styles.cardIconWrap}>
                <Ionicons name="cloud-download-outline" size={24} color={theme.colors.primary} />
              </View>
              <View style={styles.cardHeaderText}>
                <Text style={styles.cardTitle}>Actualizaciones</Text>
                <Text style={styles.cardSubtitle}>Versión instalada: {CURRENT_VERSION}</Text>
              </View>
            </View>

            <TouchableOpacity
              style={[styles.primaryButton, checking && { opacity: 0.7 }]}
              onPress={handleCheckUpdates}
              disabled={checking || downloading}
              activeOpacity={0.8}
            >
              {checking ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <>
                  <Ionicons name="sync" size={18} color="#ffffff" />
                  <Text style={styles.primaryButtonText}>Buscar actualizaciones</Text>
                </>
              )}
            </TouchableOpacity>

            {/* Resultado de la búsqueda */}
            {updateInfo && (
              <View style={styles.updateResultBox}>
                {updateInfo.hasUpdate ? (
                  <>
                    <View style={styles.badgeUpdate}>
                      <Ionicons name="sparkles" size={16} color="#ffffff" />
                      <Text style={styles.badgeUpdateText}>Nueva versión {updateInfo.version}</Text>
                    </View>

                    {updateInfo.notes ? (
                      <Text style={styles.updateNotes}>{updateInfo.notes}</Text>
                    ) : null}

                    {downloading ? (
                      <View style={styles.progressContainer}>
                        <View style={styles.progressBarBg}>
                          <View style={[styles.progressBarFill, { width: `${Math.round(progress * 100)}%` }]} />
                        </View>
                        <Text style={styles.progressText}>
                          Descargando actualización… {Math.round(progress * 100)}%
                        </Text>
                      </View>
                    ) : (
                      <TouchableOpacity
                        style={[styles.installButton]}
                        onPress={handleDownloadAndInstall}
                        activeOpacity={0.8}
                      >
                        <Ionicons name="download-outline" size={20} color="#ffffff" />
                        <Text style={styles.installButtonText}>Descargar e instalar ahora</Text>
                      </TouchableOpacity>
                    )}
                  </>
                ) : updateInfo.latestRunUrl ? (
                  <View style={styles.upToDateBox}>
                    <Ionicons name="checkmark-circle-outline" size={32} color={theme.colors.primary} />
                    <Text style={styles.upToDateTitle}>Tu app está al día</Text>
                    <Text style={styles.upToDateDesc}>
                      Última compilación exitosa detectada en GitHub Actions.
                    </Text>
                    <TouchableOpacity
                      style={styles.outlineButton}
                      onPress={() => handleOpenGitHub(updateInfo.latestRunUrl)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="logo-github" size={16} color={theme.colors.primaryLight} />
                      <Text style={styles.outlineButtonText}>Ver compilación en GitHub</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={styles.upToDateBox}>
                    <Ionicons name="checkmark-circle-outline" size={32} color={theme.colors.primary} />
                    <Text style={styles.upToDateTitle}>Todo en orden</Text>
                    <Text style={styles.upToDateDesc}>{updateInfo.message}</Text>
                  </View>
                )}
              </View>
            )}
          </View>

          {/* Tarjeta de Información */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Acerca de Mi Galería</Text>
            <Text style={styles.aboutText}>
              Aplicación de galería rápida para Android con visor multimedia, recorte de video y fotos, detector de duplicados y explorador por carpetas.
            </Text>

            <TouchableOpacity
              style={styles.rowItem}
              onPress={() => handleOpenGitHub('https://github.com/Rembrandt7/galeria-app')}
              activeOpacity={0.7}
            >
              <Ionicons name="logo-github" size={20} color={theme.colors.textSecondary} />
              <Text style={styles.rowItemText}>Repositorio en GitHub</Text>
              <Ionicons name="chevron-forward" size={18} color={theme.colors.textMuted} />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.rowItem}
              onPress={() => handleOpenGitHub('https://github.com/Rembrandt7/galeria-app/actions')}
              activeOpacity={0.7}
            >
              <Ionicons name="hardware-chip-outline" size={20} color={theme.colors.textSecondary} />
              <Text style={styles.rowItemText}>Compilaciones de GitHub Actions</Text>
              <Ionicons name="chevron-forward" size={18} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
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
  headerTitle: {
    color: '#ffffff',
    fontSize: 18,
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
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  cardIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: theme.colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardHeaderText: {
    flex: 1,
  },
  cardTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  cardSubtitle: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    marginTop: 2,
  },
  primaryButton: {
    backgroundColor: theme.colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    paddingHorizontal: 20,
    borderRadius: 10,
    gap: 8,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  updateResultBox: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: theme.colors.surfaceBorder,
  },
  badgeUpdate: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#10b981',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 6,
    marginBottom: 10,
  },
  badgeUpdateText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  updateNotes: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 14,
  },
  installButton: {
    backgroundColor: '#10b981',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    gap: 8,
  },
  installButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  progressContainer: {
    gap: 8,
  },
  progressBarBg: {
    height: 8,
    backgroundColor: theme.colors.surfaceHover,
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#10b981',
    borderRadius: 4,
  },
  progressText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
  },
  upToDateBox: {
    alignItems: 'center',
    paddingVertical: 12,
    gap: 6,
  },
  upToDateTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  upToDateDesc: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  outlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceHover,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    gap: 6,
    marginTop: 8,
  },
  outlineButtonText: {
    color: theme.colors.primaryLight,
    fontSize: 13,
    fontWeight: '600',
  },
  aboutText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
    marginBottom: 14,
  },
  rowItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.surfaceBorder,
    gap: 12,
  },
  rowItemText: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: 14,
  },
});
