import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  RefreshControl,
  ScrollView,
  Modal,
  ActivityIndicator,
  Alert,
  TextInput,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { folderService } from '../services/folderService';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SIDE_PADDING = 12;
const COLUMN_GAP = 8;
const NUM_COLUMNS = 3;
const CARD_WIDTH = Math.floor(
  (SCREEN_WIDTH - SIDE_PADDING * 2 - COLUMN_GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS
);
const CARD_HEIGHT = Math.round(CARD_WIDTH * 1.26);

// Imágenes curadas de alta estética (paisajes nocturnos, montañas, nebulosa y naturaleza estilo Samsung Galaxy)
// para portadas cuando una carpeta aún no tiene miniatura directa
const BEAUTIFUL_FALLBACK_COVERS = [
  'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=600&q=80',
  'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=600&q=80',
];

function getFallbackCoverForKey(key = '') {
  let hash = 0;
  const str = String(key);
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return BEAUTIFUL_FALLBACK_COVERS[hash % BEAUTIFUL_FALLBACK_COVERS.length];
}

export default function AlbumList({
  albums = [],
  favorites = {},
  onSelectAlbum,
  onSelectFavorites,
  onRefresh,
  isRefreshing,
  hiddenFolders = {},
  onToggleHideFolder,
  manuallyEnabledSystemFolders = {},
  autoHideSystemFolders = true,
  onToggleSystemFolderManual,
  onToggleAutoHideSystem,
  onSetAllSystemFoldersManual,
  showAllFolders = false,
  onToggleShowAllFolders,
  onPickNewFolder,
  onAddMultipleFolders,
  savedFolders = [],
  searchVisible = false,
  visibilityModalVisible = false,
  onCloseVisibilityModal,
  onOpenVisibilityModal,
}) {
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [isScanningFolders, setIsScanningFolders] = useState(false);
  const [scanProgressInfo, setScanProgressInfo] = useState(null);
  const [suggestedFolders, setSuggestedFolders] = useState([]);
  const [selectedSuggestedUris, setSelectedSuggestedUris] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [quickEditVisibility, setQuickEditVisibility] = useState(false);
  const [sortBy, setSortBy] = useState('smart'); // 'smart' | 'count' | 'months' | 'az'
  const [groupSmallInVarios, setGroupSmallInVarios] = useState(true);
  const [variosModalVisible, setVariosModalVisible] = useState(false);
  const [showFoldersInScreen, setShowFoldersInScreen] = useState(true);
  const [managerTab, setManagerTab] = useState('system'); // 'system' | 'main' | 'all'
  const [managerSearch, setManagerSearch] = useState('');

  const favList = useMemo(() => Object.values(favorites || {}), [favorites]);
  const favCount = favList.length;
  const favCoverUri = favList[0]?.uri || BEAUTIFUL_FALLBACK_COVERS[2];

  const getItemKey = (item) => item?.uri || item?.id || item?.title || '';

  const isManuallyEnabledSystem = (item) => {
    if (!item) return false;
    return Boolean(
      manuallyEnabledSystemFolders[item.uri] ||
        manuallyEnabledSystemFolders[item.id] ||
        manuallyEnabledSystemFolders[item.title]
    );
  };

  const isExplicitlyHidden = (item) =>
    Boolean(
      hiddenFolders[item.title] ||
        hiddenFolders[item.id] ||
        (item.uri && hiddenFolders[item.uri])
    );

  // Una carpeta está desactivada/oculta si:
  // 1) El usuario la ocultó manualmente, o
  // 2) Es una carpeta sugerida de sistema y el modo auto-desactivar sistema está activo (salvo que el usuario la haya activado manualmente)
  const isAlbumHidden = (item) => {
    if (isExplicitlyHidden(item)) return true;
    const sysInfo = folderService.classifySystemFolder(item);
    if (sysInfo.isSystemSuggested && autoHideSystemFolders && !isManuallyEnabledSystem(item)) {
      return true;
    }
    return false;
  };

  // Detectar si el nombre de la carpeta es un mes (ej. "Octubre 2026", "Enero 2025")
  const getMonthOrderScore = (title = '') => {
    const clean = String(title).trim().toLowerCase();
    const months = {
      enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
      julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
    };
    const match = clean.match(/^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(\d{4})/i);
    if (!match) return 0;
    const m = months[match[1].toLowerCase()] || 0;
    const y = parseInt(match[2], 10) || 0;
    return y * 100 + m;
  };

  const isEssentialMainAlbum = (item) => {
    const t = String(item?.title || '').trim().toLowerCase();
    return (
      item?.isDownloadedVideos ||
      /^(camera|cámara|camara|dcim|videos descargados|favoritos)$/i.test(t)
    );
  };

  // Determinar cuáles álbumes tienen menos de 5 elementos (1 a 4 fotos/videos) para agruparlos en "Varios"
  const isSmallMiscAlbum = (item) => {
    const count = Number(item?.assetCount || 0);
    if (count >= 5) return false;
    if ((item?.subfolderCount || 0) > 0) return false;
    if (isEssentialMainAlbum(item)) return false;
    return true;
  };

  const { mainVisibleAlbums, smallGroupedAlbums } = useMemo(() => {
    const base = showAllFolders || quickEditVisibility
      ? albums
      : albums.filter((item) => !isAlbumHidden(item));
    const q = searchQuery.trim().toLowerCase();

    const filtered = q
      ? base.filter((item) => {
          const displayTitle = folderService.formatFolderDisplayName(item.title, item.uri || '');
          return displayTitle.toLowerCase().includes(q);
        })
      : base;

    const mainList = [];
    const smallList = [];

    for (const item of filtered) {
      // Si el modo "Varios (<5)" está activo y no estamos buscando ni editando visibilidad individual
      if (groupSmallInVarios && !q && !quickEditVisibility && isSmallMiscAlbum(item)) {
        smallList.push(item);
      } else {
        mainList.push(item);
      }
    }

    const getPriorityRank = (item) => {
      const t = folderService.formatFolderDisplayName(item.title, item.uri || '').toLowerCase();
      if (/^(camera|cámara|camara|dcim)$/i.test(t)) return 1;
      if (item.isDownloadedVideos || /videos descargados/i.test(t)) return 2;
      if (/whatsapp/i.test(t)) return 3;
      if (/screenshot|captura/i.test(t)) return 4;
      if (/download|descarg/i.test(t)) return 5;
      if (/facebook|instagram|tiktok|telegram/i.test(t)) return 6;
      return 50;
    };

    mainList.sort((a, b) => {
      const nameA = folderService.formatFolderDisplayName(a.title, a.uri || '');
      const nameB = folderService.formatFolderDisplayName(b.title, b.uri || '');

      if (sortBy === 'az') {
        return nameA.localeCompare(nameB, 'es');
      }
      if (sortBy === 'count') {
        return (b.assetCount || 0) - (a.assetCount || 0);
      }
      if (sortBy === 'months') {
        const mA = getMonthOrderScore(nameA);
        const mB = getMonthOrderScore(nameB);
        if (mA !== mB) return mB - mA;
        return (b.assetCount || 0) - (a.assetCount || 0);
      }
      // Por defecto: 'smart' (Esenciales primero y luego los que tienen más fotos)
      const rankA = getPriorityRank(a);
      const rankB = getPriorityRank(b);
      if (rankA !== rankB) return rankA - rankB;
      return (b.assetCount || 0) - (a.assetCount || 0);
    });

    return {
      mainVisibleAlbums: mainList,
      smallGroupedAlbums: smallList,
    };
  }, [
    albums,
    hiddenFolders,
    manuallyEnabledSystemFolders,
    autoHideSystemFolders,
    showAllFolders,
    quickEditVisibility,
    searchQuery,
    groupSmallInVarios,
    sortBy,
  ]);

  // Clasificación de carpetas para mostrar conteos exactos y sugerencias de sistema
  const {
    systemSuggestedAlbums,
    normalUserAlbums,
    activeSystemCount,
    deactivatedSystemCount,
    hiddenCount,
    visibleCount,
  } = useMemo(() => {
    const sysList = [];
    const normList = [];
    let activeSys = 0;
    let deactSys = 0;
    let totalHidden = 0;

    for (const item of albums) {
      const sysInfo = folderService.classifySystemFolder(item);
      const hidden = isAlbumHidden(item);
      if (hidden) totalHidden++;

      if (sysInfo.isSystemSuggested) {
        sysList.push({ ...item, systemReason: sysInfo.reason, systemCategory: sysInfo.category });
        if (hidden) deactSys++;
        else activeSys++;
      } else {
        normList.push(item);
      }
    }

    return {
      systemSuggestedAlbums: sysList,
      normalUserAlbums: normList,
      activeSystemCount: activeSys,
      deactivatedSystemCount: deactSys,
      hiddenCount: totalHidden,
      visibleCount: Math.max(0, albums.length - totalHidden),
    };
  }, [albums, hiddenFolders, manuallyEnabledSystemFolders, autoHideSystemFolders]);

  const handleToggleAlbumOrSystem = (item) => {
    if (!item) return;
    const key = getItemKey(item);
    const displayName = folderService.formatFolderDisplayName(item.title, item.uri || '');
    const sysInfo = folderService.classifySystemFolder(item);

    if (sysInfo.isSystemSuggested && onToggleSystemFolderManual) {
      const currentlyHidden = isAlbumHidden(item);
      // Si estaba oculta/desactivada, la activamos manualmente; si estaba activa, la desactivamos
      onToggleSystemFolderManual(key, currentlyHidden, displayName, item);
      return;
    }

    if (onToggleHideFolder) {
      onToggleHideFolder(key, displayName, true);
    }
  };

  // Construir lista final con "Favoritos" al inicio y "Varios" (carpetas de <5 archivos) agrupadas al final
  const gridData = useMemo(() => {
    if (!showFoldersInScreen) {
      return [
        {
          id: '__galaxy_favorites_card__',
          isFavoritesCard: true,
          title: 'Favoritos',
          assetCount: favCount,
          coverUri: favCoverUri,
        },
      ];
    }

    const favCard = {
      id: '__galaxy_favorites_card__',
      isFavoritesCard: true,
      title: 'Favoritos',
      assetCount: favCount,
      coverUri: favCoverUri,
    };
    const q = searchQuery.trim().toLowerCase();
    const list = [];

    if (!q || 'favoritos'.includes(q)) {
      list.push(favCard);
    }

    list.push(...mainVisibleAlbums);

    if (smallGroupedAlbums.length > 0) {
      const totalSmallPhotos = smallGroupedAlbums.reduce(
        (acc, it) => acc + Number(it.assetCount || 0),
        0
      );
      const firstWithCover = smallGroupedAlbums.find((it) => Boolean(it.coverUri));
      list.push({
        id: '__galaxy_varios_card__',
        isVariosCard: true,
        title: 'Varios',
        assetCount: totalSmallPhotos,
        folderCount: smallGroupedAlbums.length,
        coverUri: firstWithCover?.coverUri || BEAUTIFUL_FALLBACK_COVERS[4],
        childAlbums: smallGroupedAlbums,
      });
    }

    return list;
  }, [
    showFoldersInScreen,
    favCount,
    favCoverUri,
    mainVisibleAlbums,
    smallGroupedAlbums,
    searchQuery,
  ]);

  const handleOpenFolderScanner = async () => {
    if (onCloseVisibilityModal) onCloseVisibilityModal();
    setShowScannerModal(true);
    setIsScanningFolders(true);
    setScanProgressInfo({ foundCount: 0, currentFolder: 'Iniciando escaneo...' });
    try {
      const found = await folderService.scanSuggestedFolders(savedFolders, (prog) => {
        setScanProgressInfo(prog);
      });
      setSuggestedFolders(found);
      const initialSel = {};
      found.slice(0, 6).forEach((item) => {
        initialSel[item.uri] = true;
      });
      setSelectedSuggestedUris(initialSel);
    } catch (_e) {
      setSuggestedFolders([]);
    } finally {
      setIsScanningFolders(false);
      setScanProgressInfo(null);
    }
  };

  const toggleSelectSuggested = (uri) => {
    setSelectedSuggestedUris((prev) => {
      const next = { ...prev };
      if (next[uri]) delete next[uri];
      else next[uri] = true;
      return next;
    });
  };

  const handleConfirmAddSuggested = async () => {
    const chosen = suggestedFolders.filter((f) => selectedSuggestedUris[f.uri]);
    if (chosen.length === 0) {
      Alert.alert('Selecciona carpetas', 'Marca al menos una carpeta sugerida para agregarla.');
      return;
    }
    setShowScannerModal(false);
    if (onAddMultipleFolders) {
      await onAddMultipleFolders(chosen);
    }
    if (onRefresh) onRefresh();
  };

  const renderItem = ({ item }) => {
    // 1. Tarjeta especial "Favoritos" con efecto de fotos apiladas idéntico a Samsung Galaxy
    if (item.isFavoritesCard) {
      return (
        <TouchableOpacity
          style={[styles.galaxyCard, styles.favoritesCardBg]}
          activeOpacity={0.82}
          onPress={() => {
            if (onSelectFavorites) onSelectFavorites();
          }}
        >
          <View style={styles.favStackContainer}>
            <View style={styles.favStackBack2} />
            <View style={styles.favStackBack1} />
            <View style={styles.favStackFront}>
              <Image
                source={{ uri: item.coverUri }}
                style={styles.favStackImg}
                contentFit="cover"
                transition={120}
                cachePolicy="memory-disk"
              />
            </View>
          </View>

          <View style={styles.cardBottomOverlayFav}>
            <Text style={styles.galaxyCardTitle} numberOfLines={1}>
              Favoritos
            </Text>
            <Text style={styles.galaxyCardCount}>{item.assetCount}</Text>
          </View>
        </TouchableOpacity>
      );
    }

    // 1.5. Tarjeta especial "Varios" que agrupa todas las carpetas con menos de 5 archivos (1 a 4 fotos/videos)
    if (item.isVariosCard) {
      return (
        <TouchableOpacity
          style={[styles.galaxyCard, styles.variosCardBg]}
          activeOpacity={0.82}
          onPress={() => {
            onSelectAlbum(item);
          }}
          onLongPress={() => setVariosModalVisible(true)}
        >
          <Image
            source={{ uri: item.coverUri }}
            style={[styles.coverImage, { opacity: 0.78 }]}
            contentFit="cover"
            transition={120}
            cachePolicy="memory-disk"
          />
          <View style={styles.bottomScrim} />

          {/* Botón superior derecho para ver el listado de carpetas individuales dentro de "Varios" */}
          <TouchableOpacity
            style={styles.variosFolderCountPill}
            onPress={(e) => {
              e.stopPropagation();
              setVariosModalVisible(true);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="albums" size={11} color="#c4b5fd" />
            <Text style={styles.variosFolderCountText}>{item.folderCount} carpetas</Text>
          </TouchableOpacity>

          <View style={styles.cardBottomOverlay}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="file-tray-stacked" size={13} color="#a78bfa" />
              <Text style={styles.galaxyCardTitle} numberOfLines={1}>
                Varios
              </Text>
            </View>
            <Text style={styles.galaxyCardCount}>
              {item.assetCount} {item.assetCount === 1 ? 'archivo' : 'archivos'}
            </Text>
          </View>
        </TouchableOpacity>
      );
    }

    // 2. Tarjeta de Carpeta / Álbum estilo Samsung Galaxy One UI
    const isHidden = isAlbumHidden(item);
    const displayTitle = folderService.formatFolderDisplayName(item.title, item.uri || '');
    const lowerTitle = displayTitle.toLowerCase();
    const isCameraAlbum = /^(camera|cámara|camara|dcim)$/i.test(lowerTitle);
    const isDownloadsAlbum = /descarg|download/i.test(lowerTitle);
    const coverToUse = item.coverUri || getFallbackCoverForKey(item.id || displayTitle);

    return (
      <TouchableOpacity
        style={[
          styles.galaxyCard,
          isHidden && styles.galaxyCardHidden,
        ]}
        activeOpacity={0.82}
        onPress={() => {
          if (quickEditVisibility) {
            handleToggleAlbumOrSystem(item);
            return;
          }
          onSelectAlbum({ ...item, title: displayTitle });
        }}
        onLongPress={() => {
          handleToggleAlbumOrSystem(item);
        }}
      >
        <Image
          source={{ uri: coverToUse }}
          style={[styles.coverImage, isHidden && { opacity: 0.42 }]}
          contentFit="cover"
          transition={120}
          cachePolicy="memory-disk"
        />

        {/* Oscurecedor gradual inferior para que el nombre y conteo luzcan nítidos como en Galaxy */}
        <View style={styles.bottomScrim} />

        {/* Icono superior derecho (Cámara, Descargas, Subcarpetas o botón de Ocultar/Mostrar) */}
        {quickEditVisibility || showAllFolders ? (
          <TouchableOpacity
            style={[styles.topRightCornerBadge, isHidden && styles.topRightCornerBadgeHidden]}
            onPress={(e) => {
              e.stopPropagation();
              handleToggleAlbumOrSystem(item);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={isHidden ? 'eye-off' : 'eye'}
              size={15}
              color={isHidden ? '#ffffff' : '#60a5fa'}
            />
          </TouchableOpacity>
        ) : isCameraAlbum ? (
          <View style={styles.topRightIconClean}>
            <Ionicons name="camera" size={16} color="#ffffff" />
          </View>
        ) : isDownloadsAlbum ? (
          <View style={styles.topRightIconClean}>
            <Ionicons name="cloud-download" size={15} color="#38bdf8" />
          </View>
        ) : item.subfolderCount > 0 ? (
          <View style={styles.topRightSubfolderBadge}>
            <Ionicons name="folder-open" size={12} color="#fde68a" />
            <Text style={styles.topRightSubfolderText}>{item.subfolderCount}</Text>
          </View>
        ) : null}

        {isHidden && (
          <View style={styles.hiddenCenterPill}>
            <Ionicons name="eye-off" size={12} color="#fff" />
            <Text style={styles.hiddenCenterPillText}>Oculta</Text>
          </View>
        )}

        {/* Nombre de la carpeta y conteo centrados abajo dentro de la tarjeta */}
        <View style={styles.cardBottomOverlay}>
          <Text
            style={[styles.galaxyCardTitle, isHidden && { color: '#fcd34d' }]}
            numberOfLines={1}
          >
            {displayTitle}
          </Text>
          <Text style={styles.galaxyCardCount}>
            {item.assetCount > 0
              ? item.assetCount
              : item.subfolderCount > 0
              ? `${item.subfolderCount} subcarpetas`
              : 'Abrir'}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderHeader = () => (
    <View style={styles.headerBlock}>
      {/* Barra de búsqueda instantánea (cuando se toca la lupa arriba) */}
      {(searchVisible || searchQuery.length > 0) && (
        <View style={styles.searchBarBox}>
          <Ionicons name="search" size={16} color="#a1a1aa" />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Buscar álbum o carpeta..."
            placeholderTextColor="#71717a"
            autoFocus={searchVisible}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={18} color="#a1a1aa" />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Encabezado idéntico a Samsung Galaxy: "Álbumes esenciales" + Número de carpetas a la izquierda y acciones a la derecha */}
      <View style={styles.galaxySectionHeaderRow}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
          <Text style={styles.galaxySectionTitle}>Carpetas</Text>
          <View
            style={{
              backgroundColor: 'rgba(96, 165, 250, 0.16)',
              borderWidth: 1,
              borderColor: 'rgba(96, 165, 250, 0.4)',
              paddingHorizontal: 9,
              paddingVertical: 3,
              borderRadius: 12,
            }}
          >
            <Text style={{ color: '#93c5fd', fontSize: 12, fontWeight: '800' }}>
              {visibleCount} de {albums.length}
            </Text>
          </View>
        </View>

        <View style={styles.galaxyHeaderRightActions}>
          {/* Opción directa para Mostrar o No mostrar carpetas en pantalla */}
          <TouchableOpacity
            onPress={() => setShowFoldersInScreen((prev) => !prev)}
            style={[
              styles.quickEyePill,
              !showFoldersInScreen && {
                backgroundColor: 'rgba(245, 158, 11, 0.18)',
                borderColor: '#f59e0b',
              },
            ]}
            activeOpacity={0.8}
          >
            <Ionicons
              name={showFoldersInScreen ? 'folder-open' : 'folder-outline'}
              size={14}
              color={showFoldersInScreen ? '#60a5fa' : '#fbbf24'}
            />
            <Text
              style={[
                styles.quickEyePillText,
                !showFoldersInScreen && { color: '#fbbf24' },
              ]}
            >
              {showFoldersInScreen ? 'Ocultar carpetas' : `Mostrar carpetas (${visibleCount})`}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => {
              setManagerTab('system');
              if (onOpenVisibilityModal) {
                onOpenVisibilityModal();
              }
            }}
            style={[
              styles.quickEyePill,
              {
                backgroundColor: 'rgba(16, 185, 129, 0.15)',
                borderColor: 'rgba(16, 185, 129, 0.45)',
              },
            ]}
            activeOpacity={0.8}
          >
            <Ionicons name="options-outline" size={14} color="#34d399" />
            <Text style={[styles.quickEyePillText, { color: '#6ee7b7' }]}>
              Administrar ({albums.length})
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Tarjeta resumen de Número de Carpetas y Carpetas de Sistema Sugeridas (Desactivadas automáticamente) */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: '#12151f',
          borderWidth: 1,
          borderColor: 'rgba(56, 189, 248, 0.28)',
          borderRadius: 14,
          paddingHorizontal: 12,
          paddingVertical: 9,
          gap: 10,
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Ionicons name="shield-checkmark" size={15} color="#38bdf8" />
            <Text style={{ color: '#ffffff', fontSize: 12.5, fontWeight: '800' }}>
              {visibleCount} carpetas activas · {deactivatedSystemCount} de sistema desactivadas
            </Text>
          </View>
          <Text style={{ color: '#94a3b8', fontSize: 11 }} numberOfLines={2}>
            {systemSuggestedAlbums.length > 0
              ? `Se detectaron ${systemSuggestedAlbums.length} carpetas de sistema/residuales (de ${albums.length} totales) y se ocultaron para no saturar. Puedes activarlas manualmente.`
              : `Total de carpetas detectadas en el teléfono: ${albums.length}.`}
          </Text>
        </View>

        <TouchableOpacity
          onPress={() => {
            setManagerTab('system');
            if (onOpenVisibilityModal) onOpenVisibilityModal();
          }}
          style={{
            backgroundColor: '#2563eb',
            paddingHorizontal: 11,
            paddingVertical: 7,
            borderRadius: 11,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
          }}
          activeOpacity={0.85}
        >
          <Ionicons name="construct-outline" size={13} color="#ffffff" />
          <Text style={{ color: '#ffffff', fontSize: 11.5, fontWeight: '800' }}>
            Sistema ({systemSuggestedAlbums.length})
          </Text>
        </TouchableOpacity>
      </View>

      {/* Barra de acomodo inteligente y agrupación "Varios (<5)" */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.sortBarScroll}
      >
        <TouchableOpacity
          style={[styles.sortChip, sortBy === 'smart' && styles.sortChipActive]}
          onPress={() => setSortBy('smart')}
          activeOpacity={0.8}
        >
          <Ionicons
            name="sparkles"
            size={13}
            color={sortBy === 'smart' ? '#ffffff' : '#60a5fa'}
          />
          <Text style={[styles.sortChipText, sortBy === 'smart' && styles.sortChipTextActive]}>
            Inteligente
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.sortChip, sortBy === 'count' && styles.sortChipActive]}
          onPress={() => setSortBy('count')}
          activeOpacity={0.8}
        >
          <Ionicons
            name="stats-chart"
            size={13}
            color={sortBy === 'count' ? '#ffffff' : '#38bdf8'}
          />
          <Text style={[styles.sortChipText, sortBy === 'count' && styles.sortChipTextActive]}>
            Más fotos
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.sortChip, sortBy === 'months' && styles.sortChipActive]}
          onPress={() => setSortBy('months')}
          activeOpacity={0.8}
        >
          <Ionicons
            name="calendar-outline"
            size={13}
            color={sortBy === 'months' ? '#ffffff' : '#f59e0b'}
          />
          <Text style={[styles.sortChipText, sortBy === 'months' && styles.sortChipTextActive]}>
            Por Meses
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.sortChip, sortBy === 'az' && styles.sortChipActive]}
          onPress={() => setSortBy('az')}
          activeOpacity={0.8}
        >
          <Ionicons
            name="text"
            size={13}
            color={sortBy === 'az' ? '#ffffff' : '#a78bfa'}
          />
          <Text style={[styles.sortChipText, sortBy === 'az' && styles.sortChipTextActive]}>
            A-Z
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.sortChip,
            groupSmallInVarios ? styles.variosChipActive : styles.sortChip,
          ]}
          onPress={() => setGroupSmallInVarios((prev) => !prev)}
          activeOpacity={0.8}
        >
          <Ionicons
            name="file-tray-stacked"
            size={13}
            color={groupSmallInVarios ? '#ffffff' : '#c4b5fd'}
          />
          <Text
            style={[
              styles.sortChipText,
              groupSmallInVarios && styles.sortChipTextActive,
            ]}
          >
            {groupSmallInVarios
              ? `Varios <5 (${smallGroupedAlbums.length})`
              : 'Agrupar <5 en Varios'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.sortChip,
            quickEditVisibility && styles.sortChipActive,
          ]}
          onPress={() => setQuickEditVisibility((prev) => !prev)}
          activeOpacity={0.8}
        >
          <Ionicons
            name={quickEditVisibility ? 'checkmark-circle' : 'eye-outline'}
            size={13}
            color={quickEditVisibility ? '#ffffff' : '#60a5fa'}
          />
          <Text
            style={[
              styles.sortChipText,
              quickEditVisibility && styles.sortChipTextActive,
            ]}
          >
            {quickEditVisibility ? 'Listo' : 'Toque rápido ocultar'}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {!showFoldersInScreen && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: 'rgba(245, 158, 11, 0.14)',
            borderWidth: 1,
            borderColor: 'rgba(245, 158, 11, 0.4)',
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
            <Ionicons name="eye-off-outline" size={18} color="#fbbf24" />
            <Text style={{ color: '#fde68a', fontSize: 12, fontWeight: '700', flex: 1 }}>
              Las {visibleCount} carpetas están ocultas temporalmente de esta vista.
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setShowFoldersInScreen(true)}
            style={{
              backgroundColor: '#f59e0b',
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 9,
            }}
          >
            <Text style={{ color: '#000', fontSize: 11.5, fontWeight: '800' }}>Mostrar</Text>
          </TouchableOpacity>
        </View>
      )}

      {quickEditVisibility && (
        <View style={styles.quickEditBanner}>
          <Ionicons name="information-circle" size={16} color="#60a5fa" />
          <Text style={styles.quickEditBannerText}>
            Toca cualquier carpeta para ocultarla o mostrarla y no saturar tu pantalla.
          </Text>
        </View>
      )}
    </View>
  );

  const renderEmpty = () => {
    if (isRefreshing) return null;
    return (
      <View style={styles.emptyContainer}>
        <Ionicons name="folder-outline" size={64} color={theme.colors.textMuted} />
        <Text style={styles.emptyText}>
          {hiddenCount > 0 && !showAllFolders
            ? 'Has ocultado las carpetas. Toca "Ver todo" o "Elegir visibles" arriba para activarlas.'
            : 'No se encontraron álbumes en el teléfono.'}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={gridData}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        numColumns={NUM_COLUMNS}
        columnWrapperStyle={styles.columnWrapper}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={renderEmpty}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor="#60a5fa"
            colors={['#60a5fa']}
            progressBackgroundColor="#18181b"
          />
        }
      />

      {/* Modal Gestor de Carpetas y Sugerencias de Sistema (Auto-desactivadas con activación manual) */}
      <Modal
        visible={Boolean(visibilityModalVisible)}
        animationType="slide"
        onRequestClose={onCloseVisibilityModal}
        transparent={true}
        statusBarTranslucent
      >
        <View style={styles.scannerBackdrop}>
          <View style={[styles.scannerCard, { maxHeight: '88%' }]}>
            <View style={styles.scannerHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <Ionicons name="folder-open" size={22} color="#38bdf8" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.scannerTitle}>
                    Carpetas ({visibleCount} activas de {albums.length})
                  </Text>
                  <Text style={{ color: '#94a3b8', fontSize: 11 }}>
                    {systemSuggestedAlbums.length} sugeridas de sistema · {normalUserAlbums.length} principales
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={onCloseVisibilityModal}>
                <Ionicons name="close" size={24} color="#fff" />
              </TouchableOpacity>
            </View>

            {/* Pestañas del Gestor: 1) Sugeridas de Sistema, 2) Principales, 3) Todas */}
            <View
              style={{
                flexDirection: 'row',
                backgroundColor: '#1c1c22',
                borderRadius: 12,
                padding: 3,
                gap: 4,
              }}
            >
              <TouchableOpacity
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 10,
                  alignItems: 'center',
                  backgroundColor: managerTab === 'system' ? '#2563eb' : 'transparent',
                }}
                onPress={() => setManagerTab('system')}
              >
                <Text
                  style={{
                    color: managerTab === 'system' ? '#ffffff' : '#a1a1aa',
                    fontSize: 11.5,
                    fontWeight: '800',
                  }}
                >
                  🤖 Sistema ({systemSuggestedAlbums.length})
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 10,
                  alignItems: 'center',
                  backgroundColor: managerTab === 'main' ? '#2563eb' : 'transparent',
                }}
                onPress={() => setManagerTab('main')}
              >
                <Text
                  style={{
                    color: managerTab === 'main' ? '#ffffff' : '#a1a1aa',
                    fontSize: 11.5,
                    fontWeight: '800',
                  }}
                >
                  📂 Principales ({normalUserAlbums.length})
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: 10,
                  alignItems: 'center',
                  backgroundColor: managerTab === 'all' ? '#2563eb' : 'transparent',
                }}
                onPress={() => setManagerTab('all')}
              >
                <Text
                  style={{
                    color: managerTab === 'all' ? '#ffffff' : '#a1a1aa',
                    fontSize: 11.5,
                    fontWeight: '800',
                  }}
                >
                  📋 Todas ({albums.length})
                </Text>
              </TouchableOpacity>
            </View>

            {/* Buscador rápido dentro del modal */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: '#1f1f26',
                borderRadius: 11,
                paddingHorizontal: 10,
                paddingVertical: 6,
                gap: 6,
                borderWidth: 1,
                borderColor: '#2e2e38',
              }}
            >
              <Ionicons name="search" size={15} color="#94a3b8" />
              <TextInput
                style={{ flex: 1, color: '#fff', fontSize: 13, paddingVertical: 2 }}
                value={managerSearch}
                onChangeText={setManagerSearch}
                placeholder="Buscar carpeta por nombre..."
                placeholderTextColor="#64748b"
              />
              {managerSearch.length > 0 && (
                <TouchableOpacity onPress={() => setManagerSearch('')}>
                  <Ionicons name="close-circle" size={16} color="#94a3b8" />
                </TouchableOpacity>
              )}
            </View>

            {/* Explicación y controles masivos cuando estamos en "Sugeridas de Sistema" */}
            {managerTab === 'system' && (
              <View
                style={{
                  backgroundColor: 'rgba(37, 99, 235, 0.12)',
                  borderWidth: 1,
                  borderColor: 'rgba(56, 189, 248, 0.35)',
                  borderRadius: 12,
                  padding: 10,
                  gap: 8,
                }}
              >
                <Text style={{ color: '#bae6fd', fontSize: 11.5, lineHeight: 16 }}>
                  💡 Estas <Text style={{ fontWeight: '800', color: '#fff' }}>{systemSuggestedAlbums.length} carpetas</Text> se detectaron como de sistema, caché o con 1-3 archivos sueltos y están <Text style={{ fontWeight: '800', color: '#fbbf24' }}>desactivadas automáticamente</Text>. Toca cualquiera abajo para <Text style={{ fontWeight: '800', color: '#34d399' }}>activarla manualmente</Text>.
                </Text>

                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <TouchableOpacity
                    style={{
                      flex: 1,
                      backgroundColor: 'rgba(245, 158, 11, 0.2)',
                      borderWidth: 1,
                      borderColor: '#f59e0b',
                      paddingVertical: 7,
                      borderRadius: 9,
                      alignItems: 'center',
                      flexDirection: 'row',
                      justifyContent: 'center',
                      gap: 5,
                    }}
                    onPress={() => {
                      if (onSetAllSystemFoldersManual) {
                        onSetAllSystemFoldersManual(false, systemSuggestedAlbums);
                      }
                    }}
                  >
                    <Ionicons name="eye-off" size={13} color="#fbbf24" />
                    <Text style={{ color: '#fde68a', fontSize: 11, fontWeight: '800' }}>
                      Desactivar todas ({systemSuggestedAlbums.length})
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={{
                      flex: 1,
                      backgroundColor: 'rgba(16, 185, 129, 0.2)',
                      borderWidth: 1,
                      borderColor: '#10b981',
                      paddingVertical: 7,
                      borderRadius: 9,
                      alignItems: 'center',
                      flexDirection: 'row',
                      justifyContent: 'center',
                      gap: 5,
                    }}
                    onPress={() => {
                      if (onSetAllSystemFoldersManual) {
                        onSetAllSystemFoldersManual(true, systemSuggestedAlbums);
                      }
                    }}
                  >
                    <Ionicons name="eye" size={13} color="#34d399" />
                    <Text style={{ color: '#a7f3d0', fontSize: 11, fontWeight: '800' }}>
                      Activar todas manual
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Acciones rápidas dentro del gestor de carpetas */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.managerQuickRow}
            >
              {onPickNewFolder && (
                <TouchableOpacity
                  style={styles.addBtnPill}
                  onPress={() => {
                    if (onCloseVisibilityModal) onCloseVisibilityModal();
                    onPickNewFolder();
                  }}
                >
                  <Ionicons name="add-circle" size={15} color="#fff" />
                  <Text style={styles.addBtnPillText}>+ Agregar carpeta</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={styles.scanBtnPill}
                onPress={handleOpenFolderScanner}
              >
                <Ionicons name="scan-circle-outline" size={15} color="#38bdf8" />
                <Text style={styles.scanBtnPillText}>Escanear teléfono</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.showAllToggle, showAllFolders && styles.showAllToggleActive]}
                onPress={onToggleShowAllFolders}
              >
                <Ionicons
                  name={showAllFolders ? 'lock-open' : 'lock-closed-outline'}
                  size={14}
                  color="#fff"
                />
                <Text style={styles.showAllToggleTextActive}>
                  {showAllFolders ? 'Ocultar privadas' : 'Mostrar todas temporal'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.permBtnPill}
                onPress={() => folderService.openAllFilesAccessSettings()}
              >
                <Ionicons name="shield-checkmark" size={14} color="#a78bfa" />
                <Text style={styles.permBtnPillText}>Permisos</Text>
              </TouchableOpacity>
            </ScrollView>

            <ScrollView style={{ maxHeight: 330 }} showsVerticalScrollIndicator={false}>
              {(() => {
                const sourceList =
                  managerTab === 'system'
                    ? systemSuggestedAlbums
                    : managerTab === 'main'
                    ? normalUserAlbums
                    : albums;
                const mq = managerSearch.trim().toLowerCase();
                const filteredList = mq
                  ? sourceList.filter((alb) =>
                      folderService
                        .formatFolderDisplayName(alb.title, alb.uri || '')
                        .toLowerCase()
                        .includes(mq)
                    )
                  : sourceList;

                if (filteredList.length === 0) {
                  return (
                    <View style={{ paddingVertical: 28, alignItems: 'center', gap: 6 }}>
                      <Ionicons name="folder-open-outline" size={34} color="#71717a" />
                      <Text style={{ color: '#a1a1aa', fontSize: 12.5, textAlign: 'center' }}>
                        No hay carpetas en esta sección.
                      </Text>
                    </View>
                  );
                }

                return filteredList.map((alb) => {
                  const hidden = isAlbumHidden(alb);
                  const visible = !hidden;
                  const sysInfo = folderService.classifySystemFolder(alb);
                  const displayName = folderService.formatFolderDisplayName(alb.title, alb.uri || '');
                  const thumb = alb.coverUri || getFallbackCoverForKey(alb.id || displayName);

                  return (
                    <TouchableOpacity
                      key={`vis_${alb.id}`}
                      style={[
                        styles.visibilityRow,
                        !visible && styles.visibilityRowHidden,
                      ]}
                      onPress={() => handleToggleAlbumOrSystem(alb)}
                      activeOpacity={0.75}
                    >
                      <Image
                        source={{ uri: thumb }}
                        style={styles.visibilityThumb}
                        contentFit="cover"
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.visibilityRowTitle} numberOfLines={1}>
                          {displayName}
                        </Text>
                        <Text style={styles.visibilityRowSub}>
                          {alb.assetCount || 0} {alb.assetCount === 1 ? 'archivo' : 'archivos'}
                          {alb.subfolderCount > 0 ? ` · ${alb.subfolderCount} subcarpetas` : ''}
                        </Text>
                        {sysInfo.isSystemSuggested && (
                          <View
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 4,
                              marginTop: 3,
                            }}
                          >
                            <Ionicons name="hardware-chip-outline" size={11} color="#fbbf24" />
                            <Text style={{ color: '#fbbf24', fontSize: 10.5, fontWeight: '700' }}>
                              Sugerida de sistema: {sysInfo.reason}
                            </Text>
                          </View>
                        )}
                      </View>
                      <View
                        style={[
                          styles.visibilityToggleBadge,
                          visible ? styles.visibilityBadgeOn : styles.visibilityBadgeOff,
                        ]}
                      >
                        <Ionicons
                          name={visible ? 'checkmark-circle' : 'close-circle-outline'}
                          size={14}
                          color="#ffffff"
                        />
                        <Text style={styles.visibilityToggleText}>
                          {visible
                            ? sysInfo.isSystemSuggested
                              ? 'Activada'
                              : 'Visible'
                            : sysInfo.isSystemSuggested
                            ? 'Desactivada'
                            : 'Oculta'}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                });
              })()}
            </ScrollView>

            <TouchableOpacity
              style={styles.confirmScanBtn}
              onPress={onCloseVisibilityModal}
              activeOpacity={0.85}
            >
              <Text style={styles.confirmScanBtnText}>Listo y guardar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Modal Escáner Inteligente de Carpetas Sugeridas */}
      <Modal
        visible={showScannerModal}
        animationType="slide"
        onRequestClose={() => setShowScannerModal(false)}
        transparent={true}
        statusBarTranslucent
      >
        <View style={styles.scannerBackdrop}>
          <View style={styles.scannerCard}>
            <View style={styles.scannerHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="scan-circle" size={24} color="#38bdf8" />
                <Text style={styles.scannerTitle}>Carpetas sugeridas del teléfono</Text>
              </View>
              <TouchableOpacity onPress={() => setShowScannerModal(false)}>
                <Ionicons name="close" size={24} color="#fff" />
              </TouchableOpacity>
            </View>

            {isScanningFolders ? (
              <View style={{ alignItems: 'center', paddingVertical: 32, gap: 10 }}>
                <ActivityIndicator size="large" color="#38bdf8" />
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>
                  Escaneando carpetas con fotos y videos…
                </Text>
                {scanProgressInfo?.currentFolder ? (
                  <Text style={{ color: theme.colors.textMuted, fontSize: 12 }} numberOfLines={1}>
                    {scanProgressInfo.currentFolder} ({scanProgressInfo.foundCount} encontradas)
                  </Text>
                ) : null}
              </View>
            ) : suggestedFolders.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 28, gap: 10 }}>
                <Ionicons name="checkmark-done-circle" size={44} color="#10b981" />
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700', textAlign: 'center' }}>
                  ¡Todas las carpetas con fotos ya están agregadas!
                </Text>
              </View>
            ) : (
              <>
                <ScrollView style={{ maxHeight: 340 }} showsVerticalScrollIndicator={false}>
                  {suggestedFolders.map((item) => {
                    const isChecked = Boolean(selectedSuggestedUris[item.uri]);
                    const formattedName = folderService.formatFolderDisplayName(item.name, item.uri);
                    return (
                      <TouchableOpacity
                        key={item.uri}
                        style={[
                          styles.suggestedRow,
                          isChecked && styles.suggestedRowSelected,
                        ]}
                        onPress={() => toggleSelectSuggested(item.uri)}
                        activeOpacity={0.75}
                      >
                        <Ionicons
                          name={isChecked ? 'checkbox' : 'square-outline'}
                          size={22}
                          color={isChecked ? '#38bdf8' : theme.colors.textMuted}
                        />
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }} numberOfLines={1}>
                            {formattedName}
                          </Text>
                          <Text style={{ color: theme.colors.textMuted, fontSize: 11 }} numberOfLines={1}>
                            {item.relativePath} · {item.photoCount} fotos · {item.videoCount} videos
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>

                <TouchableOpacity
                  style={styles.confirmScanBtn}
                  onPress={handleConfirmAddSuggested}
                  activeOpacity={0.85}
                >
                  <Ionicons name="add-circle" size={18} color="#fff" />
                  <Text style={styles.confirmScanBtnText}>
                    Agregar seleccionadas ({Object.keys(selectedSuggestedUris).length})
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Modal para inspeccionar las carpetas pequeñas (< 5 archivos) agrupadas dentro de "Varios" */}
      <Modal
        visible={variosModalVisible}
        animationType="slide"
        onRequestClose={() => setVariosModalVisible(false)}
        transparent={true}
        statusBarTranslucent
      >
        <View style={styles.scannerBackdrop}>
          <View style={styles.scannerCard}>
            <View style={styles.scannerHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="file-tray-stacked" size={22} color="#a78bfa" />
                <Text style={styles.scannerTitle}>
                  Varios ({smallGroupedAlbums.length} carpetas con &lt; 5 fotos)
                </Text>
              </View>
              <TouchableOpacity onPress={() => setVariosModalVisible(false)}>
                <Ionicons name="close" size={24} color="#fff" />
              </TouchableOpacity>
            </View>

            <Text style={styles.visibilitySubHint}>
              Aquí se agrupan todas las carpetas que tienen de 1 a 4 fotos/videos para mantener tu pantalla limpia. Puedes ver todas sus fotos juntas o abrir una carpeta individual.
            </Text>

            <TouchableOpacity
              style={[styles.confirmScanBtn, { backgroundColor: '#7c3aed', marginBottom: 4 }]}
              onPress={() => {
                setVariosModalVisible(false);
                const variosCard = gridData.find((it) => it.isVariosCard);
                if (variosCard) onSelectAlbum(variosCard);
              }}
              activeOpacity={0.85}
            >
              <Ionicons name="images" size={17} color="#fff" />
              <Text style={styles.confirmScanBtnText}>
                Ver todas las fotos de Varios juntas
              </Text>
            </TouchableOpacity>

            <ScrollView style={{ maxHeight: 340 }} showsVerticalScrollIndicator={false}>
              {smallGroupedAlbums.map((alb) => {
                const displayName = folderService.formatFolderDisplayName(alb.title, alb.uri || '');
                const thumb = alb.coverUri || getFallbackCoverForKey(alb.id || displayName);
                return (
                  <TouchableOpacity
                    key={`varios_sub_${alb.id}`}
                    style={styles.visibilityRow}
                    onPress={() => {
                      setVariosModalVisible(false);
                      onSelectAlbum({ ...alb, title: displayName });
                    }}
                    activeOpacity={0.75}
                  >
                    <Image
                      source={{ uri: thumb }}
                      style={styles.visibilityThumb}
                      contentFit="cover"
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.visibilityRowTitle} numberOfLines={1}>
                        {displayName}
                      </Text>
                      <Text style={styles.visibilityRowSub}>
                        {alb.assetCount || 0} {alb.assetCount === 1 ? 'elemento' : 'elementos'}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#a1a1aa" />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  listContent: {
    paddingHorizontal: SIDE_PADDING,
    paddingTop: 4,
    paddingBottom: 145, // Espacio libre para la cápsula flotante inferior elevada sobre los botones del celular
    flexGrow: 1,
  },
  headerBlock: {
    marginBottom: 12,
    gap: 10,
  },
  sortBarScroll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 2,
  },
  sortChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#18181b',
    borderWidth: 1,
    borderColor: '#27272a',
  },
  sortChipActive: {
    backgroundColor: '#2563eb',
    borderColor: '#3b82f6',
  },
  variosChipActive: {
    backgroundColor: '#6d28d9',
    borderColor: '#8b5cf6',
  },
  sortChipText: {
    color: '#d4d4d8',
    fontSize: 11.5,
    fontWeight: '700',
  },
  sortChipTextActive: {
    color: '#ffffff',
  },
  variosCardBg: {
    borderWidth: 1.5,
    borderColor: 'rgba(167, 139, 250, 0.55)',
    backgroundColor: '#1e1b2e',
  },
  variosFolderCountPill: {
    position: 'absolute',
    top: 7,
    right: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(15, 12, 28, 0.82)',
    borderWidth: 1,
    borderColor: 'rgba(167, 139, 250, 0.5)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 10,
    zIndex: 10,
  },
  variosFolderCountText: {
    color: '#ddd6fe',
    fontSize: 10,
    fontWeight: '800',
  },
  searchBarBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#18181b',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    borderWidth: 1,
    borderColor: '#27272a',
  },
  searchInput: {
    flex: 1,
    color: '#ffffff',
    fontSize: 14,
    paddingVertical: 2,
  },
  galaxySectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
    paddingTop: 4,
  },
  galaxySectionTitle: {
    color: '#ffffff',
    fontSize: 19,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  galaxyHeaderRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  quickEyePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 16,
    backgroundColor: 'rgba(96, 165, 250, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.3)',
  },
  quickEyePillActive: {
    backgroundColor: '#2563eb',
    borderColor: '#3b82f6',
  },
  quickEyePillText: {
    color: '#60a5fa',
    fontSize: 12,
    fontWeight: '700',
  },
  verTodoBlueLink: {
    color: '#60a5fa',
    fontSize: 14,
    fontWeight: '600',
  },
  quickEditBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(37, 99, 235, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.35)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  quickEditBannerText: {
    flex: 1,
    color: '#bfdbfe',
    fontSize: 12,
    fontWeight: '600',
  },
  columnWrapper: {
    justifyContent: 'flex-start',
    gap: COLUMN_GAP,
    marginBottom: 10,
  },
  galaxyCard: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#222226',
    position: 'relative',
  },
  galaxyCardHidden: {
    borderWidth: 1.5,
    borderColor: '#f59e0b',
    borderStyle: 'dashed',
  },
  favoritesCardBg: {
    backgroundColor: '#2c2c30',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 14,
    paddingBottom: 10,
  },
  favStackContainer: {
    width: Math.round(CARD_WIDTH * 0.66),
    height: Math.round(CARD_WIDTH * 0.66),
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    marginTop: 4,
  },
  favStackBack2: {
    position: 'absolute',
    top: -7,
    right: -7,
    width: '84%',
    height: '84%',
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
  },
  favStackBack1: {
    position: 'absolute',
    top: -3,
    right: -3,
    width: '90%',
    height: '90%',
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.28)',
  },
  favStackFront: {
    width: '92%',
    height: '92%',
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#18181b',
  },
  favStackImg: {
    width: '100%',
    height: '100%',
  },
  cardBottomOverlayFav: {
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  bottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '52%',
    backgroundColor: 'rgba(0, 0, 0, 0.56)',
  },
  topRightIconClean: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topRightSubfolderBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 10,
  },
  topRightSubfolderText: {
    color: '#fde68a',
    fontSize: 10.5,
    fontWeight: '800',
  },
  topRightCornerBadge: {
    position: 'absolute',
    top: 7,
    right: 7,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  topRightCornerBadgeHidden: {
    backgroundColor: '#f59e0b',
  },
  hiddenCenterPill: {
    position: 'absolute',
    top: '38%',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(245, 158, 11, 0.92)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  hiddenCenterPillText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
  },
  cardBottomOverlay: {
    position: 'absolute',
    left: 6,
    right: 6,
    bottom: 9,
    alignItems: 'center',
  },
  galaxyCardTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  galaxyCardCount: {
    color: '#d4d4d8',
    fontSize: 11.5,
    fontWeight: '500',
    marginTop: 1,
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  visibilitySubHint: {
    color: '#a1a1aa',
    fontSize: 12,
    lineHeight: 17,
  },
  managerQuickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  visibilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 8,
    borderRadius: 14,
    backgroundColor: '#1f1f25',
    marginBottom: 7,
    borderWidth: 1,
    borderColor: '#2e2e36',
  },
  visibilityRowHidden: {
    opacity: 0.65,
    borderColor: 'rgba(245, 158, 11, 0.45)',
  },
  visibilityThumb: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#27272a',
  },
  visibilityRowTitle: {
    color: '#ffffff',
    fontSize: 13.5,
    fontWeight: '700',
  },
  visibilityRowSub: {
    color: '#a1a1aa',
    fontSize: 11.5,
    marginTop: 2,
  },
  visibilityToggleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
  },
  visibilityBadgeOn: {
    backgroundColor: '#2563eb',
  },
  visibilityBadgeOff: {
    backgroundColor: '#52525b',
  },
  visibilityToggleText: {
    color: '#ffffff',
    fontSize: 11.5,
    fontWeight: '800',
  },
  addBtnPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: 20,
  },
  addBtnPillText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  scanBtnPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(56, 189, 248, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.45)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  scanBtnPillText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
  },
  permBtnPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: theme.colors.surfaceHover,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 20,
  },
  permBtnPillText: {
    color: theme.colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  showAllToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#27272a',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    gap: 6,
  },
  showAllToggleActive: {
    backgroundColor: '#10b981',
  },
  showAllToggleTextActive: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  scannerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.82)',
    justifyContent: 'flex-end',
  },
  scannerCard: {
    backgroundColor: '#141418',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 18,
    gap: 12,
    borderTopWidth: 1,
    borderColor: '#2e2e36',
  },
  scannerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  scannerTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
  },
  suggestedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: 10,
    backgroundColor: '#1c1c22',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#2e2e36',
  },
  suggestedRowSelected: {
    borderColor: '#38bdf8',
    backgroundColor: 'rgba(56, 189, 248, 0.1)',
  },
  confirmScanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 14,
    marginTop: 4,
  },
  confirmScanBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 100,
  },
  emptyText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 32,
    marginTop: theme.spacing.md,
    lineHeight: 20,
  },
});
