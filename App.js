import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  StatusBar,
  Alert,
  ActivityIndicator,
  Linking,
  AppState,
} from 'react-native';
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
import FolderBrowser from './src/components/FolderBrowser';
import FullScreenViewer from './src/components/FullScreenViewer';
import PermissionScreen from './src/components/PermissionScreen';
import DuplicatesScreen from './src/components/DuplicatesScreen';
import SettingsModal from './src/components/SettingsModal';
import CameraScreen from './src/components/CameraScreen';

export default function App() {
  const [hasPermission, setHasPermission] = useState(null);
  // Por defecto: 'folder' (Mi carpeta primero)
  const [activeTab, setActiveTab] = useState('folder'); // 'folder' | 'albums' | 'photos' | 'favorites'
  const [filterType, setFilterType] = useState('all'); // 'all' | 'photos' | 'videos'

  // Datos
  const [assets, setAssets] = useState([]);
  const [albums, setAlbums] = useState([]);
  const [favorites, setFavorites] = useState({});
  const [selectedAlbum, setSelectedAlbum] = useState(null);

  // Carpeta elegida por el usuario
  const [folderUri, setFolderUri] = useState(null);
  const [folderAssets, setFolderAssets] = useState([]);

  // Paginación y Carga
  const [endCursor, setEndCursor] = useState(null);
  const [hasNextPage, setHasNextPage] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  // Modales
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [dupVisible, setDupVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [cameraVisible, setCameraVisible] = useState(false);

  // Inicializar permisos y datos de arranque (ultra rápido)
  useEffect(() => {
    (async () => {
      // 1. Cargar favoritos en segundo plano
      storageService.getFavorites().then(setFavorites);

      // 2. Cargar carpeta guardada en segundo plano
      folderService.getSavedFolder().then((saved) => {
        if (saved) setFolderUri(saved);
      });

      // 3. Revisar permisos
      const granted = await mediaService.checkAndRequestPermissions();
      setHasPermission(granted);

      if (granted) {
        // Cargar únicamente el primer bloque de fotos
        await loadAssets({ reset: true });
      } else if (!(await mediaService.canAskAgain())) {
        Linking.openSettings();
      }

      // Quitar pantalla de carga INMEDIATAMENTE (< 1 segundo)
      setInitialLoading(false);
    })();
  }, []);

  // Elegir cualquier carpeta del sistema
  const handlePickFolder = async () => {
    try {
      const uri = await folderService.pickFolder();
      if (uri) {
        setFolderUri(uri);
        setActiveTab('folder');
        setSelectedAlbum(null);
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
      setInitialLoading(false);
    } else if (!(await mediaService.canAskAgain())) {
      Linking.openSettings();
    }
  };

  // Al volver desde los ajustes del sistema, revisar si ya se concedió el permiso
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active' || hasPermission !== false) return;
      const { status } = await MediaLibrary.getPermissionsAsync();
      if (status === 'granted') {
        setHasPermission(true);
        setInitialLoading(true);
        await loadAssets({ reset: true });
        setInitialLoading(false);
      }
    });
    return () => sub.remove();
  }, [hasPermission]);

  // Determinar los media types según el filtro activo
  const getMediaTypes = (filter) => {
    if (filter === 'photos') return [MediaLibrary.MediaType.photo];
    if (filter === 'videos') return [MediaLibrary.MediaType.video];
    return [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video];
  };

  // Cargar fotos/videos de la galería principal
  const loadAssets = async ({ reset = false, album = selectedAlbum, filter = filterType } = {}) => {
    try {
      const cursor = reset ? null : endCursor;
      const result = await mediaService.getAssets({
        first: 36,
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

  // Cargar lista de álbumes bajo demanda
  const loadAlbums = async () => {
    try {
      const albumList = await mediaService.getAlbums();
      setAlbums(albumList);
    } catch (error) {
      console.error('Error al cargar álbumes:', error);
    }
  };

  // Cambio de pestaña con carga perezosa de álbumes
  const handleSelectTab = (tab) => {
    setSelectedAlbum(null);
    setActiveTab(tab);
    if (tab === 'albums' && albums.length === 0) {
      loadAlbums();
    }
  };

  // Refrescar contenido actual
  const handleRefresh = async () => {
    setIsRefreshing(true);
    if (activeTab === 'albums' && !selectedAlbum) {
      await loadAlbums();
    } else if (activeTab !== 'folder') {
      await loadAssets({ reset: true, album: selectedAlbum, filter: filterType });
    }
    const updatedFavs = await storageService.getFavorites();
    setFavorites(updatedFavs);
    setIsRefreshing(false);
  };

  // Cargar más fotos (scroll infinito)
  const handleLoadMore = async () => {
    if (!hasNextPage || isLoadingMore || activeTab === 'favorites' || activeTab === 'folder') return;
    setIsLoadingMore(true);
    await loadAssets({ reset: false, album: selectedAlbum, filter: filterType });
    setIsLoadingMore(false);
  };

  // Cambiar filtro de tipo (Todas -> Fotos -> Videos)
  const handleToggleFilter = () => {
    const nextFilter = filterType === 'all' ? 'photos' : filterType === 'photos' ? 'videos' : 'all';
    setFilterType(nextFilter);
    if (activeTab !== 'folder') {
      loadAssets({ reset: true, album: selectedAlbum, filter: nextFilter });
    }
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
        setAssets((prev) => prev.filter((a) => a.id !== asset.id));
        setFolderAssets((prev) => prev.filter((a) => a.id !== asset.id));
        const updatedFavs = await storageService.removeFavorite(asset.id);
        setFavorites(updatedFavs);
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
      return favList.filter((a) => {
        if (filterType === 'photos') return a.mediaType === 'photo';
        if (filterType === 'videos') return a.mediaType === 'video';
        return true;
      });
    }
    if (activeTab === 'folder') {
      return folderAssets;
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

    if (activeTab === 'folder') {
      return {
        title: folderUri ? folderService.folderName(folderUri) : 'Mi carpeta',
        subtitle: folderUri ? `${folderAssets.length} fotos y videos aquí` : 'Elige una carpeta',
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

    if (activeTab === 'photos') {
      return {
        title: 'Todas las fotos',
        subtitle: `${displayedAssets.length} fotos y videos`,
        showBack: false,
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

    return {
      title: 'Mi Galería',
      subtitle: `${displayedAssets.length} fotos y videos`,
      showBack: false,
    };
  };

  if (hasPermission === null || initialLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (!hasPermission) {
    return (
      <PermissionScreen
        onRequestPermission={handleRequestPermission}
        onOpenSettings={() => Linking.openSettings()}
      />
    );
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
          onRefresh={activeTab !== 'folder' ? handleRefresh : null}
          isRefreshing={isRefreshing}
          filterType={filterType}
          onToggleFilter={activeTab !== 'albums' || selectedAlbum ? handleToggleFilter : null}
          onPickFolder={activeTab === 'folder' ? handlePickFolder : null}
          onFindDuplicates={
            (activeTab === 'photos' || activeTab === 'folder') && !selectedAlbum
              ? () => setDupVisible(true)
              : null
          }
          onOpenCamera={() => setCameraVisible(true)}
          onOpenSettings={() => setSettingsVisible(true)}
        />

        {/* Barra de pestañas en la parte de arriba (debajo del Header) */}
        <TabBar
          activeTab={activeTab}
          onSelectTab={handleSelectTab}
          favoritesCount={Object.keys(favorites).length}
        />

        {/* Contenido Principal */}
        <View style={styles.content}>
          {activeTab === 'folder' ? (
            <FolderBrowser
              rootUri={folderUri}
              onPickNewFolder={handlePickFolder}
              onSelectPhoto={handleOpenViewer}
              favorites={favorites}
              filterType={filterType}
              onAssetsChange={(items) => setFolderAssets(items)}
            />
          ) : activeTab === 'albums' && !selectedAlbum ? (
            <AlbumList
              albums={albums}
              onSelectAlbum={handleSelectAlbum}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
            />
          ) : (
            <PhotoGrid
              assets={displayedAssets}
              favorites={favorites}
              onSelectPhoto={handleOpenViewer}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
              onLoadMore={handleLoadMore}
              hasMore={activeTab !== 'favorites' && hasNextPage}
              isLoadingMore={isLoadingMore}
              emptyMessage={
                activeTab === 'favorites'
                  ? 'Aún no has agregado fotos a favoritos.\nToca el corazón en cualquier foto para guardarla aquí.'
                  : selectedAlbum
                  ? 'No hay fotos en este álbum.'
                  : 'No se encontraron fotos en el dispositivo.'
              }
            />
          )}
        </View>

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
          onMediaSaved={() => handleRefresh()}
        />

        {/* Buscador de fotos duplicadas */}
        <DuplicatesScreen
          visible={dupVisible}
          sourceAssets={activeTab === 'folder' ? folderAssets : null}
          onClose={() => setDupVisible(false)}
          onChanged={() => handleRefresh()}
        />

        {/* Modal de Configuración y Actualizaciones */}
        <SettingsModal
          visible={settingsVisible}
          onClose={() => setSettingsVisible(false)}
        />

        {/* Modal de Cámara y Grabación Discreta */}
        <CameraScreen
          visible={cameraVisible}
          onClose={() => setCameraVisible(false)}
          onVideoSaved={() => handleRefresh()}
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
});
