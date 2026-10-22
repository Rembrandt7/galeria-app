import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  StatusBar,
  Alert,
  ActivityIndicator,
  Text,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';

import { theme } from './src/constants/theme';
import { mediaService } from './src/services/mediaService';
import { storageService } from './src/services/storageService';
import { folderService } from './src/services/folderService';

import Header from './src/components/Header';
import TabBar from './src/components/TabBar';
import PhotoGrid from './src/components/PhotoGrid';
import AlbumList from './src/components/AlbumList';
import FullScreenViewer from './src/components/FullScreenViewer';
import PermissionScreen from './src/components/PermissionScreen';

export default function App() {
  const [hasPermission, setHasPermission] = useState(null);
  const [activeTab, setActiveTab] = useState('photos'); // 'photos' | 'albums' | 'favorites'
  const [filterType, setFilterType] = useState('all'); // 'all' | 'photos' | 'videos'

  // Datos
  const [assets, setAssets] = useState([]);
  const [albums, setAlbums] = useState([]);
  const [favorites, setFavorites] = useState({});
  const [selectedAlbum, setSelectedAlbum] = useState(null);

  // Carpeta elegida por el usuario (cualquier carpeta del sistema)
  const [folderUri, setFolderUri] = useState(null);
  const [folderAssets, setFolderAssets] = useState([]);
  const [folderLoading, setFolderLoading] = useState(false);

  // Paginación y Carga
  const [endCursor, setEndCursor] = useState(null);
  const [hasNextPage, setHasNextPage] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  // Visor Pantalla Completa
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);

  // Inicializar permisos y favoritos
  useEffect(() => {
    (async () => {
      const favs = await storageService.getFavorites();
      setFavorites(favs);

      const savedFolder = await folderService.getSavedFolder();
      if (savedFolder) {
        setFolderUri(savedFolder);
        loadFolder(savedFolder);
      }

      const granted = await mediaService.checkAndRequestPermissions();
      setHasPermission(granted);

      if (granted) {
        await loadAssets({ reset: true });
        await loadAlbums();
      }
      setInitialLoading(false);
    })();
  }, []);

  // Cargar contenido de la carpeta elegida
  const loadFolder = async (uri) => {
    setFolderLoading(true);
    try {
      const list = await folderService.loadFolderAssets(uri);
      setFolderAssets(list);
    } catch (e) {
      setFolderAssets([]);
      Alert.alert('No se pudo abrir la carpeta', 'Vuelve a elegirla con el botón de carpeta.');
    }
    setFolderLoading(false);
  };

  // Elegir cualquier carpeta del sistema
  const handlePickFolder = async () => {
    try {
      const uri = await folderService.pickFolder();
      if (uri) {
        setFolderUri(uri);
        setActiveTab('folder');
        setSelectedAlbum(null);
        await loadFolder(uri);
      }
    } catch (e) {
      Alert.alert('Error', 'No se pudo seleccionar la carpeta.');
    }
  };

  // Solicitar permiso manualmente desde el botón
  const handleRequestPermission = async () => {
    const granted = await mediaService.checkAndRequestPermissions();
    setHasPermission(granted);
    if (granted) {
      setInitialLoading(true);
      await loadAssets({ reset: true });
      await loadAlbums();
      setInitialLoading(false);
    }
  };

  // Determinar los media types según el filtro activo
  const getMediaTypes = (filter) => {
    if (filter === 'photos') return [MediaLibrary.MediaType.photo];
    if (filter === 'videos') return [MediaLibrary.MediaType.video];
    return [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video];
  };

  // Cargar fotos/videos
  const loadAssets = async ({ reset = false, album = selectedAlbum, filter = filterType } = {}) => {
    try {
      const cursor = reset ? null : endCursor;
      const result = await mediaService.getAssets({
        first: 50,
        after: cursor,
        albumId: album ? album.id : null,
        mediaTypes: getMediaTypes(filter),
      });

      if (reset) {
        setAssets(result.assets);
      } else {
        setAssets((prev) => [...prev, ...result.assets]);
      }

      setEndCursor(result.endCursor);
      setHasNextPage(result.hasNextPage);
    } catch (error) {
      console.error('Error al cargar multimedia:', error);
    }
  };

  // Cargar lista de álbumes
  const loadAlbums = async () => {
    try {
      const albumList = await mediaService.getAlbums();
      setAlbums(albumList);
    } catch (error) {
      console.error('Error al cargar álbumes:', error);
    }
  };

  // Refrescar contenido actual
  const handleRefresh = async () => {
    setIsRefreshing(true);
    if (activeTab === 'folder') {
      if (folderUri) await loadFolder(folderUri);
    } else if (activeTab === 'albums' && !selectedAlbum) {
      await loadAlbums();
    } else {
      await loadAssets({ reset: true, album: selectedAlbum, filter: filterType });
    }
    const updatedFavs = await storageService.getFavorites();
    setFavorites(updatedFavs);
    setIsRefreshing(false);
  };

  // Cargar más fotos (scroll infinito)
  const handleLoadMore = async () => {
    if (!hasNextPage || isLoadingMore || activeTab === 'favorites') return;
    setIsLoadingMore(true);
    await loadAssets({ reset: false, album: selectedAlbum, filter: filterType });
    setIsLoadingMore(false);
  };

  // Cambiar filtro de tipo (Todas -> Fotos -> Videos)
  const handleToggleFilter = () => {
    const nextFilter = filterType === 'all' ? 'photos' : filterType === 'photos' ? 'videos' : 'all';
    setFilterType(nextFilter);
    loadAssets({ reset: true, album: selectedAlbum, filter: nextFilter });
  };

  // Seleccionar un álbum
  const handleSelectAlbum = (album) => {
    setSelectedAlbum(album);
    setAssets([]);
    setEndCursor(null);
    setHasNextPage(true);
    loadAssets({ reset: true, album });
  };

  // Volver del álbum a la lista
  const handleBackFromAlbum = () => {
    setSelectedAlbum(null);
    loadAssets({ reset: true, album: null });
  };

  // Alternar favorito
  const handleToggleFavorite = async (asset) => {
    try {
      const updated = await storageService.toggleFavorite(asset);
      setFavorites(updated);
    } catch (e) {
      Alert.alert('Error', 'No se pudo actualizar el estado de favorito.');
    }
  };

  // Compartir foto o video
  const handleShare = async (asset) => {
    if (asset?.uri) {
      await mediaService.shareAsset(asset.uri);
    }
  };

  // Eliminar foto o video
  const handleDelete = async (asset) => {
    try {
      const deleted = asset.fromFolder
        ? await folderService.deleteFile(asset.uri)
        : await mediaService.deleteAsset(asset.id);
      if (deleted) {
        // Remover de la lista activa
        setAssets((prev) => prev.filter((a) => a.id !== asset.id));
        setFolderAssets((prev) => prev.filter((a) => a.id !== asset.id));
        // Remover de favoritos si estaba
        const updatedFavs = await storageService.removeFavorite(asset.id);
        setFavorites(updatedFavs);
        // Cerrar o ajustar visor si era el último
        setViewerVisible(false);
      }
    } catch (error) {
      Alert.alert('No se pudo eliminar', 'Es posible que el archivo esté protegido o no se haya concedido el permiso.');
    }
  };

  // Lista de fotos a mostrar según la pestaña activa
  const displayedAssets = useMemo(() => {
    if (activeTab === 'favorites') {
      const favList = Object.values(favorites);
      // Filtrar según filtro si aplica
      return favList.filter((a) => {
        if (filterType === 'photos') return a.mediaType === 'photo';
        if (filterType === 'videos') return a.mediaType === 'video';
        return true;
      });
    }
    if (activeTab === 'folder') {
      return folderAssets.filter((a) => {
        if (filterType === 'photos') return a.mediaType === 'photo';
        if (filterType === 'videos') return a.mediaType === 'video';
        return true;
      });
    }
    return assets;
  }, [activeTab, favorites, assets, folderAssets, filterType]);

  // Abrir visor a pantalla completa
  const handleOpenViewer = (asset) => {
    const idx = displayedAssets.findIndex((a) => a.id === asset.id);
    setViewerIndex(idx >= 0 ? idx : 0);
    setViewerVisible(true);
  };

  // Título y subtítulo del Header
  const getHeaderProps = () => {
    if (selectedAlbum) {
      return {
        title: selectedAlbum.title,
        subtitle: `${displayedAssets.length} elementos`,
        showBack: true,
        onBack: handleBackFromAlbum,
      };
    }

    if (activeTab === 'favorites') {
      const count = Object.keys(favorites).length;
      return {
        title: 'Favoritos',
        subtitle: `${count} ${count === 1 ? 'elemento guardado' : 'elementos guardados'}`,
        showBack: false,
      };
    }

    if (activeTab === 'folder') {
      return {
        title: folderUri ? folderService.folderName(folderUri) : 'Mi carpeta',
        subtitle: folderUri ? ${displayedAssets.length} fotos y videos : 'Elige una carpeta',
        showBack: false,
      };
    }

    if (activeTab === 'albums') {
      return {
        title: 'Álbumes',
        subtitle: `${albums.length} carpetas`,
        showBack: false,
      };
    }

    return {
      title: 'Mi Galería',
      subtitle: `${displayedAssets.length} fotos y videos`,
      showBack: false,
    };
  };

  // Si aún está revisando permisos en el arranque
  if (hasPermission === null || initialLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  // Si no se han concedido permisos
  if (!hasPermission) {
    return <PermissionScreen onRequestPermission={handleRequestPermission} />;
  }

  const headerProps = getHeaderProps();
  const currentAssetInViewer = displayedAssets[viewerIndex];
  const isCurrentAssetFavorite = Boolean(currentAssetInViewer && favorites[currentAssetInViewer.id]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.rootContainer} edges={['top', 'left', 'right']}>
        <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />

        {/* Encabezado */}
        <Header
          {...headerProps}
          onRefresh={handleRefresh}
          isRefreshing={isRefreshing}
          filterType={filterType}
          onToggleFilter={activeTab !== 'albums' || selectedAlbum ? handleToggleFilter : null}
          onPickFolder={activeTab === 'folder' ? handlePickFolder : null}
        />

        {/* Contenido Principal */}
        <View style={styles.content}>
          {activeTab === 'albums' && !selectedAlbum ? (
            <AlbumList
              albums={albums}
              onSelectAlbum={handleSelectAlbum}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
            />
          ) : activeTab === 'folder' && !folderUri ? (
            <View style={styles.pickFolderBox}>
              <Ionicons name="folder-open-outline" size={72} color={theme.colors.primary} />
              <Text style={styles.pickFolderTitle}>Elige una carpeta</Text>
              <Text style={styles.pickFolderText}>
                Selecciona cualquier carpeta de tu teléfono o tarjeta SD para ver sus fotos y videos.
              </Text>
              <TouchableOpacity style={styles.pickFolderButton} onPress={handlePickFolder} activeOpacity={0.8}>
                <Text style={styles.pickFolderButtonText}>Seleccionar carpeta</Text>
              </TouchableOpacity>
            </View>
          ) : folderLoading && activeTab === 'folder' ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
            </View>
          ) : (
            <PhotoGrid
              assets={displayedAssets}
              favorites={favorites}
              onSelectPhoto={handleOpenViewer}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
              onLoadMore={activeTab === 'folder' ? undefined : handleLoadMore}
              hasMore={activeTab !== 'favorites' && activeTab !== 'folder' && hasNextPage}
              isLoadingMore={isLoadingMore}
              emptyMessage={
                activeTab === 'favorites'
                  ? 'Aún no has agregado fotos a favoritos.\nToca el corazón en cualquier foto para guardarla aquí.'
                  : activeTab === 'folder'
                  ? 'No hay fotos ni videos en esta carpeta.'
                  : selectedAlbum
                  ? 'No hay fotos en este álbum.'
                  : 'No se encontraron fotos en el dispositivo.'
              }
            />
          )}
        </View>

        {/* Barra de pestañas inferior */}
        <TabBar
          activeTab={activeTab}
          onSelectTab={(tab) => {
            setSelectedAlbum(null);
            setActiveTab(tab);
          }}
          favoritesCount={Object.keys(favorites).length}
        />

        {/* Visor de Pantalla Completa */}
        <FullScreenViewer
          visible={viewerVisible}
          assets={displayedAssets}
          initialIndex={viewerIndex}
          onClose={() => setViewerVisible(false)}
          isFavorite={isCurrentAssetFavorite}
          onToggleFavorite={handleToggleFavorite}
          onShare={handleShare}
          onDelete={handleDelete}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  rootContainer: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: theme.colors.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
  },
  pickFolderBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  pickFolderTitle: {
    color: theme.colors.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    marginTop: 16,
  },
  pickFolderText: {
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  pickFolderButton: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
    marginTop: 24,
  },
  pickFolderButtonText: {
    color: '#fff',
    fontWeight: '700',
  },
});
