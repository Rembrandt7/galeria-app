import React, { useMemo, useCallback, useRef, useState } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  Dimensions,
  Text,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
  Alert,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import PhotoThumbnail from './PhotoThumbnail';
import { theme } from '../constants/theme';
import { compressionService } from '../services/compressionService';
import { mediaService } from '../services/mediaService';
import { folderService } from '../services/folderService';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const NUM_COLUMNS = 3;
const ITEM_MARGIN = 1;
// Screen width minus spacing divided by 3
const ITEM_SIZE = Math.floor((SCREEN_WIDTH - ITEM_MARGIN * (NUM_COLUMNS * 2)) / NUM_COLUMNS);

export default function PhotoGrid({
  assets = [],
  favorites = {},
  onSelectPhoto,
  onRefresh,
  isRefreshing,
  onLoadMore,
  hasMore,
  isLoadingMore,
  emptyMessage = 'No se encontraron fotos ni videos.',
}) {
  const selectRef = useRef(onSelectPhoto);
  selectRef.current = onSelectPhoto;
  const assetsRef = useRef(assets);
  assetsRef.current = assets;

  const [isCompressingBatch, setIsCompressingBatch] = useState(false);
  const [compressProgress, setCompressProgress] = useState(null);
  const [selectedIds, setSelectedIds] = useState({});
  const [numColumns, setNumColumns] = useState(NUM_COLUMNS);

  const itemSize = useMemo(
    () => Math.floor((SCREEN_WIDTH - ITEM_MARGIN * (numColumns * 2)) / numColumns),
    [numColumns]
  );

  const cycleColumns = () => {
    setNumColumns((prev) => (prev === 3 ? 4 : prev === 4 ? 2 : 3));
  };

  const selectedCount = useMemo(() => Object.keys(selectedIds).length, [selectedIds]);
  const isSelecting = selectedCount > 0;
  const isSelectingRef = useRef(isSelecting);
  isSelectingRef.current = isSelecting;

  const selectedAssets = useMemo(
    () => (assets || []).filter((a) => a && selectedIds[a.id]),
    [assets, selectedIds]
  );

  const photoAssets = useMemo(
    () => (assets || []).filter((a) => a && a.mediaType === 'photo'),
    [assets]
  );

  const toggleSelectAsset = useCallback((asset) => {
    if (!asset?.id) return;
    setSelectedIds((prev) => {
      const next = { ...prev };
      if (next[asset.id]) {
        delete next[asset.id];
      } else {
        next[asset.id] = true;
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds({});
  }, []);

  const selectAllVisible = useCallback(() => {
    const next = {};
    (assets || []).forEach((a) => {
      if (a?.id) next[a.id] = true;
    });
    setSelectedIds(next);
  }, [assets]);

  const handleDeleteSelected = () => {
    if (selectedAssets.length === 0) return;
    Alert.alert(
      'Eliminar seleccionados',
      `¿Deseas eliminar ${selectedAssets.length} ${selectedAssets.length === 1 ? 'archivo seleccionado' : 'archivos seleccionados'}?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: async () => {
            try {
              const mediaLibIds = [];
              for (const item of selectedAssets) {
                const isCustomFile =
                  String(item.id).startsWith('content://') ||
                  String(item.id).startsWith('file://');
                if (isCustomFile) {
                  await folderService.deleteFile(item.uri);
                } else {
                  mediaLibIds.push(item.id);
                }
              }
              if (mediaLibIds.length > 0) {
                await mediaService.deleteAssets(mediaLibIds);
              }
              clearSelection();
              if (onRefresh) onRefresh();
            } catch (e) {
              Alert.alert('Error', 'No se pudieron eliminar algunos archivos.');
            }
          },
        },
      ]
    );
  };

  const handleCompressSelected = () => {
    const selectedPhotos = selectedAssets.filter((a) => a.mediaType === 'photo');
    if (selectedPhotos.length === 0) {
      Alert.alert('Sin fotos', 'Selecciona al menos una fotografía para comprimir.');
      return;
    }
    Alert.alert(
      'Comprimir seleccionadas',
      `¿Optimizar ${selectedPhotos.length} ${selectedPhotos.length === 1 ? 'foto seleccionada' : 'fotos seleccionadas'} manteniendo el 100% de su resolución original?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Comprimir',
          onPress: async () => {
            setIsCompressingBatch(true);
            setCompressProgress({
              current: 0,
              total: selectedPhotos.length,
              percent: 0,
              savedFormatted: '0 B',
            });
            try {
              const res = await compressionService.compressFolderPhotos(
                selectedPhotos,
                (prog) => setCompressProgress(prog)
              );
              clearSelection();
              Alert.alert(
                '¡Compresión finalizada!',
                `Se optimizaron ${res.compressedCount || res.processed} de ${selectedPhotos.length} fotos.\n\nEspacio ahorrado: ${compressionService.formatBytes(res.totalSavedBytes)}.`
              );
              if (onRefresh) onRefresh();
            } catch (e) {
              Alert.alert('Error', e?.message || String(e));
            } finally {
              setIsCompressingBatch(false);
              setCompressProgress(null);
            }
          },
        },
      ]
    );
  };

  const handleShareSelected = async () => {
    if (selectedAssets.length === 0) return;
    await mediaService.shareAsset(selectedAssets[0]);
  };

  const handleCompressAll = () => {
    if (photoAssets.length === 0) {
      Alert.alert('Sin fotos', 'No hay fotografías en esta vista para comprimir.');
      return;
    }

    Alert.alert(
      'Comprimir fotos sin perder resolución',
      `¿Deseas optimizar las ${photoAssets.length} fotos visibles manteniendo el 100% de su resolución original (mismo ancho y alto)?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Comprimir fotos',
          onPress: async () => {
            setIsCompressingBatch(true);
            setCompressProgress({
              current: 0,
              total: photoAssets.length,
              percent: 0,
              savedFormatted: '0 B',
            });
            try {
              const res = await compressionService.compressFolderPhotos(
                photoAssets,
                (prog) => setCompressProgress(prog)
              );
              Alert.alert(
                '¡Compresión finalizada!',
                `Se procesaron ${res.compressedCount || res.processed} de ${photoAssets.length} fotos manteniendo el 100% de su resolución.\n\nEspacio total ahorrado: ${compressionService.formatBytes(res.totalSavedBytes)}.`
              );
              if (onRefresh) onRefresh();
            } catch (e) {
              Alert.alert(
                'Error',
                'Ocurrió un problema durante la compresión: ' + (e?.message || String(e))
              );
            } finally {
              setIsCompressingBatch(false);
              setCompressProgress(null);
            }
          },
        },
      ]
    );
  };

  // Manejador estable: evita re-dibujar todas las miniaturas cada vez que cambia la lista
  const handlePress = useCallback(
    (a) => {
      if (isSelectingRef.current) {
        toggleSelectAsset(a);
        return;
      }
      if (selectRef.current) selectRef.current(a, assetsRef.current);
    },
    [toggleSelectAsset]
  );

  const handleLongPress = useCallback(
    (a) => {
      toggleSelectAsset(a);
    },
    [toggleSelectAsset]
  );

  const renderItem = useCallback(
    ({ item }) => {
      const isFav = Boolean(favorites[item.id]);
      const isSel = Boolean(selectedIds[item.id]);
      return (
        <PhotoThumbnail
          asset={item}
          size={itemSize}
          onPress={handlePress}
          onLongPress={handleLongPress}
          isFavorite={isFav}
          selectable={isSelecting}
          isSelected={isSel}
        />
      );
    },
    [favorites, handlePress, handleLongPress, isSelecting, selectedIds, itemSize]
  );

  // Con numColumns, FlatList pide el layout por FILA (no por elemento)
  const getItemLayout = useCallback(
    (_, index) => ({
      length: itemSize + ITEM_MARGIN * 2,
      offset: (itemSize + ITEM_MARGIN * 2) * index,
      index,
    }),
    [itemSize]
  );

  const renderFooter = () => {
    if (!isLoadingMore) return <View style={styles.footerSpacing} />;
    return (
      <View style={styles.footerLoader}>
        <ActivityIndicator size="small" color={theme.colors.primary} />
      </View>
    );
  };

  const renderEmpty = () => {
    if (isRefreshing) return null;
    return (
      <View style={styles.emptyContainer}>
        <Ionicons name="images-outline" size={64} color={theme.colors.textMuted} />
        <Text style={styles.emptyText}>{emptyMessage}</Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {isSelecting ? (
        <View style={styles.selectionBar}>
          <View style={styles.selectionTopRow}>
            <TouchableOpacity onPress={clearSelection} style={styles.selHeaderBtn}>
              <Ionicons name="close" size={18} color="#fff" />
              <Text style={styles.selCountText}>{selectedCount} sel.</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={selectAllVisible} style={styles.selAllBtn}>
              <Ionicons name="checkmark-done" size={15} color="#38bdf8" />
              <Text style={styles.selAllText}>Seleccionar todo ({assets.length})</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.selectionActionsRow}>
            <TouchableOpacity style={styles.selActionBtn} onPress={handleCompressSelected}>
              <Ionicons name="sparkles" size={15} color="#38bdf8" />
              <Text style={[styles.selActionText, { color: '#38bdf8' }]}>Comprimir</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.selActionBtn} onPress={handleShareSelected}>
              <Ionicons name="share-social-outline" size={15} color="#fff" />
              <Text style={styles.selActionText}>Compartir</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.selActionBtn, styles.selDeleteBtn]}
              onPress={handleDeleteSelected}
            >
              <Ionicons name="trash-outline" size={15} color={theme.colors.danger} />
              <Text style={[styles.selActionText, { color: theme.colors.danger }]}>
                Eliminar ({selectedCount})
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        assets.length > 0 && (
          <View style={styles.toolsBar}>
            <Text style={styles.toolsInfoText} numberOfLines={1}>
              {assets.length} archivos · Mantén presionado para elegir
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <TouchableOpacity
                style={styles.compressBatchBtn}
                onPress={cycleColumns}
                activeOpacity={0.8}
              >
                <Ionicons name="grid-outline" size={13} color={theme.colors.textSecondary} />
                <Text style={[styles.compressBatchBtnText, { color: theme.colors.textSecondary }]}>
                  {numColumns} col
                </Text>
              </TouchableOpacity>
              {photoAssets.length > 0 && (
                <TouchableOpacity
                  style={styles.compressBatchBtn}
                  onPress={handleCompressAll}
                  disabled={isCompressingBatch}
                  activeOpacity={0.8}
                >
                  <Ionicons name="sparkles" size={14} color="#38bdf8" />
                  <Text style={styles.compressBatchBtnText}>
                    Comprimir ({photoAssets.length})
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )
      )}
      <FlatList
        key={`photo_grid_${numColumns}`}
        data={assets}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        numColumns={numColumns}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        initialNumToRender={24}
        maxToRenderPerBatch={24}
        updateCellsBatchingPeriod={30}
        windowSize={7}
        removeClippedSubviews={true}
        getItemLayout={getItemLayout}
        onEndReached={() => {
          if (hasMore && !isLoadingMore && onLoadMore) {
            onLoadMore();
          }
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={renderFooter}
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

      <Modal
        visible={isCompressingBatch}
        transparent={true}
        animationType="fade"
        statusBarTranslucent
      >
        <View style={styles.progressModalBackdrop}>
          <View style={styles.progressModalCard}>
            <Ionicons name="sparkles" size={36} color="#38bdf8" />
            <Text style={styles.progressModalTitle}>Comprimiendo fotos...</Text>
            <Text style={styles.progressModalSubtitle}>
              Manteniendo el 100% de la resolución original sin pérdida
            </Text>

            {compressProgress && (
              <View style={{ width: '100%', marginTop: 14 }}>
                <View style={styles.progressBarBg}>
                  <View
                    style={[
                      styles.progressBarFill,
                      { width: `${Math.round((compressProgress.percent || 0) * 100)}%` },
                    ]}
                  />
                </View>
                <Text style={styles.progressPercentText}>
                  {compressProgress.current} de {compressProgress.total} fotos ({Math.round((compressProgress.percent || 0) * 100)}%)
                </Text>
                <Text style={styles.progressSavedText}>
                  Espacio ahorrado: {compressProgress.savedFormatted}
                </Text>
              </View>
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
  toolsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  selectionBar: {
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: '#38bdf8',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  selectionTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  selCountText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  selAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: theme.colors.surfaceHover,
  },
  selAllText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '600',
  },
  selectionActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  selActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    paddingVertical: 7,
    borderRadius: 8,
  },
  selDeleteBtn: {
    borderColor: 'rgba(239, 68, 68, 0.45)',
  },
  selActionText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  toolsInfoText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  compressBatchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.45)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  compressBatchBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
  },
  progressModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  progressModalCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    padding: 22,
    alignItems: 'center',
    width: '100%',
    maxWidth: 340,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  progressModalTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 12,
    textAlign: 'center',
  },
  progressModalSubtitle: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 16,
  },
  progressBarBg: {
    height: 8,
    backgroundColor: theme.colors.surfaceBorder,
    borderRadius: 4,
    overflow: 'hidden',
    width: '100%',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#38bdf8',
    borderRadius: 4,
  },
  progressPercentText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
    textAlign: 'center',
  },
  progressSavedText: {
    color: '#10b981',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
    textAlign: 'center',
  },
  listContent: {
    paddingHorizontal: ITEM_MARGIN,
    paddingTop: ITEM_MARGIN,
    paddingBottom: 24,
    flexGrow: 1,
  },
  footerLoader: {
    paddingVertical: theme.spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerSpacing: {
    height: 16,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 100,
    paddingHorizontal: theme.spacing.xl,
  },
  emptyText: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    marginTop: theme.spacing.md,
  },
});
