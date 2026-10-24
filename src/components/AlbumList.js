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
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { folderService } from '../services/folderService';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const COLUMN_GAP = 12;
const NUM_COLUMNS = 2;
const CARD_WIDTH = (SCREEN_WIDTH - theme.spacing.lg * 2 - COLUMN_GAP) / NUM_COLUMNS;

export default function AlbumList({
  albums = [],
  onSelectAlbum,
  onRefresh,
  isRefreshing,
  hiddenFolders = {},
  onToggleHideFolder,
  showAllFolders = false,
  onToggleShowAllFolders,
  onPickNewFolder,
  onAddMultipleFolders,
  savedFolders = [],
}) {
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [isScanningFolders, setIsScanningFolders] = useState(false);
  const [scanProgressInfo, setScanProgressInfo] = useState(null);
  const [suggestedFolders, setSuggestedFolders] = useState([]);
  const [selectedSuggestedUris, setSelectedSuggestedUris] = useState({});

  const visibleAlbums = useMemo(() => {
    if (showAllFolders) return albums;
    return albums.filter((item) => !(hiddenFolders[item.title] || hiddenFolders[item.id] || (item.uri && hiddenFolders[item.uri])));
  }, [albums, hiddenFolders, showAllFolders]);

  const hiddenCount = useMemo(() => {
    return albums.filter((item) => Boolean(hiddenFolders[item.title] || hiddenFolders[item.id] || (item.uri && hiddenFolders[item.uri]))).length;
  }, [albums, hiddenFolders]);

  const handleOpenFolderScanner = async () => {
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
    const isHidden = Boolean(
      hiddenFolders[item.title] || hiddenFolders[item.id] || (item.uri && hiddenFolders[item.uri])
    );
    const displayTitle = folderService.formatFolderDisplayName(item.title, item.uri || '');

    return (
      <TouchableOpacity
        style={[
          styles.albumCard,
          { width: CARD_WIDTH },
          isHidden && styles.albumCardHidden,
        ]}
        activeOpacity={0.8}
        onPress={() => onSelectAlbum({ ...item, title: displayTitle })}
      >
        <View style={styles.coverWrapper}>
          {item.coverUri ? (
            <Image
              source={{ uri: item.coverUri }}
              style={[styles.coverImage, isHidden && { opacity: 0.6 }]}
              contentFit="cover"
              transition={100}
              cachePolicy="memory-disk"
            />
          ) : (
            <View style={styles.fallbackCover}>
              <Ionicons name="folder-open" size={40} color={theme.colors.textMuted} />
            </View>
          )}

          {/* Insignia de carpeta en la portada */}
          <View style={styles.folderCornerBadge}>
            <Ionicons name="folder" size={12} color="#ffffff" />
          </View>

          {/* Botón de Ocultar / Prender Carpeta */}
          <TouchableOpacity
            style={[styles.eyeButton, isHidden && styles.eyeButtonHidden]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={(e) => {
              e.stopPropagation();
              if (onToggleHideFolder) {
                onToggleHideFolder(item.uri || item.id || item.title, item.title);
              }
            }}
            activeOpacity={0.7}
          >
            <Ionicons
              name={isHidden ? 'eye-off' : 'eye-outline'}
              size={18}
              color={isHidden ? '#f59e0b' : '#ffffff'}
            />
          </TouchableOpacity>

          {/* Badge Oculto o Contador */}
          {isHidden ? (
            <View style={styles.hiddenBadge}>
              <Ionicons name="eye-off" size={11} color="#ffffff" />
              <Text style={styles.hiddenBadgeText}>Oculto</Text>
            </View>
          ) : (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{item.assetCount}</Text>
            </View>
          )}
        </View>

        <View style={styles.infoWrapper}>
          <Text style={[styles.albumTitle, isHidden && styles.albumTitleHidden]} numberOfLines={1}>
            {displayTitle}
          </Text>
          <Text style={styles.albumSubtitle}>
            {item.assetCount} {item.assetCount === 1 ? 'elemento' : 'elementos'}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderHeader = () => (
    <View style={styles.headerBlock}>
      {/* Botones de Gestión de Carpetas y Álbumes (+ Agregar, Escanear, Ocultar/Mostrar, Sistema) */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.actionsCarouselRow}
      >
        {onPickNewFolder && (
          <TouchableOpacity style={styles.addBtnPill} onPress={onPickNewFolder} activeOpacity={0.8}>
            <Ionicons name="add-circle" size={16} color="#ffffff" />
            <Text style={styles.addBtnPillText}>+ Agregar carpeta</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={styles.scanBtnPill}
          onPress={handleOpenFolderScanner}
          activeOpacity={0.8}
        >
          <Ionicons name="scan-circle-outline" size={16} color="#38bdf8" />
          <Text style={styles.scanBtnPillText}>Escanear carpetas</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.showAllToggle, showAllFolders && styles.showAllToggleActive]}
          onPress={onToggleShowAllFolders}
          activeOpacity={0.8}
        >
          <Ionicons
            name={showAllFolders ? 'eye' : 'eye-off-outline'}
            size={14}
            color={showAllFolders ? '#ffffff' : theme.colors.textSecondary}
          />
          <Text style={[styles.showAllToggleText, showAllFolders && styles.showAllToggleTextActive]}>
            {showAllFolders ? 'Todo visible' : 'Ocultas (off)'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.permBtnPill}
          onPress={() => folderService.openAllFilesAccessSettings()}
          activeOpacity={0.8}
        >
          <Ionicons name="shield-checkmark" size={14} color={theme.colors.accent} />
          <Text style={styles.permBtnPillText}>Permisos</Text>
        </TouchableOpacity>
      </ScrollView>

      <View style={styles.topFilterBar}>
        <View style={styles.titleCountRow}>
          <Text style={styles.albumCountText}>
            {visibleAlbums.length} {visibleAlbums.length === 1 ? 'carpeta / álbum' : 'carpetas y álbumes'}
          </Text>
          {hiddenCount > 0 && (
            <Text style={styles.hiddenInfoText}>
              ({hiddenCount} {hiddenCount === 1 ? 'oculta' : 'ocultas'} · toca el ojo para ocultar/mostrar)
            </Text>
          )}
        </View>
      </View>
    </View>
  );

  const renderEmpty = () => {
    if (isRefreshing) return null;
    return (
      <View style={styles.emptyContainer}>
        <Ionicons name="folder-outline" size={64} color={theme.colors.textMuted} />
        <Text style={styles.emptyText}>
          {hiddenCount > 0 && !showAllFolders
            ? 'Todos los álbumes están ocultos. Activa "Todo visible" arriba para verlos.'
            : 'No se encontraron álbumes en el teléfono.'}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={visibleAlbums}
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
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.surface}
          />
        }
      />

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
    backgroundColor: theme.colors.background,
  },
  listContent: {
    padding: theme.spacing.lg,
    paddingBottom: 32,
    flexGrow: 1,
  },
  headerBlock: {
    marginBottom: 14,
    gap: 10,
  },
  actionsCarouselRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
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
  folderCornerBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scannerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  scannerCard: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 18,
    gap: 12,
    borderTopWidth: 1,
    borderColor: theme.colors.surfaceBorder,
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
    backgroundColor: theme.colors.background,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
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
    backgroundColor: theme.colors.primary,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 4,
  },
  confirmScanBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
  },
  topFilterBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  titleCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  albumCountText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  hiddenInfoText: {
    color: '#f59e0b',
    fontSize: 12,
    fontWeight: '600',
  },
  showAllToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceHover,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    gap: 6,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  showAllToggleActive: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  showAllToggleText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  showAllToggleTextActive: {
    color: '#ffffff',
  },
  columnWrapper: {
    justifyContent: 'space-between',
    marginBottom: theme.spacing.lg,
  },
  albumCard: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  albumCardHidden: {
    borderColor: '#f59e0b',
    borderStyle: 'dashed',
    opacity: 0.85,
  },
  coverWrapper: {
    width: '100%',
    height: CARD_WIDTH,
    position: 'relative',
    backgroundColor: theme.colors.surfaceHover,
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  fallbackCover: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceHover,
  },
  eyeButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  eyeButtonHidden: {
    backgroundColor: 'rgba(245, 158, 11, 0.9)',
  },
  hiddenBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: '#f59e0b',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  hiddenBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
  countBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  countText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
  infoWrapper: {
    padding: theme.spacing.sm,
  },
  albumTitle: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  albumTitleHidden: {
    color: '#f59e0b',
  },
  albumSubtitle: {
    color: theme.colors.textMuted,
    fontSize: 12,
    marginTop: 2,
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
