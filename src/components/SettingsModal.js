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
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { updateService, CURRENT_VERSION, CURRENT_BUILD_NUMBER } from '../services/updateService';
import { folderService } from '../services/folderService';
import { storageService } from '../services/storageService';

export default function SettingsModal({ visible, onClose, onOpenStore }) {
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [savedApks, setSavedApks] = useState({ current: null, previous: null });
  const [savedPin, setSavedPin] = useState(null);
  const [pinInput, setPinInput] = useState('');
  const [savedDecoyPin, setSavedDecoyPin] = useState('0000');
  const [decoyPinInput, setDecoyPinInput] = useState('');
  const [stripGpsOnShare, setStripGpsOnShare] = useState(true);

  const refreshSavedApks = async () => {
    const apks = await updateService.getSavedApks();
    setSavedApks(apks || { current: null, previous: null });
    return apks || { current: null, previous: null };
  };

  useEffect(() => {
    if (visible) {
      refreshSavedApks();
      storageService.getPin().then((p) => {
        setSavedPin(p);
        setPinInput('');
      });
      storageService.getDecoyPin().then((dp) => {
        setSavedDecoyPin(dp || '0000');
        setDecoyPinInput('');
      });
      storageService.getStripGpsOnShare().then((sg) => {
        setStripGpsOnShare(Boolean(sg));
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
    Alert.alert('PIN guardado', 'Ahora se pedirá este PIN de 4 dígitos (o tu Huella Digital) para mostrar tus carpetas privadas.');
  };

  const handleSaveDecoyPin = async () => {
    const clean = (decoyPinInput || '').trim();
    if (clean.length < 4) {
      Alert.alert('PIN Señuelo', 'Ingresa al menos 4 dígitos o caracteres para tu PIN Señuelo (Modo Pánico).');
      return;
    }
    if (savedPin && clean === savedPin) {
      Alert.alert('PIN Señuelo', 'El PIN Señuelo debe ser distinto a tu PIN real.');
      return;
    }
    await storageService.setDecoyPin(clean);
    setSavedDecoyPin(clean);
    setDecoyPinInput('');
    Alert.alert(
      '🕵️ PIN Señuelo Guardado',
      `Si ingresas "${clean}" al entrar a Archivos, se abrirá el Modo Señuelo ocultando por completo la Bóveda Privada y la carpeta 2do plano.`
    );
  };

  const handleToggleStripGps = async () => {
    const nextVal = !stripGpsOnShare;
    setStripGpsOnShare(nextVal);
    await storageService.setStripGpsOnShare(nextVal);
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
      const localApks = await refreshSavedApks();
      const result = await updateService.checkForUpdates();
      setUpdateInfo(result);

      if (result.hasUpdate && result.apkUrl) {
        setChecking(false);
        // Si ya tenemos descargado este mismo número de compilación en el teléfono, instalar directo sin volver a descargar
        if (
          localApks?.current?.uri &&
          result.remoteRunNumber > 0 &&
          localApks.current.buildNumber === result.remoteRunNumber
        ) {
          await updateService.installSavedApk(localApks.current.uri);
          return;
        }

        // Descargar dentro de la app, guardar la versión anterior y eliminar cualquier APK más viejo
        setDownloading(true);
        try {
          await updateService.downloadAndInstallApk(
            result.apkUrl,
            (pct) => setProgress(pct),
            {
              buildNumber: result.remoteRunNumber,
              version: result.detectedVersion || CURRENT_VERSION,
            }
          );
          await refreshSavedApks();
        } catch (downloadErr) {
          Alert.alert(
            'Aviso de descarga',
            'No se pudo completar la descarga automática: ' +
              (downloadErr?.message || String(downloadErr))
          );
        } finally {
          setDownloading(false);
        }
      } else if (!result.hasUpdate && !result.latestRunUrl) {
        Alert.alert(
          'Ya tienes esta versión instalada',
          result.message || `Tu aplicación ya tiene instalada la última versión (${CURRENT_VERSION}).`
        );
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
      await updateService.downloadAndInstallApk(
        updateInfo.apkUrl,
        (pct) => setProgress(pct),
        {
          buildNumber: updateInfo.remoteRunNumber || CURRENT_BUILD_NUMBER,
          version: updateInfo.detectedVersion || CURRENT_VERSION,
        }
      );
      await refreshSavedApks();
    } catch (e) {
      Alert.alert(
        'Error en la actualización',
        'No se pudo completar la descarga o instalación: ' + (e?.message || String(e))
      );
    } finally {
      setDownloading(false);
    }
  };

  const handleInstallLocalApk = async (apkItem) => {
    if (!apkItem?.uri) return;
    await updateService.installSavedApk(apkItem.uri);
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

            {onOpenStore && (
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  {
                    backgroundColor: '#0284c7',
                    marginTop: 10,
                  },
                ]}
                onPress={() => {
                  onClose();
                  setTimeout(() => onOpenStore(), 150);
                }}
                activeOpacity={0.8}
              >
                <Ionicons name="bag-handle" size={18} color="#ffffff" />
                <Text style={styles.primaryButtonText}>
                  Abrir Tienda Remb (Mis Apps de GitHub)
                </Text>
              </TouchableOpacity>
            )}

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
                          Descargando actualización dentro de la app… {Math.round(progress * 100)}%
                        </Text>
                      </View>
                    ) : (
                      <View style={{ gap: 8 }}>
                        {savedApks?.current?.uri &&
                        updateInfo.remoteRunNumber > 0 &&
                        savedApks.current.buildNumber === updateInfo.remoteRunNumber ? (
                          <TouchableOpacity
                            style={styles.installButton}
                            onPress={() => handleInstallLocalApk(savedApks.current)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="flash" size={20} color="#ffffff" />
                            <Text style={styles.installButtonText}>
                              Instalar APK ya descargado (#{savedApks.current.buildNumber}) — Sin descargar
                            </Text>
                          </TouchableOpacity>
                        ) : (
                          <TouchableOpacity
                            style={styles.installButton}
                            onPress={handleDownloadAndInstall}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="download-outline" size={20} color="#ffffff" />
                            <Text style={styles.installButtonText}>
                              Descargar en la app e instalar ahora
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    )}
                  </>
                ) : (
                  <View style={styles.upToDateBox}>
                    <Ionicons name="checkmark-circle" size={38} color="#10b981" />
                    <Text style={styles.upToDateTitle}>
                      Ya tienes esta versión instalada ({CURRENT_VERSION} #{CURRENT_BUILD_NUMBER})
                    </Text>
                    <Text style={styles.upToDateDesc}>
                      {updateInfo.message || 'No necesitas volver a descargar esta actualización.'}
                    </Text>

                    <View style={styles.alreadyInstalledPill}>
                      <Ionicons name="shield-checkmark" size={16} color="#10b981" />
                      <Text style={styles.alreadyInstalledPillText}>
                        Versión instalada al día • No requiere descarga
                      </Text>
                    </View>

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
                          Descargando APK dentro de la app… {Math.round(progress * 100)}%
                        </Text>
                      </View>
                    ) : savedApks?.current?.uri ? (
                      <TouchableOpacity
                        style={[styles.secondaryButton, { marginTop: 8 }]}
                        onPress={() => handleInstallLocalApk(savedApks.current)}
                        activeOpacity={0.8}
                      >
                        <Ionicons name="cube-outline" size={18} color="#ffffff" />
                        <Text style={styles.secondaryButtonText}>
                          Instalar desde APK guardado ({savedApks.current.label}) — Sin descargar
                        </Text>
                      </TouchableOpacity>
                    ) : updateInfo.apkUrl ? (
                      <TouchableOpacity
                        style={[styles.outlineButton, { marginTop: 8 }]}
                        onPress={handleDownloadAndInstall}
                        activeOpacity={0.8}
                      >
                        <Ionicons name="cloud-download-outline" size={16} color={theme.colors.primaryLight} />
                        <Text style={styles.outlineButtonText}>
                          Guardar copia del APK actual en la app
                        </Text>
                      </TouchableOpacity>
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

            {/* Sección permanente de APKs guardados dentro de la app (Actual y Versión Anterior) */}
            {(savedApks?.current || savedApks?.previous) && (
              <View style={styles.savedApksBox}>
                <View style={styles.savedApksHeaderRow}>
                  <Ionicons name="folder-open-outline" size={18} color="#38bdf8" />
                  <Text style={styles.savedApksTitle}>
                    APKs guardados en la app (Instalar sin descargar)
                  </Text>
                </View>

                {savedApks.current && (
                  <View style={styles.savedApkItemCard}>
                    <View style={{ flex: 1 }}>
                      <View style={styles.savedApkBadgeRow}>
                        <Text style={styles.savedApkItemTitle}>
                          Último APK: {savedApks.current.label}
                        </Text>
                        {savedApks.current.buildNumber === CURRENT_BUILD_NUMBER && (
                          <View style={styles.installedTag}>
                            <Text style={styles.installedTagText}>Ya instalado</Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.savedApkMetaText}>
                        {savedApks.current.sizeBytes
                          ? `${(savedApks.current.sizeBytes / (1024 * 1024)).toFixed(1)} MB · `
                          : ''}
                        Listo para instalar sin gastar datos
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.savedApkInstallBtn}
                      onPress={() => handleInstallLocalApk(savedApks.current)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="download-outline" size={16} color="#ffffff" />
                      <Text style={styles.savedApkInstallBtnText}>Instalar</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {savedApks.previous && (
                  <View style={[styles.savedApkItemCard, styles.savedApkPreviousCard]}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.savedApkPreviousTitle}>
                        Versión anterior guardada: {savedApks.previous.label}
                      </Text>
                      <Text style={styles.savedApkMetaText}>
                        {savedApks.previous.sizeBytes
                          ? `${(savedApks.previous.sizeBytes / (1024 * 1024)).toFixed(1)} MB · `
                          : ''}
                        Respaldo por si deseas regresar a la versión previa
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.savedApkRollbackBtn}
                      onPress={() => handleInstallLocalApk(savedApks.previous)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="refresh-outline" size={16} color="#fde68a" />
                      <Text style={styles.savedApkRollbackBtnText}>Instalar anterior</Text>
                    </TouchableOpacity>
                  </View>
                )}

                <Text style={styles.savedApksHintText}>
                  Al descargar una nueva actualización, la versión previa se conserva aquí como respaldo y el APK más antiguo se elimina automáticamente.
                </Text>
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

            {/* Configuración de PIN Señuelo (Modo Pánico) */}
            <View
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTopWidth: 1,
                borderTopColor: theme.colors.surfaceBorder,
                gap: 8,
              }}
            >
              <Text style={{ color: '#fcd34d', fontSize: 13, fontWeight: '800' }}>
                🕵️ PIN Señuelo / Modo Pánico (Actual: {savedDecoyPin || '0000'})
              </Text>
              <Text style={{ color: theme.colors.textSecondary, fontSize: 11.5, lineHeight: 16 }}>
                Si alguien te pide desbloquear "Archivos", ingresa este PIN falso: abrirá una vista limpia ocultando por completo tu Bóveda Privada y 2do plano.
              </Text>
              <View style={styles.pinRow}>
                <TextInput
                  style={styles.pinInput}
                  value={decoyPinInput}
                  onChangeText={setDecoyPinInput}
                  placeholder="Nuevo PIN Señuelo (ej. 0000)"
                  placeholderTextColor={theme.colors.textMuted}
                  maxLength={12}
                  secureTextEntry
                />
                <TouchableOpacity
                  style={[styles.pinSaveBtn, { backgroundColor: '#d97706' }]}
                  onPress={handleSaveDecoyPin}
                  activeOpacity={0.8}
                >
                  <Ionicons name="eye-off-outline" size={16} color="#fff" />
                  <Text style={styles.pinSaveBtnText}>Guardar Señuelo</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Limpiador de Metadatos GPS al Compartir */}
            <View
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTopWidth: 1,
                borderTopColor: theme.colors.surfaceBorder,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#34d399', fontSize: 13, fontWeight: '800' }}>
                  🛡️ Limpiar ubicación GPS al compartir fotos
                </Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 11.5, marginTop: 2 }}>
                  Elimina coordenadas GPS (EXIF) automáticamente antes de enviar fotos por WhatsApp o redes.
                </Text>
              </View>
              <TouchableOpacity
                onPress={handleToggleStripGps}
                style={{
                  backgroundColor: stripGpsOnShare ? '#059669' : '#3f3f46',
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: stripGpsOnShare ? '#34d399' : '#52525b',
                }}
              >
                <Text style={{ color: '#ffffff', fontSize: 12, fontWeight: '800' }}>
                  {stripGpsOnShare ? 'ACTIVO' : 'APAGADO'}
                </Text>
              </TouchableOpacity>
            </View>
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
    paddingTop: Platform.OS === 'android' ? Math.max((StatusBar.currentHeight || 36) + 14, 50) : 52,
    paddingBottom: 12,
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
    paddingBottom: Platform.OS === 'android' ? 68 : 40,
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
  alreadyInstalledPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.4)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    marginTop: 6,
  },
  alreadyInstalledPillText: {
    color: '#34d399',
    fontSize: 12,
    fontWeight: '700',
  },
  savedApksBox: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: theme.colors.surfaceBorder,
    gap: 10,
  },
  savedApksHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  savedApksTitle: {
    color: '#e2e8f0',
    fontSize: 13.5,
    fontWeight: '800',
  },
  savedApkItemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.35)',
    borderRadius: 10,
    padding: 11,
  },
  savedApkPreviousCard: {
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    borderColor: 'rgba(245, 158, 11, 0.35)',
  },
  savedApkBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  savedApkItemTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  savedApkPreviousTitle: {
    color: '#fde68a',
    fontSize: 13,
    fontWeight: '800',
  },
  installedTag: {
    backgroundColor: '#10b981',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  installedTagText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
  },
  savedApkMetaText: {
    color: theme.colors.textSecondary,
    fontSize: 11.5,
    marginTop: 2,
  },
  savedApkInstallBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#10b981',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  savedApkInstallBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  savedApkRollbackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    borderWidth: 1,
    borderColor: '#f59e0b',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
  },
  savedApkRollbackBtnText: {
    color: '#fde68a',
    fontSize: 11.5,
    fontWeight: '800',
  },
  savedApksHintText: {
    color: theme.colors.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
});
