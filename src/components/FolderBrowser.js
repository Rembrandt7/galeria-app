import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
  Platform,
  ScrollView,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { folderService } from '../services/folderService';
import PhotoThumbnail from './PhotoThumbnail';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const NUM_PHOTO_COLUMNS = 3;
const PHOTO_MARGIN = 1;
const PHOTO_SIZE = Math.floor(
  (SCREEN_WIDTH - PHOTO_MARGIN * (NUM_PHOTO_COLUMNS * 2)) / NUM_PHOTO_COLUMNS
);

const FOLDER_GAP = 12;
const NUM_FOLDER_COLUMNS = 2;
const FOLDER_CARD_WIDTH =
  (SCREEN_WIDTH - theme.spacing.lg * 2 - FOLDER_GAP) / NUM_FOLDER_COLUMNS;

const BATCH_SIZE = 30; // Tamaño de carga parcial progresiva

export default function FolderBrowser({
  rootUri,
  savedFolders = [],
  onSelectSavedFolder,
  onPickNewFolder,
  onRemoveFolder,
  onSelectPhoto,
  favorites = {},
  filterType = 'all',
  onAssetsChange,
  hiddenFolders = {},
  onToggleHideFolder,
  showAllFolders = false,
  onToggleShowAllFolders,
}) {
  // Historial de navegación dentro de la carpeta activa: [{ uri, name }]
  const [history, setHistory] = useState(() => {
    return rootUri ? [{ uri: rootUri, name: folderService.folderName(rootUri) }] : [];
  });

  // Modo de visualización: 'folders' (por carpetas) | 'all' (todo junto)
  const [viewMode, setViewMode] = useState('folders');

  // Contenido de la carpeta actual
  const [subfolders, setSubfolders] = useState([]);
  const [currentFolderAssets, setCurrentFolderAssets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  // Contenido cuando se elige "Ver todo junto" (recursivo progresivo)
  const [allAssets, setAllAssets] = useState([]);
  const [loadingAll, setLoadingAll] = useState(false);

  // Límite de fotos visibles para renderizado parcial fluido
  const [visibleLimit, setVisibleLimit] = useState(BATCH_SIZE);

  const currentFolder = history[history.length - 1] || null;

  // Cargar nivel actual con emisión parcial temprana
  const loadCurrentLevel = useCallback(async (uri) => {
    if (!uri) return;
    setLoading(true);
    setIsStreaming(true);
    setVisibleLimit(BATCH_SIZE);
    try {
      await folderService.readDirectory(uri, ({ subfolders: subs, assets: arts, isPartial }) => {
        setSubfolders(subs);
        setCurrentFolderAssets(arts);
        if (isPartial) {
          setLoading(false);
        }
      });
    } catch (e) {
      setSubfolders([]);
      setCurrentFolderAssets([]);
    }
    setLoading(false);
    setIsStreaming(false);
  }, []);

  // Cargar todo junto recursivamente de manera progresiva
  const loadAllRecursive = useCallback(async (uri) => {
    if (!uri) return;
    setLoadingAll(true);
    setAllAssets([]);
    setVisibleLimit(BATCH_SIZE);
    try {
      await folderService.loadFolderAssets(uri, (chunk) => {
        setAllAssets((prev) => [...prev, ...chunk]);
        setLoadingAll(false);
      });
    } catch (e) {
      setAllAssets([]);
    }
    setLoadingAll(false);
  }, []);

  // Sincronizar historial al cambiar de carpeta raíz
  useEffect(() => {
    if (rootUri) {
      setHistory([{ uri: rootUri, name: folderService.folderName(rootUri) }]);
    } else {
      setHistory([]);
    }
  }, [rootUri]);

  // Ejecutar carga cuando cambia la carpeta activa o el modo
  useEffect(() => {
    if (currentFolder?.uri) {
      if (viewMode === 'folders') {
        loadCurrentLevel(currentFolder.uri);
      } else {
        loadAllRecursive(currentFolder.uri);
      }
    }
  }, [currentFolder?.uri, viewMode]);

  // Navegar dentro de una subcarpeta
  const handleOpenSubfolder = (sub) => {
    setHistory((prev) => [...prev, { uri: sub.uri, name: sub.name }]);
  };

  // Volver a la carpeta padre
  const handleGoBack = () => {
    if (history.length > 1) {
      setHistory((prev) => prev.slice(0, prev.length - 1));
    }
  };

  // Ir a un punto específico de la ruta
  const handleJumpToHistory = (index) => {
    if (index >= 0 && index < history.length) {
      setHistory((prev) => prev.slice(0, index + 1));
    }
  };

  // Refrescar contenido
  const handleRefresh = async () => {
    if (!currentFolder?.uri) return;
    setRefreshing(true);
    if (viewMode === 'folders') {
      await loadCurrentLevel(currentFolder.uri);
    } else {
      await loadAllRecursive(currentFolder.uri);
    }
    setRefreshing(false);
  };

  // Lista total filtrada (photos | videos | all)
  const totalFilteredAssets = useMemo(() => {
    const list = viewMode === 'folders' ? currentFolderAssets : allAssets;
    if (filterType === 'photos') return list.filter((a) => a.mediaType === 'photo');
    if (filterType === 'videos') return list.filter((a) => a.mediaType === 'video');
    return list;
  }, [viewMode, currentFolderAssets, allAssets, filterType]);

  // Porción visible para no sobrecargar el renderizado
  const paginatedAssets = useMemo(() => {
    return totalFilteredAssets.slice(0, visibleLimit);
  }, [totalFilteredAssets, visibleLimit]);

  // Cargar más fotos al hacer scroll hacia abajo
  const handleLoadMorePhotos = () => {
    if (visibleLimit < totalFilteredAssets.length) {
      setVisibleLimit((prev) => Math.min(prev + BATCH_SIZE, totalFilteredAssets.length));
    }
  };

  // Notificar al componente padre los assets totales visibles
  useEffect(() => {
    if (onAssetsChange) {
      onAssetsChange(totalFilteredAssets);
    }
  }, [totalFilteredAssets, onAssetsChange]);

  // Subcarpetas visibles filtradas por el modo oculto
  const visibleSubfolders = useMemo(() => {
    if (showAllFolders) return subfolders;
    return subfolders.filter((item) => !(hiddenFolders[item.uri] || hiddenFolders[item.name]));
  }, [subfolders, hiddenFolders, showAllFolders]);

  const hiddenSubfolderCount = useMemo(() => {
    return subfolders.filter((item) => Boolean(hiddenFolders[item.uri] || hiddenFolders[item.name])).length;
  }, [subfolders, hiddenFolders]);

  // Renderizar selector superior de múltiples carpetas guardadas
  const renderSavedFoldersBar = () => {
    return (
      <View style={styles.savedFoldersBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.savedFoldersScroll}
        >
          {/* Botón para Agregar Más Carpetas */}
          <TouchableOpacity
            style={styles.addFolderChip}
            onPress={onPickNewFolder}
            activeOpacity={0.8}
          >
            <Ionicons name="add-circle" size={18} color="#ffffff" />
            <Text style={styles.addFolderChipText}>+ Agregar carpeta</Text>
          </TouchableOpacity>

          {/* Chips de Carpetas Guardadas */}
          {savedFolders.map((f) => {
            const isSelected = f.uri === rootUri;
            return (
              <View
                key={f.uri}
                style={[
                  styles.savedFolderChip,
                  isSelected && styles.savedFolderChipActive,
                ]}
              >
                <TouchableOpacity
                  style={styles.savedFolderChipTouch}
                  onPress={() => onSelectSavedFolder && onSelectSavedFolder(f.uri)}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={isSelected ? 'folder-open' : 'folder'}
                    size={16}
                    color={isSelected ? '#ffffff' : theme.colors.primaryLight}
                  />
                  <Text
                    style={[
                      styles.savedFolderChipText,
                      isSelected && styles.savedFolderChipTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {f.name}
                  </Text>
                </TouchableOpacity>

                {onRemoveFolder && (
                  <TouchableOpacity
                    style={styles.removeChipBtn}
                    onPress={() => onRemoveFolder(f.uri)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons
                      name="close-circle"
                      size={16}
                      color={isSelected ? 'rgba(255,255,255,0.8)' : theme.colors.textMuted}
                    />
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </ScrollView>
      </View>
    );
  };

  // Si no hay ninguna carpeta seleccionada o guardada
  if (!rootUri && savedFolders.length === 0) {
    return (
      <View style={styles.centerContainer}>
        <View style={styles.emptyIconCircle}>
          <Ionicons name="folder-open-outline" size={64} color={theme.colors.primary} />
        </View>
        <Text style={styles.title}>Mis Carpetas</Text>
        <Text style={styles.subtitle}>
          Agrega carpetas de tu teléfono o memoria SD para ver y organizar todas tus fotos y videos en un solo lugar.
        </Text>
        <TouchableOpacity style={styles.primaryButton} onPress={onPickNewFolder} activeOpacity={0.8}>
          <Ionicons name="add" size={20} color="#ffffff" />
          <Text style={styles.primaryButtonText}>Agregar mi primera carpeta</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Renderizar una tarjeta de subcarpeta con soporte para ocultar/prender
  const renderSubfolderItem = (item) => {
    const isHidden = Boolean(hiddenFolders[item.uri] || hiddenFolders[item.name]);
    if (!showAllFolders && isHidden) return null;

    return (
      <TouchableOpacity
        key={item.id}
        style={[
          styles.folderCard,
          { width: FOLDER_CARD_WIDTH },
          isHidden && styles.folderCardHidden,
        ]}
        onPress={() => handleOpenSubfolder(item)}
        activeOpacity={0.7}
      >
        <View style={styles.folderCardTopRow}>
          <View style={[styles.folderIconWrap, isHidden && styles.folderIconWrapHidden]}>
            <Ionicons
              name={isHidden ? 'folder-outline' : 'folder'}
              size={28}
              color={isHidden ? '#f59e0b' : theme.colors.primary}
            />
          </View>

          {/* Botón para Ocultar / Prender la subcarpeta */}
          <TouchableOpacity
            style={[styles.hideEyeBtn, isHidden && styles.hideEyeBtnHidden]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={(e) => {
              e.stopPropagation();
              if (onToggleHideFolder) onToggleHideFolder(item.uri, item.name);
            }}
            activeOpacity={0.7}
          >
            <Ionicons
              name={isHidden ? 'eye-off' : 'eye-outline'}
              size={18}
              color={isHidden ? '#f59e0b' : theme.colors.textMuted}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.folderInfo}>
          <Text style={[styles.folderName, isHidden && styles.folderNameHidden]} numberOfLines={2}>
            {item.name}
          </Text>
          <Text style={[styles.folderHint, isHidden && styles.folderHintHidden]}>
            {isHidden ? 'Oculta · Toca para entrar' : 'Toca para entrar'}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Carrusel superior de carpetas guardadas y botón de agregar */}
      {renderSavedFoldersBar()}

      {/* Barra de Navegación y Controles */}
      <View style={styles.navBar}>
        <View style={styles.pathRow}>
          {history.length > 1 && (
            <TouchableOpacity style={styles.backBtn} onPress={handleGoBack} activeOpacity={0.7}>
              <Ionicons name="arrow-back" size={16} color="#fff" />
              <Text style={styles.backBtnText}>Subir nivel</Text>
            </TouchableOpacity>
          )}

          {/* Ruta en migas de pan */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.breadcrumbsScroll}>
            <View style={styles.breadcrumbsContainer}>
              {history.map((step, idx) => {
                const isLast = idx === history.length - 1;
                return (
                  <TouchableOpacity
                    key={step.uri + idx}
                    onPress={() => handleJumpToHistory(idx)}
                    disabled={isLast}
                    style={styles.crumbItem}
                  >
                    <Text style={[styles.crumbText, isLast && styles.crumbTextActive]} numberOfLines={1}>
                      {step.name}
                    </Text>
                    {!isLast && <Ionicons name="chevron-forward" size={14} color={theme.colors.textMuted} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
        </View>

        {/* Selector de modo, modo todo visible y cambiar carpeta */}
        <View style={styles.controlsRow}>
          <View style={styles.modeTabs}>
            <TouchableOpacity
              style={[styles.modeTab, viewMode === 'folders' && styles.modeTabActive]}
              onPress={() => setViewMode('folders')}
              activeOpacity={0.8}
            >
              <Ionicons
                name="folder-outline"
                size={14}
                color={viewMode === 'folders' ? '#fff' : theme.colors.textMuted}
              />
              <Text style={[styles.modeTabText, viewMode === 'folders' && styles.modeTabTextActive]}>
                Por carpetas
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modeTab, viewMode === 'all' && styles.modeTabActive]}
              onPress={() => setViewMode('all')}
              activeOpacity={0.8}
            >
              <Ionicons
                name="grid-outline"
                size={14}
                color={viewMode === 'all' ? '#fff' : theme.colors.textMuted}
              />
              <Text style={[styles.modeTabText, viewMode === 'all' && styles.modeTabTextActive]}>
                Todo junto
              </Text>
            </TouchableOpacity>
          </View>

          {/* Botón Modo Todo Visible */}
          <TouchableOpacity
            style={[styles.showAllToggle, showAllFolders && styles.showAllToggleActive]}
            onPress={onToggleShowAllFolders}
            activeOpacity={0.8}
          >
            <Ionicons
              name={showAllFolders ? 'eye' : 'eye-off-outline'}
              size={13}
              color={showAllFolders ? '#ffffff' : theme.colors.textSecondary}
            />
            <Text style={[styles.showAllToggleText, showAllFolders && styles.showAllToggleTextActive]}>
              {showAllFolders ? 'Todo visible' : 'Ocultas (off)'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Contenido Principal */}
      {loading && paginatedAssets.length === 0 && subfolders.length === 0 ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.loadingText}>Leyendo contenido de la carpeta…</Text>
        </View>
      ) : (
        <FlatList
          data={paginatedAssets}
          keyExtractor={(item) => item.id}
          numColumns={NUM_PHOTO_COLUMNS}
          contentContainerStyle={styles.photoListContent}
          initialNumToRender={18}
          maxToRenderPerBatch={18}
          windowSize={7}
          removeClippedSubviews={Platform.OS === 'android'}
          onEndReached={handleLoadMorePhotos}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
              colors={[theme.colors.primary]}
            />
          }
          ListHeaderComponent={
            <View>
              {viewMode === 'all' ? (
                <View style={styles.allBanner}>
                  <Ionicons name="information-circle-outline" size={18} color={theme.colors.primaryLight} />
                  <Text style={styles.allBannerText}>
                    {loadingAll
                      ? `Cargando fotos progresivamente… (${totalFilteredAssets.length} encontradas)`
                      : `Mostrando ${totalFilteredAssets.length} archivos de esta carpeta y sus subcarpetas.`}
                  </Text>
                </View>
              ) : (
                <>
                  {/* Sección de Subcarpetas */}
                  {visibleSubfolders.length > 0 && (
                    <View style={styles.subfolderSection}>
                      <View style={styles.sectionHeader}>
                        <Ionicons name="folder-outline" size={18} color={theme.colors.primary} />
                        <Text style={styles.sectionTitle}>
                          Carpetas ({visibleSubfolders.length}
                          {hiddenSubfolderCount > 0 && showAllFolders ? ` · ${hiddenSubfolderCount} ocultas` : ''})
                        </Text>
                      </View>
                      <View style={styles.folderGrid}>
                        {visibleSubfolders.map((item) => renderSubfolderItem(item))}
                      </View>
                    </View>
                  )}

                  {/* Cabecera de Fotos */}
                  <View style={styles.sectionHeader}>
                    <Ionicons name="images-outline" size={18} color={theme.colors.primary} />
                    <Text style={styles.sectionTitle}>
                      Fotos y Videos ({totalFilteredAssets.length})
                    </Text>
                  </View>
                </>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <PhotoThumbnail
              asset={item}
              size={PHOTO_SIZE}
              onPress={(a) => onSelectPhoto(a, totalFilteredAssets)}
              isFavorite={Boolean(favorites[item.id])}
            />
          )}
          ListEmptyComponent={
            !loading && subfolders.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Ionicons name="images-outline" size={48} color={theme.colors.textMuted} />
                <Text style={styles.emptyText}>No hay fotos ni videos en esta carpeta.</Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            isStreaming ? (
              <View style={styles.streamingFooter}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
                <Text style={styles.streamingText}>Cargando más fotos en segundo plano…</Text>
              </View>
            ) : (
              <View style={{ height: 30 }} />
            )
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  savedFoldersBar: {
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
    paddingVertical: 8,
  },
  savedFoldersScroll: {
    paddingHorizontal: 12,
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  addFolderChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
  },
  addFolderChipText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  savedFolderChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceHover,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 4,
    gap: 6,
  },
  savedFolderChipActive: {
    backgroundColor: theme.colors.primaryDark,
    borderColor: theme.colors.primaryLight,
  },
  savedFolderChipTouch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 150,
  },
  savedFolderChipText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  savedFolderChipTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  removeChipBtn: {
    padding: 2,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.spacing.xl,
  },
  emptyIconCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
    maxWidth: 320,
  },
  primaryButton: {
    flexDirection: 'row',
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 22,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    gap: 8,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  navBar: {
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 8,
    gap: 8,
  },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceHover,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  backBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  breadcrumbsScroll: {
    flex: 1,
  },
  breadcrumbsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  crumbItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  crumbText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '500',
    maxWidth: 120,
  },
  crumbTextActive: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modeTabs: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surfaceHover,
    borderRadius: 8,
    padding: 2,
    gap: 2,
  },
  modeTab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    gap: 5,
  },
  modeTabActive: {
    backgroundColor: theme.colors.primary,
  },
  modeTabText: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  modeTabTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  showAllToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceHover,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    gap: 5,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  showAllToggleActive: {
    backgroundColor: '#d97706',
    borderColor: '#f59e0b',
  },
  showAllToggleText: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  showAllToggleTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  photoListContent: {
    paddingBottom: 24,
  },
  allBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceHover,
    marginHorizontal: theme.spacing.lg,
    marginVertical: 10,
    padding: 10,
    borderRadius: 8,
    gap: 8,
  },
  allBannerText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    flex: 1,
  },
  subfolderSection: {
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 10,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.colors.textPrimary,
  },
  folderGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: FOLDER_GAP,
    paddingHorizontal: theme.spacing.lg,
  },
  folderCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  folderCardHidden: {
    borderColor: 'rgba(245, 158, 11, 0.4)',
    backgroundColor: 'rgba(245, 158, 11, 0.05)',
  },
  folderCardTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  folderIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: theme.colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  folderIconWrapHidden: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
  },
  hideEyeBtn: {
    padding: 4,
    borderRadius: 6,
    backgroundColor: theme.colors.surfaceHover,
  },
  hideEyeBtnHidden: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
  },
  folderInfo: {
    gap: 2,
  },
  folderName: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  folderNameHidden: {
    color: '#f59e0b',
  },
  folderHint: {
    color: theme.colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  folderHintHidden: {
    color: 'rgba(245, 158, 11, 0.7)',
  },
  loadingBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    gap: 12,
  },
  loadingText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 10,
  },
  emptyText: {
    color: theme.colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
  },
  streamingFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    gap: 8,
  },
  streamingText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
  },
});
