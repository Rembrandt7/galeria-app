import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  TextInput,
  Linking,
  Platform,
  StatusBar,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { CURRENT_VERSION, CURRENT_BUILD_NUMBER } from '../services/updateService';

const DEFAULT_GITHUB_USER = 'Rembrandt7';
const STORE_CACHE_KEY = '@tienda_remb_downloaded_apks_v1';
const CATALOG_CACHE_KEY = '@tienda_remb_catalog_cache_v2';
const STORE_APK_DIR = `${FileSystem.documentDirectory}tienda_remb_apks/`;

async function ensureStoreDir() {
  const info = await FileSystem.getInfoAsync(STORE_APK_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(STORE_APK_DIR, { intermediates: true });
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return 'APK';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatDateShort(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('es-MX', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch (_e) {
    return '';
  }
}

function getFriendlyAppMeta(repoName, assetName, releaseName, repoDescription) {
  const lowerRepo = (repoName || '').toLowerCase();
  const lowerAsset = (assetName || '').toLowerCase();

  if (lowerAsset.includes('nfc') || lowerRepo === 'nfc-smart-hub') {
    return {
      title: 'NFC Smart Control',
      subtitle: 'Automatización y Acciones Rápidas con Tags NFC',
      description:
        'Configura y ejecuta perfiles inteligentes, rutinas del carro, Wi-Fi, Bluetooth y acciones rápidas al acercar tu celular a un tag NFC.',
      icon: 'radio-outline',
      accentColor: '#10b981',
      badge: 'APP NFC HUB',
      isCurrentApp: false,
    };
  }

  if (lowerAsset.includes('antigravity') || lowerRepo === 'antigravity-pc-control') {
    return {
      title: 'Antigravity PC Control',
      subtitle: 'Chat Remoto Antigravity + Google Desktop para tu PC',
      description:
        'Escribe o dicta por micrófono directo al Antigravity de tu PC, lee respuestas resumidas, controla el escritorio remoto y compila APKs.',
      icon: 'desktop-outline',
      accentColor: '#8b5cf6',
      badge: 'APP PC CONTROL',
      isCurrentApp: false,
    };
  }

  if (lowerAsset.includes('dolphin-control-celular')) {
    return {
      title: 'Dolphin Control Celular',
      subtitle: 'Control Remoto & Emisor Cast para el Carro',
      description:
        'Controla la pantalla del carro desde tu celular, envía videos de YouTube, usa el touchpad y transmite pantalla.',
      icon: 'phone-portrait-outline',
      accentColor: '#38bdf8',
      badge: 'APP CELULAR',
      isCurrentApp: false,
    };
  }

  if (lowerAsset.includes('youtube-dolphin-mini') || lowerRepo === 'youtube-dolphin-app') {
    return {
      title: 'YouTube Dolphin Mini',
      subtitle: 'Centro Multimedia para Pantalla del Carro',
      description:
        'YouTube, Spotify, Google Maps, WhatsApp, Películas USB y receptor Mirror diseñados para BYD Dolphin Mini.',
      icon: 'car-sport-outline',
      accentColor: '#f43f5e',
      badge: 'APP CARRO',
      isCurrentApp: false,
    };
  }

  if (lowerRepo === 'galeria-app') {
    return {
      title: 'Mi Galería Pro',
      subtitle: `Instalada actualmente (${CURRENT_VERSION} #${CURRENT_BUILD_NUMBER})`,
      description:
        'Galería inteligente con compresión de fotos y videos, detector de duplicados, carpetas con PIN y descargador de videos.',
      icon: 'images-outline',
      accentColor: '#a855f7',
      badge: 'ESTA APP',
      isCurrentApp: true,
    };
  }

  const cleanTitle = assetName
    .replace(/\.apk$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase());

  return {
    title: cleanTitle === 'App Release' ? repoName : cleanTitle,
    subtitle: `Repositorio: ${repoName}`,
    description: repoDescription || releaseName || 'Aplicación Android publicada en tu cuenta de GitHub.',
    icon: 'cube-outline',
    accentColor: '#10b981',
    badge: 'GITHUB APK',
    isCurrentApp: false,
  };
}

function buildDefaultRembCatalog() {
  const rawApps = [
    {
      repoName: 'youtube-dolphin-app',
      assetName: 'Dolphin-Control-Celular.apk',
      versionLabel: 'Última versión (latest)',
      downloadUrl:
        'https://github.com/Rembrandt7/youtube-dolphin-app/releases/download/latest/Dolphin-Control-Celular.apk',
      sizeBytes: 19654151,
      updatedAt: '2026-10-25T05:32:50Z',
    },
    {
      repoName: 'youtube-dolphin-app',
      assetName: 'YouTube-Dolphin-Mini.apk',
      versionLabel: 'Última versión (latest)',
      downloadUrl:
        'https://github.com/Rembrandt7/youtube-dolphin-app/releases/download/latest/YouTube-Dolphin-Mini.apk',
      sizeBytes: 19667675,
      updatedAt: '2026-10-25T05:32:50Z',
    },
    {
      repoName: 'antigravity-pc-control',
      assetName: 'Antigravity-PC-Control.apk',
      versionLabel: 'Última versión (latest)',
      downloadUrl:
        'https://github.com/Rembrandt7/antigravity-pc-control/releases/download/latest/Antigravity-PC-Control.apk',
      sizeBytes: 19246942,
      updatedAt: '2026-10-25T02:36:28Z',
    },
    {
      repoName: 'nfc-smart-hub',
      assetName: 'NFC-Smart-Control.apk',
      versionLabel: 'Última versión (latest)',
      downloadUrl:
        'https://github.com/Rembrandt7/nfc-smart-hub/releases/download/latest/NFC-Smart-Control.apk',
      sizeBytes: 19195609,
      updatedAt: '2026-10-25T02:09:32Z',
    },
    {
      repoName: 'galeria-app',
      assetName: 'app-release.apk',
      versionLabel: `${CURRENT_VERSION} (#${CURRENT_BUILD_NUMBER})`,
      downloadUrl:
        'https://github.com/Rembrandt7/galeria-app/releases/download/latest/app-release.apk',
      sizeBytes: 79769971,
      updatedAt: '2026-10-25T03:34:32Z',
    },
  ];

  const apks = rawApps.map((item) => {
    const meta = getFriendlyAppMeta(item.repoName, item.assetName, item.versionLabel, '');
    return {
      id: `${item.repoName}::${item.assetName}`,
      repoName: item.repoName,
      repoUrl: `https://github.com/Rembrandt7/${item.repoName}`,
      assetName: item.assetName,
      versionLabel: item.versionLabel,
      tagName: 'latest',
      downloadUrl: item.downloadUrl,
      sizeBytes: item.sizeBytes,
      updatedAt: item.updatedAt,
      notes: '',
      ...meta,
    };
  });

  const repos = [
    {
      id: 'repo_youtube_dolphin',
      name: 'youtube-dolphin-app',
      html_url: 'https://github.com/Rembrandt7/youtube-dolphin-app',
      description: 'YouTube Dolphin Mini (Carro) + Dolphin Control Celular',
      language: 'TypeScript',
      updated_at: '2026-10-25T05:32:50Z',
    },
    {
      id: 'repo_galeria_app',
      name: 'galeria-app',
      html_url: 'https://github.com/Rembrandt7/galeria-app',
      description: 'Mi Galería Pro con Modo Guardar, compresión 100% y Tienda Remb',
      language: 'JavaScript',
      updated_at: '2026-10-25T03:34:32Z',
    },
    {
      id: 'repo_antigravity_pc',
      name: 'antigravity-pc-control',
      html_url: 'https://github.com/Rembrandt7/antigravity-pc-control',
      description: 'Control Remoto Antigravity PC + Escritorio Remoto desde tu celular',
      language: 'TypeScript',
      updated_at: '2026-10-25T02:36:28Z',
    },
    {
      id: 'repo_nfc_smart_hub',
      name: 'nfc-smart-hub',
      html_url: 'https://github.com/Rembrandt7/nfc-smart-hub',
      description: 'NFC Smart Control para automatización con etiquetas NFC',
      language: 'TypeScript',
      updated_at: '2026-10-25T02:09:32Z',
    },
  ];

  return { apks, repos };
}

export default function TiendaRembModal({ visible, onClose }) {
  const defaultCatalog = useMemo(() => buildDefaultRembCatalog(), []);
  const [githubUser, setGithubUser] = useState(DEFAULT_GITHUB_USER);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('apps'); // 'apps' | 'repos'
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const [apkItems, setApkItems] = useState(defaultCatalog.apks);
  const [repoItems, setRepoItems] = useState(defaultCatalog.repos);
  const [downloadedMap, setDownloadedMap] = useState({});
  const [downloadingId, setDownloadingId] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(0);

  const loadDownloadedMap = useCallback(async () => {
    try {
      await ensureStoreDir();
      const raw = await AsyncStorage.getItem(STORE_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const valid = {};
      for (const [key, entry] of Object.entries(parsed)) {
        if (entry?.uri) {
          const info = await FileSystem.getInfoAsync(entry.uri);
          if (info?.exists && (info.size || 0) > 10000) {
            valid[key] = entry;
          }
        }
      }
      await AsyncStorage.setItem(STORE_CACHE_KEY, JSON.stringify(valid));
      setDownloadedMap(valid);
    } catch (_e) {}
  }, []);

  const sortApks = (list = []) => {
    const copy = [...list];
    copy.sort((a, b) => {
      const score = (item) => {
        const lowerA = (item.assetName || '').toLowerCase();
        const lowerR = (item.repoName || '').toLowerCase();
        if (lowerA.includes('dolphin-control')) return 40;
        if (lowerA.includes('youtube-dolphin')) return 35;
        if (lowerA.includes('antigravity') || lowerR.includes('antigravity')) return 30;
        if (lowerA.includes('nfc') || lowerR.includes('nfc')) return 25;
        if (lowerR === 'galeria-app') return 20;
        return 10;
      };
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    });
    return copy;
  };

  const fetchGithubStore = useCallback(
    async (targetUser = githubUser) => {
      const cleanUser = (targetUser || DEFAULT_GITHUB_USER).trim();
      if (!cleanUser) return;

      setErrorMsg(null);
      await loadDownloadedMap();

      // 1. Hidratar catálogo inmediato (respaldo integrado + caché local) para que SIEMPRE aparezcan tus apps al instante
      const isDefaultUser = cleanUser.toLowerCase() === DEFAULT_GITHUB_USER.toLowerCase();
      let baseApks = isDefaultUser ? [...defaultCatalog.apks] : [];
      let baseRepos = isDefaultUser ? [...defaultCatalog.repos] : [];

      try {
        const cachedRaw = await AsyncStorage.getItem(CATALOG_CACHE_KEY);
        if (cachedRaw && isDefaultUser) {
          const cached = JSON.parse(cachedRaw);
          if (Array.isArray(cached?.apks) && cached.apks.length > 0) {
            const mergedMap = new Map();
            baseApks.forEach((a) => mergedMap.set(a.id, a));
            cached.apks.forEach((a) => mergedMap.set(a.id, { ...mergedMap.get(a.id), ...a }));
            baseApks = sortApks(Array.from(mergedMap.values()));
          }
          if (Array.isArray(cached?.repos) && cached.repos.length > 0) {
            baseRepos = cached.repos;
          }
        }
      } catch (_eCache) {}

      if (baseApks.length > 0) {
        setApkItems(baseApks);
        setRepoItems(baseRepos);
      } else {
        setLoading(true);
      }

      // 2. Actualizar en segundo plano desde GitHub (fusionando con el catálogo base para que si GitHub limita llamadas 403 nunca desaparezcan tus apps)
      try {
        const reposRes = await fetch(
          `https://api.github.com/users/${encodeURIComponent(cleanUser)}/repos?per_page=30&sort=updated`,
          {
            headers: {
              Accept: 'application/vnd.github.v3+json',
              'User-Agent': 'TiendaRemb-Android',
            },
          }
        );

        if (reposRes.ok) {
          const repos = await reposRes.json();
          if (Array.isArray(repos) && repos.length > 0) {
            setRepoItems(repos);
            baseRepos = repos;

            // Consultar releases de los primeros 8 repositorios más recientes para no agotar el límite de GitHub API
            const topRepos = repos.slice(0, 8);
            const discoveredApks = [];

            await Promise.all(
              topRepos.map(async (repo) => {
                try {
                  const relRes = await fetch(
                    `https://api.github.com/repos/${encodeURIComponent(cleanUser)}/${encodeURIComponent(repo.name)}/releases?per_page=3`,
                    {
                      headers: {
                        Accept: 'application/vnd.github.v3+json',
                        'User-Agent': 'TiendaRemb-Android',
                      },
                    }
                  );

                  if (!relRes.ok) return;
                  const releases = await relRes.json();
                  if (!Array.isArray(releases)) return;

                  const seenAssetNamesInRepo = new Set();

                  for (const rel of releases) {
                    const assets = Array.isArray(rel.assets) ? rel.assets : [];
                    for (const asset of assets) {
                      if (!asset?.name || !asset.name.toLowerCase().endsWith('.apk')) continue;
                      const normalizedAssetKey = asset.name.toLowerCase();
                      if (seenAssetNamesInRepo.has(normalizedAssetKey)) continue;
                      seenAssetNamesInRepo.add(normalizedAssetKey);

                      const meta = getFriendlyAppMeta(
                        repo.name,
                        asset.name,
                        rel.name || rel.tag_name,
                        repo.description
                      );

                      discoveredApks.push({
                        id: `${repo.name}::${asset.name}`,
                        repoName: repo.name,
                        repoUrl: repo.html_url,
                        assetName: asset.name,
                        versionLabel: rel.name || rel.tag_name || 'Última versión',
                        tagName: rel.tag_name || 'latest',
                        downloadUrl: asset.browser_download_url,
                        sizeBytes: asset.size || 0,
                        updatedAt: asset.updated_at || rel.published_at || repo.updated_at,
                        notes: rel.body || '',
                        ...meta,
                      });
                    }
                  }
                } catch (_errRepo) {}
              })
            );

            // Fusionar lo descubierto en vivo con el catálogo conocido para nunca perder ninguna app
            const finalMap = new Map();
            baseApks.forEach((a) => finalMap.set(a.id, a));
            discoveredApks.forEach((a) => finalMap.set(a.id, a));
            const mergedList = sortApks(Array.from(finalMap.values()));

            setApkItems(mergedList);
            if (isDefaultUser) {
              AsyncStorage.setItem(
                CATALOG_CACHE_KEY,
                JSON.stringify({ apks: mergedList, repos: baseRepos, savedAt: Date.now() })
              ).catch(() => {});
            }
          }
        } else if (!isDefaultUser && baseApks.length === 0) {
          setErrorMsg(`No se pudo consultar el usuario "${cleanUser}" en GitHub (código ${reposRes.status}).`);
        }
      } catch (err) {
        if (baseApks.length === 0) {
          setErrorMsg(err?.message || 'Error al conectar con GitHub.');
        }
      } finally {
        setLoading(false);
      }
    },
    [githubUser, loadDownloadedMap, defaultCatalog]
  );

  useEffect(() => {
    if (visible) {
      fetchGithubStore(githubUser);
    }
  }, [visible]);

  const installLocalApk = async (localUri, appTitle) => {
    if (Platform.OS !== 'android') {
      Alert.alert('Solo Android', 'La instalación directa de archivos APK solo está disponible en Android.');
      return;
    }

    try {
      const info = await FileSystem.getInfoAsync(localUri);
      if (!info?.exists) {
        Alert.alert('Archivo no encontrado', 'El APK descargado ya no está en caché. Descárgalo nuevamente.');
        await loadDownloadedMap();
        return;
      }

      const contentUri = await FileSystem.getContentUriAsync(localUri);
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        type: 'application/vnd.android.package-archive',
        flags: 1 | 268435456, // FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK
      });
    } catch (_intentErr) {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(localUri, {
          mimeType: 'application/vnd.android.package-archive',
          dialogTitle: `Instalar ${appTitle}`,
        });
      } else {
        Alert.alert('Error', 'No se pudo abrir el instalador de paquetes de Android.');
      }
    }
  };

  const handleDownloadAndInstall = async (item) => {
    if (downloadingId) return;

    try {
      setDownloadingId(item.id);
      setDownloadProgress(0.02);
      await ensureStoreDir();

      const safeFile = item.id.replace(/[^a-zA-Z0-9._-]/g, '_');
      const targetPath = `${STORE_APK_DIR}${safeFile}`;

      try {
        await FileSystem.deleteAsync(targetPath, { idempotent: true });
      } catch (_e) {}

      const downloadResumable = FileSystem.createDownloadResumable(
        item.downloadUrl,
        targetPath,
        {},
        (dp) => {
          if (dp.totalBytesExpectedToWrite > 0) {
            setDownloadProgress(dp.totalBytesWritten / dp.totalBytesExpectedToWrite);
          }
        }
      );

      const res = await downloadResumable.downloadAsync();
      if (!res || res.status >= 400) {
        throw new Error(`El servidor devolvió código ${res?.status || 'desconocido'}`);
      }

      const fileCheck = await FileSystem.getInfoAsync(res.uri);
      if (!fileCheck?.exists || (fileCheck.size && fileCheck.size < 10240)) {
        throw new Error('El archivo descargado no es un APK válido.');
      }

      const nextMap = {
        ...downloadedMap,
        [item.id]: {
          uri: res.uri,
          updatedAt: item.updatedAt,
          versionLabel: item.versionLabel,
          sizeBytes: fileCheck.size || item.sizeBytes,
          savedAt: Date.now(),
        },
      };
      setDownloadedMap(nextMap);
      await AsyncStorage.setItem(STORE_CACHE_KEY, JSON.stringify(nextMap));

      setDownloadingId(null);
      setDownloadProgress(0);

      await installLocalApk(res.uri, item.title);
    } catch (err) {
      setDownloadingId(null);
      setDownloadProgress(0);
      Alert.alert(
        'Error al descargar APK',
        `No se pudo descargar "${item.title}": ${err?.message || 'Error de red'}.\n\n¿Deseas descargarlo directamente en el navegador?`,
        [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Abrir navegador', onPress: () => Linking.openURL(item.downloadUrl) },
        ]
      );
    }
  };

  const filteredApks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return apkItems;
    return apkItems.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.repoName.toLowerCase().includes(q) ||
        item.assetName.toLowerCase().includes(q)
    );
  }, [apkItems, searchQuery]);

  const filteredRepos = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return repoItems;
    return repoItems.filter(
      (r) =>
        (r.name || '').toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q)
    );
  }, [repoItems, searchQuery]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#080b14" />

        {/* Encabezado Tienda Remb */}
        <View style={styles.header}>
          <View style={styles.headerTitleRow}>
            <View style={styles.storeLogoBadge}>
              <Ionicons name="bag-handle" size={22} color="#38bdf8" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle}>Tienda Remb</Text>
              <Text style={styles.headerSubtitle}>
                Tus aplicaciones de GitHub (@{githubUser}) listas para instalar
              </Text>
            </View>
            <TouchableOpacity
              style={styles.refreshBtn}
              onPress={() => fetchGithubStore(githubUser)}
              disabled={loading}
            >
              <Ionicons
                name="refresh"
                size={20}
                color={loading ? theme.colors.textMuted : '#38bdf8'}
              />
            </TouchableOpacity>
            <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
              <Ionicons name="close" size={24} color={theme.colors.textPrimary} />
            </TouchableOpacity>
          </View>

          {/* Buscador de apps en la tienda */}
          <View style={styles.searchBar}>
            <Ionicons name="search" size={18} color={theme.colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Buscar app o repositorio en Tienda Remb..."
              placeholderTextColor={theme.colors.textMuted}
              autoCapitalize="none"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <Ionicons name="close-circle" size={18} color={theme.colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>

          {/* Selector de Pestañas */}
          <View style={styles.tabsRow}>
            <TouchableOpacity
              style={[styles.tabBtn, activeTab === 'apps' && styles.tabBtnActive]}
              onPress={() => setActiveTab('apps')}
            >
              <Ionicons
                name="apps"
                size={16}
                color={activeTab === 'apps' ? '#ffffff' : theme.colors.textSecondary}
              />
              <Text style={[styles.tabBtnText, activeTab === 'apps' && styles.tabBtnTextActive]}>
                Apps Instalables ({filteredApks.length})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.tabBtn, activeTab === 'repos' && styles.tabBtnActive]}
              onPress={() => setActiveTab('repos')}
            >
              <Ionicons
                name="logo-github"
                size={16}
                color={activeTab === 'repos' ? '#ffffff' : theme.colors.textSecondary}
              />
              <Text style={[styles.tabBtnText, activeTab === 'repos' && styles.tabBtnTextActive]}>
                Mis Repositorios ({filteredRepos.length})
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Contenido */}
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {loading ? (
            <View style={styles.centerBox}>
              <ActivityIndicator size="large" color="#38bdf8" />
              <Text style={styles.loadingText}>
                Buscando aplicaciones y APKs en tu GitHub (@{githubUser})...
              </Text>
            </View>
          ) : errorMsg ? (
            <View style={styles.errorCard}>
              <Ionicons name="alert-circle-outline" size={34} color={theme.colors.danger} />
              <Text style={styles.errorTitle}>No se pudo cargar el catálogo</Text>
              <Text style={styles.errorDesc}>{errorMsg}</Text>
              <TouchableOpacity
                style={styles.retryBtn}
                onPress={() => fetchGithubStore(githubUser)}
              >
                <Text style={styles.retryBtnText}>Reintentar conexión</Text>
              </TouchableOpacity>
            </View>
          ) : activeTab === 'apps' ? (
            filteredApks.length === 0 ? (
              <View style={styles.centerBox}>
                <Ionicons name="cube-outline" size={48} color={theme.colors.textMuted} />
                <Text style={styles.emptyTitle}>No se encontraron APKs con ese filtro</Text>
                <Text style={styles.emptySub}>
                  Cuando publiques un archivo .apk en los Releases de cualquiera de tus repositorios de GitHub, aparecerá aquí automáticamente.
                </Text>
              </View>
            ) : (
              filteredApks.map((item) => {
                const isDownloadingThis = downloadingId === item.id;
                const savedEntry = downloadedMap[item.id];
                const isUpToDateInCache =
                  savedEntry &&
                  savedEntry.uri &&
                  (!item.updatedAt || savedEntry.updatedAt === item.updatedAt);

                return (
                  <View key={item.id} style={styles.appCard}>
                    <View style={styles.appCardTop}>
                      <View
                        style={[
                          styles.appIconBox,
                          {
                            backgroundColor: `${item.accentColor}20`,
                            borderColor: `${item.accentColor}66`,
                          },
                        ]}
                      >
                        <Ionicons name={item.icon} size={30} color={item.accentColor} />
                      </View>

                      <View style={styles.appInfoBox}>
                        <View style={styles.appTitleRow}>
                          <Text style={styles.appTitle} numberOfLines={1}>
                            {item.title}
                          </Text>
                          <View
                            style={[
                              styles.appBadge,
                              { backgroundColor: `${item.accentColor}26` },
                            ]}
                          >
                            <Text style={[styles.appBadgeText, { color: item.accentColor }]}>
                              {item.badge}
                            </Text>
                          </View>
                        </View>

                        <Text style={styles.appSubtitle} numberOfLines={1}>
                          {item.subtitle}
                        </Text>

                        <View style={styles.metaPillsRow}>
                          <Text style={styles.metaPill}>📦 {formatBytes(item.sizeBytes)}</Text>
                          <Text style={styles.metaPill}>🏷️ {item.versionLabel}</Text>
                          {item.updatedAt ? (
                            <Text style={styles.metaPill}>
                              🕒 {formatDateShort(item.updatedAt)}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                    </View>

                    <Text style={styles.appDescription}>{item.description}</Text>

                    {isDownloadingThis ? (
                      <View style={styles.progressBox}>
                        <View style={styles.progressHeader}>
                          <ActivityIndicator size="small" color="#38bdf8" />
                          <Text style={styles.progressLabel}>
                            Descargando {item.assetName}... {Math.round(downloadProgress * 100)}%
                          </Text>
                        </View>
                        <View style={styles.progressBarBg}>
                          <View
                            style={[
                              styles.progressBarFill,
                              { width: `${Math.max(4, Math.round(downloadProgress * 100))}%` },
                            ]}
                          />
                        </View>
                      </View>
                    ) : (
                      <View style={styles.appActionsRow}>
                        <TouchableOpacity
                          style={[
                            styles.installBtn,
                            { backgroundColor: item.accentColor },
                            Boolean(downloadingId) && { opacity: 0.5 },
                          ]}
                          disabled={Boolean(downloadingId)}
                          onPress={() => handleDownloadAndInstall(item)}
                        >
                          <Ionicons name="download-outline" size={18} color="#ffffff" />
                          <Text style={styles.installBtnText}>
                            {item.isCurrentApp
                              ? 'Descargar / Actualizar APK'
                              : 'Descargar e Instalar'}
                          </Text>
                        </TouchableOpacity>

                        {savedEntry?.uri ? (
                          <TouchableOpacity
                            style={styles.reinstallCachedBtn}
                            disabled={Boolean(downloadingId)}
                            onPress={() => installLocalApk(savedEntry.uri, item.title)}
                          >
                            <Ionicons name="flash-outline" size={17} color="#38bdf8" />
                            <Text style={styles.reinstallCachedText}>
                              {isUpToDateInCache ? 'Instalar guardado' : 'Guardado'}
                            </Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    )}
                  </View>
                );
              })
            )
          ) : (
            /* Pestaña de todos los repositorios de GitHub */
            filteredRepos.map((repo) => (
              <View key={repo.id} style={styles.repoCard}>
                <View style={styles.repoTopRow}>
                  <Ionicons name="git-branch-outline" size={20} color="#38bdf8" />
                  <Text style={styles.repoName}>{repo.name}</Text>
                  {repo.language ? (
                    <View style={styles.langBadge}>
                      <Text style={styles.langBadgeText}>{repo.language}</Text>
                    </View>
                  ) : null}
                </View>

                {repo.description ? (
                  <Text style={styles.repoDesc}>{repo.description}</Text>
                ) : (
                  <Text style={styles.repoDescMuted}>Sin descripción en GitHub</Text>
                )}

                <View style={styles.repoFooterRow}>
                  <Text style={styles.repoDate}>
                    Actualizado: {formatDateShort(repo.updated_at)}
                  </Text>
                  <TouchableOpacity
                    style={styles.openRepoBtn}
                    onPress={() => Linking.openURL(repo.html_url)}
                  >
                    <Ionicons name="open-outline" size={15} color="#38bdf8" />
                    <Text style={styles.openRepoBtnText}>Ver en GitHub</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#080b14',
  },
  header: {
    paddingTop: Platform.OS === 'android' ? Math.max((StatusBar.currentHeight || 36) + 14, 50) : 52,
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: '#0d1322',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(56, 189, 248, 0.18)',
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  storeLogoBadge: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 1,
  },
  refreshBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#131b2e',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 42,
    marginTop: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    gap: 8,
  },
  searchInput: {
    flex: 1,
    color: '#ffffff',
    fontSize: 14,
    paddingVertical: 0,
  },
  tabsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  tabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
  },
  tabBtnActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8',
  },
  tabBtnText: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '600',
  },
  tabBtnTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  scrollContent: {
    padding: 16,
    paddingBottom: Platform.OS === 'android' ? 68 : 40,
    gap: 14,
  },
  centerBox: {
    paddingVertical: 60,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  loadingText: {
    color: '#94a3b8',
    fontSize: 14,
    marginTop: 14,
    textAlign: 'center',
  },
  emptyTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 12,
    textAlign: 'center',
  },
  emptySub: {
    color: '#94a3b8',
    fontSize: 13,
    marginTop: 6,
    textAlign: 'center',
    lineHeight: 19,
  },
  errorCard: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.35)',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
  },
  errorTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 8,
  },
  errorDesc: {
    color: '#fca5a5',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 14,
  },
  retryBtn: {
    backgroundColor: '#ef4444',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
  retryBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 13,
  },
  appCard: {
    backgroundColor: '#111827',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
  },
  appCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 13,
  },
  appIconBox: {
    width: 58,
    height: 58,
    borderRadius: 16,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  appInfoBox: {
    flex: 1,
  },
  appTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  appTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
    flex: 1,
  },
  appBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  appBadgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  appSubtitle: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 2,
  },
  metaPillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 7,
  },
  metaPill: {
    color: '#cbd5e1',
    fontSize: 11,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  appDescription: {
    color: '#cbd5e1',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 12,
    marginBottom: 14,
  },
  appActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  installBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
  },
  installBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  reinstallCachedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
  },
  reinstallCachedText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
  },
  progressBox: {
    backgroundColor: 'rgba(56, 189, 248, 0.08)',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.25)',
  },
  progressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  progressLabel: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
  },
  progressBarBg: {
    height: 7,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#38bdf8',
    borderRadius: 4,
  },
  repoCard: {
    backgroundColor: '#111827',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  repoTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  repoName: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
    flex: 1,
  },
  langBadge: {
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  langBadgeText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700',
  },
  repoDesc: {
    color: '#cbd5e1',
    fontSize: 13,
    marginTop: 6,
  },
  repoDescMuted: {
    color: '#64748b',
    fontSize: 12,
    fontStyle: 'italic',
    marginTop: 6,
  },
  repoFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  repoDate: {
    color: '#94a3b8',
    fontSize: 11,
  },
  openRepoBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  openRepoBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
  },
});
