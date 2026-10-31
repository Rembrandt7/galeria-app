import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  NativeModules,
  Linking,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

const HISTORY_STORAGE_KEY = '@galeria_browser_history_v1';
const BASE_EMAIL_STORAGE_KEY = '@galeria_browser_base_email_v1';

const QUICK_SITES = [
  { id: 'google', name: 'Google', url: 'https://www.google.com', icon: 'search', color: '#3B82F6' },
  { id: 'youtube', name: 'YouTube', url: 'https://m.youtube.com', icon: 'logo-youtube', color: '#EF4444' },
  { id: 'images', name: 'Imágenes', url: 'https://www.google.com/imghp', icon: 'images', color: '#10B981' },
  { id: 'tiktok', name: 'TikTok', url: 'https://www.tiktok.com', icon: 'musical-notes', color: '#EC4899' },
  { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com', icon: 'logo-instagram', color: '#D946EF' },
  { id: 'facebook', name: 'Facebook', url: 'https://m.facebook.com', icon: 'logo-facebook', color: '#2563EB' },
  { id: 'x', name: 'X / Twitter', url: 'https://x.com', icon: 'logo-twitter', color: '#0EA5E9' },
  { id: 'pinterest', name: 'Pinterest', url: 'https://www.pinterest.com', icon: 'Flame', iconFallback: 'sparkles', color: '#E11D48' },
  { id: 'pexels', name: 'Pexels HD', url: 'https://www.pexels.com/es-es/', icon: 'camera', color: '#14B8A6' },
];

export const WebBrowserModal = ({ visible, onClose, onDownloadVideoUrl }) => {
  const [queryOrUrl, setQueryOrUrl] = useState('');
  const [history, setHistory] = useState([]);
  const [opening, setOpening] = useState(false);
  const [cleaningData, setCleaningData] = useState(false);
  const [baseEmail, setBaseEmail] = useState('');
  const [generatedAlias, setGeneratedAlias] = useState('');

  useEffect(() => {
    if (visible) {
      loadHistory();
      AsyncStorage.getItem(BASE_EMAIL_STORAGE_KEY)
        .then((saved) => {
          if (saved) setBaseEmail(saved);
        })
        .catch(() => {});
    }
  }, [visible]);

  const handleClearFirstTimeData = async (alsoLaunch = false) => {
    setCleaningData(true);
    try {
      if (NativeModules.VideoEngineModule?.clearWebBrowserDataNative) {
        await NativeModules.VideoEngineModule.clearWebBrowserDataNative();
      }
      setCleaningData(false);
      if (alsoLaunch) {
        launchBrowser(queryOrUrl || 'https://www.google.com');
      } else {
        Alert.alert(
          '✨ Identidad Web Limpia (Modo 1ª Vez)',
          'Se borraron todas las Cookies, LocalStorage, Caché y Sesiones.\n\nLas páginas web ahora te detectarán como un visitante nuevo para usar pruebas o beneficios gratuitos.'
        );
      }
    } catch (_e) {
      setCleaningData(false);
    }
  };

  const handleGeneratePromoAlias = async () => {
    const clean = (baseEmail || '').trim();
    if (!clean || !clean.includes('@')) {
      Alert.alert(
        'Ingresa tu correo base',
        'Escribe tu correo normal (ej. tucorreo@gmail.com) para generar un alias +promo único que llega a tu misma bandeja.'
      );
      return;
    }
    try {
      await AsyncStorage.setItem(BASE_EMAIL_STORAGE_KEY, clean);
    } catch (_e) {}
    const [userPart, domainPart] = clean.split('@');
    const cleanUser = userPart.split('+')[0];
    const rand = Math.floor(100 + Math.random() * 900);
    const dayTag = new Date().getDate();
    const alias = `${cleanUser}+promo${dayTag}${rand}@${domainPart}`;
    setGeneratedAlias(alias);
  };

  const loadHistory = async () => {
    try {
      const raw = await AsyncStorage.getItem(HISTORY_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setHistory(parsed);
      }
    } catch (_) {}
  };

  const saveToHistory = async (urlStr) => {
    try {
      const clean = (urlStr || '').trim();
      if (!clean) return;
      const next = [
        { url: clean, timestamp: Date.now() },
        ...history.filter((h) => h.url !== clean),
      ].slice(0, 15);
      setHistory(next);
      await AsyncStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
    } catch (_) {}
  };

  const clearHistory = async () => {
    setHistory([]);
    try {
      await AsyncStorage.removeItem(HISTORY_STORAGE_KEY);
    } catch (_) {}
  };

  const normalizeTargetUrl = (rawInput) => {
    const trimmed = (rawInput || '').trim();
    if (!trimmed) return 'https://www.google.com';
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    if (!trimmed.includes(' ') && trimmed.includes('.')) return `https://${trimmed}`;
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  };

  const launchBrowser = async (targetInput) => {
    const finalUrl = normalizeTargetUrl(targetInput);
    await saveToHistory(finalUrl);
    setOpening(true);
    try {
      if (NativeModules.VideoEngineModule?.openInAppBrowserNative) {
        const res = await NativeModules.VideoEngineModule.openInAppBrowserNative(finalUrl);
        setOpening(false);
        if (res?.url && res.url.startsWith('http')) {
          saveToHistory(res.url);
        }
        if (res?.action === 'download' && res?.url) {
          if (onDownloadVideoUrl) {
            onDownloadVideoUrl(res.url);
          }
        }
      } else {
        setOpening(false);
        await Linking.openURL(finalUrl);
      }
    } catch (_) {
      setOpening(false);
      try {
        await Linking.openURL(finalUrl);
      } catch (_err) {}
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.headerRow}>
            <View style={styles.headerTitleWrap}>
              <View style={styles.headerIconBadge}>
                <Ionicons name="globe" size={18} color="#38BDF8" />
              </View>
              <View>
                <Text style={styles.headerTitle}>Navegador Web Integrado</Text>
                <Text style={styles.headerSubtitle}>
                  Navega sin salir de Mi Galería y captura videos con 1 toque
                </Text>
              </View>
            </View>
            <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
              <Ionicons name="close" size={20} color="#E4E4E7" />
            </TouchableOpacity>
          </View>

          {/* Search / URL Bar */}
          <View style={styles.searchBarRow}>
            <Ionicons name="search-outline" size={18} color="#38BDF8" style={{ marginLeft: 4 }} />
            <TextInput
              style={styles.searchInput}
              placeholder="Buscar en Google o pegar dirección web..."
              placeholderTextColor="#71717A"
              value={queryOrUrl}
              onChangeText={setQueryOrUrl}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={() => launchBrowser(queryOrUrl)}
            />
            {queryOrUrl.length > 0 && (
              <TouchableOpacity onPress={() => setQueryOrUrl('')} style={styles.clearInputBtn}>
                <Ionicons name="close-circle" size={17} color="#71717A" />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.goButton}
              onPress={() => launchBrowser(queryOrUrl)}
              disabled={opening}
            >
              {opening ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons name="arrow-forward" size={15} color="#FFF" />
                  <Text style={styles.goButtonText}>Ir</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
            {/* Direct Open Google Button */}
            <TouchableOpacity
              style={styles.heroLaunchCard}
              activeOpacity={0.85}
              onPress={() => launchBrowser(queryOrUrl || 'https://www.google.com')}
            >
              <View style={styles.heroLaunchLeft}>
                <Ionicons name="compass" size={24} color="#38BDF8" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.heroLaunchTitle}>Abrir Ventana de Navegador</Text>
                  <Text style={styles.heroLaunchSub}>
                    Incluye controles ◀ ▶ ↻, barra "🧹 Limpiar 1ª Vez", cambio de dispositivo y botón ⬇ Video
                  </Text>
                </View>
              </View>
              <Ionicons name="open-outline" size={20} color="#38BDF8" />
            </TouchableOpacity>

            {/* Modo Primera Vez: Limpiador Total de Cookies / Storage + Entrar Limpio */}
            <View
              style={{
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                borderRadius: 16,
                padding: 12,
                borderWidth: 1,
                borderColor: 'rgba(16, 185, 129, 0.35)',
                marginBottom: 14,
                gap: 10,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="sparkles" size={18} color="#34D399" />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: '#ECFDF5', fontSize: 13.5, fontWeight: '800' }}>
                    Modo "Primera Vez" (Beneficios y Pruebas Gratis)
                  </Text>
                  <Text style={{ color: '#A7F3D0', fontSize: 11, marginTop: 1 }}>
                    Borra cookies, caché, almacenamiento local y rastro del sitio con 1 toque
                  </Text>
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    backgroundColor: '#065F46',
                    paddingVertical: 10,
                    paddingHorizontal: 10,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: '#10B981',
                  }}
                  onPress={() => handleClearFirstTimeData(false)}
                  disabled={cleaningData}
                >
                  <Ionicons name="trash-bin-outline" size={15} color="#A7F3D0" />
                  <Text style={{ color: '#ECFDF5', fontSize: 12, fontWeight: '800' }}>
                    {cleaningData ? 'Limpiando...' : '🧹 Limpiar Datos Ahora'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={{
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    backgroundColor: '#047857',
                    paddingVertical: 10,
                    paddingHorizontal: 10,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: '#34D399',
                  }}
                  onPress={() => handleClearFirstTimeData(true)}
                  disabled={cleaningData}
                >
                  <Ionicons name="flash-outline" size={15} color="#FFFFFF" />
                  <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '800' }}>
                    Limpiar y Abrir Web
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Generador de Alias +promo */}
              <View
                style={{
                  borderTopWidth: 1,
                  borderTopColor: 'rgba(16, 185, 129, 0.25)',
                  paddingTop: 8,
                  gap: 6,
                }}
              >
                <Text style={{ color: '#D1FAE5', fontSize: 11.5, fontWeight: '700' }}>
                  📧 Generador de Correo +Alias (Llega a tu mismo Gmail/Outlook pero cuenta como nuevo):
                </Text>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                  <TextInput
                    style={{
                      flex: 1,
                      backgroundColor: '#0F172A',
                      color: '#FFFFFF',
                      fontSize: 12.5,
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                      borderRadius: 9,
                      borderWidth: 1,
                      borderColor: 'rgba(255,255,255,0.15)',
                    }}
                    placeholder="tucorreo@gmail.com"
                    placeholderTextColor="#64748B"
                    value={baseEmail}
                    onChangeText={setBaseEmail}
                    autoCapitalize="none"
                    keyboardType="email-address"
                  />
                  <TouchableOpacity
                    style={{
                      backgroundColor: '#0284C7',
                      paddingHorizontal: 11,
                      paddingVertical: 8,
                      borderRadius: 9,
                    }}
                    onPress={handleGeneratePromoAlias}
                  >
                    <Text style={{ color: '#FFF', fontSize: 11.5, fontWeight: '800' }}>
                      Generar +Alias
                    </Text>
                  </TouchableOpacity>
                </View>
                {Boolean(generatedAlias) && (
                  <View
                    style={{
                      backgroundColor: '#0F172A',
                      borderRadius: 9,
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                      borderWidth: 1,
                      borderColor: '#38BDF8',
                    }}
                  >
                    <Text style={{ color: '#94A3B8', fontSize: 10, marginBottom: 2 }}>
                      Mantén presionado el correo de abajo para copiarlo:
                    </Text>
                    <TextInput
                      value={generatedAlias}
                      editable={true}
                      selectTextOnFocus={true}
                      style={{
                        color: '#38BDF8',
                        fontSize: 13,
                        fontWeight: '800',
                        padding: 0,
                      }}
                    />
                  </View>
                )}
              </View>
            </View>

            {/* Quick Sites Grid */}
            <Text style={styles.sectionTitle}>ACCESOS RÁPIDOS</Text>
            <View style={styles.quickGrid}>
              {QUICK_SITES.map((site) => (
                <TouchableOpacity
                  key={site.id}
                  style={styles.quickTile}
                  activeOpacity={0.8}
                  onPress={() => launchBrowser(site.url)}
                >
                  <View style={[styles.quickIconCircle, { backgroundColor: site.color + '22', borderColor: site.color + '55' }]}>
                    <Ionicons name={site.iconFallback || site.icon} size={20} color={site.color} />
                  </View>
                  <Text style={styles.quickTileLabel} numberOfLines={1}>
                    {site.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* History */}
            <View style={styles.historyHeaderRow}>
              <Text style={styles.sectionTitle}>HISTORIAL RECIENTE</Text>
              {history.length > 0 && (
                <TouchableOpacity onPress={clearHistory}>
                  <Text style={styles.clearHistoryText}>Limpiar</Text>
                </TouchableOpacity>
              )}
            </View>

            {history.length === 0 ? (
              <View style={styles.emptyHistoryBox}>
                <Ionicons name="time-outline" size={22} color="#52525B" />
                <Text style={styles.emptyHistoryText}>
                  Tus páginas visitadas aparecerán aquí para abrirlas rápido.
                </Text>
              </View>
            ) : (
              history.map((item, idx) => (
                <TouchableOpacity
                  key={`${item.url}-${idx}`}
                  style={styles.historyItem}
                  onPress={() => launchBrowser(item.url)}
                >
                  <Ionicons name="globe-outline" size={16} color="#A1A1AA" />
                  <Text style={styles.historyUrlText} numberOfLines={1}>
                    {item.url}
                  </Text>
                  <Ionicons name="chevron-forward" size={15} color="#52525B" />
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.78)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#0F0F1A',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: Platform.OS === 'android' ? 52 : 32,
    maxHeight: '84%',
    borderTopWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.25)',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  headerTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  headerIconBadge: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  headerSubtitle: {
    color: '#A1A1AA',
    fontSize: 11.5,
    marginTop: 1,
  },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#181828',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    marginBottom: 12,
    gap: 6,
  },
  searchInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 13.5,
    paddingVertical: 6,
  },
  clearInputBtn: {
    padding: 4,
  },
  goButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0284C7',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  goButtonText: {
    color: '#FFFFFF',
    fontSize: 12.5,
    fontWeight: '800',
  },
  scrollContent: {
    paddingBottom: 16,
  },
  heroLaunchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(56, 189, 248, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
    borderRadius: 14,
    padding: 12,
    marginBottom: 14,
  },
  heroLaunchLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  heroLaunchTitle: {
    color: '#F8FAFC',
    fontSize: 13.5,
    fontWeight: '800',
  },
  heroLaunchSub: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 2,
  },
  sectionTitle: {
    color: '#71717A',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  quickTile: {
    width: '31%',
    backgroundColor: '#161625',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    gap: 6,
  },
  quickIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickTileLabel: {
    color: '#E4E4E7',
    fontSize: 11.5,
    fontWeight: '700',
  },
  historyHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  clearHistoryText: {
    color: '#EF4444',
    fontSize: 11.5,
    fontWeight: '700',
  },
  emptyHistoryBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#141422',
    padding: 12,
    borderRadius: 12,
  },
  emptyHistoryText: {
    color: '#71717A',
    fontSize: 12,
    flex: 1,
  },
  historyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#141422',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.04)',
  },
  historyUrlText: {
    color: '#D4D4D8',
    fontSize: 12,
    flex: 1,
  },
});
