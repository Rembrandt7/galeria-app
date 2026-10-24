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

  const favList = useMemo(() => Object.values(favorites || {}), [favorites]);
  const favCount = favList.length;
  const favCoverUri = favList[0]?.uri || BEAUTIFUL_FALLBACK_COVERS[2];

  const isAlbumHidden = (item) =>
    Boolean(
      hiddenFolders[item.title] ||
        hiddenFolders[item.id] ||
        (item.uri && hiddenFolders[item.uri])
    );

  const visibleAlbums = useMemo(() => {
    const base = showAllFolders || quickEditVisibility
      ? albums
      : albums.filter((item) => !isAlbumHidden(item));
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((item) => {
      const displayTitle = folderService.formatFolderDisplayName(item.title, item.uri || '');
      return displayTitle.toLowerCase().includes(q);
    });
  }, [albums, hiddenFolders, showAllFolders, quickEditVisibility, searchQuery]);

  const hiddenCount = useMemo(() => {
    return albums.filter((item) => isAlbumHidden(item)).length;
  }, [albums, hiddenFolders]);

  // Construir lista final con la tarjeta "Favoritos" estilo Samsung Galaxy en la primera posición
  const gridData = useMemo(() => {
    const favCard = {
      id: '__galaxy_favorites_card__',
      isFavoritesCard: true,
      title: 'Favoritos',
      assetCount: favCount,
      coverUri: favCoverUri,
    };
    const q = searchQuery.trim().toLowerCase();
    if (q && !'favoritos'.includes(q)) {
      return visibleAlbums;
    }
    return [favCard, ...visibleAlbums];
  }, [favCount, favCoverUri, visibleAlbums, searchQuery]);

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
          if (quickEditVisibility && onToggleHideFolder) {
            onToggleHideFolder(item.uri || item.id || item.title, displayTitle);
            return;
          }
          onSelectAlbum({ ...item, title: displayTitle });
        }}
        onLongPress={() => {
          if (onToggleHideFolder) {
            onToggleHideFolder(item.uri || item.id || item.title, displayTitle);
          }
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
        {(quickEditVisibility || showAllFolders) && onToggleHideFolder ? (
          <TouchableOpacity
            style={[styles.topRightCornerBadge, isHidden && styles.topRightCornerBadgeHidden]}
            onPress={(e) => {
              e.stopPropagation();
              onToggleHideFolder(item.uri || item.id || item.title, displayTitle);
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

      {/* Encabezado idéntico a Samsung Galaxy: "Álbumes esenciales" a la izquierda y "Ver todo / Elegir visibles" a la derecha */}
      <View style={styles.galaxySectionHeaderRow}>
        <Text style={styles.galaxySectionTitle}>Álbumes esenciales</Text>

        <View style={styles.galaxyHeaderRightActions}>
          <TouchableOpacity
            onPress={() => setQuickEditVisibility((prev) => !prev)}
            style={[
              styles.quickEyePill,
              quickEditVisibility && styles.quickEyePillActive,
            ]}
            activeOpacity={0.8}
          >
            <Ionicons
              name={quickEditVisibility ? 'checkmark-circle' : 'eye-outline'}
              size={14}
              color={quickEditVisibility ? '#ffffff' : '#60a5fa'}
            />
            <Text
              style={[
                styles.quickEyePillText,
                quickEditVisibility && { color: '#ffffff' },
              ]}
            >
              {quickEditVisibility ? 'Listo' : 'Elegir visibles'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => {
              if (onOpenVisibilityModal) {
                onOpenVisibilityModal();
              } else if (onToggleShowAllFolders) {
                onToggleShowAllFolders();
              }
            }}
            activeOpacity={0.75}
          >
            <Text style={styles.verTodoBlueLink}>
              {showAllFolders ? 'Ocultar privadas' : 'Ver todo'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

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

      {/* Modal Estilo Samsung: Elegir qué carpetas se ven y cuáles están ocultas + Agregar/Escanear */}
      <Modal
        visible={Boolean(visibilityModalVisible)}
        animationType="slide"
        onRequestClose={onCloseVisibilityModal}
        transparent={true}
        statusBarTranslucent
      >
        <View style={styles.scannerBackdrop}>
          <View style={styles.scannerCard}>
            <View style={styles.scannerHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="eye-outline" size={22} color="#60a5fa" />
                <Text style={styles.scannerTitle}>Mostrar u ocultar carpetas</Text>
              </View>
              <TouchableOpacity onPress={onCloseVisibilityModal}>
                <Ionicons name="close" size={24} color="#fff" />
              </TouchableOpacity>
            </View>

            <Text style={styles.visibilitySubHint}>
              Elige qué carpetas quieres ver en tu pantalla principal para no cargarla tanto de imágenes ({albums.length - hiddenCount} visibles · {hiddenCount} ocultas).
            </Text>

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
                  {showAllFolders ? 'Ocultar privadas' : 'Ver ocultas (PIN)'}
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

            <ScrollView style={{ maxHeight: 370 }} showsVerticalScrollIndicator={false}>
              {albums.map((alb) => {
                const hidden = isAlbumHidden(alb);
                const visible = !hidden;
                const displayName = folderService.formatFolderDisplayName(alb.title, alb.uri || '');
                const thumb = alb.coverUri || getFallbackCoverForKey(alb.id || displayName);

                return (
                  <TouchableOpacity
                    key={`vis_${alb.id}`}
                    style={[
                      styles.visibilityRow,
                      !visible && styles.visibilityRowHidden,
                    ]}
                    onPress={() => {
                      if (onToggleHideFolder) {
                        onToggleHideFolder(alb.uri || alb.id || alb.title, displayName);
                      }
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
                        {alb.assetCount || 0} elementos
                        {alb.subfolderCount > 0 ? ` · ${alb.subfolderCount} subcarpetas` : ''}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.visibilityToggleBadge,
                        visible ? styles.visibilityBadgeOn : styles.visibilityBadgeOff,
                      ]}
                    >
                      <Ionicons
                        name={visible ? 'eye' : 'eye-off'}
                        size={14}
                        color="#ffffff"
                      />
                      <Text style={styles.visibilityToggleText}>
                        {visible ? 'Visible' : 'Oculta'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <TouchableOpacity
              style={styles.confirmScanBtn}
              onPress={onCloseVisibilityModal}
              activeOpacity={0.85}
            >
              <Text style={styles.confirmScanBtnText}>Guardar y cerrar</Text>
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
    paddingBottom: 110, // Espacio libre para la cápsula flotante inferior estilo Galaxy
    flexGrow: 1,
  },
  headerBlock: {
    marginBottom: 12,
    gap: 10,
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
