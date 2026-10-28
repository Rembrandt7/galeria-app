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
const ACTIVE_SEGMENT_KEY = '@galeria_active_segment_v1';
const FOLDER_SEGMENTS_STORAGE_KEY = '@galeria_folder_segments_v2';

import { theme } from './src/constants/theme';
import { mediaService } from './src/services/mediaService';
import { storageService } from './src/services/storageService';
import { folderService } from './src/services/folderService';
import { updateService, CURRENT_VERSION } from './src/services/updateService';

import Header from './src/components/Header';
import SegmentBar from './src/components/SegmentBar';
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
import ModoGuardarModal from './src/components/ModoGuardarModal';

export default function App() {
  const [hasPermission, setHasPermission] = useState(null);
  // Por defecto: 'albums' (Vista principal estilo Samsung Galaxy One UI con carpetas y álbumes)
  const [activeTab, setActiveTab] = useState('albums'); // 'albums' | 'folder' | 'photos' | 'favorites'
  const [filterType, setFilterType] = useState('all'); // 'all' | 'photos' | 'videos'
  // Segmentos: 'photos' (DCIM y Dron) | 'files' (Archivos, Screenshots, WhatsApp, X, Threads) | 'all' (Todo)
  const [activeSegment, setActiveSegment] = useState('photos');
  // Asignaciones manuales exclusivas de carpetas a segmentos: { [uri_or_title]: 'photos' | 'files' }
  const [folderSegments, setFolderSegments] = useState({});

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

  // Modo Guardar y Papelera temporal
  const [trashBin, setTrashBin] = useState({});
  const [modoGuardarVisible, setModoGuardarVisible] = useState(false);
  const [modoGuardarAssets, setModoGuardarAssets] = useState([]);
  const [modoGuardarInitialIndex, setModoGuardarInitialIndex] = useState(0);
  const [modoGuardarInitialView, setModoGuardarInitialView] = useState('swipe');

  // Carpetas ocultas, carpetas de sistema sugeridas y modo todo visible
  const [hiddenFolders, setHiddenFolders] = useState({});
  const [manuallyEnabledSystemFolders, setManuallyEnabledSystemFolders] = useState({});
  const [autoHideSystemFolders, setAutoHideSystemFolders] = useState(true);
  const [showAllFolders, setShowAllFolders] = useState(false);
  const [pinModalVisible, setPinModalVisible] = useState(false);
  const [pinAttempt, setPinAttempt] = useState('');
  const [storedPin, setStoredPin] = useState(null);

  // Portadas personalizadas de carpetas y configuración de columnas (Fold / Sistema)
  const [customCovers, setCustomCovers] = useState({});
  const [gridConfig, setGridConfig] = useState({
    albumColumns: 0,
    photoColumns: 0,
    groupSmallInVarios: true,
    showFoldersInScreen: true,
  });

  // Inicializar permisos y datos de arranque (ultra rápido y ligero)
  useEffect(() => {
    (async () => {
      // 0. Hidratar álbumes, portadas personalizadas y configuración de columnas instantáneamente
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

      storageService.getCustomFolderCovers().then((cc) => {
        if (cc) setCustomCovers(cc);
      });
      storageService.getGridColumnsConfig().then((gc) => {
        if (gc) setGridConfig(gc);
      });

      // 1. Cargar favoritos y papelera temporal del Modo Guardar en segundo plano
      storageService.getFavorites().then(setFavorites);
      storageService.getTrashBin().then((tb) => { if (tb) setTrashBin(tb); });

      // 1b. Cargar carpetas ocultas, carpetas de sistema activadas manualmente y SIEMPRE iniciar con privadas bloqueadas
      storageService.getHiddenFolders().then((hf) => { if (hf) setHiddenFolders(hf); });
      storageService.getManuallyEnabledSystemFolders().then((ms) => {
        if (ms) setManuallyEnabledSystemFolders(ms);
      });
      storageService.getAutoHideSystemFolders().then((ah) => {
        setAutoHideSystemFolders(Boolean(ah));
      });
      setShowAllFolders(false);
      storageService.setShowAllFolders(false);

      // 1c. Cargar segmento activo (Fotos y Dron vs Archivos y Redes)
      AsyncStorage.getItem(ACTIVE_SEGMENT_KEY)
        .then((seg) => {
          if (seg && ['photos', 'files', 'all'].includes(seg)) {
            setActiveSegment(seg);
          }
        })
        .catch(() => {});

      // 1d. Cargar asignaciones exclusivas de carpetas a segmentos
      AsyncStorage.getItem(FOLDER_SEGMENTS_STORAGE_KEY)
        .then((raw) => {
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === 'object') {
                setFolderSegments(parsed);
              }
            } catch (_e) {}
          }
        })
        .catch(() => {});

      // 2. Cargar carpetas guardadas de inmediato sin bloquear el arranque
      folderService.getSavedFolders().then((folders) => {
        if (folders && folders.length > 0) {
          setSavedFolders(folders);
          setFolderUri(folders[0].uri);
        }
      });
      setTimeout(() => {
        folderService.ensureDownloadedVideosFolder().catch(() => {});
      }, 1500);

      // 3. Revisar permisos y quitar pantalla de carga de inmediato
      const granted = await mediaService.checkAndRequestPermissions();
      setHasPermission(granted);
      setInitialLoading(false);

      if (granted) {
        // Cargar primero únicamente los álbumes (pantalla principal) para no saturar la memoria al abrir
        loadAlbums();
      } else if (!(await mediaService.canAskAgain())) {
        Linking.openSettings();
      }

      // Verificar en segundo plano si existe una actualización disponible
      setTimeout(() => {
        updateService
          .checkForUpdates()
          .then((res) => {
            if (res?.hasUpdate) setHasUpdateAvailable(true);
          })
          .catch(() => {});
      }, 1800);
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

  // Resuelve a qué sección pertenece exclusivamente una carpeta ('photos' | 'files')
  const getResolvedFolderSegment = useCallback(
    (item) => {
      if (!item) return 'photos';
      if (item.isFavoritesCard) return 'photos';
      if (item.isVariosCard) return 'all';

      const keyUri = item.uri ? String(item.uri).trim() : '';
      const keyTitle = item.title ? String(item.title).trim() : '';
      const keyName = item.name ? String(item.name).trim() : '';
      const keyId = item.id ? String(item.id).trim() : '';

      // La asignación manual del usuario tiene máxima prioridad
      if (keyUri && folderSegments[keyUri]) return folderSegments[keyUri];
      if (keyTitle && folderSegments[keyTitle]) return folderSegments[keyTitle];
      if (keyName && folderSegments[keyName]) return folderSegments[keyName];
      if (keyId && folderSegments[keyId]) return folderSegments[keyId];

      // Si no fue asignada manualmente, usar la clasificación inteligente
      return folderService.classifyMediaSegment(item);
    },
    [folderSegments]
  );

  // Asignar o mover una carpeta exclusivamente a una sección
  const handleSetFolderSegment = useCallback(
    async (folderItemOrUri, targetSegment, folderTitle = '') => {
      const seg = targetSegment === 'files' ? 'files' : 'photos';
      const uri = typeof folderItemOrUri === 'string' ? folderItemOrUri : folderItemOrUri?.uri || '';
      const title =
        folderTitle ||
        (typeof folderItemOrUri === 'object' ? folderItemOrUri?.title || folderItemOrUri?.name : '') ||
        (uri ? folderService.folderName(uri) : '');

      setFolderSegments((prev) => {
        const next = { ...prev };
        if (uri) next[uri] = seg;
        if (title) next[title] = seg;
        AsyncStorage.setItem(FOLDER_SEGMENTS_STORAGE_KEY, JSON.stringify(next)).catch(() => {});
        return next;
      });

      if (uri) {
        await folderService.addSavedFolder(uri, title);
        const updated = await folderService.getSavedFolders();
        setSavedFolders(updated);
      }

      await loadAlbums(true);
    },
    []
  );

  // Abrir cualquier carpeta directamente en el Explorador
  const handleOpenInExplorer = useCallback((folderItem) => {
    const uri =
      (typeof folderItem === 'string' ? folderItem : folderItem?.uri) ||
      (folderItem?.id && String(folderItem.id).startsWith('file://') ? folderItem.id : null);
    if (uri) {
      setFolderUri(uri);
    } else if (folderItem?.title) {
      setFolderUri(`file:///storage/emulated/0/DCIM/${folderItem.title}`);
    } else {
      setFolderUri('file:///storage/emulated/0');
    }
    setSelectedAlbum(null);
    setActiveTab('folder');
  }, []);

  // Elegir o agregar una nueva carpeta del sistema exclusivamente a la sección activa
  const handlePickFolder = async (targetSegment = activeSegment) => {
    try {
      const res = await folderService.pickFolder();
      if (res && res.uri) {
        const seg = targetSegment === 'files' ? 'files' : 'photos';
        await handleSetFolderSegment(res.uri, seg, res.name);
        setFolderUri(res.uri);
        Alert.alert(
          '¡Carpeta agregada!',
          `"${res.name}" se guardó exclusivamente en ${
            seg === 'photos' ? 'Fotos y Dron' : 'Archivos y Redes'
          } y no aparecerá en la otra sección.`
        );
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
      await loadAlbums(true);
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
  const loadAlbums = async (forceRefresh = false) => {
    try {
      const albumList = await mediaService.getAlbums({ forceRefresh });
      setAlbums(albumList);
      if (Array.isArray(albumList) && albumList.length > 0) {
        AsyncStorage.setItem(ALBUMS_FAST_CACHE_KEY, JSON.stringify(albumList)).catch(() => {});
      }
    } catch (error) {
      console.error('Error al cargar álbumes:', error);
    }
  };

  // Cambio de pestaña con carga de álbumes, fotos o explorador
  const handleSelectTab = (tab) => {
    setSelectedAlbum(null);
    if (tab === 'folder') {
      if (!folderUri) {
        setFolderUri('file:///storage/emulated/0');
      }
      setActiveTab('folder');
      return;
    }
    setActiveTab(tab);
    if (tab === 'albums') {
      loadAlbums(false);
    } else if (tab === 'photos' && assets.length === 0) {
      loadAssets({ reset: true, album: null, filter: filterType });
    }
  };

  // Refrescar contenido actual (limpiando cachés en RAM para reflejar cambios reales)
  const handleRefresh = async () => {
    setIsRefreshing(true);
    folderService.invalidateCache();
    if (activeTab === 'albums' && !selectedAlbum) {
      await loadAlbums(true);
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
  };

  // Cambiar configuración de columnas y vista desde el botón de Sistema (arriba al lado de Actualizar)
  const handleChangeGridConfig = useCallback(async (partial = {}) => {
    setGridConfig((prev) => {
      const next = { ...prev, ...partial };
      storageService.setGridColumnsConfig(next).catch(() => {});
      return next;
    });
  }, []);

  // Alternar auto-desactivación de carpetas de sistema sugeridas
  const handleToggleAutoHideSystem = useCallback(async () => {
    const nextVal = !autoHideSystemFolders;
    setAutoHideSystemFolders(nextVal);
    await storageService.setAutoHideSystemFolders(nextVal);
  }, [autoHideSystemFolders]);

  // Definir cualquier foto dentro de una carpeta o álbum como su Foto Principal (Portada)
  const handleSetFolderCover = useCallback(
    async (asset, customTargetFolder = null) => {
      if (!asset?.uri) return;
      try {
        const keys = [];
        if (customTargetFolder?.uri) keys.push(customTargetFolder.uri);
        if (customTargetFolder?.name) keys.push(customTargetFolder.name);
        if (selectedAlbum?.id) keys.push(selectedAlbum.id);
        if (selectedAlbum?.uri) keys.push(selectedAlbum.uri);
        if (selectedAlbum?.title) keys.push(selectedAlbum.title);
        if (activeTab === 'folder' && folderUri) {
          keys.push(folderUri);
          keys.push(`folder_${folderUri}`);
          keys.push(folderService.folderName(folderUri));
        }
        // También inferir la carpeta física directa desde la ruta del archivo
        if (asset.uri.startsWith('file://')) {
          const lastSlash = asset.uri.lastIndexOf('/');
          if (lastSlash > 7) {
            const parentDir = asset.uri.slice(0, lastSlash);
            keys.push(parentDir);
            keys.push(`folder_${parentDir}`);
            keys.push(folderService.folderName(parentDir));
          }
        }
        if (asset.sourceFolderTitle) {
          keys.push(asset.sourceFolderTitle);
        }

        const updatedCovers = await storageService.setCustomFolderCover(keys, asset.uri);
        setCustomCovers(updatedCovers);

        const targetLabel =
          customTargetFolder?.name ||
          selectedAlbum?.title ||
          (folderUri ? folderService.folderName(folderUri) : 'esta carpeta');

        Alert.alert(
          '✨ Portada definida',
          `Esta fotografía ahora aparecerá como la imagen principal de "${targetLabel}".`
        );
      } catch (e) {
        Alert.alert('Aviso', 'No se pudo guardar la portada personalizada.');
      }
    },
    [selectedAlbum, activeTab, folderUri]
  );

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

  // Lista de fotos a mostrar según la pestaña activa (excluyendo las que están en la Papelera temporal)
  const displayedAssets = useMemo(() => {
    let baseList = assets;
    if (activeTab === 'favorites') {
      const favList = Object.values(favorites);
      baseList = favList.filter((a) => {
        if (filterType === 'photos') return a.mediaType === 'photo';
        if (filterType === 'videos') return a.mediaType === 'video';
        return true;
      });
    } else if (activeTab === 'folder') {
      baseList = folderAssets;
    } else if (activeTab === 'photos' && !selectedAlbum) {
      baseList = (assets || []).filter((a) => {
        if (filterType === 'photos' && a.mediaType !== 'photo') return false;
        if (filterType === 'videos' && a.mediaType !== 'video') return false;
        if (activeSegment !== 'all') {
          const seg = folderService.classifyMediaSegment(a);
          return seg === activeSegment;
        }
        return true;
      });
    }
    return (baseList || []).filter((a) => a && !trashBin[a.id]);
  }, [activeTab, favorites, assets, folderAssets, filterType, trashBin, activeSegment, selectedAlbum]);

  const handleSelectSegment = useCallback((seg) => {
    setActiveSegment(seg);
    AsyncStorage.setItem(ACTIVE_SEGMENT_KEY, seg).catch(() => {});
  }, []);

  // Abrir Modo Guardar (organizador por deslizamiento + papelera con restauración en 1 clic)
  const handleOpenModoGuardar = useCallback(
    async (customList, startIndex = 0, startView = 'swipe') => {
      let list =
        Array.isArray(customList) && customList.length > 0
          ? customList
          : displayedAssets && displayedAssets.length > 0
          ? displayedAssets
          : folderAssets && folderAssets.length > 0
          ? folderAssets
          : assets;

      // Si el usuario pulsa "Modo Guardar" desde la pantalla de Álbumes antes de que la lista general esté cargada,
      // cargamos de inmediato el lote principal de fotos para que nunca abra vacío
      if (!list || list.length === 0) {
        try {
          const res = await mediaService.getAssets({ first: 120 });
          if (res?.assets && res.assets.length > 0) {
            setAssets(res.assets);
            list = res.assets.filter((a) => a && !trashBin[a.id]);
          }
        } catch (_e) {}
      }

      setModoGuardarAssets(list || []);
      setModoGuardarInitialIndex(Math.max(0, startIndex));
      setModoGuardarInitialView(startView || 'swipe');
      setModoGuardarVisible(true);
    },
    [displayedAssets, folderAssets, assets, trashBin]
  );

  // Enviar foto a la Papelera temporal del Modo Guardar (sin borrarla aún del dispositivo)
  const handleAddToTrash = useCallback(async (asset) => {
    try {
      const updated = await storageService.addToTrashBin(asset);
      setTrashBin(updated);
    } catch (e) {
      console.error('Error al enviar a papelera:', e);
    }
  }, []);

  // Restaurar foto de la Papelera con 1 clic
  const handleRestoreFromTrash = useCallback(async (assetId) => {
    try {
      const updated = await storageService.restoreFromTrashBin(assetId);
      setTrashBin(updated);
    } catch (e) {
      console.error('Error al restaurar de papelera:', e);
    }
  }, []);

  // Vaciar Papelera definitivamente (elimina los archivos del teléfono y libera el espacio real)
  const handleEmptyTrash = useCallback(async (itemsToDelete = []) => {
    const list =
      Array.isArray(itemsToDelete) && itemsToDelete.length > 0
        ? itemsToDelete
        : Object.values(trashBin);
    if (list.length === 0) return { deletedCount: 0 };

    const folderItems = list.filter((it) => it.fromFolder && it.uri);
    const mediaItems = list.filter((it) => !it.fromFolder && it.id);
    const deletedIds = new Set();

    for (const item of folderItems) {
      const ok = await folderService.deleteFile(item.uri);
      if (ok) deletedIds.add(item.id);
    }

    if (mediaItems.length > 0) {
      const ids = mediaItems.map((it) => it.id);
      const ok = await mediaService.deleteAssets(ids);
      if (ok) {
        ids.forEach((id) => deletedIds.add(id));
      }
    }

    if (deletedIds.size > 0) {
      setAssets((prev) => prev.filter((a) => !deletedIds.has(a.id)));
      setFolderAssets((prev) => prev.filter((a) => !deletedIds.has(a.id)));
      for (const id of deletedIds) {
        if (favorites[id]) {
          await storageService.removeFavorite(id);
        }
      }
      const updatedFavs = await storageService.getFavorites();
      setFavorites(updatedFavs);
      const updatedTrash = await storageService.clearTrashBin(Array.from(deletedIds));
      setTrashBin(updatedTrash);
    }

    return { deletedCount: deletedIds.size };
  }, [trashBin, favorites]);

  // Ocultar o prender cualquier carpeta normal
  const handleToggleHideFolder = async (folderKey, folderName, silent = false) => {
    try {
      const updated = await storageService.toggleHideFolder(folderKey, folderName);
      setHiddenFolders(updated);
      if (!silent) {
        const isNowHidden = Boolean(updated[folderKey]);
        Alert.alert(
          isNowHidden ? 'Carpeta oculta' : 'Carpeta visible',
          isNowHidden
            ? `La carpeta "${folderName || folderKey}" ahora está oculta. Puedes activarla en "Administrar carpetas".`
            : `La carpeta "${folderName || folderKey}" vuelve a estar visible normalmente.`
        );
      }
    } catch (e) {
      console.error('Error al ocultar carpeta:', e);
    }
  };

  // Activar o desactivar manualmente una carpeta sugerida como de sistema
  const handleToggleSystemFolderManual = useCallback(
    async (folderKey, enableNow, _folderName, itemObj) => {
      try {
        const updated = await storageService.setManuallyEnabledSystemFolder(folderKey, enableNow);
        if (itemObj) {
          if (itemObj.id) await storageService.setManuallyEnabledSystemFolder(itemObj.id, enableNow);
          if (itemObj.title) await storageService.setManuallyEnabledSystemFolder(itemObj.title, enableNow);
          if (itemObj.uri) await storageService.setManuallyEnabledSystemFolder(itemObj.uri, enableNow);
        }
        const finalMap = await storageService.getManuallyEnabledSystemFolders();
        setManuallyEnabledSystemFolders(finalMap || updated);
        // Si el usuario la activa manualmente y estaba en hiddenFolders, quitarla de hiddenFolders
        if (enableNow && hiddenFolders[folderKey]) {
          const nextHidden = await storageService.toggleHideFolder(folderKey);
          setHiddenFolders(nextHidden);
        }
      } catch (e) {
        console.error('Error al alternar carpeta de sistema:', e);
      }
    },
    [hiddenFolders]
  );

  // Activar o desactivar en bloque todas las carpetas sugeridas de sistema
  const handleSetAllSystemFoldersManual = useCallback(async (enableAll, systemList = []) => {
    try {
      if (!enableAll) {
        const cleared = await storageService.setAllManuallyEnabledSystemFolders({});
        setManuallyEnabledSystemFolders(cleared);
        return;
      }
      const nextMap = {};
      for (const item of systemList) {
        if (item?.uri) nextMap[item.uri] = true;
        if (item?.id) nextMap[item.id] = true;
        if (item?.title) nextMap[item.title] = true;
      }
      const saved = await storageService.setAllManuallyEnabledSystemFolders(nextMap);
      setManuallyEnabledSystemFolders(saved);
    } catch (e) {
      console.error('Error al cambiar todas las carpetas de sistema:', e);
    }
  }, []);

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
      if (modoGuardarVisible) {
        setModoGuardarVisible(false);
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
    modoGuardarVisible,
    selectedAlbum,
    filterType,
    activeTab,
  ]);

  // Estadísticas memorizadas de carpetas activas, de sistema y por segmento (Fotos/Dron vs Archivos/Redes)
  const { activeAlbumsCount, systemAlbumsCount, photosAlbumsCount, filesAlbumsCount, totalActiveAlbumsCount } = useMemo(() => {
    let active = 0;
    let sysCount = 0;
    let pCount = 0;
    let fCount = 0;
    for (const item of albums) {
      const sysInfo = folderService.classifySystemFolder(item);
      if (sysInfo.isSystemSuggested) sysCount++;
      if (
        hiddenFolders[item.title] ||
        hiddenFolders[item.id] ||
        (item.uri && hiddenFolders[item.uri])
      ) {
        continue;
      }
      const manualOn = Boolean(
        manuallyEnabledSystemFolders[item.uri] ||
          manuallyEnabledSystemFolders[item.id] ||
          manuallyEnabledSystemFolders[item.title]
      );
      if (sysInfo.isSystemSuggested && autoHideSystemFolders && !manualOn) {
        continue;
      }
      active++;
      const seg = getResolvedFolderSegment(item);
      if (seg === 'photos') pCount++;
      else if (seg === 'files') fCount++;
    }
    return {
      activeAlbumsCount: active,
      systemAlbumsCount: sysCount,
      photosAlbumsCount: pCount,
      filesAlbumsCount: fCount,
      totalActiveAlbumsCount: active,
    };
  }, [albums, hiddenFolders, manuallyEnabledSystemFolders, autoHideSystemFolders, folderSegments, getResolvedFolderSegment]);

  // Conteo de fotos por segmento
  const { photosAssetsCount, filesAssetsCount } = useMemo(() => {
    let p = 0;
    let f = 0;
    for (const a of assets || []) {
      if (!a || trashBin[a.id]) continue;
      const seg = folderService.classifyMediaSegment(a);
      if (seg === 'photos') p++;
      else if (seg === 'files') f++;
    }
    return { photosAssetsCount: p, filesAssetsCount: f };
  }, [assets, trashBin]);

  const currentFolderCoverUri = useMemo(() => {
    if (selectedAlbum) {
      return storageService.resolveCustomCover(customCovers, selectedAlbum);
    }
    if (activeTab === 'folder' && folderUri) {
      return storageService.resolveCustomCover(customCovers, {
        uri: folderUri,
        title: folderService.folderName(folderUri),
      });
    }
    return null;
  }, [customCovers, selectedAlbum, activeTab, folderUri]);

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
      const segName =
        activeSegment === 'photos'
          ? 'Fotos y Dron'
          : activeSegment === 'files'
          ? 'Archivos y Redes'
          : 'Álbumes esenciales';
      const segCount =
        activeSegment === 'photos'
          ? photosAlbumsCount
          : activeSegment === 'files'
          ? filesAlbumsCount
          : activeAlbumsCount;
      return {
        title: segName,
        subtitle: `${segCount} carpetas activas de ${albums.length}`,
        showBack: false,
      };
    }

    if (activeTab === 'photos') {
      const segName =
        activeSegment === 'photos'
          ? 'Fotos y Dron'
          : activeSegment === 'files'
          ? 'Archivos y Redes'
          : 'Todas las Fotos';
      return {
        title: segName,
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

        {/* Encabezado Superior con botón desplegable de Configuración / Sistema al lado de Actualizar */}
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
          onOpenVisibilityManager={() => {
            if (activeTab !== 'albums' || selectedAlbum) {
              setSelectedAlbum(null);
              setActiveTab('albums');
            }
            setVisibilityModalVisible(true);
          }}
          onOpenSettings={() => setSettingsVisible(true)}
          gridConfig={gridConfig}
          onChangeGridConfig={handleChangeGridConfig}
          autoHideSystemFolders={autoHideSystemFolders}
          onToggleAutoHideSystem={handleToggleAutoHideSystem}
          activeAlbumsCount={activeAlbumsCount}
          totalAlbumsCount={albums.length}
          systemAlbumsCount={systemAlbumsCount}
        />

        {/* Contenido Principal */}
        <View style={styles.content}>
          {/* Barra de Segmentos estilo Samsung Galaxy One UI: Fotos y Dron vs Archivos y Redes vs Todo */}
          {!selectedAlbum && (activeTab === 'albums' || activeTab === 'photos') && (
            <SegmentBar
              activeSegment={activeSegment}
              onSelectSegment={handleSelectSegment}
              photosCount={activeTab === 'albums' ? photosAlbumsCount : photosAssetsCount}
              filesCount={activeTab === 'albums' ? filesAlbumsCount : filesAssetsCount}
              allCount={
                activeTab === 'albums'
                  ? totalActiveAlbumsCount
                  : (assets ? assets.length : 0)
              }
              labelMode={activeTab === 'albums' ? 'albums' : 'assets'}
            />
          )}

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
              customCovers={customCovers}
              gridConfig={gridConfig}
              onSetFolderCover={handleSetFolderCover}
              filterType={filterType}
              onAssetsChange={(items) => setFolderAssets(items)}
              hiddenFolders={hiddenFolders}
              onToggleHideFolder={handleToggleHideFolder}
              manuallyEnabledSystemFolders={manuallyEnabledSystemFolders}
              autoHideSystemFolders={autoHideSystemFolders}
              onToggleSystemFolderManual={handleToggleSystemFolderManual}
              showAllFolders={showAllFolders}
              onToggleShowAllFolders={handleToggleShowAllFolders}
              onExitFolder={handleBackFromAlbum}
              onOpenModoGuardar={handleOpenModoGuardar}
              trashCount={Object.keys(trashBin).length}
              trashBin={trashBin}
              onAssignFolderToSegment={handleSetFolderSegment}
            />
          ) : activeTab === 'albums' && !selectedAlbum ? (
            <AlbumList
              albums={albums}
              favorites={favorites}
              customCovers={customCovers}
              activeSegment={activeSegment}
              folderSegments={folderSegments}
              getResolvedFolderSegment={getResolvedFolderSegment}
              onMoveFolderSegment={handleSetFolderSegment}
              onOpenInExplorer={handleOpenInExplorer}
              onAddNewFolderToSegment={handlePickFolder}
              gridConfig={gridConfig}
              onChangeGridConfig={handleChangeGridConfig}
              onSelectAlbum={handleSelectAlbum}
              onSelectFavorites={() => setActiveTab('favorites')}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
              hiddenFolders={hiddenFolders}
              onToggleHideFolder={handleToggleHideFolder}
              manuallyEnabledSystemFolders={manuallyEnabledSystemFolders}
              autoHideSystemFolders={autoHideSystemFolders}
              onToggleSystemFolderManual={handleToggleSystemFolderManual}
              onToggleAutoHideSystem={handleToggleAutoHideSystem}
              onSetAllSystemFoldersManual={handleSetAllSystemFoldersManual}
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
              defaultColumns={gridConfig?.photoColumns || 0}
              onSetFolderCover={selectedAlbum ? handleSetFolderCover : null}
              currentFolderCoverUri={currentFolderCoverUri}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
              onLoadMore={handleLoadMore}
              hasMore={activeTab !== 'favorites' && hasNextPage}
              isLoadingMore={isLoadingMore}
              onOpenModoGuardar={handleOpenModoGuardar}
              trashCount={Object.keys(trashBin).length}
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
            onOpenModoGuardar={() => handleOpenModoGuardar(displayedAssets, 0, 'swipe')}
            trashCount={Object.keys(trashBin).length}
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
              onSetFolderCover={
                selectedAlbum || activeTab === 'folder' ? handleSetFolderCover : null
              }
              currentFolderCoverUri={currentFolderCoverUri}
              onShare={handleShare}
              onDelete={handleDelete}
              onMediaSaved={() => handleRefresh()}
              onOpenModoGuardar={(list, idx) => {
                setViewerVisible(false);
                handleOpenModoGuardar(list, idx, 'swipe');
              }}
            />
          </ErrorBoundary>
        )}

        {/* Modo Guardar: Organizador Rápido por Deslizamiento (⬆️ Favorito, ⬇️ Papelera) + Papelera con Restauración en 1 Clic */}
        <ModoGuardarModal
          visible={modoGuardarVisible}
          assets={modoGuardarAssets.length > 0 ? modoGuardarAssets : displayedAssets}
          initialIndex={modoGuardarInitialIndex}
          initialView={modoGuardarInitialView}
          favorites={favorites}
          trashBin={trashBin}
          onClose={() => setModoGuardarVisible(false)}
          onToggleFavorite={handleToggleFavorite}
          onAddToTrash={handleAddToTrash}
          onRestoreFromTrash={handleRestoreFromTrash}
          onEmptyTrash={handleEmptyTrash}
          onChanged={() => handleRefresh()}
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
