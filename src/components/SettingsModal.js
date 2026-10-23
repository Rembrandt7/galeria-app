import React, { useState, useEffect } from 'react';
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
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { updateService, CURRENT_VERSION, CURRENT_BUILD_NUMBER } from '../services/updateService';
import { folderService } from '../services/folderService';
import { storageService } from '../services/storageService';

export default function SettingsModal({ visible, onClose }) {
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [savedPin, setSavedPin] = useState(null);
  const [pinInput, setPinInput] = useState('');

  useEffect(() => {
    if (visible) {
      storageService.getPin().then((p) => {
        setSavedPin(p);
        setPinInput('');
      });
    }
  }, [visible]);

  const handleSavePin = async () => {
    const clean = (pinInput || '').trim();
    if (!/^\d{4}$/.test(clean)) {
      Alert.alert('PIN inválido', 'Ingresa un PIN numérico de exactamente 4 dígitos.');
      return;
    }
    await storageService.setPin(clean);
    setSavedPin(clean);
    setPinInput('');
    Alert.alert('PIN guardado', 'Ahora se pedirá este PIN de 4 dígitos para mostrar tus carpetas ocultas.');
  };

  const handleRemovePin = async () => {
    await storageService.setPin(null);
    setSavedPin(null);
    setPinInput('');
    Alert.alert('PIN desactivado', 'Se eliminó la protección por PIN para carpetas ocultas.');
  };

  const handleCheckUpdates = async () => {
    setChecking(true);
    setUpdateInfo(null);
    setProgress(0);
    try {
      const result = await updateService.checkForUpdates();
      setUpdateInfo(result);

      // Si existe un APK listo para descargar, actualizar automáticamente de inmediato
      if (result.hasUpdate && result.apkUrl) {
        setChecking(false);
        setDownloading(true);
        try {
          await updateService.downloadAndInstallApk(result.apkUrl, (pct) => {
            setProgress(pct);
          });
        } catch (downloadErr) {
          Alert.alert(
            'Aviso de descarga',
            'No se pudo completar la instalación automática: ' + (downloadErr?.message || String(downloadErr))
          );
        } finally {
          setDownloading(false);
        }
      } else if (!result.hasUpdate && !result.latestRunUrl) {
        Alert.alert('Al día', result.message || `Tu aplicación tiene la última versión disponible (${CURRENT_VERSION}).`);
      }
    } catch (e) {
      Alert.alert(
        'Error de conexión',
        'No se pudo conectar con GitHub. Comprueba tu conexión a Internet e inténtalo de nuevo.'
      );
    } finally {
      setChecking(false);
    }
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
    } finally {
      setDownloading(false);
    }
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
                <Text style={styles.cardSubtitle}>
                  Versión instalada: {CURRENT_VERSION} (#{CURRENT_BUILD_NUMBER})
                </Text>
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

                    {updateInfo.apkSize ? (
                      <Text style={styles.apkSizeText}>
                        Tamaño del instalador: {(updateInfo.apkSize / (1024 * 1024)).toFixed(1)} MB
                      </Text>
                    ) : null}

                    {updateInfo.notes ? (
                      <Text style={styles.updateNotes}>{updateInfo.notes}</Text>
                    ) : null}

                    {downloading ? (
                      <View style={styles.progressContainer}>
                        <View style={styles.progressBarBg}>
                          <View
                            style={[
                              styles.progressBarFill,
                              { width: `${Math.round(progress * 100)}%` },
                            ]}
                          />
                        </View>
                        <Text style={styles.progressText}>
                          Descargando actualización… {Math.round(progress * 100)}%
                        </Text>
                      </View>
                    ) : (
                      <View style={{ gap: 8 }}>
                        <TouchableOpacity
                          style={[styles.installButton]}
                          onPress={handleDownloadAndInstall}
                          activeOpacity={0.8}
                        >
                          <Ionicons name="download-outline" size={20} color="#ffffff" />
                          <Text style={styles.installButtonText}>Descargar e instalar ahora</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.outlineButton}
                          onPress={() => handleOpenGitHub(updateInfo.apkUrl)}
                          activeOpacity={0.8}
                        >
                          <Ionicons name="globe-outline" size={16} color={theme.colors.primaryLight} />
                          <Text style={styles.outlineButtonText}>Descargar en navegador (Chrome)</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </>
                ) : (
                  <View style={styles.upToDateBox}>
                    <Ionicons name="checkmark-circle-outline" size={36} color="#10b981" />
                    <Text style={styles.upToDateTitle}>Tu app está al día</Text>
                    <Text style={styles.upToDateDesc}>
                      {updateInfo.message || 'Tienes instalada la versión más reciente disponible.'}
                    </Text>

                    {downloading ? (
                      <View style={[styles.progressContainer, { width: '100%', marginTop: 8 }]}>
                        <View style={styles.progressBarBg}>
                          <View
                            style={[
                              styles.progressBarFill,
                              { width: `${Math.round(progress * 100)}%` },
                            ]}
                          />
                        </View>
                        <Text style={styles.progressText}>
                          Descargando APK… {Math.round(progress * 100)}%
                        </Text>
                      </View>
                    ) : updateInfo.apkUrl ? (
                      <View style={{ width: '100%', gap: 8, marginTop: 8 }}>
                        <TouchableOpacity
                          style={[styles.secondaryButton]}
                          onPress={handleDownloadAndInstall}
                          activeOpacity={0.8}
                        >
                          <Ionicons name="cloud-download-outline" size={18} color="#ffffff" />
                          <Text style={styles.secondaryButtonText}>
                            Reinstalar / Descargar APK actual
                          </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.outlineButton}
                          onPress={() => handleOpenGitHub(updateInfo.apkUrl)}
                          activeOpacity={0.8}
                        >
                          <Ionicons name="globe-outline" size={16} color={theme.colors.primaryLight} />
                          <Text style={styles.outlineButtonText}>Descargar en navegador (Chrome)</Text>
                        </TouchableOpacity>
                      </View>
                    ) : null}

                    {updateInfo.latestRunUrl ? (
                      <TouchableOpacity
                        style={styles.outlineButton}
                        onPress={() => handleOpenGitHub(updateInfo.latestRunUrl)}
                        activeOpacity={0.8}
                      >
                        <Ionicons name="logo-github" size={16} color={theme.colors.primaryLight} />
                        <Text style={styles.outlineButtonText}>Ver compilaciones en GitHub</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                )}
              </View>
            )}
          </View>

          {/* Tarjeta de Seguridad de Carpetas Ocultas (PIN y Auto-bloqueo) */}
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <View style={[styles.cardIconWrap, { backgroundColor: 'rgba(245, 158, 11, 0.15)' }]}>
                <Ionicons name="lock-closed-outline" size={24} color={theme.colors.warning} />
              </View>
              <View style={styles.cardHeaderText}>
                <Text style={styles.cardTitle}>Privacidad de Carpetas Ocultas</Text>
                <Text style={styles.cardSubtitle}>
                  {savedPin ? 'PIN de 4 dígitos activo · Auto-bloqueo activo' : 'Auto-bloqueo al minimizar activo · Sin PIN'}
                </Text>
              </View>
            </View>
            <Text style={styles.aboutText}>
              Las carpetas ocultas se bloquean automáticamente al cerrar o minimizar la app. Además, puedes definir un PIN de 4 dígitos para desbloquear el botón "Todo visible".
            </Text>
            <View style={styles.pinRow}>
              <TextInput
                style={styles.pinInput}
                value={pinInput}
                onChangeText={(t) => setPinInput(t.replace(/[^0-9]/g, '').slice(0, 4))}
                placeholder={savedPin ? 'Nuevo PIN (4 dígitos)' : 'PIN de 4 dígitos'}
                placeholderTextColor={theme.colors.textMuted}
                keyboardType="numeric"
                maxLength={4}
                secureTextEntry
              />
              <TouchableOpacity style={styles.pinSaveBtn} onPress={handleSavePin} activeOpacity={0.8}>
                <Ionicons name="key-outline" size={16} color="#fff" />
                <Text style={styles.pinSaveBtnText}>{savedPin ? 'Cambiar PIN' : 'Activar PIN'}</Text>
              </TouchableOpacity>
            </View>
            {savedPin && (
              <TouchableOpacity
                style={[styles.outlineButton, { marginTop: 10, borderColor: theme.colors.danger }]}
                onPress={handleRemovePin}
                activeOpacity={0.8}
              >
                <Ionicons name="trash-outline" size={16} color={theme.colors.danger} />
                <Text style={[styles.outlineButtonText, { color: theme.colors.danger }]}>
                  Quitar protección por PIN
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Tarjeta de Permisos del Sistema */}
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <View style={[styles.cardIconWrap, { backgroundColor: 'rgba(56, 189, 248, 0.15)' }]}>
                <Ionicons name="shield-checkmark-outline" size={24} color={theme.colors.accent} />
              </View>
              <View style={styles.cardHeaderText}>
                <Text style={styles.cardTitle}>Permisos del sistema</Text>
                <Text style={styles.cardSubtitle}>Acceso total a memoria y carpetas</Text>
              </View>
            </View>
            <Text style={styles.aboutText}>
              Para que la aplicación pueda mostrar carpetas ocultas, descargas y archivos multimedia del sistema en Android 11+, activa el permiso especial "Acceso a todos los archivos".
            </Text>
            <TouchableOpacity
              style={[styles.outlineButton, { borderColor: theme.colors.accent, marginTop: 10 }]}
              onPress={() => folderService.openAllFilesAccessSettings()}
              activeOpacity={0.8}
            >
              <Ionicons name="settings-outline" size={16} color={theme.colors.accent} />
              <Text style={[styles.outlineButtonText, { color: theme.colors.accent }]}>
                Abrir Ajustes de Acceso a Todos los Archivos
              </Text>
            </TouchableOpacity>
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
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceHover,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    gap: 6,
    width: '100%',
  },
  outlineButtonText: {
    color: theme.colors.primaryLight,
    fontSize: 13,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: theme.colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 8,
    gap: 8,
    width: '100%',
  },
  secondaryButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  apkSizeText: {
    color: theme.colors.textMuted,
    fontSize: 12,
    marginBottom: 6,
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
  pinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pinInput: {
    flex: 1,
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#ffffff',
    fontSize: 14,
    letterSpacing: 4,
  },
  pinSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.warning,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 8,
  },
  pinSaveBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
});
