import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  StatusBar,
  Alert,
  ActivityIndicator,
  Linking,
  AppState,
  Modal,
  TextInput,
  TouchableOpacity,
  BackHandler,
  NativeModules,
  DeviceEventEmitter,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

const ALBUMS_FAST_CACHE_KEY = '@galeria_albums_fast_cache_v1';

import { theme } from './src/constants/theme';
import { mediaService } from './src/services/mediaService';
import { storageService } from './src/services/storageService';
import { folderService } from './src/services/folderService';
import { updateService, CURRENT_VERSION } from './src/services/updateService';

import Header from './src/components/Header';
import TabBar from './src/components/TabBar';
import PhotoGrid from './src/components/PhotoGrid';
import AlbumList from './src/components/AlbumList';
import FolderBrowser from './src/components/FolderBrowser';
import FullScreenViewer from './src/components/FullScreenViewer';
import ErrorBoundary from './src/components/ErrorBoundary';
import PermissionScreen from './src/components/PermissionScreen';
import DuplicatesScreen from './src/components/DuplicatesScreen';
import SettingsModal from './src/components/SettingsModal';
import CameraScreen from './src/components/CameraScreen';
import VideoDownloaderModal from './src/components/VideoDownloaderModal';
import TiendaRembModal from './src/components/TiendaRembModal';

export default function App() {
  const [hasPermission, setHasPermission] = useState(null);
  // Por defecto: 'albums' (Vista principal estilo Samsung Galaxy One UI con carpetas y álbumes)
  const [activeTab, setActiveTab] = useState('albums'); // 'albums' | 'folder' | 'photos' | 'favorites'
  const [filterType, setFilterType] = useState('all'); // 'all' | 'photos' | 'videos'

  // Datos
  const [assets, setAssets] = useState([]);
  const [albums, setAlbums] = useState([]);
  const [favorites, setFavorites] = useState({});
  const [selectedAlbum, setSelectedAlbum] = useState(null);

  // Carpetas elegidas por el usuario (múltiples carpetas)
  const [savedFolders, setSavedFolders] = useState([]);
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
  const [viewerCustomAssets, setViewerCustomAssets] = useState(null);
  const [dupVisible, setDupVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [cameraVisible, setCameraVisible] = useState(false);
  const [downloaderVisible, setDownloaderVisible] = useState(false);
  const [sharedIncomingUrl, setSharedIncomingUrl] = useState(null);
  const [storeVisible, setStoreVisible] = useState(false);
  const [albumSearchVisible, setAlbumSearchVisible] = useState(false);
  const [visibilityModalVisible, setVisibilityModalVisible] = useState(false);
  const [hasUpdateAvailable, setHasUpdateAvailable] = useState(false);

  // Carpetas ocultas y modo todo visible
  const [hiddenFolders, setHiddenFolders] = useState({});
  const [showAllFolders, setShowAllFolders] = useState(false);
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinAttempt, setPinAttempt] = useState('');
  const [storedPin, setStoredPin] = useState(null);

  // Inicializar permisos y datos de arranque (ultra rápido)
  useEffect(() => {
    (async () => {
      // 0. Hidratar álbumes desde caché local instantáneamente (< 0.1s) para que la pantalla aparezca al instante
      AsyncStorage.getItem(ALBUMS_FAST_CACHE_KEY)
        .then((raw) => {
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setAlbums((prev) => (prev.length === 0 ? parsed : prev));
            }
          }
        })
        .catch(() => {});

      // 1. Cargar favoritos en segundo plano
      storageService.getFavorites().then(setFavorites);

      // 1b. Cargar carpetas ocultas y SIEMPRE iniciar con carpetas ocultas bloqueadas (showAllFolders = false)
      storageService.getHiddenFolders().then((hf) => { if (hf) setHiddenFolders(hf); });
      setShowAllFolders(false);
      storageService.setShowAllFolders(false);

      // 2. Asegurar carpeta propia "Videos Descargados" y cargar carpetas guardadas
      folderService
        .ensureDownloadedVideosFolder()
        .catch(() => {})
        .finally(() => {
          folderService.getSavedFolders().then((folders) => {
            if (folders && folders.length > 0) {
              setSavedFolders(folders);
              setFolderUri(folders[0].uri);
            }
          });
        });

      // 3. Revisar permisos y quitar pantalla de carga de inmediato
      const granted = await mediaService.checkAndRequestPermissions();
      setHasPermission(granted);
      setInitialLoading(false);

      if (granted) {
        // Actualizar álbumes y el primer bloque de fotos en paralelo sin bloquear la apertura
        loadAlbums();
        loadAssets({ reset: true });
      } else if (!(await mediaService.canAskAgain())) {
        Linking.openSettings();
      }

      // Verificar en segundo plano si existe una actualización disponible para encender el indicador
      updateService
        .checkForUpdates()
        .then((res) => {
          if (res?.hasUpdate) setHasUpdateAvailable(true);
        })
        .catch(() => {});
    })();
  }, []);

  // Detectar enlaces compartidos hacia "Mi Galería" desde cualquier app (Facebook, Instagram, TikTok, X, YouTube, Navegador, WhatsApp, etc.)
  useEffect(() => {
    const checkSharedIntent = async () => {
      try {
        if (NativeModules?.VideoEngineModule?.getSharedTextNative) {
          const sharedText = await NativeModules.VideoEngineModule.getSharedTextNative(true);
          if (sharedText && typeof sharedText === 'string' && sharedText.trim().length > 0) {
            setSharedIncomingUrl(sharedText.trim());
            setDownloaderVisible(true);
          }
        }
      } catch (_e) {}
    };

    checkSharedIntent();

    const subEvent = DeviceEventEmitter.addListener('SharedVideoLinkReceived', (evt) => {
      const txt = evt?.text;
      if (txt && typeof txt === 'string' && txt.trim().length > 0) {
        if (NativeModules?.VideoEngineModule?.getSharedTextNative) {
          NativeModules.VideoEngineModule.getSharedTextNative(true).catch(() => {});
        }
        setSharedIncomingUrl(txt.trim());
        setDownloaderVisible(true);
      }
    });

    const subAppState = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        checkSharedIntent();
      }
    });

    return () => {
      subEvent.remove();
      subAppState.remove();
    };
  }, []);

  // Elegir o agregar una nueva carpeta del sistema
  const handlePickFolder = async () => {
    try {
      const res = await folderService.pickFolder();
      if (res && res.uri) {
        const updated = await folderService.getSavedFolders();
        setSavedFolders(updated);
        await loadAlbums();
        setFolderUri(res.uri);
        setActiveTab('folder');
        setSelectedAlbum(null);
      }
    } catch (e) {
      Alert.alert('Error', 'No se pudo seleccionar la carpeta.');
    }
  };

  // Agregar múltiples carpetas sugeridas desde el escáner inteligente
  const handleAddMultipleFolders = async (chosenFolders = []) => {
    try {
      const updated = await folderService.addMultipleSavedFolders(chosenFolders);
      setSavedFolders(updated);
      await loadAlbums();
      if (chosenFolders[0]?.uri) {
        setFolderUri(chosenFolders[0].uri);
      } else if (!folderUri && updated.length > 0) {
        setFolderUri(updated[0].uri);
      }
      setActiveTab('albums');
      setSelectedAlbum(null);
      Alert.alert(
        '¡Carpetas agregadas!',
        `Se agregaron ${chosenFolders.length} ${chosenFolders.length === 1 ? 'carpeta' : 'carpetas'} a tu pantalla de Álbumes.`
      );
    } catch (e) {
      Alert.alert('Error', 'No se pudieron agregar las carpetas seleccionadas.');
    }
  };

  // Quitar una carpeta de la lista
  const handleRemoveFolder = (uri) => {
    Alert.alert(
      '¿Quitar carpeta?',
      'Esta carpeta se quitará de tus accesos directos (sus fotos no se borrarán del teléfono).',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Quitar',
          style: 'destructive',
          onPress: async () => {
            const updated = await folderService.removeSavedFolder(uri);
            setSavedFolders(updated);
            if (folderUri === uri) {
              setFolderUri(updated.length > 0 ? updated[0].uri : null);
            }
          },
        },
      ]
    );
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

  // Al minimizar/salir de la app, bloquear automáticamente las carpetas ocultas; al volver revisar permisos
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') {
        setShowAllFolders(false);
        storageService.setShowAllFolders(false);
        return;
      }
      if (hasPermission !== false) return;
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
        first: 72,
        after: cursor,
        albumId: album ? album.id : null,
        albumUri: album ? album.uri || null : null,
        childAlbums: album?.childAlbums || null,
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

  // Cargar lista de álbumes bajo demanda y guardar en caché rápida
  const loadAlbums = async () => {
    try {
      const albumList = await mediaService.getAlbums();
      setAlbums(albumList);
      if (Array.isArray(albumList) && albumList.length > 0) {
        AsyncStorage.setItem(ALBUMS_FAST_CACHE_KEY, JSON.stringify(albumList)).catch(() => {});
      }
    } catch (error) {
      console.error('Error al cargar álbumes:', error);
    }
  };

  // Cambio de pestaña con carga de álbumes o fotos
  const handleSelectTab = (tab) => {
    setSelectedAlbum(null);
    setActiveTab(tab);
    if (tab === 'albums') {
      loadAlbums();
    } else if (tab === 'photos' && assets.length === 0) {
      loadAssets({ reset: true, album: null, filter: filterType });
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

  // Seleccionar un álbum o carpeta desde la cuadrícula estilo Samsung Galaxy:
  // Si es la tarjeta agrupada "Varios", abrimos todas sus fotos juntas en PhotoGrid.
  // Si tiene ruta de carpeta (uri), entramos con FolderBrowser para ver sus subcarpetas y herramientas.
  const handleSelectAlbum = (album) => {
    if (album?.isVariosCard) {
      setSelectedAlbum(album);
      setAssets([]);
      setEndCursor(null);
      setHasNextPage(false);
      loadAssets({ reset: true, album });
      return;
    }
    if (album?.uri) {
      setSelectedAlbum(null);
      setFolderUri(album.uri);
      setActiveTab('folder');
      return;
    }
    setSelectedAlbum(album);
    setAssets([]);
    setEndCursor(null);
    setHasNextPage(true);
    loadAssets({ reset: true, album });
  };

  // Volver del álbum o carpeta a la pantalla principal de Álbumes estilo Samsung Galaxy
  const handleBackFromAlbum = () => {
    setSelectedAlbum(null);
    setActiveTab('albums');
    loadAlbums();
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
      await mediaService.shareAsset(asset);
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

  // Ocultar o prender cualquier carpeta
  const handleToggleHideFolder = async (folderKey, folderName) => {
    try {
      const updated = await storageService.toggleHideFolder(folderKey, folderName);
      setHiddenFolders(updated);
      const isNowHidden = Boolean(updated[folderKey]);
      Alert.alert(
        isNowHidden ? 'Carpeta oculta' : 'Carpeta visible',
        isNowHidden
          ? `La carpeta "${folderName || folderKey}" ahora está oculta. Puedes verla activando "Todo visible".`
          : `La carpeta "${folderName || folderKey}" vuelve a estar visible normalmente.`
      );
    } catch (e) {
      console.error('Error al ocultar carpeta:', e);
    }
  };

  // Alternar modo todo visible (muestra u oculta las carpetas privadas, con PIN opcional)
  const handleToggleShowAllFolders = async () => {
    if (showAllFolders) {
      setShowAllFolders(false);
      await storageService.setShowAllFolders(false);
      return;
    }
    const pin = await storageService.getPin();
    if (pin) {
      setStoredPin(pin);
      setPinAttempt('');
      setPinModalVisible(true);
    } else {
      setShowAllFolders(true);
      await storageService.setShowAllFolders(true);
    }
  };

  const handleConfirmPin = async () => {
    if (pinAttempt.trim() === storedPin) {
      setPinModalVisible(false);
      setPinAttempt('');
      setShowAllFolders(true);
      await storageService.setShowAllFolders(true);
    } else {
      Alert.alert('PIN incorrecto', 'El PIN ingresado no coincide.');
      setPinAttempt('');
    }
  };

  // Abrir visor a pantalla completa a prueba de fallos
  const handleOpenViewer = (asset, optionalList) => {
    const list = optionalList && optionalList.length > 0 ? optionalList : displayedAssets;
    const effectiveList = list && list.length > 0 ? list : [asset];
    const idx = effectiveList.findIndex((a) => a.id === asset.id);
    setViewerCustomAssets(effectiveList);
    setViewerIndex(idx >= 0 ? idx : 0);
    setViewerVisible(true);
  };

  // Botón físico Atrás de Android a nivel global: regresa a Álbumes o a la pestaña inicial antes de salir
  useEffect(() => {
    const onBackPress = () => {
      if (viewerVisible) return false; // FullScreenViewer maneja su propio BackHandler
      if (pinModalVisible) {
        setPinModalVisible(false);
        return true;
      }
      if (settingsVisible) {
        setSettingsVisible(false);
        return true;
      }
      if (dupVisible) {
        setDupVisible(false);
        return true;
      }
      if (cameraVisible) {
        setCameraVisible(false);
        return true;
      }
      if (downloaderVisible) {
        setDownloaderVisible(false);
        return true;
      }
      if (selectedAlbum) {
        handleBackFromAlbum();
        return true;
      }
      if (filterType !== 'all') {
        setFilterType('all');
        loadAssets({ reset: true, album: selectedAlbum, filter: 'all' });
        return true;
      }
      if (activeTab !== 'albums') {
        setActiveTab('albums');
        return true;
      }
      return false; // En la pantalla inicial ('albums' estilo Samsung Galaxy) permite salir de la app
    };

    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, [
    viewerVisible,
    pinModalVisible,
    settingsVisible,
    dupVisible,
    cameraVisible,
    downloaderVisible,
    selectedAlbum,
    filterType,
    activeTab,
  ]);

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
        title: folderUri ? folderService.folderName(folderUri) : 'Carpeta',
        subtitle: `${folderAssets.length} fotos y videos`,
        showBack: true,
        onBack: handleBackFromAlbum,
      };
    }

    if (activeTab === 'albums') {
      return {
        title: 'Álbumes esenciales',
        subtitle: `${albums.length} carpetas`,
        showBack: false,
      };
    }

    if (activeTab === 'photos') {
      return {
        title: 'Imágenes',
        subtitle: `${displayedAssets.length} fotos y videos`,
        showBack: false,
      };
    }

    if (activeTab === 'favorites') {
      const count = Object.keys(favorites).length;
      return {
        title: 'Favoritos',
        subtitle: `${count} ${count === 1 ? 'elemento guardado' : 'elementos guardados'}`,
        showBack: true,
        onBack: () => setActiveTab('albums'),
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
  const hasBothInActiveList =
    filterType !== 'all' ||
    (displayedAssets.some((a) => a.mediaType === 'photo') &&
      displayedAssets.some((a) => a.mediaType === 'video'));

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.rootContainer} edges={['top', 'left', 'right']}>
        <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />

        {/* Encabezado Superior estilo Samsung Galaxy One UI */}
        <Header
          {...headerProps}
          hasUpdateAvailable={hasUpdateAvailable}
          onRefresh={activeTab !== 'folder' ? handleRefresh : null}
          isRefreshing={isRefreshing}
          filterType={filterType}
          onToggleFilter={
            activeTab !== 'folder' &&
            (activeTab !== 'albums' || selectedAlbum) &&
            hasBothInActiveList
              ? handleToggleFilter
              : null
          }
          onPickFolder={handlePickFolder}
          onToggleSearch={
            activeTab === 'albums' && !selectedAlbum
              ? () => setAlbumSearchVisible((prev) => !prev)
              : null
          }
          onOpenVisibilityManager={
            activeTab === 'albums' && !selectedAlbum
              ? () => setVisibilityModalVisible(true)
              : () => setSettingsVisible(true)
          }
          onOpenSettings={() => setSettingsVisible(true)}
        />

        {/* Contenido Principal */}
        <View style={styles.content}>
          {activeTab === 'folder' ? (
            <FolderBrowser
              rootUri={folderUri}
              savedFolders={savedFolders}
              onSelectSavedFolder={async (uri) => {
                const updated = await folderService.getSavedFolders();
                setSavedFolders(updated);
                setFolderUri(uri);
              }}
              onPickNewFolder={handlePickFolder}
              onAddMultipleFolders={handleAddMultipleFolders}
              onRemoveFolder={handleRemoveFolder}
              onSelectPhoto={handleOpenViewer}
              favorites={favorites}
              filterType={filterType}
              onAssetsChange={(items) => setFolderAssets(items)}
              hiddenFolders={hiddenFolders}
              onToggleHideFolder={handleToggleHideFolder}
              showAllFolders={showAllFolders}
              onToggleShowAllFolders={handleToggleShowAllFolders}
              onExitFolder={handleBackFromAlbum}
            />
          ) : activeTab === 'albums' && !selectedAlbum ? (
            <AlbumList
              albums={albums}
              favorites={favorites}
              onSelectAlbum={handleSelectAlbum}
              onSelectFavorites={() => setActiveTab('favorites')}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
              hiddenFolders={hiddenFolders}
              onToggleHideFolder={handleToggleHideFolder}
              showAllFolders={showAllFolders}
              onToggleShowAllFolders={handleToggleShowAllFolders}
              onPickNewFolder={handlePickFolder}
              onAddMultipleFolders={handleAddMultipleFolders}
              savedFolders={savedFolders}
              searchVisible={albumSearchVisible}
              visibilityModalVisible={visibilityModalVisible}
              onCloseVisibilityModal={() => setVisibilityModalVisible(false)}
              onOpenVisibilityModal={() => setVisibilityModalVisible(true)}
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

          {/* Cápsula Flotante Inferior Estilo Samsung Galaxy con todas las opciones y herramientas */}
          <TabBar
            activeTab={activeTab}
            onSelectTab={handleSelectTab}
            favoritesCount={Object.keys(favorites).length}
            onOpenDownloader={() => setDownloaderVisible(true)}
            onOpenStore={() => setStoreVisible(true)}
            onOpenSettings={() => setSettingsVisible(true)}
            onOpenCamera={() => setCameraVisible(true)}
            onFindDuplicates={() => setDupVisible(true)}
            hasUpdateAvailable={hasUpdateAvailable}
            currentVersionLabel={CURRENT_VERSION}
          />
        </View>

        {/* Visor de Pantalla Completa */}
        {viewerVisible && (
          <ErrorBoundary onReset={() => setViewerVisible(false)}>
            <FullScreenViewer
              visible={viewerVisible}
              assets={viewerCustomAssets || displayedAssets}
              initialIndex={viewerIndex}
              onClose={() => {
                setViewerVisible(false);
                setViewerCustomAssets(null);
              }}
              favorites={favorites}
              isFavorite={isCurrentAssetFavorite}
              onToggleFavorite={handleToggleFavorite}
              onShare={handleShare}
              onDelete={handleDelete}
              onMediaSaved={() => handleRefresh()}
            />
          </ErrorBoundary>
        )}

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
          onOpenStore={() => setStoreVisible(true)}
        />

        {/* Tienda Remb: Buscador e Instalador de Apps de tu GitHub */}
        <TiendaRembModal
          visible={storeVisible}
          onClose={() => setStoreVisible(false)}
        />

        {/* Modal de Cámara y Grabación Discreta */}
        <CameraScreen
          visible={cameraVisible}
          onClose={() => setCameraVisible(false)}
          onVideoSaved={() => handleRefresh()}
        />

        {/* Modal para Descargar Videos desde Internet mediante enlace */}
        <VideoDownloaderModal
          visible={downloaderVisible}
          initialSharedUrl={sharedIncomingUrl}
          onClearSharedUrl={() => setSharedIncomingUrl(null)}
          onClose={() => setDownloaderVisible(false)}
          onReopen={() => setDownloaderVisible(true)}
          onVideoDownloaded={async () => {
            const updated = await folderService.getSavedFolders();
            setSavedFolders(updated);
            handleRefresh();
          }}
          onOpenDownloadedFolder={async (targetFolderUri) => {
            const finalUri = await folderService.ensureDownloadedVideosFolder();
            const updated = await folderService.getSavedFolders();
            setSavedFolders(updated);
            setDownloaderVisible(false);
            setSelectedAlbum(null);
            setActiveTab('folder');
            setFolderUri(targetFolderUri || finalUri);
          }}
          onPlayDownloadedAsset={(asset) => {
            if (!asset?.uri) return;
            setDownloaderVisible(false);
            handleOpenViewer(asset, [asset]);
          }}
        />

        {/* Modal de PIN para desbloquear carpetas ocultas */}
        <Modal
          visible={pinModalVisible}
          transparent={true}
          animationType="fade"
          onRequestClose={() => setPinModalVisible(false)}
          statusBarTranslucent
        >
          <View style={styles.pinModalBackdrop}>
            <View style={styles.pinModalCard}>
              <Ionicons name="lock-closed" size={36} color={theme.colors.warning} />
              <Text style={styles.pinModalTitle}>Desbloquear carpetas ocultas</Text>
              <Text style={styles.pinModalSub}>Ingresa tu PIN de 4 dígitos</Text>
              <TextInput
                style={styles.pinModalInput}
                value={pinAttempt}
                onChangeText={(t) => setPinAttempt(t.replace(/[^0-9]/g, '').slice(0, 4))}
                keyboardType="numeric"
                maxLength={4}
                secureTextEntry
                autoFocus
                placeholder="••••"
                placeholderTextColor={theme.colors.textMuted}
              />
              <View style={styles.pinModalActions}>
                <TouchableOpacity
                  style={styles.pinCancelBtn}
                  onPress={() => setPinModalVisible(false)}
                >
                  <Text style={styles.pinCancelText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.pinConfirmBtn}
                  onPress={handleConfirmPin}
                >
                  <Text style={styles.pinConfirmText}>Desbloquear</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
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
  pinModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  pinModalCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 16,
    padding: 22,
    width: '100%',
    maxWidth: 320,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  pinModalTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 10,
  },
  pinModalSub: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 4,
    marginBottom: 14,
  },
  pinModalInput: {
    width: '100%',
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    color: '#ffffff',
    fontSize: 20,
    textAlign: 'center',
    letterSpacing: 10,
    marginBottom: 16,
  },
  pinModalActions: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },
  pinCancelBtn: {
    flex: 1,
    backgroundColor: theme.colors.surfaceHover,
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: 'center',
  },
  pinCancelText: {
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  pinConfirmBtn: {
    flex: 1,
    backgroundColor: theme.colors.warning,
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: 'center',
  },
  pinConfirmText: {
    color: '#ffffff',
    fontWeight: '700',
  },
});
