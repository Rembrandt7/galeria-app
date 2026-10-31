import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Image,
  ActivityIndicator,
  Alert,
  Platform,
  StatusBar,
  NativeModules,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as MediaLibrary from 'expo-media-library/legacy';

const FACE_INDEX_STORAGE_KEY = '@galeria_checkremb_face_index_v1';
const CHECKREMB_SERVER_URL_KEY = '@galeria_checkremb_server_url_v1';

const SOCIAL_PLATFORMS = [
  { id: 'all', label: '🌐 Todas las Redes', siteFilter: '' },
  { id: 'instagram', label: '📸 Instagram', siteFilter: 'site:instagram.com' },
  { id: 'facebook', label: '📘 Facebook', siteFilter: 'site:facebook.com' },
  { id: 'pinterest', label: '📌 Pinterest', siteFilter: 'site:pinterest.com' },
  { id: 'x', label: '🐦 X / Twitter', siteFilter: 'site:x.com OR site:twitter.com' },
  { id: 'tiktok', label: '🎵 TikTok', siteFilter: 'site:tiktok.com' },
];

function computeCosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = Number(vecA[i]) || 0;
    const b = Number(vecB[i]) || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom <= 1e-8) return 0;
  // Mapear similitud coseno al rango 0..100%
  const raw = dot / denom;
  return Math.max(0, Math.min(1, raw));
}

export default function FaceCheckModal({
  visible,
  onClose,
  onOpenBrowserUrl,
  onOpenAsset,
}) {
  const [activeTab, setActiveTab] = useState('search'); // 'search' | 'crawl' | 'compare' | 'index'
  const [faceIndex, setFaceIndex] = useState([]);
  const [serverUrl, setServerUrl] = useState('');
  const [showServerConfig, setShowServerConfig] = useState(false);

  // Tab 1: Buscar Rostro
  const [queryPhoto, setQueryPhoto] = useState(null); // { uri, cropUri, embedding, confidence }
  const [searchingFace, setSearchingFace] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [minThreshold, setMinThreshold] = useState(0.68);

  // Tab 2: Rastrear Redes / Galería
  const [crawlPlatform, setCrawlPlatform] = useState('all');
  const [crawlQuery, setCrawlQuery] = useState('');
  const [crawling, setCrawling] = useState(false);
  const [crawlStatus, setCrawlStatus] = useState('');
  const [crawlSummary, setCrawlSummary] = useState(null);

  // Tab 3: Verificar 1:1 (Comparar 2 Rostros)
  const [compareFaceA, setCompareFaceA] = useState(null);
  const [compareFaceB, setCompareFaceB] = useState(null);
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState(null);

  // Selector interno de fotos de Mi Galería (sin depender de paquetes externos)
  const [pickerTarget, setPickerTarget] = useState(null); // null | 'query' | 'A' | 'B'
  const [pickerPhotos, setPickerPhotos] = useState([]);
  const [loadingPickerPhotos, setLoadingPickerPhotos] = useState(false);

  useEffect(() => {
    if (visible) {
      loadFaceIndex();
      AsyncStorage.getItem(CHECKREMB_SERVER_URL_KEY)
        .then((u) => {
          if (u) setServerUrl(u);
        })
        .catch(() => {});
    }
  }, [visible]);

  const loadFaceIndex = async () => {
    try {
      const raw = await AsyncStorage.getItem(FACE_INDEX_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setFaceIndex(parsed);
      }
    } catch (_e) {}
  };

  const saveFaceIndex = async (nextList) => {
    setFaceIndex(nextList);
    try {
      await AsyncStorage.setItem(FACE_INDEX_STORAGE_KEY, JSON.stringify(nextList.slice(0, 600)));
    } catch (_e) {}
  };

  const handleSaveServerUrl = async (val) => {
    const clean = (val || '').trim().replace(/\/+$/, '');
    setServerUrl(clean);
    try {
      await AsyncStorage.setItem(CHECKREMB_SERVER_URL_KEY, clean);
    } catch (_e) {}
  };

  const extractFaceDataFromUri = async (uri, allowFallback = true) => {
    if (!NativeModules?.VideoEngineModule?.detectFacesAndEmbedNative) {
      throw new Error('El motor biométrico nativo no está disponible.');
    }
    const res = await NativeModules.VideoEngineModule.detectFacesAndEmbedNative(uri, allowFallback);
    const faces = Array.isArray(res?.faces) ? res.faces : [];
    if (faces.length === 0) {
      return null;
    }
    const primary = faces[0];
    return {
      uri,
      cropUri: primary.cropUri || uri,
      embedding: Array.isArray(primary.embedding) ? primary.embedding : [],
      confidence: Number(primary.confidence || 0.8),
      allFaces: faces,
    };
  };

  const openGalleryPicker = async (targetSlot) => {
    setPickerTarget(targetSlot);
    if (pickerPhotos.length === 0) {
      setLoadingPickerPhotos(true);
      try {
        const media = await MediaLibrary.getAssetsAsync({
          first: 120,
          mediaType: ['photo'],
          sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        });
        setPickerPhotos(media?.assets || []);
      } catch (_e) {
      } finally {
        setLoadingPickerPhotos(false);
      }
    }
  };

  const handlePhotoChosenFromPicker = async (pickedUri) => {
    const target = pickerTarget;
    setPickerTarget(null);
    if (!pickedUri || !target) return;

    if (target === 'query') {
      try {
        setSearchingFace(true);
        setSearchResults([]);
        const faceData = await extractFaceDataFromUri(pickedUri, true);
        if (!faceData) {
          setSearchingFace(false);
          Alert.alert('Sin rostro detectado', 'No se detectó un rostro claro en la imagen seleccionada.');
          return;
        }
        setQueryPhoto(faceData);
        await runBiometricSearch(faceData, pickedUri);
      } catch (e) {
        Alert.alert('Aviso', e?.message || 'Error al analizar el rostro.');
      } finally {
        setSearchingFace(false);
      }
    } else if (target === 'A' || target === 'B') {
      try {
        setComparing(true);
        setCompareResult(null);
        const faceData = await extractFaceDataFromUri(pickedUri, true);
        if (!faceData) {
          Alert.alert('Sin rostro', 'No se pudo detectar un rostro en esa imagen.');
          setComparing(false);
          return;
        }
        if (target === 'A') {
          setCompareFaceA(faceData);
          if (compareFaceB) {
            const sim = computeCosineSimilarity(faceData.embedding, compareFaceB.embedding);
            setCompareResult({
              similarity: sim,
              isMatch: sim >= 0.75,
              isPossible: sim >= 0.62 && sim < 0.75,
            });
          }
        } else {
          setCompareFaceB(faceData);
          if (compareFaceA) {
            const sim = computeCosineSimilarity(compareFaceA.embedding, faceData.embedding);
            setCompareResult({
              similarity: sim,
              isMatch: sim >= 0.75,
              isPossible: sim >= 0.62 && sim < 0.75,
            });
          }
        }
      } catch (_e) {
      } finally {
        setComparing(false);
      }
    }
  };

  // --- TAB 1: BUSCAR ROSTRO ---
  const handleSelectQueryPhoto = () => {
    openGalleryPicker('query');
  };

  const runBiometricSearch = async (faceData, originalUri) => {
    setSearchingFace(true);
    try {
      const matches = [];
      // 1. Búsqueda local en el índice biométrico de CheckRemb
      for (const item of faceIndex) {
        if (!Array.isArray(item.embedding) || item.embedding.length === 0) continue;
        const sim = computeCosineSimilarity(faceData.embedding, item.embedding);
        if (sim >= minThreshold) {
          matches.push({
            ...item,
            similarity: sim,
          });
        }
      }

      // 2. Si el usuario configuró su servidor CheckRemb Backend (FastAPI /api/v1/search), consultar también ahí
      if (serverUrl && serverUrl.startsWith('http') && originalUri) {
        try {
          const form = new FormData();
          form.append('file', {
            uri: originalUri,
            name: 'query_face.jpg',
            type: 'image/jpeg',
          });
          const resp = await fetch(
            `${serverUrl}/api/v1/search?limit=20&score_threshold=${minThreshold}`,
            {
              method: 'POST',
              body: form,
            }
          );
          if (resp.ok) {
            const data = await resp.json();
            const remoteMatches = Array.isArray(data?.matches) ? data.matches : [];
            remoteMatches.forEach((rm, idx) => {
              matches.push({
                id: rm.face_id || `remote_${idx}`,
                cropUri: rm.face_crop_b64
                  ? `data:image/jpeg;base64,${rm.face_crop_b64}`
                  : faceData.cropUri,
                sourceUrl: rm.source_url || 'Servidor CheckRemb',
                title: rm.person_label || rm.source_url || 'Coincidencia Servidor',
                platform: 'CheckRemb Server',
                similarity: Number(rm.similarity || 0.8),
              });
            });
          }
        } catch (_srvErr) {}
      }

      matches.sort((a, b) => b.similarity - a.similarity);
      setSearchResults(matches.slice(0, 30));
    } finally {
      setSearchingFace(false);
    }
  };

  // --- TAB 2: RASTREAR REDES / INDEXAR GALERÍA ---
  const handleCrawlSocialFaces = async () => {
    const q = (crawlQuery || '').trim();
    if (!q) {
      Alert.alert(
        'Ingresa un nombre o usuario',
        'Escribe el nombre de la persona, @usuario o pega una dirección web para rastrear e indexar sus rostros.'
      );
      return;
    }

    setCrawling(true);
    setCrawlSummary(null);
    setCrawlStatus('Conectando con buscador de rostros en redes...');

    try {
      let targetSearchUrl = q;
      const platObj = SOCIAL_PLATFORMS.find((p) => p.id === crawlPlatform) || SOCIAL_PLATFORMS[0];
      if (!/^https?:\/\//i.test(q)) {
        const fullQuery = platObj.siteFilter ? `${q} ${platObj.siteFilter}` : q;
        targetSearchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(
          fullQuery
        )}&qft=+filterui:face-face&form=IRFLTR`;
      }

      let html = '';
      if (NativeModules?.VideoEngineModule?.fetchCleanHtmlNative) {
        const page = await NativeModules.VideoEngineModule.fetchCleanHtmlNative(
          targetSearchUrl,
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        );
        html = page?.html || '';
      } else {
        const r = await fetch(targetSearchUrl);
        html = await r.text();
      }

      // Extraer imágenes de resultados (murl / turl / og:image / img src)
      const candidateSet = new Set();
      const murlRegex = /murl&quot;:&quot;(https?:\/\/[^&"']+)&quot;/gi;
      let m;
      while ((m = murlRegex.exec(html)) !== null) {
        if (m[1]) candidateSet.add(m[1]);
      }
      const imgRegex = /https?:\/\/[^\s"'<>\\]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\]*)?/gi;
      while ((m = imgRegex.exec(html)) !== null) {
        const u = m[0];
        if (!/logo|icon|sprite|avatar_default|favicon/i.test(u)) {
          candidateSet.add(u);
        }
      }

      const candidates = Array.from(candidateSet).slice(0, 14);
      if (candidates.length === 0) {
        setCrawling(false);
        setCrawlStatus('');
        Alert.alert(
          'Sin imágenes públicas directas',
          'No se encontraron fotos públicas directas con ese término. Puedes abrir el buscador en el Navegador Integrado.'
        );
        return;
      }

      let indexedCount = 0;
      const newlyIndexed = [];

      for (let i = 0; i < candidates.length; i++) {
        const imgUrl = candidates[i];
        setCrawlStatus(`Analizando rostro ${i + 1} de ${candidates.length}...`);
        try {
          const res = await NativeModules.VideoEngineModule.detectFacesAndEmbedNative(
            imgUrl,
            false
          );
          const faces = Array.isArray(res?.faces) ? res.faces : [];
          for (const f of faces) {
            if (Array.isArray(f.embedding) && f.embedding.length > 0) {
              indexedCount++;
              newlyIndexed.push({
                id: `face_${Date.now()}_${indexedCount}_${Math.random().toString(36).slice(2, 6)}`,
                uri: imgUrl,
                cropUri: f.cropUri || imgUrl,
                embedding: f.embedding,
                title: `${q} (${platObj.label.replace(/^[^\s]+\s/, '')})`,
                sourceUrl: imgUrl,
                platform: platObj.label,
                createdAt: Date.now(),
              });
            }
          }
        } catch (_imgErr) {}
      }

      if (newlyIndexed.length > 0) {
        const updated = [...newlyIndexed, ...faceIndex];
        await saveFaceIndex(updated);
      }

      setCrawlSummary({
        scannedImages: candidates.length,
        facesIndexed: indexedCount,
        query: q,
      });
      setCrawlStatus('');
    } catch (e) {
      Alert.alert('Aviso', e?.message || 'No se pudo completar el rastreo.');
      setCrawlStatus('');
    } finally {
      setCrawling(false);
    }
  };

  const handleIndexLocalGalleryPhotos = async () => {
    setCrawling(true);
    setCrawlSummary(null);
    setCrawlStatus('Escaneando fotos recientes de tu Galería...');
    try {
      const media = await MediaLibrary.getAssetsAsync({
        first: 35,
        mediaType: ['photo'],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      const assets = media?.assets || [];
      const existingUris = new Set(faceIndex.map((f) => f.uri));
      let indexedCount = 0;
      const newlyIndexed = [];

      for (let i = 0; i < assets.length; i++) {
        const a = assets[i];
        if (!a?.uri || existingUris.has(a.uri)) continue;
        setCrawlStatus(`Detectando rostros en tu Galería (${i + 1}/${assets.length})...`);
        try {
          const res = await NativeModules.VideoEngineModule.detectFacesAndEmbedNative(
            a.uri,
            false
          );
          const faces = Array.isArray(res?.faces) ? res.faces : [];
          for (const f of faces) {
            if (Array.isArray(f.embedding) && f.embedding.length > 0) {
              indexedCount++;
              newlyIndexed.push({
                id: `gal_${Date.now()}_${indexedCount}_${Math.random().toString(36).slice(2, 6)}`,
                uri: a.uri,
                cropUri: f.cropUri || a.uri,
                embedding: f.embedding,
                title: a.filename || 'Foto de Galería',
                sourceUrl: a.uri,
                platform: '📱 Mi Galería',
                asset: a,
                createdAt: Date.now(),
              });
            }
          }
        } catch (_e) {}
      }

      if (newlyIndexed.length > 0) {
        const updated = [...newlyIndexed, ...faceIndex];
        await saveFaceIndex(updated);
      }

      setCrawlSummary({
        scannedImages: assets.length,
        facesIndexed: indexedCount,
        query: 'Fotos de Mi Galería',
      });
      setCrawlStatus('');
    } catch (e) {
      Alert.alert('Aviso', 'No se pudo escanear la galería.');
      setCrawlStatus('');
    } finally {
      setCrawling(false);
    }
  };

  // --- TAB 3: VERIFICAR 1:1 ---
  const handleSelectComparePhoto = (slot) => {
    openGalleryPicker(slot);
  };

  const handleClearIndex = () => {
    Alert.alert(
      'Vaciar Índice de Rostros',
      '¿Seguro que deseas borrar los rostros indexados localmente?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Vaciar',
          style: 'destructive',
          onPress: () => {
            saveFaceIndex([]);
            setSearchResults([]);
          },
        },
      ]
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <StatusBar barStyle="light-content" backgroundColor="#070B14" />
      <View style={styles.container}>
        {/* HEADER SEGURO (Respeta Regla de Oro #2) */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={styles.faceBadgeIcon}>
              <Ionicons name="happy-outline" size={22} color="#34D399" />
            </View>
            <View>
              <Text style={styles.headerTitle}>CheckRemb · FaceCheck ID</Text>
              <Text style={styles.headerSub}>
                Buscador Biométrico de Rostros ({faceIndex.length} en índice)
              </Text>
            </View>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableOpacity
              style={styles.serverBtn}
              onPress={() => setShowServerConfig((p) => !p)}
            >
              <Ionicons
                name="server-outline"
                size={16}
                color={serverUrl ? '#34D399' : '#94A3B8'}
              />
            </TouchableOpacity>
            <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
              <Ionicons name="close" size={20} color="#F8FAFC" />
            </TouchableOpacity>
          </View>
        </View>

        {/* CONFIGURACIÓN OPCIONAL DE SERVIDOR CHECKREMB BACKEND */}
        {showServerConfig && (
          <View style={styles.serverConfigBox}>
            <Text style={styles.serverConfigTitle}>
              🔌 Conexión opcional a tu servidor CheckRemb PC (FastAPI :8000):
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <TextInput
                style={styles.serverInput}
                placeholder="Ej: http://192.168.1.70:8000"
                placeholderTextColor="#64748B"
                value={serverUrl}
                onChangeText={handleSaveServerUrl}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={styles.serverSaveBtn}
                onPress={() => setShowServerConfig(false)}
              >
                <Text style={{ color: '#FFF', fontSize: 11.5, fontWeight: '800' }}>Listo</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* PESTAÑAS DE NAVEGACIÓN */}
        <View style={styles.tabsRow}>
          <TouchableOpacity
            style={[styles.tabPill, activeTab === 'search' && styles.tabPillActive]}
            onPress={() => setActiveTab('search')}
          >
            <Ionicons
              name="scan-outline"
              size={15}
              color={activeTab === 'search' ? '#34D399' : '#94A3B8'}
            />
            <Text style={[styles.tabText, activeTab === 'search' && styles.tabTextActive]}>
              Buscar Rostro
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabPill, activeTab === 'crawl' && styles.tabPillActive]}
            onPress={() => setActiveTab('crawl')}
          >
            <Ionicons
              name="globe-outline"
              size={15}
              color={activeTab === 'crawl' ? '#34D399' : '#94A3B8'}
            />
            <Text style={[styles.tabText, activeTab === 'crawl' && styles.tabTextActive]}>
              Rastrear Redes
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabPill, activeTab === 'compare' && styles.tabPillActive]}
            onPress={() => setActiveTab('compare')}
          >
            <Ionicons
              name="git-compare-outline"
              size={15}
              color={activeTab === 'compare' ? '#34D399' : '#94A3B8'}
            />
            <Text style={[styles.tabText, activeTab === 'compare' && styles.tabTextActive]}>
              Verificar 1:1
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tabPill, activeTab === 'index' && styles.tabPillActive]}
            onPress={() => setActiveTab('index')}
          >
            <Ionicons
              name="people-outline"
              size={15}
              color={activeTab === 'index' ? '#34D399' : '#94A3B8'}
            />
            <Text style={[styles.tabText, activeTab === 'index' && styles.tabTextActive]}>
              Índice ({faceIndex.length})
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* ================= TAB 1: BUSCAR ROSTRO ================= */}
          {activeTab === 'search' && (
            <View style={{ gap: 14 }}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>🔍 Buscar Persona por Foto de Rostro</Text>
                <Text style={styles.cardSub}>
                  Sube una foto para extraer su huella facial y buscar coincidencias en tu índice o en motores de reconocimiento facial web.
                </Text>

                <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', marginTop: 12 }}>
                  <TouchableOpacity
                    style={styles.uploadFaceBox}
                    onPress={handleSelectQueryPhoto}
                    activeOpacity={0.85}
                  >
                    {queryPhoto?.cropUri ? (
                      <Image source={{ uri: queryPhoto.cropUri }} style={styles.uploadFaceImg} />
                    ) : (
                      <View style={{ alignItems: 'center', gap: 6 }}>
                        <Ionicons name="person-add-outline" size={28} color="#34D399" />
                        <Text style={{ color: '#A7F3D0', fontSize: 11, fontWeight: '800' }}>
                          Elegir Rostro
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>

                  <View style={{ flex: 1, gap: 8 }}>
                    <TouchableOpacity
                      style={styles.primaryActionBtn}
                      onPress={handleSelectQueryPhoto}
                      disabled={searchingFace}
                    >
                      {searchingFace ? (
                        <ActivityIndicator size="small" color="#FFF" />
                      ) : (
                        <Ionicons name="camera-outline" size={18} color="#FFF" />
                      )}
                      <Text style={styles.primaryActionText}>
                        {queryPhoto ? 'Cambiar Foto a Buscar' : 'Seleccionar Foto de Rostro'}
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.secondaryActionBtn}
                      onPress={handleIndexLocalGalleryPhotos}
                      disabled={crawling}
                    >
                      <Ionicons name="images-outline" size={16} color="#38BDF8" />
                      <Text style={styles.secondaryActionText}>
                        Indexar Rostros de Mi Galería ({faceIndex.length})
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Buscadores Externos de Rostros en 1 Toque (FaceCheck.ID, PimEyes, Yandex, Google Lens) */}
                <View style={styles.externalEnginesSection}>
                  <Text style={styles.externalEnginesLabel}>
                    🌐 Buscar también en Motores Globales de Reconocimiento Facial Web:
                  </Text>
                  <View style={styles.externalEnginesGrid}>
                    <TouchableOpacity
                      style={[styles.engineChip, { borderColor: '#10B981' }]}
                      onPress={() => {
                        if (onOpenBrowserUrl) {
                          onClose();
                          onOpenBrowserUrl('https://facecheck.id/es');
                        }
                      }}
                    >
                      <Ionicons name="scan-circle" size={15} color="#34D399" />
                      <Text style={styles.engineChipText}>FaceCheck.ID</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.engineChip, { borderColor: '#F59E0B' }]}
                      onPress={() => {
                        if (onOpenBrowserUrl) {
                          onClose();
                          onOpenBrowserUrl('https://yandex.com/images/');
                        }
                      }}
                    >
                      <Ionicons name="eye-outline" size={15} color="#FBBF24" />
                      <Text style={styles.engineChipText}>Yandex Rostros</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.engineChip, { borderColor: '#3B82F6' }]}
                      onPress={() => {
                        if (onOpenBrowserUrl) {
                          onClose();
                          onOpenBrowserUrl('https://pimeyes.com/es');
                        }
                      }}
                    >
                      <Ionicons name="globe-outline" size={15} color="#60A5FA" />
                      <Text style={styles.engineChipText}>PimEyes</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[styles.engineChip, { borderColor: '#8B5CF6' }]}
                      onPress={() => {
                        if (onOpenBrowserUrl) {
                          onClose();
                          onOpenBrowserUrl('https://lens.google.com/');
                        }
                      }}
                    >
                      <Ionicons name="search-outline" size={15} color="#C4B5FD" />
                      <Text style={styles.engineChipText}>Google Lens</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>

              {/* RESULTADOS DE COINCIDENCIA FACIAL */}
              {queryPhoto && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>
                    🎯 Coincidencias Encontradas ({searchResults.length})
                  </Text>
                  {searchResults.length === 0 ? (
                    <Text style={styles.emptyText}>
                      No se encontraron rostros idénticos en tu índice actual. Usa &quot;Rastrear Redes&quot; o &quot;Indexar Rostros de Mi Galería&quot; para poblar tu base o abre FaceCheck.ID arriba.
                    </Text>
                  ) : (
                    <View style={styles.resultsGrid}>
                      {searchResults.map((match) => {
                        const pct = Math.round((match.similarity || 0) * 100);
                        const badgeColor =
                          pct >= 82 ? '#10B981' : pct >= 72 ? '#F59E0B' : '#3B82F6';
                        return (
                          <TouchableOpacity
                            key={match.id}
                            style={styles.matchCard}
                            activeOpacity={0.85}
                            onPress={() => {
                              if (match.asset && onOpenAsset) {
                                onClose();
                                onOpenAsset(match.asset);
                              } else if (
                                match.sourceUrl &&
                                /^https?:\/\//i.test(match.sourceUrl) &&
                                onOpenBrowserUrl
                              ) {
                                onClose();
                                onOpenBrowserUrl(match.sourceUrl);
                              }
                            }}
                          >
                            <Image
                              source={{ uri: match.cropUri || match.uri }}
                              style={styles.matchThumb}
                            />
                            <View style={[styles.scoreBadge, { backgroundColor: badgeColor }]}>
                              <Text style={styles.scoreBadgeText}>{pct}% Similar</Text>
                            </View>
                            <Text style={styles.matchTitle} numberOfLines={1}>
                              {match.title || 'Rostro'}
                            </Text>
                            <Text style={styles.matchPlatform} numberOfLines={1}>
                              {match.platform || 'Índice'}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}
                </View>
              )}
            </View>
          )}

          {/* ================= TAB 2: RASTREAR REDES / WEB ================= */}
          {activeTab === 'crawl' && (
            <View style={{ gap: 14 }}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  🌐 Rastrear Rostros en Redes Sociales y Web
                </Text>
                <Text style={styles.cardSub}>
                  Busca por nombre, @usuario o URL en Instagram, Facebook, Pinterest, X o TikTok. CheckRemb detectará los rostros y los guardará en tu índice biométrico.
                </Text>

                <View style={styles.platformChipsWrap}>
                  {SOCIAL_PLATFORMS.map((p) => (
                    <TouchableOpacity
                      key={p.id}
                      style={[
                        styles.platChip,
                        crawlPlatform === p.id && styles.platChipActive,
                      ]}
                      onPress={() => setCrawlPlatform(p.id)}
                    >
                      <Text
                        style={[
                          styles.platChipText,
                          crawlPlatform === p.id && styles.platChipTextActive,
                        ]}
                      >
                        {p.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={styles.crawlInputRow}>
                  <TextInput
                    style={styles.crawlInput}
                    placeholder="Nombre de persona, @usuario o URL https://..."
                    placeholderTextColor="#64748B"
                    value={crawlQuery}
                    onChangeText={setCrawlQuery}
                    autoCapitalize="none"
                    returnKeyType="search"
                    onSubmitEditing={handleCrawlSocialFaces}
                  />
                  <TouchableOpacity
                    style={styles.crawlBtn}
                    onPress={handleCrawlSocialFaces}
                    disabled={crawling}
                  >
                    {crawling ? (
                      <ActivityIndicator size="small" color="#FFF" />
                    ) : (
                      <>
                        <Ionicons name="sparkles" size={15} color="#FFF" />
                        <Text style={styles.crawlBtnText}>Rastrear</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                {Boolean(crawlStatus) && (
                  <View style={styles.statusBanner}>
                    <ActivityIndicator size="small" color="#34D399" />
                    <Text style={styles.statusBannerText}>{crawlStatus}</Text>
                  </View>
                )}

                {crawlSummary && (
                  <View style={styles.summaryBanner}>
                    <Ionicons name="checkmark-circle" size={18} color="#34D399" />
                    <Text style={styles.summaryBannerText}>
                      ¡Listo! Se analizaron {crawlSummary.scannedImages} imágenes de &quot;
                      {crawlSummary.query}&quot; y se indexaron {crawlSummary.facesIndexed} rostros.
                    </Text>
                  </View>
                )}
              </View>
            </View>
          )}

          {/* ================= TAB 3: VERIFICAR 1:1 ================= */}
          {activeTab === 'compare' && (
            <View style={{ gap: 14 }}>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>⚖️ Verificación Biométrica 1:1 (2 Fotos)</Text>
                <Text style={styles.cardSub}>
                  Compara dos fotografías para verificar si pertenecen a la misma persona.
                </Text>

                <View style={styles.compareRow}>
                  <TouchableOpacity
                    style={styles.compareSlot}
                    onPress={() => handleSelectComparePhoto('A')}
                  >
                    {compareFaceA?.cropUri ? (
                      <Image source={{ uri: compareFaceA.cropUri }} style={styles.compareImg} />
                    ) : (
                      <View style={{ alignItems: 'center', gap: 6 }}>
                        <Ionicons name="person-outline" size={30} color="#38BDF8" />
                        <Text style={{ color: '#BAE6FD', fontSize: 12, fontWeight: '800' }}>
                          Foto Rostro 1
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>

                  <View style={{ alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name="swap-horizontal" size={24} color="#64748B" />
                  </View>

                  <TouchableOpacity
                    style={styles.compareSlot}
                    onPress={() => handleSelectComparePhoto('B')}
                  >
                    {compareFaceB?.cropUri ? (
                      <Image source={{ uri: compareFaceB.cropUri }} style={styles.compareImg} />
                    ) : (
                      <View style={{ alignItems: 'center', gap: 6 }}>
                        <Ionicons name="person-outline" size={30} color="#A855F7" />
                        <Text style={{ color: '#E9D5FF', fontSize: 12, fontWeight: '800' }}>
                          Foto Rostro 2
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>
                </View>

                {comparing && (
                  <ActivityIndicator size="large" color="#34D399" style={{ marginTop: 12 }} />
                )}

                {compareResult && (
                  <View
                    style={[
                      styles.verdictCard,
                      {
                        borderColor: compareResult.isMatch
                          ? '#10B981'
                          : compareResult.isPossible
                          ? '#F59E0B'
                          : '#EF4444',
                      },
                    ]}
                  >
                    <Text
                      style={{
                        color: compareResult.isMatch
                          ? '#34D399'
                          : compareResult.isPossible
                          ? '#FBBF24'
                          : '#F87171',
                        fontSize: 22,
                        fontWeight: '900',
                      }}
                    >
                      {Math.round(compareResult.similarity * 100)}% Similitud
                    </Text>
                    <Text style={{ color: '#F8FAFC', fontSize: 14, fontWeight: '800', marginTop: 4 }}>
                      {compareResult.isMatch
                        ? '✅ ALTA PROBABILIDAD: MISMA PERSONA'
                        : compareResult.isPossible
                        ? '⚠️ POSIBLE COINCIDENCIA / RASGOS SIMILARES'
                        : '❌ ROSTROS DIFERENTES'}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          )}

          {/* ================= TAB 4: ÍNDICE DE ROSTROS ================= */}
          {activeTab === 'index' && (
            <View style={{ gap: 14 }}>
              <View style={styles.card}>
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Text style={styles.cardTitle}>
                    🗂️ Rostros Indexados ({faceIndex.length})
                  </Text>
                  {faceIndex.length > 0 && (
                    <TouchableOpacity onPress={handleClearIndex}>
                      <Text style={{ color: '#F87171', fontSize: 12, fontWeight: '800' }}>
                        Vaciar índice
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>

                {faceIndex.length === 0 ? (
                  <Text style={styles.emptyText}>
                    Aún no hay rostros en el índice. Usa &quot;Indexar Rostros de Mi Galería&quot; o &quot;Rastrear Redes&quot; para agregar rostros.
                  </Text>
                ) : (
                  <View style={styles.resultsGrid}>
                    {faceIndex.slice(0, 60).map((item) => (
                      <TouchableOpacity
                        key={item.id}
                        style={styles.matchCard}
                        onPress={() => {
                          if (item.asset && onOpenAsset) {
                            onClose();
                            onOpenAsset(item.asset);
                          } else if (
                            item.sourceUrl &&
                            /^https?:\/\//i.test(item.sourceUrl) &&
                            onOpenBrowserUrl
                          ) {
                            onClose();
                            onOpenBrowserUrl(item.sourceUrl);
                          }
                        }}
                      >
                        <Image
                          source={{ uri: item.cropUri || item.uri }}
                          style={styles.matchThumb}
                        />
                        <Text style={styles.matchTitle} numberOfLines={1}>
                          {item.title || 'Rostro'}
                        </Text>
                        <Text style={styles.matchPlatform} numberOfLines={1}>
                          {item.platform || 'Galería'}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            </View>
          )}
        </ScrollView>

        {/* Selector Visual Rápido de Fotos de Mi Galería */}
        {Boolean(pickerTarget) && (
          <View
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              backgroundColor: 'rgba(7, 11, 20, 0.96)',
              paddingTop:
                Platform.OS === 'android'
                  ? Math.max((StatusBar.currentHeight || 36) + 14, 52)
                  : 52,
              paddingBottom: Platform.OS === 'android' ? 50 : 32,
              paddingHorizontal: 14,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingBottom: 12,
                borderBottomWidth: 1,
                borderBottomColor: '#1E293B',
              }}
            >
              <Text style={{ color: '#F8FAFC', fontSize: 15, fontWeight: '900' }}>
                📸 Elige una foto de tu Galería
              </Text>
              <TouchableOpacity
                style={styles.closeBtn}
                onPress={() => setPickerTarget(null)}
              >
                <Ionicons name="close" size={20} color="#F8FAFC" />
              </TouchableOpacity>
            </View>

            {loadingPickerPhotos ? (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator size="large" color="#34D399" />
              </View>
            ) : (
              <ScrollView
                contentContainerStyle={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  gap: 8,
                  paddingVertical: 12,
                }}
              >
                {pickerPhotos.map((p) => (
                  <TouchableOpacity
                    key={p.id}
                    style={{
                      width: '31%',
                      aspectRatio: 1,
                      borderRadius: 10,
                      overflow: 'hidden',
                      backgroundColor: '#111827',
                      borderWidth: 1,
                      borderColor: '#1E293B',
                    }}
                    onPress={() => handlePhotoChosenFromPicker(p.uri)}
                  >
                    <Image
                      source={{ uri: p.uri }}
                      style={{ width: '100%', height: '100%' }}
                    />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#070B14',
    paddingTop:
      Platform.OS === 'android' ? Math.max((StatusBar.currentHeight || 36) + 14, 50) : 52,
    paddingBottom: Platform.OS === 'android' ? 50 : 32,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(52, 211, 153, 0.2)',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  faceBadgeIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(52, 211, 153, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#F8FAFC',
    fontSize: 15.5,
    fontWeight: '900',
  },
  headerSub: {
    color: '#6EE7B7',
    fontSize: 11,
    marginTop: 1,
  },
  serverBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1F2937',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  serverConfigBox: {
    backgroundColor: '#0F172A',
    marginHorizontal: 14,
    marginTop: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#34D399',
  },
  serverConfigTitle: {
    color: '#A7F3D0',
    fontSize: 11.5,
    fontWeight: '700',
  },
  serverInput: {
    flex: 1,
    backgroundColor: '#070B14',
    color: '#FFF',
    fontSize: 12.5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  serverSaveBtn: {
    backgroundColor: '#059669',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  tabsRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
  tabPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  tabPillActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderColor: '#10B981',
  },
  tabText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '700',
  },
  tabTextActive: {
    color: '#ECFDF5',
    fontWeight: '900',
  },
  scrollContent: {
    paddingHorizontal: 14,
    paddingBottom: 28,
  },
  card: {
    backgroundColor: '#0F172A',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  cardTitle: {
    color: '#F8FAFC',
    fontSize: 14.5,
    fontWeight: '800',
  },
  cardSub: {
    color: '#94A3B8',
    fontSize: 11.5,
    marginTop: 4,
    lineHeight: 16,
  },
  uploadFaceBox: {
    width: 92,
    height: 92,
    borderRadius: 16,
    backgroundColor: '#070B14',
    borderWidth: 1.5,
    borderColor: '#10B981',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  uploadFaceImg: {
    width: '100%',
    height: '100%',
  },
  primaryActionBtn: {
    backgroundColor: '#059669',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  primaryActionText: {
    color: '#FFFFFF',
    fontSize: 12.5,
    fontWeight: '800',
  },
  secondaryActionBtn: {
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 11,
  },
  secondaryActionText: {
    color: '#BAE6FD',
    fontSize: 11.5,
    fontWeight: '800',
  },
  externalEnginesSection: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#1E293B',
    gap: 8,
  },
  externalEnginesLabel: {
    color: '#CBD5E1',
    fontSize: 11.5,
    fontWeight: '700',
  },
  externalEnginesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  engineChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#070B14',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
  },
  engineChipText: {
    color: '#F8FAFC',
    fontSize: 11.5,
    fontWeight: '800',
  },
  resultsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
  },
  matchCard: {
    width: '30.5%',
    backgroundColor: '#070B14',
    borderRadius: 12,
    padding: 6,
    borderWidth: 1,
    borderColor: '#1E293B',
    alignItems: 'center',
  },
  matchThumb: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 9,
    backgroundColor: '#111827',
  },
  scoreBadge: {
    marginTop: -10,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
  },
  scoreBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
  },
  matchTitle: {
    color: '#F8FAFC',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 4,
  },
  matchPlatform: {
    color: '#64748B',
    fontSize: 9.5,
  },
  emptyText: {
    color: '#64748B',
    fontSize: 12,
    marginTop: 10,
    lineHeight: 17,
  },
  platformChipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12,
  },
  platChip: {
    backgroundColor: '#070B14',
    borderWidth: 1,
    borderColor: '#1E293B',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  platChipActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    borderColor: '#10B981',
  },
  platChipText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '700',
  },
  platChipTextActive: {
    color: '#ECFDF5',
    fontWeight: '800',
  },
  crawlInputRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  crawlInput: {
    flex: 1,
    backgroundColor: '#070B14',
    color: '#FFFFFF',
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#334155',
  },
  crawlBtn: {
    backgroundColor: '#059669',
    paddingHorizontal: 14,
    borderRadius: 11,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  crawlBtnText: {
    color: '#FFFFFF',
    fontSize: 12.5,
    fontWeight: '800',
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    padding: 10,
    borderRadius: 10,
  },
  statusBannerText: {
    color: '#A7F3D0',
    fontSize: 12,
    fontWeight: '700',
  },
  summaryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderWidth: 1,
    borderColor: '#10B981',
    padding: 10,
    borderRadius: 10,
  },
  summaryBannerText: {
    color: '#ECFDF5',
    fontSize: 12,
    fontWeight: '700',
    flex: 1,
  },
  compareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    gap: 10,
  },
  compareSlot: {
    flex: 1,
    aspectRatio: 1,
    backgroundColor: '#070B14',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#334155',
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  compareImg: {
    width: '100%',
    height: '100%',
  },
  verdictCard: {
    marginTop: 16,
    backgroundColor: '#070B14',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    alignItems: 'center',
  },
});
