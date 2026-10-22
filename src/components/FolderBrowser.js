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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { folderService } from '../services/folderService';
import PhotoThumbnail from './PhotoThumbnail';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const NUM_PHOTO_COLUMNS = 3;
const PHOTO_MARGIN = 1;
const PHOTO_SIZE = Math.floor((SCREEN_WIDTH - PHOTO_MARGIN * (NUM_PHOTO_COLUMNS * 2)) / NUM_PHOTO_COLUMNS);

const FOLDER_GAP = 12;
const NUM_FOLDER_COLUMNS = 2;
const FOLDER_CARD_WIDTH = (SCREEN_WIDTH - theme.spacing.lg * 2 - FOLDER_GAP) / NUM_FOLDER_COLUMNS;

export default function FolderBrowser({
  rootUri,
  onPickNewFolder,
  onSelectPhoto,
  favorites = {},
  filterType = 'all',
  onAssetsChange,
}) {
  // Historial de navegación: [{ uri, name }]
  const [history, setHistory] = useState(() => {
    return rootUri ? [{ uri: rootUri, name: folderService.folderName(rootUri) }] : [];
  });

  // Modo de visualización: 'folders' (por carpetas - por defecto) | 'all' (todo junto)
  const [viewMode, setViewMode] = useState('folders');

  // Contenido de la carpeta actual
  const [subfolders, setSubfolders] = useState([]);
  const [currentFolderAssets, setCurrentFolderAssets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Contenido cuando se elige "Ver todo junto" (recursivo)
  const [allAssets, setAllAssets] = useState([]);
  const [loadingAll, setLoadingAll] = useState(false);

  const currentFolder = history[history.length - 1] || null;

  // Cargar nivel actual (ultra rápido, no recursivo)
  const loadCurrentLevel = useCallback(async (uri) => {
    if (!uri) return;
    setLoading(true);
    try {
      const { subfolders: subs, assets: arts } = await folderService.readDirectory(uri);
      setSubfolders(subs);
      setCurrentFolderAssets(arts);
    } catch (e) {
      setSubfolders([]);
      setCurrentFolderAssets([]);
    }
    setLoading(false);
  }, []);

  // Cargar todo junto recursivamente (solo cuando el usuario lo pide)
  const loadAllRecursive = useCallback(async (uri) => {
    if (!uri) return;
    setLoadingAll(true);
    try {
      const items = await folderService.loadFolderAssets(uri);
      setAllAssets(items);
    } catch (e) {
      setAllAssets([]);
    }
    setLoadingAll(false);
  }, []);

  // Al cambiar rootUri o la carpeta actual
  useEffect(() => {
    if (rootUri && history.length === 0) {
      setHistory([{ uri: rootUri, name: folderService.folderName(rootUri) }]);
    }
  }, [rootUri]);

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

  // Refrescar
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

  // Filtrar fotos/videos según el filtro activo (all | photos | videos)
  const displayedAssets = useMemo(() => {
    const list = viewMode === 'folders' ? currentFolderAssets : allAssets;
    if (filterType === 'photos') return list.filter((a) => a.mediaType === 'photo');
    if (filterType === 'videos') return list.filter((a) => a.mediaType === 'video');
    return list;
  }, [viewMode, currentFolderAssets, allAssets, filterType]);

  // Notificar al componente padre los assets visibles (para el detector de duplicados)
  useEffect(() => {
    if (onAssetsChange) {
      onAssetsChange(displayedAssets);
    }
  }, [displayedAssets, onAssetsChange]);

  if (!rootUri) {
    return (
      <View style={styles.centerContainer}>
        <Ionicons name="folder-open-outline" size={72} color={theme.colors.primary} />
        <Text style={styles.title}>Elige una carpeta</Text>
        <Text style={styles.subtitle}>
          Selecciona cualquier carpeta de tu dispositivo para explorar sus subcarpetas y fotos.
        </Text>
        <TouchableOpacity style={styles.primaryButton} onPress={onPickNewFolder} activeOpacity={0.8}>
          <Text style={styles.primaryButtonText}>Seleccionar carpeta</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Renderizar una tarjeta de subcarpeta
  const renderSubfolderItem = (item) => (
    <TouchableOpacity
      key={item.id}
      style={[styles.folderCard, { width: FOLDER_CARD_WIDTH }]}
      onPress={() => handleOpenSubfolder(item)}
      activeOpacity={0.7}
    >
      <View style={styles.folderIconWrap}>
        <Ionicons name="folder" size={32} color={theme.colors.primary} />
      </View>
      <View style={styles.folderInfo}>
        <Text style={styles.folderName} numberOfLines={2}>
          {item.name}
        </Text>
        <Text style={styles.folderHint}>Toca para entrar</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Barra de Navegación y Breadcrumbs */}
      <View style={styles.navBar}>
        <View style={styles.pathRow}>
          {history.length > 1 && (
            <TouchableOpacity style={styles.backBtn} onPress={handleGoBack} activeOpacity={0.7}>
              <Ionicons name="arrow-back" size={20} color="#fff" />
              <Text style={styles.backBtnText}>Subir nivel</Text>
            </TouchableOpacity>
          )}

          {/* Ruta en migas de pan */}
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
        </View>

        {/* Selector de modo y botón de cambiar carpeta */}
        <View style={styles.controlsRow}>
          <View style={styles.modeTabs}>
            <TouchableOpacity
              style={[styles.modeTab, viewMode === 'folders' && styles.modeTabActive]}
              onPress={() => setViewMode('folders')}
              activeOpacity={0.8}
            >
              <Ionicons
                name="folder-outline"
                size={16}
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
                size={16}
                color={viewMode === 'all' ? '#fff' : theme.colors.textMuted}
              />
              <Text style={[styles.modeTabText, viewMode === 'all' && styles.modeTabTextActive]}>
                Todo junto
              </Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.pickFolderBtn} onPress={onPickNewFolder} activeOpacity={0.7}>
            <Ionicons name="folder-open-outline" size={16} color={theme.colors.primaryLight} />
            <Text style={styles.pickFolderBtnText}>Cambiar</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Contenido */}
      {loading || loadingAll ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.loadingText}>
            {viewMode === 'all' ? 'Cargando todo el contenido…' : 'Leyendo carpeta…'}
          </Text>
        </View>
      ) : viewMode === 'all' ? (
        /* Modo "Todo junto" (recursivo) */
        <FlatList
          data={displayedAssets}
          keyExtractor={(item) => item.id}
          numColumns={NUM_PHOTO_COLUMNS}
          contentContainerStyle={styles.photoListContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
              colors={[theme.colors.primary]}
            />
          }
          ListHeaderComponent={
            <View style={styles.allBanner}>
              <Ionicons name="information-circle-outline" size={18} color={theme.colors.primaryLight} />
              <Text style={styles.allBannerText}>
                Mostrando {displayedAssets.length} archivos de esta carpeta y todas sus subcarpetas.
              </Text>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Ionicons name="images-outline" size={56} color={theme.colors.textMuted} />
              <Text style={styles.emptyText}>No se encontraron fotos ni videos en esta carpeta.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <PhotoThumbnail
              asset={item}
              size={PHOTO_SIZE}
              onPress={onSelectPhoto}
              isFavorite={Boolean(favorites[item.id])}
            />
          )}
        />
      ) : (
        /* Modo "Por carpetas" (jerárquico - por defecto) */
        <FlatList
          data={displayedAssets}
          keyExtractor={(item) => item.id}
          numColumns={NUM_PHOTO_COLUMNS}
          contentContainerStyle={styles.photoListContent}
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
              {/* Sección de Subcarpetas */}
              {subfolders.length > 0 && (
                <View style={styles.subfolderSection}>
                  <View style={styles.sectionHeader}>
                    <Ionicons name="folder-outline" size={18} color={theme.colors.primary} />
                    <Text style={styles.sectionTitle}>Carpetas ({subfolders.length})</Text>
                  </View>
                  <View style={styles.subfolderGrid}>
                    {subfolders.map((item) => renderSubfolderItem(item))}
                  </View>
                </View>
              )}

              {/* Título de Fotos Sueltas de esta carpeta */}
              {displayedAssets.length > 0 && (
                <View style={styles.sectionHeader}>
                  <Ionicons name="images-outline" size={18} color={theme.colors.primary} />
                  <Text style={styles.sectionTitle}>
                    Fotos y videos aquí ({displayedAssets.length})
                  </Text>
                </View>
              )}
            </View>
          }
          ListEmptyComponent={
            subfolders.length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons name="folder-open-outline" size={56} color={theme.colors.textMuted} />
                <Text style={styles.emptyText}>Esta carpeta está vacía.</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <PhotoThumbnail
              asset={item}
              size={PHOTO_SIZE}
              onPress={onSelectPhoto}
              isFavorite={Boolean(favorites[item.id])}
            />
          )}
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
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    marginTop: 16,
  },
  subtitle: {
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
    maxWidth: 320,
  },
  primaryButton: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
    marginTop: 24,
  },
  primaryButtonText: {
    color: '#fff',
    fontWeight: '700',
  },
  navBar: {
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
    paddingHorizontal: 12,
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
    paddingVertical: 5,
    borderRadius: 8,
    gap: 4,
  },
  backBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  breadcrumbsContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
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
    maxWidth: 130,
  },
  crumbTextActive: {
    color: theme.colors.primaryLight,
    fontWeight: '700',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modeTabs: {
    flexDirection: 'row',
    backgroundColor: theme.colors.background,
    borderRadius: 8,
    padding: 3,
    gap: 4,
  },
  modeTab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    gap: 4,
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
    color: '#fff',
  },
  pickFolderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceHover,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    gap: 4,
  },
  pickFolderBtnText: {
    color: theme.colors.primaryLight,
    fontSize: 12,
    fontWeight: '600',
  },
  loadingBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
  },
  allBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    padding: 10,
    marginHorizontal: 10,
    marginTop: 10,
    marginBottom: 6,
    borderRadius: 8,
    gap: 8,
  },
  allBannerText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    flex: 1,
  },
  subfolderSection: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 8,
    gap: 6,
  },
  sectionTitle: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  subfolderGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: FOLDER_GAP,
    marginTop: 6,
  },
  folderCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  folderIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: theme.colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  folderInfo: {
    flex: 1,
  },
  folderName: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 17,
  },
  folderHint: {
    color: theme.colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  photoListContent: {
    paddingBottom: 40,
  },
  emptyBox: {
    padding: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: theme.colors.textMuted,
    marginTop: 12,
    fontSize: 14,
    textAlign: 'center',
  },
});
