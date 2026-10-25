import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  Dimensions,
  useWindowDimensions,
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
import { videoEngineService } from '../services/videoEngineService';

const NUM_COLUMNS = 4;
const ITEM_MARGIN = 1;

export default function PhotoGrid({
  assets = [],
  favorites = {},
  onSelectPhoto,
  onOpenModoGuardar,
  trashCount = 0,
  defaultColumns = 0,
  onSetFolderCover,
  currentFolderCoverUri = null,
  onRefresh,
  isRefreshing,
  onLoadMore,
  hasMore,
  isLoadingMore,
  emptyMessage = 'No se encontraron fotos ni videos.',
}) {
  const { width: screenWidth } = useWindowDimensions();
  const isFoldExpanded = screenWidth >= 580;

  const selectRef = useRef(onSelectPhoto);
  selectRef.current = onSelectPhoto;
  const assetsRef = useRef(assets);
  assetsRef.current = assets;

  const [isCompressingBatch, setIsCompressingBatch] = useState(false);
  const [compressProgress, setCompressProgress] = useState(null);
  const [selectedIds, setSelectedIds] = useState({});
  const [numColumns, setNumColumns] = useState(() =>
    defaultColumns > 0 ? defaultColumns : isFoldExpanded ? 6 : NUM_COLUMNS
  );

  useEffect(() => {
    if (defaultColumns > 0) {
      setNumColumns(Number(defaultColumns));
    } else {
      setNumColumns(isFoldExpanded ? 6 : NUM_COLUMNS);
    }
  }, [defaultColumns, isFoldExpanded]);

  const itemSize = useMemo(
    () => Math.max(50, Math.floor((screenWidth - ITEM_MARGIN * (numColumns * 2)) / numColumns)),
    [screenWidth, numColumns]
  );

  const cycleColumns = () => {
    setNumColumns((prev) => (prev === 3 ? 4 : prev === 4 ? 2 : prev === 2 ? 1 : 3));
  };

  // Gesto de pellizco con 2 dedos en la cuadrícula para hacer zoom sin entrar a la foto (4 <-> 3 <-> 2 <-> 1 col)
  const pinchRef = useRef({ active: false, startDist: 0, startCols: NUM_COLUMNS });

  const handleGridTouchStart = useCallback(
    (e) => {
      const touches = e.nativeEvent.touches;
      if (touches && touches.length >= 2) {
        const dx = touches[0].pageX - touches[1].pageX;
        const dy = touches[0].pageY - touches[1].pageY;
        const dist = Math.hypot(dx, dy);
        if (dist > 15) {
          pinchRef.current = { active: true, startDist: dist, startCols: numColumns };
        }
      }
    },
    [numColumns]
  );

  const handleGridTouchMove = useCallback(
    (e) => {
      const touches = e.nativeEvent.touches;
      if (!touches || touches.length < 2) return;
      const dx = touches[0].pageX - touches[1].pageX;
      const dy = touches[0].pageY - touches[1].pageY;
      const dist = Math.hypot(dx, dy);
      if (!pinchRef.current.active) {
        if (dist > 15) {
          pinchRef.current = { active: true, startDist: dist, startCols: numColumns };
        }
        return;
      }
      const delta = dist - pinchRef.current.startDist;
      if (Math.abs(delta) > 55) {
        const step = delta > 0 ? -1 : 1;
        setNumColumns((prev) => {
          const next = Math.max(1, Math.min(6, prev + step));
          if (next !== prev) {
            pinchRef.current.startDist = dist;
            pinchRef.current.startCols = next;
          }
          return next;
        });
      }
    },
    [numColumns]
  );

  const handleGridTouchEnd = useCallback((e) => {
    const touches = e.nativeEvent.touches;
    if (!touches || touches.length < 2) {
      pinchRef.current.active = false;
    }
  }, []);

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

  const videoAssets = useMemo(
    () => (assets || []).filter((a) => a && a.mediaType === 'video'),
    [assets]
  );

  const photoReductionSummary = useMemo(
    () => compressionService.getBatchReductionSummary(assets, null),
    [assets]
  );

  const selectedReductionSummary = useMemo(
    () => compressionService.getBatchReductionSummary(selectedAssets, null),
    [selectedAssets]
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
    const selectedVideos = selectedAssets.filter((a) => a.mediaType === 'video');
    const totalSel = selectedPhotos.length + selectedVideos.length;
    if (totalSel === 0) {
      Alert.alert('Sin archivos', 'Selecciona al menos una fotografía o video para comprimir.');
      return;
    }
    Alert.alert(
      'Comprimir seleccionados (100% Resolución)',
      `¿Optimizar ${selectedPhotos.length} foto(s) y ${selectedVideos.length} video(s) manteniendo el 100% de su resolución original?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Comprimir',
          onPress: async () => {
            setIsCompressingBatch(true);
            setCompressProgress({
              current: 0,
              total: totalSel,
              percent: 0,
              savedFormatted: '0 B',
            });
            try {
              let totalSaved = 0;
              let totalDone = 0;
              let permReq = false;
              if (selectedPhotos.length > 0) {
                const res = await compressionService.compressFolderPhotos(
                  selectedPhotos,
                  (prog) => setCompressProgress(prog)
                );
                totalSaved += res.totalSavedBytes || 0;
                totalDone += res.compressedCount || 0;
                if (res.permissionRequired) permReq = true;
              }
              if (selectedVideos.length > 0) {
                const resVid = await videoEngineService.compressVideosBatch(selectedVideos, {
                  presetId: 'balanced',
                  onProgress: (prog) => setCompressProgress(prog),
                });
                totalSaved += resVid.totalSavedBytes || 0;
                totalDone += resVid.compressedCount || 0;
              }
              clearSelection();
              if (permReq && totalDone === 0) {
                Alert.alert(
                  'Permiso requerido para modificar originales',
                  'Android bloqueó la modificación directa del archivo original. Activa "Acceso a todos los archivos" para comprimir sin crear copias.',
                  [
                    { text: 'Cancelar', style: 'cancel' },
                    {
                      text: 'Activar permiso en Ajustes',
                      onPress: () => folderService.openAllFilesAccessSettings(),
                    },
                  ]
                );
              } else {
                Alert.alert(
                  '¡Compresión finalizada!',
                  `Se optimizaron ${totalDone} de ${totalSel} archivos al 100% de su resolución.\n\nEspacio ahorrado: ${compressionService.formatBytes(totalSaved)}.`
                );
              }
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
    const totalCount = photoAssets.length + videoAssets.length;
    if (totalCount === 0) {
      Alert.alert('Sin archivos', 'No hay fotografías ni videos en esta vista para comprimir.');
      return;
    }

    Alert.alert(
      'Comprimir sin perder resolución (100%)',
      `¿Deseas optimizar ${photoAssets.length} foto(s) y ${videoAssets.length} video(s) visibles manteniendo el 100% de su resolución original?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Comprimir todo',
          onPress: async () => {
            setIsCompressingBatch(true);
            setCompressProgress({
              current: 0,
              total: totalCount,
              percent: 0,
              savedFormatted: '0 B',
            });
            try {
              let totalSaved = 0;
              let totalDone = 0;
              let permReq = false;
              if (photoAssets.length > 0) {
                const res = await compressionService.compressFolderPhotos(
                  photoAssets,
                  (prog) => setCompressProgress(prog)
                );
                totalSaved += res.totalSavedBytes || 0;
                totalDone += res.compressedCount || 0;
                if (res.permissionRequired) permReq = true;
              }
              if (videoAssets.length > 0) {
                const resVid = await videoEngineService.compressVideosBatch(videoAssets, {
                  presetId: 'balanced',
                  onProgress: (prog) => setCompressProgress(prog),
                });
                totalSaved += resVid.totalSavedBytes || 0;
                totalDone += resVid.compressedCount || 0;
              }
              if (permReq && totalDone === 0) {
                Alert.alert(
                  'Permiso requerido para modificar originales',
                  'Android bloqueó la modificación directa del archivo original. Activa "Acceso a todos los archivos" para comprimir sin crear copias.',
                  [
                    { text: 'Cancelar', style: 'cancel' },
                    {
                      text: 'Activar permiso en Ajustes',
                      onPress: () => folderService.openAllFilesAccessSettings(),
                    },
                  ]
                );
              } else {
                Alert.alert(
                  '¡Compresión finalizada!',
                  `Se optimizaron ${totalDone} de ${totalCount} archivos manteniendo el 100% de su resolución.\n\nEspacio total ahorrado: ${compressionService.formatBytes(totalSaved)}.`
                );
              }
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
      const isCov = Boolean(currentFolderCoverUri && item.uri === currentFolderCoverUri);
      return (
        <PhotoThumbnail
          asset={item}
          size={itemSize}
          onPress={handlePress}
          onLongPress={handleLongPress}
          isFavorite={isFav}
          isCover={isCov}
          selectable={isSelecting}
          isSelected={isSel}
        />
      );
    },
    [favorites, handlePress, handleLongPress, isSelecting, selectedIds, itemSize, currentFolderCoverUri]
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
            {onSetFolderCover && selectedAssets.length === 1 && (
              <TouchableOpacity
                style={[
                  styles.selActionBtn,
                  {
                    backgroundColor: 'rgba(245, 158, 11, 0.18)',
                    borderColor: '#f59e0b',
                  },
                ]}
                onPress={() => {
                  onSetFolderCover(selectedAssets[0]);
                  clearSelection();
                }}
              >
                <Ionicons name="star" size={15} color="#fbbf24" />
                <Text style={[styles.selActionText, { color: '#fde68a' }]}>
                  Portada
                </Text>
              </TouchableOpacity>
            )}
            {selectedReductionSummary.canCompress && (
              <TouchableOpacity
                style={[
                  styles.selActionBtn,
                  {
                    backgroundColor: selectedReductionSummary.bgColor,
                    borderColor: selectedReductionSummary.borderColor,
                  },
                ]}
                onPress={handleCompressSelected}
              >
                <Ionicons name="sparkles" size={15} color={selectedReductionSummary.color} />
                <Text style={[styles.selActionText, { color: selectedReductionSummary.color }]}>
                  Comprimir
                </Text>
              </TouchableOpacity>
            )}
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
            <Text style={[styles.toolsInfoText, { flex: 1 }]} numberOfLines={1}>
              {assets.length} archivos · Zoom ({numColumns} col)
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {onOpenModoGuardar && (
                <TouchableOpacity
                  style={[
                    styles.compressBatchBtn,
                    {
                      backgroundColor:
                        trashCount > 0 ? 'rgba(244, 63, 94, 0.18)' : 'rgba(16, 185, 129, 0.16)',
                      borderColor: trashCount > 0 ? '#f43f5e' : '#10b981',
                    },
                  ]}
                  onPress={() => onOpenModoGuardar(assets, 0)}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name="swap-vertical"
                    size={14}
                    color={trashCount > 0 ? '#f43f5e' : '#10b981'}
                  />
                  <Text
                    style={[
                      styles.compressBatchBtnText,
                      { color: trashCount > 0 ? '#fda4af' : '#6ee7b7' },
                    ]}
                  >
                    {trashCount > 0 ? `Modo Guardar (${trashCount})` : 'Modo Guardar'}
                  </Text>
                </TouchableOpacity>
              )}

              {(photoAssets.length > 0 || videoAssets.length > 0) && (
                <TouchableOpacity
                  style={[
                    styles.compressBatchBtn,
                    {
                      backgroundColor: isCompressingBatch
                        ? 'rgba(37, 99, 235, 0.25)'
                        : photoReductionSummary.bgColor,
                      borderColor: isCompressingBatch
                        ? '#38bdf8'
                        : photoReductionSummary.borderColor,
                    },
                  ]}
                  onPress={handleCompressAll}
                  disabled={isCompressingBatch}
                  activeOpacity={0.8}
                >
                  {isCompressingBatch ? (
                    <ActivityIndicator size="small" color="#38bdf8" />
                  ) : (
                    <Ionicons name="sparkles" size={14} color={photoReductionSummary.color} />
                  )}
                  <Text
                    style={[
                      styles.compressBatchBtnText,
                      {
                        color: isCompressingBatch
                          ? '#ffffff'
                          : photoReductionSummary.textColor || photoReductionSummary.color,
                      },
                    ]}
                  >
                    {isCompressingBatch
                      ? `${compressProgress?.current || 1}/${compressProgress?.total || 1} (${Math.round((compressProgress?.percent || 0) * 100)}%)`
                      : `Comprimir (${photoReductionSummary.compressibleCount || assets.length})`}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )
      )}

      {/* Barra superior de progreso en vivo cuando se está comprimiendo */}
      {isCompressingBatch && (
        <View
          style={{
            marginHorizontal: 10,
            marginVertical: 6,
            padding: 11,
            borderRadius: 14,
            backgroundColor: '#0f172a',
            borderWidth: 1.5,
            borderColor: '#38bdf8',
            gap: 6,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator size="small" color="#38bdf8" />
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }} numberOfLines={1}>
                Comprimiendo archivo {compressProgress?.current || 1} de {compressProgress?.total || 1} ({Math.round((compressProgress?.percent || 0) * 100)}%)
              </Text>
              <Text style={{ color: '#38bdf8', fontSize: 11.5, fontWeight: '600' }} numberOfLines={1}>
                {compressProgress?.currentFile
                  ? `Procesando: ${compressProgress.currentFile}`
                  : 'Optimizando al 100% de resolución...'}
              </Text>
            </View>
            <View
              style={{
                backgroundColor: 'rgba(16, 185, 129, 0.2)',
                borderWidth: 1,
                borderColor: '#10b981',
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 8,
              }}
            >
              <Text style={{ color: '#34d399', fontSize: 11, fontWeight: '800' }}>
                -{compressProgress?.savedFormatted || '0 B'}
              </Text>
            </View>
          </View>
          <View style={styles.progressBarBg}>
            <View
              style={[
                styles.progressBarFill,
                { width: `${Math.max(4, Math.round((compressProgress?.percent || 0) * 100))}%` },
              ]}
            />
          </View>
        </View>
      )}
      <View
        style={{ flex: 1 }}
        onTouchStart={handleGridTouchStart}
        onTouchMove={handleGridTouchMove}
        onTouchEnd={handleGridTouchEnd}
        onTouchCancel={handleGridTouchEnd}
      >
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
      </View>

      {isCompressingBatch && (
        <View style={styles.bgFloatingCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator size="small" color="#38bdf8" />
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }} numberOfLines={1}>
                Comprimiendo en 2do plano ({compressProgress?.current || 0}/{compressProgress?.total || 0})
              </Text>
              <Text style={{ color: '#10b981', fontSize: 11, fontWeight: '700' }}>
                Espacio ahorrado: {compressProgress?.savedFormatted || '0 B'}
              </Text>
            </View>
          </View>
          <View style={styles.progressBarBg}>
            <View
              style={[
                styles.progressBarFill,
                { width: `${Math.round((compressProgress?.percent || 0) * 100)}%` },
              ]}
            />
          </View>
        </View>
      )}
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
    paddingBottom: 145,
    flexGrow: 1,
  },
  footerLoader: {
    paddingVertical: theme.spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerSpacing: {
    height: 95,
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
  bgFloatingCard: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 124,
    backgroundColor: 'rgba(15, 23, 42, 0.96)',
    borderWidth: 1,
    borderColor: '#38bdf8',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    elevation: 10,
    zIndex: 40,
  },
});
