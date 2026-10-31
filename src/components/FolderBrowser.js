import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
  useWindowDimensions,
  Platform,
  ScrollView,
  Alert,
  Modal,
  TextInput,
  BackHandler,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { theme } from '../constants/theme';
import { folderService, COMMON_SYSTEM_FOLDERS } from '../services/folderService';
import { compressionService } from '../services/compressionService';
import { videoEngineService } from '../services/videoEngineService';
import { cameraOrganizerService } from '../services/cameraOrganizerService';
import { mediaService } from '../services/mediaService';
import { storageService } from '../services/storageService';
import PhotoThumbnail from './PhotoThumbnail';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const NUM_PHOTO_COLUMNS = 4;
const PHOTO_MARGIN = 1;
const PHOTO_SIZE = Math.floor(
  (SCREEN_WIDTH - PHOTO_MARGIN * (NUM_PHOTO_COLUMNS * 2)) / NUM_PHOTO_COLUMNS
);

const FOLDER_GAP = 12;
const NUM_FOLDER_COLUMNS = 2;
const FOLDER_CARD_WIDTH =
  (SCREEN_WIDTH - theme.spacing.lg * 2 - FOLDER_GAP) / NUM_FOLDER_COLUMNS;

const SUBFOLDER_SIDE_PADDING = 10;
const SUBFOLDER_GAP = 8;
const SUBFOLDER_COLS = 3;
const SUBFOLDER_CARD_WIDTH = Math.floor(
  (SCREEN_WIDTH - SUBFOLDER_SIDE_PADDING * 2 - SUBFOLDER_GAP * (SUBFOLDER_COLS - 1)) / SUBFOLDER_COLS
);
const SUBFOLDER_CARD_HEIGHT = Math.round(SUBFOLDER_CARD_WIDTH * 1.22);

const BATCH_SIZE = 48; // Tamaño de carga parcial progresiva optimizado para apertura inmediata

export default function FolderBrowser({
  rootUri,
  savedFolders = [],
  onSelectSavedFolder,
  onPickNewFolder,
  onAddMultipleFolders,
  onRemoveFolder,
  onSelectPhoto,
  favorites = {},
  customCovers = {},
  gridConfig = {
    albumColumns: 0,
    photoColumns: 0,
  },
  onSetFolderCover,
  filterType = 'all',
  onAssetsChange,
  hiddenFolders = {},
  onToggleHideFolder,
  manuallyEnabledSystemFolders = {},
  autoHideSystemFolders = true,
  onToggleSystemFolderManual,
  showAllFolders = false,
  onToggleShowAllFolders,
  onExitFolder,
  onOpenModoGuardar,
  trashCount = 0,
  trashBin = {},
  onAssignFolderToSegment,
  refreshTrigger = 0,
}) {
  const { width: screenWidth } = useWindowDimensions();
  const isFoldExpanded = screenWidth >= 580;
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
  // Modal de carpetas del sistema y permisos especiales
  const [showSystemModal, setShowSystemModal] = useState(false);

  // Filtro múltiple de Fotos y Videos (por defecto Fotos activo; si solo hay videos, muestra videos automáticamente)
  const [showPhotosFilter, setShowPhotosFilter] = useState(true);
  const [showVideosFilter, setShowVideosFilter] = useState(false);
  const [folderCategory, setFolderCategory] = useState('photos');
  // Compresión de carpeta completa (con soporte en segundo plano no bloqueante)
  const [isCompressingFolder, setIsCompressingFolder] = useState(false);
  const [compressProgress, setCompressProgress] = useState(null);
  const [isBackgroundMinimized, setIsBackgroundMinimized] = useState(true);
  // Escáner inteligente de carpetas sugeridas
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [isScanningFolders, setIsScanningFolders] = useState(false);
  const [scanProgressInfo, setScanProgressInfo] = useState(null);
  const [suggestedFolders, setSuggestedFolders] = useState([]);
  const [selectedSuggestedUris, setSelectedSuggestedUris] = useState({});
  // Limpiador de carpetas vacías
  const [isScanningEmpty, setIsScanningEmpty] = useState(false);
  const [emptyFoldersFound, setEmptyFoldersFound] = useState([]);
  const [showEmptyFoldersModal, setShowEmptyFoldersModal] = useState(false);
  // Organización física de cámara por meses
  const [isOrganizingCamera, setIsOrganizingCamera] = useState(false);
  const [organizeProgress, setOrganizeProgress] = useState(null);
  const [showOrganizeConfirmModal, setShowOrganizeConfirmModal] = useState(false);
  // Control de Pausa / Cancelación para procesos en lote
  const [isProcessPaused, setIsProcessPaused] = useState(false);
  const processControlRef = useRef(null);

  const createProcessController = () => {
    let pauseResolve = null;
    let pausePromise = null;
    const ctrl = {
      isPaused: false,
      isCancelled: false,
      pause() {
        if (this.isPaused || this.isCancelled) return;
        this.isPaused = true;
        setIsProcessPaused(true);
        pausePromise = new Promise((r) => {
          pauseResolve = r;
        });
      },
      resume() {
        if (!this.isPaused) return;
        this.isPaused = false;
        setIsProcessPaused(false);
        if (pauseResolve) {
          const r = pauseResolve;
          pauseResolve = null;
          pausePromise = null;
          r();
        }
      },
      cancel() {
        this.isCancelled = true;
        this.isPaused = false;
        setIsProcessPaused(false);
        if (pauseResolve) {
          const r = pauseResolve;
          pauseResolve = null;
          pausePromise = null;
          r();
        }
      },
      async waitIfPaused() {
        while (this.isPaused && pausePromise && !this.isCancelled) {
          await pausePromise;
        }
      },
    };
    processControlRef.current = ctrl;
    setIsProcessPaused(false);
    return ctrl;
  };
  // Selección múltiple con toque prolongado
  const [selectedIds, setSelectedIds] = useState({});
  // Buscador instantáneo, filtro por peso y selector de columnas (2, 3 o 4)
  const [searchQuery, setSearchQuery] = useState('');
  const [sizeFilter, setSizeFilter] = useState('all'); // 'all' | 'heavy' (>4MB) | 'medium' (2-4MB)
  const [photoColumns, setPhotoColumns] = useState(() =>
    gridConfig?.photoColumns > 0
      ? Number(gridConfig.photoColumns)
      : isFoldExpanded
      ? 6
      : NUM_PHOTO_COLUMNS
  );
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [newSubfolderName, setNewSubfolderName] = useState('');

  useEffect(() => {
    if (gridConfig?.photoColumns > 0) {
      setPhotoColumns(Number(gridConfig.photoColumns));
    } else {
      setPhotoColumns(isFoldExpanded ? 6 : NUM_PHOTO_COLUMNS);
    }
  }, [gridConfig?.photoColumns, isFoldExpanded]);

  const effectiveSubfolderCols = useMemo(
    () =>
      gridConfig?.albumColumns > 0
        ? Number(gridConfig.albumColumns)
        : isFoldExpanded
        ? 5
        : SUBFOLDER_COLS,
    [gridConfig?.albumColumns, isFoldExpanded]
  );

  const subfolderCardWidth = useMemo(
    () =>
      Math.max(
        70,
        Math.floor(
          (screenWidth -
            SUBFOLDER_SIDE_PADDING * 2 -
            SUBFOLDER_GAP * (effectiveSubfolderCols - 1)) /
            effectiveSubfolderCols
        )
      ),
    [screenWidth, effectiveSubfolderCols]
  );
  const subfolderCardHeight = useMemo(
    () => Math.round(subfolderCardWidth * 1.22),
    [subfolderCardWidth]
  );

  const dynamicPhotoSize = useMemo(
    () =>
      Math.max(
        50,
        Math.floor((screenWidth - PHOTO_MARGIN * (photoColumns * 2)) / photoColumns)
      ),
    [screenWidth, photoColumns]
  );

  const cyclePhotoColumns = () => {
    setPhotoColumns((prev) => (prev === 3 ? 4 : prev === 4 ? 2 : prev === 2 ? 1 : 3));
  };

  // Gesto de pellizco con 2 dedos en la cuadrícula para hacer zoom sin entrar a la foto (4 <-> 3 <-> 2 <-> 1 col)
  const gridPinchRef = useRef({ active: false, startDist: 0, startCols: NUM_PHOTO_COLUMNS });

  const handleGridTouchStart = useCallback(
    (e) => {
      const touches = e.nativeEvent.touches;
      if (touches && touches.length >= 2) {
        const dx = touches[0].pageX - touches[1].pageX;
        const dy = touches[0].pageY - touches[1].pageY;
        const dist = Math.hypot(dx, dy);
        if (dist > 15) {
          gridPinchRef.current = {
            active: true,
            startDist: dist,
            startCols: photoColumns,
          };
        }
      }
    },
    [photoColumns]
  );

  const handleGridTouchMove = useCallback(
    (e) => {
      const touches = e.nativeEvent.touches;
      if (!touches || touches.length < 2) return;
      const dx = touches[0].pageX - touches[1].pageX;
      const dy = touches[0].pageY - touches[1].pageY;
      const dist = Math.hypot(dx, dy);
      if (!gridPinchRef.current.active) {
        if (dist > 15) {
          gridPinchRef.current = { active: true, startDist: dist, startCols: photoColumns };
        }
        return;
      }
      const delta = dist - gridPinchRef.current.startDist;
      // Separar dedos (> 55px) = acercar foto (menos columnas, fotos más grandes hasta 1 col)
      // Juntar dedos (< -55px) = alejar foto (más columnas hasta 6 col)
      if (Math.abs(delta) > 55) {
        const step = delta > 0 ? -1 : 1;
        setPhotoColumns((prev) => {
          const next = Math.max(1, Math.min(6, prev + step));
          if (next !== prev) {
            gridPinchRef.current.startDist = dist;
            gridPinchRef.current.startCols = next;
          }
          return next;
        });
      }
    },
    [photoColumns]
  );

  const handleGridTouchEnd = useCallback((e) => {
    const touches = e.nativeEvent.touches;
    if (!touches || touches.length < 2) {
      gridPinchRef.current.active = false;
    }
  }, []);

  const selectedCount = useMemo(() => Object.keys(selectedIds).length, [selectedIds]);
  const isSelecting = selectedCount > 0;
  const isSelectingRef = useRef(isSelecting);
  isSelectingRef.current = isSelecting;

  const currentFolder = history[history.length - 1] || null;

  // Cargar nivel actual con emisión parcial temprana
  const loadCurrentLevel = useCallback(async (uri, forceRefresh = false) => {
    if (!uri) return;
    setLoading(true);
    setIsStreaming(true);
    setVisibleLimit(BATCH_SIZE);
    try {
      await folderService.readDirectory(
        uri,
        ({ subfolders: subs, assets: arts, isPartial }) => {
          setSubfolders(subs);
          setCurrentFolderAssets(arts);
          if (isPartial) {
            setLoading(false);
          }
        },
        { forceRefresh }
      );
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
      const sorted = await folderService.loadFolderAssets(uri, (chunk) => {
        setAllAssets((prev) => [...prev, ...chunk]);
        setLoadingAll(false);
      });
      if (sorted && sorted.length > 0) setAllAssets(sorted);
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

  // Ejecutar carga cuando cambia la carpeta activa o el modo (por defecto filtro en Fotos, o Videos automático si no hay fotos)
  useEffect(() => {
    setShowPhotosFilter(true);
    setShowVideosFilter(false);
    if (currentFolder?.uri) {
      if (viewMode === 'folders') {
        loadCurrentLevel(currentFolder.uri);
      } else {
        loadAllRecursive(currentFolder.uri);
      }
    }
  }, [currentFolder?.uri, viewMode]);

  // Recargar inmediatamente cuando se guarda un nuevo video o foto en 2do plano
  useEffect(() => {
    if (refreshTrigger > 0 && currentFolder?.uri) {
      if (viewMode === 'folders') {
        loadCurrentLevel(currentFolder.uri, true);
      } else {
        loadAllRecursive(currentFolder.uri);
      }
    }
  }, [refreshTrigger]);

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

  // Refrescar contenido (limpiando caché de memoria para reflejar cambios al instante)
  const handleRefresh = async () => {
    if (!currentFolder?.uri) return;
    setRefreshing(true);
    folderService.invalidateCache(currentFolder.uri);
    if (viewMode === 'folders') {
      await loadCurrentLevel(currentFolder.uri, true);
    } else {
      await loadAllRecursive(currentFolder.uri);
    }
    setRefreshing(false);
  };

  // División entre Fotos y Videos (excluyendo los archivos enviados a la Papelera temporal del Modo Guardar y deduplicando por URI)
  const rawFolderList = useMemo(() => {
    const base = viewMode === 'folders' ? currentFolderAssets : allAssets;
    const seen = new Set();
    const out = [];
    for (const a of base || []) {
      if (!a) continue;
      if (trashBin && trashBin[a.id]) continue;
      const key = String(a.uri || a.id || '').toLowerCase();
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(a);
    }
    return out;
  }, [viewMode, currentFolderAssets, allAssets, trashBin]);
  const isVideoAsset = useCallback(
    (a) =>
      Boolean(
        a &&
          (a.mediaType === 'video' ||
            /\.(mp4|mov|m4v|mkv|webm|avi|3gp)$/i.test(a.filename || a.uri || ''))
      ),
    []
  );
  const folderPhotos = useMemo(
    () => (rawFolderList || []).filter((a) => a && !isVideoAsset(a)),
    [rawFolderList, isVideoAsset]
  );
  const folderVideos = useMemo(
    () => (rawFolderList || []).filter((a) => isVideoAsset(a)),
    [rawFolderList, isVideoAsset]
  );

  const hasPhotos = folderPhotos.length > 0;
  const hasVideos = folderVideos.length > 0;
  const hasBothPhotosAndVideos = hasPhotos && hasVideos;

  // Si existen fotos y videos, usa la selección del usuario (por defecto Fotos = true, Videos = false, o ambas).
  // Si NO hay videos, Videos no aparece y se muestran las fotos.
  // Si NO hay fotos, Fotos no aparece y se muestran automáticamente los videos.
  const isPhotosActive = hasPhotos ? (hasVideos ? showPhotosFilter : true) : false;
  const isVideosActive = hasVideos ? (hasPhotos ? showVideosFilter : true) : false;

  const handleTogglePhotosChip = useCallback(() => {
    if (!hasVideos) return;
    if (showPhotosFilter && !showVideosFilter) {
      setShowPhotosFilter(false);
      setShowVideosFilter(true);
    } else {
      setShowPhotosFilter((prev) => !prev);
    }
  }, [hasVideos, showPhotosFilter, showVideosFilter]);

  const handleToggleVideosChip = useCallback(() => {
    if (!hasPhotos) return;
    if (showVideosFilter && !showPhotosFilter) {
      setShowVideosFilter(false);
      setShowPhotosFilter(true);
    } else {
      setShowVideosFilter((prev) => !prev);
    }
  }, [hasPhotos, showPhotosFilter, showVideosFilter]);

  // Lista base por categoría y búsqueda para calcular si existen archivos Grandes o Medianos
  const categoryAndSearchList = useMemo(() => {
    let base = [];
    if (filterType === 'photos') {
      base = folderPhotos;
    } else if (filterType === 'videos') {
      base = folderVideos;
    } else if (isPhotosActive && isVideosActive) {
      base = rawFolderList;
    } else if (isPhotosActive) {
      base = folderPhotos;
    } else if (isVideosActive) {
      base = folderVideos;
    } else {
      base = rawFolderList;
    }

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      base = base.filter((a) => (a.filename || '').toLowerCase().includes(q));
    }
    return base;
  }, [isPhotosActive, isVideosActive, filterType, rawFolderList, folderPhotos, folderVideos, searchQuery]);

  // Contabilizar archivos Grandes (>4MB) y Medianos (2-4MB) para mostrar filtros solo si existen
  const { heavyCount, mediumCount } = useMemo(() => {
    let heavy = 0;
    let medium = 0;
    for (const a of categoryAndSearchList) {
      const sz = a.fileSize || 0;
      if (sz > 4 * 1024 * 1024) heavy++;
      else if (sz > 2 * 1024 * 1024) medium++;
    }
    return { heavyCount: heavy, mediumCount: medium };
  }, [categoryAndSearchList]);

  const hasWeightFilters = heavyCount > 0 || mediumCount > 0;
  const effectiveSizeFilter =
    (sizeFilter === 'heavy' && heavyCount === 0) ||
    (sizeFilter === 'medium' && mediumCount === 0)
      ? 'all'
      : sizeFilter;

  // Lista total filtrada (photos | videos | all + buscador por texto + filtro por peso condicional)
  const totalFilteredAssets = useMemo(() => {
    if (effectiveSizeFilter === 'heavy') {
      return categoryAndSearchList.filter((a) => (a.fileSize || 0) > 4 * 1024 * 1024);
    }
    if (effectiveSizeFilter === 'medium') {
      return categoryAndSearchList.filter((a) => {
        const sz = a.fileSize || 0;
        return sz > 2 * 1024 * 1024 && sz <= 4 * 1024 * 1024;
      });
    }
    return categoryAndSearchList;
  }, [categoryAndSearchList, effectiveSizeFilter]);

  // Semáforo de potencial de reducción para Fotos y Videos de la carpeta actual
  // Si todas las fotos/videos están en Verde (canCompress === false), se oculta el botón de comprimir
  const photoReductionSummary = useMemo(
    () => compressionService.getBatchReductionSummary(folderPhotos, 'photo'),
    [folderPhotos]
  );
  const videoReductionSummary = useMemo(
    () => compressionService.getBatchReductionSummary(folderVideos, 'video'),
    [folderVideos]
  );

  // Escáner de carpetas vacías
  const handleScanEmptyFolders = async () => {
    const targetUri = currentFolder?.uri || rootUri;
    if (!targetUri) return;
    setIsScanningEmpty(true);
    try {
      const empties = await folderService.scanEmptyFolders(targetUri);
      setEmptyFoldersFound(empties || []);
      if (!empties || empties.length === 0) {
        Alert.alert(
          '¡Todo limpio!',
          `No se encontraron carpetas vacías dentro de "${currentFolder?.name || 'esta carpeta'}".`
        );
      } else {
        setShowEmptyFoldersModal(true);
      }
    } catch (e) {
      Alert.alert('Aviso', 'No se pudo escanear carpetas vacías: ' + (e?.message || String(e)));
    } finally {
      setIsScanningEmpty(false);
    }
  };

  const handleConfirmDeleteEmptyFolders = async () => {
    if (emptyFoldersFound.length === 0) {
      setShowEmptyFoldersModal(false);
      return;
    }
    try {
      const deleted = await folderService.deleteEmptyFolders(emptyFoldersFound);
      setShowEmptyFoldersModal(false);
      setEmptyFoldersFound([]);
      Alert.alert(
        'Carpetas vacías eliminadas',
        `Se eliminaron ${deleted} ${deleted === 1 ? 'carpeta vacía' : 'carpetas vacías'} correctamente.`
      );
      handleRefresh();
    } catch (e) {
      Alert.alert('Error', 'No se pudieron eliminar algunas carpetas vacías.');
    }
  };

  // Escáner inteligente de carpetas sugeridas para agregar
  const handleOpenFolderScanner = async () => {
    setShowScannerModal(true);
    setIsScanningFolders(true);
    setSuggestedFolders([]);
    setSelectedSuggestedUris({});
    setScanProgressInfo({ foundCount: 0, currentFolder: 'Iniciando escaneo...' });
    try {
      const results = await folderService.scanSuggestedFolders(savedFolders, (prog) => {
        setScanProgressInfo(prog);
      });
      setSuggestedFolders(results);
      // Pre-seleccionar las primeras carpetas sugeridas con más contenido para ahorrar pasos
      const initialSel = {};
      results.slice(0, 8).forEach((item) => {
        initialSel[item.uri] = true;
      });
      setSelectedSuggestedUris(initialSel);
    } catch (e) {
      Alert.alert('Aviso', 'Error al escanear carpetas: ' + (e?.message || String(e)));
    } finally {
      setIsScanningFolders(false);
    }
  };

  const toggleSuggestedFolderUri = (uri) => {
    setSelectedSuggestedUris((prev) => {
      const next = { ...prev };
      if (next[uri]) delete next[uri];
      else next[uri] = true;
      return next;
    });
  };

  const handleAddSelectedSuggestedFolders = async () => {
    const chosen = suggestedFolders.filter((f) => selectedSuggestedUris[f.uri]);
    if (chosen.length === 0) {
      Alert.alert('Selecciona al menos una', 'Marca las carpetas que deseas agregar a tu galería.');
      return;
    }
    setShowScannerModal(false);
    if (onAddMultipleFolders) {
      await onAddMultipleFolders(chosen);
    } else {
      await folderService.addMultipleSavedFolders(chosen);
      if (onSelectSavedFolder && chosen[0]?.uri) {
        onSelectSavedFolder(chosen[0].uri);
      }
    }
  };

  // Comprimir fotos de la carpeta completa (incluyendo subcarpetas si el nivel actual solo tiene carpetas)
  const handleCompressFolder = async () => {
    let targetPhotos = folderPhotos;

    if (targetPhotos.length === 0 && currentFolder?.uri) {
      setIsCompressingFolder(true);
      setCompressProgress({ current: 0, total: 1, percent: 0, savedFormatted: 'Buscando fotos en subcarpetas…' });
      try {
        const recursiveAssets = await folderService.loadFolderAssets(currentFolder.uri);
        targetPhotos = (recursiveAssets || []).filter((a) => a.mediaType === 'photo');
      } catch (e) {
        targetPhotos = [];
      } finally {
        setIsCompressingFolder(false);
        setCompressProgress(null);
      }
    }

    if (targetPhotos.length === 0) {
      Alert.alert('Sin fotos', 'No se encontraron fotografías en esta carpeta para comprimir.');
      return;
    }

    Alert.alert(
      'Comprimir fotos de la carpeta',
      `¿Deseas optimizar las ${targetPhotos.length} fotos encontradas manteniendo el 100% de su resolución original y reemplazando el archivo original sin crear copias?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Comprimir fotos',
          onPress: async () => {
            const ctrl = createProcessController();
            setIsCompressingFolder(true);
            setCompressProgress({ current: 0, total: targetPhotos.length, percent: 0, skippedGreenCount: 0, savedFormatted: '0 B' });
            try {
              const res = await compressionService.compressFolderPhotos(
                targetPhotos,
                (prog) => setCompressProgress(prog),
                ctrl
              );
              if (res.permissionRequired && (res.compressedCount || 0) === 0) {
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
                const skippedMsg =
                  res.skippedGreenCount > 0
                    ? `\nYa estaban ligeras: ${res.skippedGreenCount}`
                    : '';
                Alert.alert(
                  res.cancelled ? 'Proceso cancelado' : '¡Compresión finalizada!',
                  `Fotos optimizadas (100% resolución): ${res.compressedCount || 0} de ${targetPhotos.length}${skippedMsg}\n\nEspacio total ahorrado: ${compressionService.formatBytes(res.totalSavedBytes)}.`
                );
              }
              handleRefresh();
            } catch (e) {
              Alert.alert('Error', 'Ocurrió un problema durante la compresión: ' + (e?.message || String(e)));
            } finally {
              setIsCompressingFolder(false);
              setCompressProgress(null);
              processControlRef.current = null;
              setIsProcessPaused(false);
            }
          },
        },
      ]
    );
  };

  // Comprimir videos de la carpeta manteniendo el 100% de la resolución original
  const handleCompressVideosFolder = async () => {
    let targetVideos = folderVideos;

    if (targetVideos.length === 0 && currentFolder?.uri) {
      setIsCompressingFolder(true);
      setCompressProgress({ current: 0, total: 1, percent: 0, savedFormatted: 'Buscando videos en subcarpetas…' });
      try {
        const recursiveAssets = await folderService.loadFolderAssets(currentFolder.uri);
        targetVideos = (recursiveAssets || []).filter((a) => a.mediaType === 'video');
      } catch (e) {
        targetVideos = [];
      } finally {
        setIsCompressingFolder(false);
        setCompressProgress(null);
      }
    }

    if (targetVideos.length === 0) {
      Alert.alert('Sin videos', 'No se encontraron videos en esta carpeta para comprimir.');
      return;
    }

    Alert.alert(
      'Comprimir videos (100% Resolución)',
      `¿Deseas comprimir los ${targetVideos.length} videos encontrados manteniendo el 100% de su resolución original y reemplazando cada original sin duplicados?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Comprimir videos',
          onPress: async () => {
            const ctrl = createProcessController();
            setIsCompressingFolder(true);
            setCompressProgress({
              current: 0,
              total: targetVideos.length,
              percent: 0,
              savedFormatted: '0 B',
            });
            try {
              const res = await videoEngineService.compressVideosBatch(targetVideos, {
                presetId: 'balanced',
                onProgress: (prog) => setCompressProgress(prog),
                control: ctrl,
              });
              Alert.alert(
                res.cancelled ? 'Proceso cancelado' : '¡Videos comprimidos!',
                `Se optimizaron ${res.compressedCount} de ${targetVideos.length} videos al 100% de su resolución original.\n\nEspacio total ahorrado: ${compressionService.formatBytes(res.totalSavedBytes)}.`
              );
              handleRefresh();
            } catch (e) {
              Alert.alert('Aviso', 'Ocurrió un problema al comprimir videos: ' + (e?.message || String(e)));
            } finally {
              processControlRef.current = null;
              setIsProcessPaused(false);
              setIsCompressingFolder(false);
              setCompressProgress(null);
            }
          },
        },
      ]
    );
  };

  // Organizar cámara físicamente por meses
  const handleOrganizeCamera = async (keepActiveInRoot = false) => {
    setShowOrganizeConfirmModal(false);
    if (!currentFolder?.uri) return;

    const ctrl = createProcessController();
    setIsOrganizingCamera(true);
    setOrganizeProgress({ current: 0, total: currentFolderAssets.length, percent: 0, currentFile: '', currentMonth: '' });

    try {
      const res = await cameraOrganizerService.physicallyOrganizeFolder({
        targetDirUri: currentFolder.uri,
        assets: currentFolderAssets,
        keepActiveMonthInRoot: Boolean(keepActiveInRoot),
        onProgress: (prog) => setOrganizeProgress(prog),
        control: ctrl,
      });

      setViewMode('folders');
      setFolderCategory('all');
      await handleRefresh();

      if (res.moved === 0 && res.keptInRoot > 0) {
        Alert.alert(
          'Mes activo en raíz',
          `Los ${res.keptInRoot} archivos de esta carpeta pertenecen al mes activo (${res.activeMonthName || 'mes actual'}). Si deseas meterlos también en su carpeta de mes, elige "Organizar TODOS los meses".`
        );
      } else {
        const rootMsg =
          res.keptInRoot > 0
            ? `\n\n📌 Se dejaron ${res.keptInRoot} archivos del mes activo (${res.activeMonthName}) en la carpeta raíz.`
            : '';
        Alert.alert(
          res.cancelled ? 'Organización detenida' : '¡Carpeta organizada por meses!',
          `Se crearon ${res.monthsCreated || 0} carpetas por mes con división de Fotos y Videos y se movieron ${res.moved} archivos.${rootMsg}`
        );
      }
    } catch (e) {
      if (e?.code === 'PERMISSION_REQUIRED') {
        Alert.alert(
          'Permiso requerido',
          e.message,
          [
            { text: 'Cancelar', style: 'cancel' },
            {
              text: 'Activar en Ajustes',
              onPress: () => folderService.openAllFilesAccessSettings(),
            },
          ]
        );
      } else {
        Alert.alert('Aviso', 'No se pudo completar la organización: ' + (e?.message || String(e)));
      }
    } finally {
      setIsOrganizingCamera(false);
      setOrganizeProgress(null);
      processControlRef.current = null;
      setIsProcessPaused(false);
    }
  };

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

  // Manejadores estables para que las miniaturas no se vuelvan a dibujar innecesariamente
  const selectRef = useRef(onSelectPhoto);
  selectRef.current = onSelectPhoto;
  const listRef = useRef(totalFilteredAssets);
  listRef.current = totalFilteredAssets;

  const selectedAssets = useMemo(
    () => totalFilteredAssets.filter((a) => a && selectedIds[a.id]),
    [totalFilteredAssets, selectedIds]
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

  const selectAllFolderAssets = useCallback(() => {
    const next = {};
    totalFilteredAssets.forEach((a) => {
      if (a?.id) next[a.id] = true;
    });
    setSelectedIds(next);
  }, [totalFilteredAssets]);

  const handleDeleteSelected = () => {
    if (selectedAssets.length === 0) return;
    Alert.alert(
      'Eliminar seleccionados',
      `¿Deseas eliminar ${selectedAssets.length} ${selectedAssets.length === 1 ? 'archivo seleccionado' : 'archivos seleccionados'} de esta carpeta?`,
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
              handleRefresh();
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
    if (selectedPhotos.length === 0 && selectedVideos.length === 0) {
      Alert.alert('Sin archivos', 'Selecciona al menos una fotografía o un video para comprimir.');
      return;
    }
    const totalSel = selectedPhotos.length + selectedVideos.length;
    Alert.alert(
      'Comprimir seleccionados (100% Resolución)',
      `¿Optimizar ${selectedPhotos.length} foto(s) y ${selectedVideos.length} video(s) manteniendo el 100% de su resolución?\n\nLas fotos en Verde se omitirán y solo se comprimirán las que estén en Naranja o Rojo.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Comprimir',
          onPress: async () => {
            const ctrl = createProcessController();
            setIsCompressingFolder(true);
            setCompressProgress({
              current: 0,
              total: totalSel,
              percent: 0,
              skippedGreenCount: 0,
              savedFormatted: '0 B',
            });
            try {
              let totalSaved = 0;
              let totalDone = 0;
              let skippedGreen = 0;
              if (selectedPhotos.length > 0) {
                const res = await compressionService.compressFolderPhotos(
                  selectedPhotos,
                  (prog) => setCompressProgress(prog),
                  ctrl
                );
                totalSaved += res.totalSavedBytes || 0;
                totalDone += res.compressedCount || 0;
                skippedGreen += res.skippedGreenCount || 0;
              }
              if (selectedVideos.length > 0 && !ctrl.cancelled) {
                const resVid = await videoEngineService.compressVideosBatch(selectedVideos, {
                  presetId: 'balanced',
                  onProgress: (prog) => setCompressProgress(prog),
                });
                totalSaved += resVid.totalSavedBytes || 0;
                totalDone += resVid.compressedCount || 0;
              }
              clearSelection();
              const skippedMsg =
                skippedGreen > 0
                  ? `\nOmitidas por estar en Verde: ${skippedGreen}`
                  : '';
              Alert.alert(
                ctrl.cancelled ? 'Proceso cancelado' : '¡Compresión finalizada!',
                `Archivos comprimidos al 100% de resolución: ${totalDone} de ${totalSel}${skippedMsg}\n\nEspacio ahorrado: ${compressionService.formatBytes(totalSaved)}.`
              );
              handleRefresh();
            } catch (e) {
              Alert.alert('Error', e?.message || String(e));
            } finally {
              setIsCompressingFolder(false);
              setCompressProgress(null);
              processControlRef.current = null;
              setIsProcessPaused(false);
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

  const handleMoveSelectedTo = async (targetDirUri, relativeSubfolder = '', targetLabel = 'carpeta destino') => {
    if (selectedAssets.length === 0 || !targetDirUri) return;
    setShowMoveModal(false);
    try {
      const res = await folderService.moveAssetsToFolder(
        selectedAssets,
        targetDirUri,
        relativeSubfolder
      );
      clearSelection();
      setNewSubfolderName('');
      Alert.alert(
        '¡Archivos movidos!',
        `Se movieron ${res.moved} de ${res.total} archivos a "${targetLabel}".`
      );
      handleRefresh();
    } catch (e) {
      Alert.alert('Error al mover archivos', String(e?.message || e));
    }
  };

  const handlePressPhoto = useCallback(
    (a) => {
      if (isSelectingRef.current) {
        toggleSelectAsset(a);
        return;
      }
      if (selectRef.current) selectRef.current(a, listRef.current);
    },
    [toggleSelectAsset]
  );

  const handleLongPressPhoto = useCallback(
    (a) => {
      toggleSelectAsset(a);
    },
    [toggleSelectAsset]
  );

  const currentFolderCoverUri = useMemo(
    () =>
      storageService.resolveCustomCover(customCovers, {
        uri: currentFolder?.uri,
        title: currentFolder?.name,
        name: currentFolder?.name,
      }),
    [customCovers, currentFolder?.uri, currentFolder?.name]
  );

  const renderPhotoItem = useCallback(
    ({ item }) => (
      <PhotoThumbnail
        asset={item}
        size={dynamicPhotoSize}
        onPress={handlePressPhoto}
        onLongPress={handleLongPressPhoto}
        isFavorite={Boolean(favorites[item.id])}
        isCover={Boolean(currentFolderCoverUri && item.uri === currentFolderCoverUri)}
        selectable={isSelecting}
        isSelected={Boolean(selectedIds[item.id])}
      />
    ),
    [
      favorites,
      handlePressPhoto,
      handleLongPressPhoto,
      isSelecting,
      selectedIds,
      dynamicPhotoSize,
      currentFolderCoverUri,
    ]
  );

  // Notificar al componente padre los assets totales visibles
  useEffect(() => {
    if (onAssetsChange) {
      onAssetsChange(totalFilteredAssets);
    }
  }, [totalFilteredAssets, onAssetsChange]);

  // Botón físico Atrás de Android: navega hacia atrás paso a paso sin salirse de la app (salvo en pantalla raíz)
  useEffect(() => {
    const onBackPress = () => {
      if (showScannerModal) {
        setShowScannerModal(false);
        return true;
      }
      if (showEmptyFoldersModal) {
        setShowEmptyFoldersModal(false);
        return true;
      }
      if (showSystemModal) {
        setShowSystemModal(false);
        return true;
      }
      if (showMoveModal) {
        setShowMoveModal(false);
        return true;
      }
      if (showOrganizeConfirmModal) {
        setShowOrganizeConfirmModal(false);
        return true;
      }
      if (isSelecting) {
        clearSelection();
        return true;
      }
      if (searchQuery.trim().length > 0) {
        setSearchQuery('');
        return true;
      }
      if (sizeFilter !== 'all') {
        setSizeFilter('all');
        return true;
      }
      if (viewMode === 'all') {
        setViewMode('folders');
        return true;
      }
      if (history.length > 1) {
        handleGoBack();
        return true;
      }
      if (onExitFolder) {
        onExitFolder();
        return true;
      }
      return false; // En la pantalla inicial raíz permite salir o delegar a App.js
    };

    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, [
    showScannerModal,
    showEmptyFoldersModal,
    showSystemModal,
    showMoveModal,
    showOrganizeConfirmModal,
    isSelecting,
    clearSelection,
    searchQuery,
    sizeFilter,
    folderCategory,
    viewMode,
    history.length,
    onExitFolder,
  ]);

  const [expandSmallSubfolders, setExpandSmallSubfolders] = useState(false);
  const [showSubfoldersSection, setShowSubfoldersSection] = useState(true);
  const [showSubfolderSystemModal, setShowSubfolderSystemModal] = useState(false);

  const isSubfolderHidden = useCallback(
    (sub) => {
      if (!sub) return false;
      if (hiddenFolders[sub.uri] || hiddenFolders[sub.name]) return true;
      const sysInfo = folderService.classifySystemFolder(sub);
      const isManualOn = Boolean(
        manuallyEnabledSystemFolders[sub.uri] || manuallyEnabledSystemFolders[sub.name]
      );
      // En subcarpetas dentro de una carpeta, solo auto-ocultar si el nombre es de sistema/caché ('system_name')
      if (
        sysInfo.isSystemSuggested &&
        sysInfo.category === 'system_name' &&
        autoHideSystemFolders &&
        !isManualOn
      ) {
        return true;
      }
      return false;
    },
    [hiddenFolders, manuallyEnabledSystemFolders, autoHideSystemFolders]
  );

  const handleToggleSubfolderVisibility = useCallback(
    (sub) => {
      if (!sub) return;
      const sysInfo = folderService.classifySystemFolder(sub);
      if (sysInfo.isSystemSuggested && onToggleSystemFolderManual) {
        const currentlyHidden = isSubfolderHidden(sub);
        onToggleSystemFolderManual(sub.uri || sub.name, currentlyHidden, sub.name, sub);
        return;
      }
      if (onToggleHideFolder) {
        onToggleHideFolder(sub.uri, sub.name, true);
      }
    },
    [isSubfolderHidden, onToggleSystemFolderManual, onToggleHideFolder]
  );

  // Filtrar estrictamente subcarpetas que sí tengan al menos 1 imagen o video y sin duplicados por ruta o nombre
  const nonEmptySubfolders = useMemo(() => {
    const raw = (subfolders || []).filter((item) => item && Number(item.count) > 0);
    raw.sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
    const seenUris = new Set();
    const seenLabels = new Set();
    const out = [];
    for (const item of raw) {
      let normUri = '';
      if (item.uri) {
        try {
          normUri = decodeURIComponent(folderService.toPhysicalUri(item.uri) || item.uri)
            .replace(/\/+$/, '')
            .toLowerCase();
        } catch (_e) {
          normUri = String(item.uri).replace(/\/+$/, '').toLowerCase();
        }
      }
      const label = folderService
        .formatFolderDisplayName(item.name, item.uri || '')
        .trim()
        .toLowerCase();
      if (normUri && seenUris.has(normUri)) continue;
      if (label && seenLabels.has(label)) continue;
      if (normUri) seenUris.add(normUri);
      if (label) seenLabels.add(label);
      out.push(item);
    }
    return out;
  }, [subfolders]);

  // Subcarpetas visibles filtradas por el modo oculto, sugerencias de sistema y buscador
  const visibleSubfolders = useMemo(() => {
    const base = showAllFolders
      ? nonEmptySubfolders
      : nonEmptySubfolders.filter((item) => !isSubfolderHidden(item));
    const q = searchQuery.trim().toLowerCase();
    const list = q
      ? base.filter((item) => (item.name || '').toLowerCase().includes(q))
      : [...base];
    list.sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
    return list;
  }, [nonEmptySubfolders, isSubfolderHidden, showAllFolders, searchQuery]);

  const systemSubfoldersList = useMemo(() => {
    return nonEmptySubfolders
      .map((sub) => {
        const sysInfo = folderService.classifySystemFolder(sub);
        return { ...sub, sysInfo };
      })
      .filter((s) => s.sysInfo.isSystemSuggested);
  }, [nonEmptySubfolders]);

  const { mainSubfolders, smallSubfolders } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q || expandSmallSubfolders) {
      return { mainSubfolders: visibleSubfolders, smallSubfolders: [] };
    }
    const main = [];
    const small = [];
    for (const sub of visibleSubfolders) {
      const cnt = Number(sub.count || 0);
      if (cnt > 0 && cnt < 5) {
        small.push(sub);
      } else {
        main.push(sub);
      }
    }
    // Si solo hay 1 subcarpeta pequeña, no hace falta agruparla en Varios
    if (small.length <= 1) {
      return { mainSubfolders: visibleSubfolders, smallSubfolders: [] };
    }
    return { mainSubfolders: main, smallSubfolders: small };
  }, [visibleSubfolders, searchQuery, expandSmallSubfolders]);

  const hiddenSubfolderCount = useMemo(() => {
    return nonEmptySubfolders.filter((item) => isSubfolderHidden(item)).length;
  }, [nonEmptySubfolders, isSubfolderHidden]);

  // 1. SECCIÓN DE SUBCARPETAS ESTILO SAMSUNG GALAXY (3 columnas dentro de la carpeta actual)
  const renderSubfoldersGridHeader = () => {
    if (viewMode !== 'folders' || nonEmptySubfolders.length === 0) return null;

    return (
      <View style={styles.subfoldersGalaxySection}>
        <View style={styles.subfoldersGalaxyHeaderRow}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
            <Ionicons name="folder-open" size={16} color="#60a5fa" />
            <Text style={styles.subfoldersGalaxyTitle}>
              Carpetas ({visibleSubfolders.length} de {nonEmptySubfolders.length})
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableOpacity
              onPress={() => setShowSubfoldersSection((prev) => !prev)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                backgroundColor: showSubfoldersSection
                  ? 'rgba(96, 165, 250, 0.14)'
                  : 'rgba(245, 158, 11, 0.2)',
                borderWidth: 1,
                borderColor: showSubfoldersSection ? 'rgba(96, 165, 250, 0.35)' : '#f59e0b',
                paddingHorizontal: 9,
                paddingVertical: 4,
                borderRadius: 12,
              }}
            >
              <Ionicons
                name={showSubfoldersSection ? 'eye-off-outline' : 'eye-outline'}
                size={12}
                color={showSubfoldersSection ? '#93c5fd' : '#fbbf24'}
              />
              <Text
                style={{
                  color: showSubfoldersSection ? '#93c5fd' : '#fbbf24',
                  fontSize: 11,
                  fontWeight: '800',
                }}
              >
                {showSubfoldersSection ? 'Ocultar carpetas' : 'Mostrar carpetas'}
              </Text>
            </TouchableOpacity>

            {systemSubfoldersList.length > 0 && (
              <TouchableOpacity
                onPress={() => setShowSubfolderSystemModal(true)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  backgroundColor: 'rgba(37, 99, 235, 0.22)',
                  borderWidth: 1,
                  borderColor: '#3b82f6',
                  paddingHorizontal: 9,
                  paddingVertical: 4,
                  borderRadius: 12,
                }}
              >
                <Ionicons name="hardware-chip-outline" size={12} color="#60a5fa" />
                <Text style={{ color: '#bfdbfe', fontSize: 11, fontWeight: '800' }}>
                  Sistema ({systemSubfoldersList.length})
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {!showSubfoldersSection ? (
          <TouchableOpacity
            onPress={() => setShowSubfoldersSection(true)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#141722',
              borderWidth: 1,
              borderColor: '#27272a',
              borderRadius: 12,
              paddingHorizontal: 12,
              paddingVertical: 8,
              marginBottom: 6,
            }}
          >
            <Text style={{ color: '#a1a1aa', fontSize: 12, fontWeight: '600' }}>
              Subcarpetas ocultas de la vista ({visibleSubfolders.length} activas · {hiddenSubfolderCount} desactivadas)
            </Text>
            <Text style={{ color: '#60a5fa', fontSize: 12, fontWeight: '800' }}>Mostrar</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.subfoldersGalaxyGrid}>
            {mainSubfolders.map((sub) => {
              const isHidden = isSubfolderHidden(sub);
              const displayLabel = folderService.formatFolderDisplayName(sub.name, sub.uri);
              const customSubCover = storageService.resolveCustomCover(customCovers, sub);
              const coverToUse = customSubCover || sub.coverUri || null;

              return (
                <TouchableOpacity
                  key={`sub_galaxy_${sub.uri}`}
                  style={[
                    styles.subfolderGalaxyCard,
                    { width: subfolderCardWidth, height: subfolderCardHeight },
                    isHidden && { borderColor: '#f59e0b', borderWidth: 1.5, borderStyle: 'dashed' },
                  ]}
                  onPress={() => handleOpenSubfolder({ ...sub, name: displayLabel })}
                  onLongPress={() => handleToggleSubfolderVisibility(sub)}
                  activeOpacity={0.82}
                >
                  {coverToUse ? (
                    <Image
                      source={{ uri: coverToUse }}
                      style={[styles.subfolderGalaxyImg, isHidden && { opacity: 0.45 }]}
                      contentFit="cover"
                      allowDownscaling={true}
                      decodeFormat="rgb"
                      cachePolicy="memory-disk"
                      transition={0}
                    />
                  ) : (
                    <View
                      style={[
                        styles.subfolderGalaxyImg,
                        {
                          backgroundColor: '#18181f',
                          alignItems: 'center',
                          justifyContent: 'center',
                          paddingBottom: 20,
                        },
                        isHidden && { opacity: 0.45 },
                      ]}
                    >
                      <Ionicons name="folder-open-outline" size={28} color="#60a5fa" />
                    </View>
                  )}
                  <View style={styles.subfolderGalaxyScrim} />

                  <View style={styles.subfolderGalaxyTopBadge}>
                    <Ionicons name="folder" size={12} color="#ffffff" />
                  </View>

                  <TouchableOpacity
                    style={[
                      styles.subfolderGalaxyEyeBtn,
                      isHidden && { backgroundColor: '#f59e0b' },
                    ]}
                    onPress={(e) => {
                      e.stopPropagation();
                      handleToggleSubfolderVisibility(sub);
                    }}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <Ionicons
                      name={isHidden ? 'eye-off' : 'eye-outline'}
                      size={13}
                      color="#ffffff"
                    />
                  </TouchableOpacity>

                  <View style={styles.subfolderGalaxyBottomInfo}>
                    <Text
                      style={[
                        styles.subfolderGalaxyCardTitle,
                        isHidden && { color: '#fcd34d' },
                      ]}
                      numberOfLines={1}
                    >
                      {displayLabel}
                    </Text>
                    <Text style={styles.subfolderGalaxyCardSub}>
                      {sub.count ? `${sub.count}` : 'Subcarpeta'}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}

            {smallSubfolders.length > 0 && (
              <TouchableOpacity
                key="sub_galaxy_varios_grouped"
                style={[
                  styles.subfolderGalaxyCard,
                  { width: subfolderCardWidth, height: subfolderCardHeight },
                  { borderColor: 'rgba(167, 139, 250, 0.6)', borderWidth: 1.5 },
                ]}
                onPress={() => setExpandSmallSubfolders(true)}
                activeOpacity={0.82}
              >
                {smallSubfolders.find((s) => s.coverUri)?.coverUri ? (
                  <Image
                    source={{
                      uri: smallSubfolders.find((s) => s.coverUri)?.coverUri,
                    }}
                    style={[styles.subfolderGalaxyImg, { opacity: 0.72 }]}
                    contentFit="cover"
                    allowDownscaling={true}
                    decodeFormat="rgb"
                    cachePolicy="memory-disk"
                    transition={0}
                  />
                ) : (
                  <View
                    style={[
                      styles.subfolderGalaxyImg,
                      {
                        backgroundColor: '#1e1b2e',
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingBottom: 20,
                      },
                    ]}
                  >
                    <Ionicons name="file-tray-stacked" size={28} color="#a78bfa" />
                  </View>
                )}
                <View style={styles.subfolderGalaxyScrim} />

                <View
                  style={[
                    styles.subfolderGalaxyTopBadge,
                    { backgroundColor: 'rgba(109, 40, 217, 0.85)' },
                  ]}
                >
                  <Ionicons name="file-tray-stacked" size={12} color="#ffffff" />
                </View>

                <View style={styles.subfolderGalaxyBottomInfo}>
                  <Text style={styles.subfolderGalaxyCardTitle} numberOfLines={1}>
                    Varios
                  </Text>
                  <Text style={[styles.subfolderGalaxyCardSub, { color: '#ddd6fe' }]}>
                    {smallSubfolders.length} carpetas (&lt;5)
                  </Text>
                </View>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Modal rápido para activar/desactivar subcarpetas sugeridas de sistema dentro de esta carpeta */}
        <Modal
          visible={showSubfolderSystemModal}
          transparent={true}
          animationType="slide"
          onRequestClose={() => setShowSubfolderSystemModal(false)}
          statusBarTranslucent
        >
          <View
            style={{
              flex: 1,
              backgroundColor: 'rgba(0,0,0,0.82)',
              justifyContent: 'flex-end',
            }}
          >
            <View
              style={{
                backgroundColor: '#141418',
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                padding: 18,
                gap: 12,
                maxHeight: '80%',
                borderTopWidth: 1,
                borderColor: '#2e2e36',
              }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                  <Ionicons name="hardware-chip-outline" size={22} color="#38bdf8" />
                  <Text style={{ color: '#fff', fontSize: 15.5, fontWeight: '800', flex: 1 }}>
                    Subcarpetas de sistema ({systemSubfoldersList.length})
                  </Text>
                </View>
                <TouchableOpacity onPress={() => setShowSubfolderSystemModal(false)}>
                  <Ionicons name="close" size={24} color="#fff" />
                </TouchableOpacity>
              </View>

              <Text style={{ color: '#a1a1aa', fontSize: 12, lineHeight: 17 }}>
                Estas subcarpetas fueron detectadas como de sistema o con 1-3 archivos y se desactivaron automáticamente. Toca cualquiera para activarla manualmente.
              </Text>

              <ScrollView style={{ maxHeight: 350 }} showsVerticalScrollIndicator={false}>
                {nonEmptySubfolders.map((sub) => {
                  const hidden = isSubfolderHidden(sub);
                  const sysInfo = folderService.classifySystemFolder(sub);
                  const displayLabel = folderService.formatFolderDisplayName(sub.name, sub.uri);
                  return (
                    <TouchableOpacity
                      key={`sys_sub_row_${sub.uri}`}
                      onPress={() => handleToggleSubfolderVisibility(sub)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        backgroundColor: '#1f1f25',
                        borderRadius: 12,
                        padding: 10,
                        marginBottom: 7,
                        borderWidth: 1,
                        borderColor: hidden ? 'rgba(245, 158, 11, 0.4)' : '#2e2e36',
                        opacity: hidden ? 0.75 : 1,
                      }}
                    >
                      <View style={{ flex: 1, paddingRight: 8 }}>
                        <Text style={{ color: '#fff', fontSize: 13.5, fontWeight: '700' }} numberOfLines={1}>
                          {displayLabel}
                        </Text>
                        <Text style={{ color: '#94a3b8', fontSize: 11.5 }}>
                          {sub.count || 0} archivos
                          {sysInfo.isSystemSuggested ? ` · 🤖 ${sysInfo.reason}` : ''}
                        </Text>
                      </View>
                      <View
                        style={{
                          backgroundColor: hidden ? '#52525b' : '#2563eb',
                          paddingHorizontal: 10,
                          paddingVertical: 6,
                          borderRadius: 12,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <Ionicons
                          name={hidden ? 'close-circle-outline' : 'checkmark-circle'}
                          size={14}
                          color="#fff"
                        />
                        <Text style={{ color: '#fff', fontSize: 11.5, fontWeight: '800' }}>
                          {hidden ? 'Desactivada' : 'Activada'}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>

              <TouchableOpacity
                onPress={() => setShowSubfolderSystemModal(false)}
                style={{
                  backgroundColor: '#2563eb',
                  paddingVertical: 12,
                  borderRadius: 14,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>Listo</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {paginatedAssets.length > 0 && (
          <View style={styles.filesDividerRow}>
            <Ionicons name="images-outline" size={15} color="#a1a1aa" />
            <Text style={styles.filesDividerText}>
              Archivos en esta carpeta ({totalFilteredAssets.length})
            </Text>
          </View>
        )}
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
          Agrega carpetas desde la pestaña de Álbumes y Carpetas o toca el botón de abajo para comenzar.
        </Text>
        <TouchableOpacity style={styles.primaryButton} onPress={onPickNewFolder} activeOpacity={0.8}>
          <Ionicons name="add" size={20} color="#ffffff" />
          <Text style={styles.primaryButtonText}>Agregar mi primera carpeta</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const currentFolderDisplayName = currentFolder
    ? folderService.formatFolderDisplayName(currentFolder.name, currentFolder.uri)
    : 'Carpeta';

  return (
    <View style={styles.container}>
      {/* Ruta de navegación (Breadcrumbs) si estamos dentro de una subcarpeta */}
      {history.length > 1 && (
        <View style={styles.breadcrumbBar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.breadcrumbScroll}
          >
            {history.map((h, idx) => {
              const isLast = idx === history.length - 1;
              const label = folderService.formatFolderDisplayName(h.name, h.uri);
              return (
                <View key={`bc_${h.uri}_${idx}`} style={styles.breadcrumbItem}>
                  <TouchableOpacity
                    onPress={() => handleJumpToHistory(idx)}
                    disabled={isLast}
                  >
                    <Text
                      style={[
                        styles.breadcrumbText,
                        isLast && styles.breadcrumbTextActive,
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                  {!isLast && (
                    <Ionicons name="chevron-forward" size={13} color="#71717a" />
                  )}
                </View>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* 2. RECUADROS DE LAS OPCIONES */}
      <View style={styles.optionsBoxesContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.optionsBoxesScroll}
        >
          {/* Opción A: Agregar esta carpeta exclusivamente a Fotos */}
          {currentFolder?.uri && onAssignFolderToSegment && (
            <TouchableOpacity
              style={[
                styles.optionSquareCard,
                {
                  backgroundColor: 'rgba(37, 99, 235, 0.18)',
                  borderColor: '#3b82f6',
                },
              ]}
              onPress={() => {
                onAssignFolderToSegment(currentFolder.uri, 'photos', currentFolder.name);
                Alert.alert(
                  'Carpeta agregada',
                  `"${currentFolder.name || 'Carpeta'}" se guardó en Fotos y no aparecerá en Archivos.`
                );
              }}
              activeOpacity={0.8}
            >
              <View style={styles.actionToolHeader}>
                <Ionicons name="camera" size={15} color="#60a5fa" />
                <Text
                  style={[styles.actionToolTitle, { color: '#93c5fd' }]}
                  numberOfLines={1}
                >
                  + A Fotos
                </Text>
              </View>
              <Text style={[styles.actionToolSub, { color: '#60a5fa' }]} numberOfLines={1}>
                Sección Fotos (exclusiva)
              </Text>
            </TouchableOpacity>
          )}

          {/* Opción B: Agregar esta carpeta exclusivamente a Archivos */}
          {currentFolder?.uri && onAssignFolderToSegment && (
            <TouchableOpacity
              style={[
                styles.optionSquareCard,
                {
                  backgroundColor: 'rgba(217, 119, 6, 0.18)',
                  borderColor: '#f59e0b',
                },
              ]}
              onPress={() => {
                onAssignFolderToSegment(currentFolder.uri, 'files', currentFolder.name);
                Alert.alert(
                  'Carpeta agregada',
                  `"${currentFolder.name || 'Carpeta'}" se guardó en Archivos y no aparecerá en Fotos.`
                );
              }}
              activeOpacity={0.8}
            >
              <View style={styles.actionToolHeader}>
                <Ionicons name="folder-open" size={15} color="#fbbf24" />
                <Text
                  style={[styles.actionToolTitle, { color: '#fde68a' }]}
                  numberOfLines={1}
                >
                  + A Archivos
                </Text>
              </View>
              <Text style={[styles.actionToolSub, { color: '#fbbf24' }]} numberOfLines={1}>
                Sección Archivos (exclusiva)
              </Text>
            </TouchableOpacity>
          )}

          {/* Opción 0: Modo Guardar (Deslizar Arriba = Favorito, Abajo = Papelera) */}
          {onOpenModoGuardar && (totalFilteredAssets.length > 0 || trashCount > 0) && (
            <TouchableOpacity
              style={[
                styles.optionSquareCard,
                {
                  backgroundColor:
                    trashCount > 0 ? 'rgba(244, 63, 94, 0.18)' : 'rgba(16, 185, 129, 0.16)',
                  borderColor: trashCount > 0 ? '#f43f5e' : '#10b981',
                },
              ]}
              onPress={() => onOpenModoGuardar(totalFilteredAssets, 0)}
              activeOpacity={0.8}
            >
              <View style={styles.actionToolHeader}>
                <Ionicons
                  name="swap-vertical"
                  size={15}
                  color={trashCount > 0 ? '#f43f5e' : '#10b981'}
                />
                <Text
                  style={[
                    styles.actionToolTitle,
                    { color: trashCount > 0 ? '#fda4af' : '#a7f3d0' },
                  ]}
                  numberOfLines={1}
                >
                  {trashCount > 0 ? `Modo Guardar (${trashCount} en papelera)` : 'Modo Guardar'}
                </Text>
              </View>
              <Text
                style={[
                  styles.actionToolSub,
                  { color: trashCount > 0 ? '#f43f5e' : '#10b981' },
                ]}
                numberOfLines={1}
              >
                ↑ Favorito · ↓ Papelera · 1 clic restaurar
              </Text>
            </TouchableOpacity>
          )}

          {/* Opción 1: Comprimir Fotos (disponible si hay fotos en este nivel o dentro de subcarpetas) */}
          {(folderPhotos.length > 0 || subfolders.length > 0) && (
            <TouchableOpacity
              style={[
                styles.optionSquareCard,
                {
                  backgroundColor: isCompressingFolder
                    ? 'rgba(37, 99, 235, 0.28)'
                    : folderPhotos.length > 0
                    ? photoReductionSummary.bgColor
                    : 'rgba(56, 189, 248, 0.16)',
                  borderColor: isCompressingFolder
                    ? '#38bdf8'
                    : folderPhotos.length > 0
                    ? photoReductionSummary.borderColor
                    : '#38bdf8',
                },
              ]}
              onPress={handleCompressFolder}
              disabled={isCompressingFolder}
              activeOpacity={0.8}
            >
              <View style={styles.actionToolHeader}>
                {isCompressingFolder ? (
                  <ActivityIndicator size="small" color="#38bdf8" />
                ) : (
                  <Ionicons
                    name="sparkles"
                    size={15}
                    color={folderPhotos.length > 0 ? photoReductionSummary.color : '#38bdf8'}
                  />
                )}
                <Text
                  style={[
                    styles.actionToolTitle,
                    {
                      color: isCompressingFolder
                        ? '#ffffff'
                        : folderPhotos.length > 0
                        ? photoReductionSummary.textColor || photoReductionSummary.color
                        : '#bae6fd',
                    },
                  ]}
                  numberOfLines={1}
                >
                  {isCompressingFolder
                    ? `Comprimiendo ${compressProgress?.current || 0}/${compressProgress?.total || 0} (${Math.round((compressProgress?.percent || 0) * 100)}%)`
                    : folderPhotos.length > 0
                    ? `Comprimir fotos (${photoReductionSummary.compressibleCount || folderPhotos.length})`
                    : 'Comprimir fotos'}
                </Text>
              </View>
              <Text
                style={[
                  styles.actionToolSub,
                  {
                    color: isCompressingFolder
                      ? '#38bdf8'
                      : folderPhotos.length > 0
                      ? photoReductionSummary.color
                      : '#38bdf8',
                  },
                ]}
                numberOfLines={1}
              >
                {isCompressingFolder
                  ? `Ahorrado: ${compressProgress?.savedFormatted || '0 B'}`
                  : folderPhotos.length > 0
                  ? photoReductionSummary.level === 'heavy'
                    ? `Reducción alta · -${photoReductionSummary.estimatedSavedFormatted}`
                    : photoReductionSummary.level === 'medium'
                    ? `Reducción media · -${photoReductionSummary.estimatedSavedFormatted}`
                    : `Optimizar 100% res · -${photoReductionSummary.estimatedSavedFormatted}`
                  : 'Optimizar carpetas e internas'}
              </Text>
            </TouchableOpacity>
          )}

          {/* Opción 2: Comprimir Videos */}
          {folderVideos.length > 0 && (
            <TouchableOpacity
              style={[
                styles.optionSquareCard,
                {
                  backgroundColor: videoReductionSummary.bgColor,
                  borderColor: videoReductionSummary.borderColor,
                },
              ]}
              onPress={handleCompressVideosFolder}
              disabled={isCompressingFolder}
              activeOpacity={0.8}
            >
              <View style={styles.actionToolHeader}>
                <Ionicons name="videocam" size={15} color={videoReductionSummary.color} />
                <Text
                  style={[
                    styles.actionToolTitle,
                    { color: videoReductionSummary.textColor || videoReductionSummary.color },
                  ]}
                  numberOfLines={1}
                >
                  Comprimir videos ({videoReductionSummary.compressibleCount || folderVideos.length})
                </Text>
              </View>
              <Text
                style={[styles.actionToolSub, { color: videoReductionSummary.color }]}
                numberOfLines={1}
              >
                {videoReductionSummary.level === 'heavy'
                  ? `Reducción alta · -${videoReductionSummary.estimatedSavedFormatted}`
                  : videoReductionSummary.level === 'medium'
                  ? `Reducción media · -${videoReductionSummary.estimatedSavedFormatted}`
                  : `Optimizar 100% res · -${videoReductionSummary.estimatedSavedFormatted}`}
              </Text>
            </TouchableOpacity>
          )}

          {/* Opción 3: Organizar por meses */}
          {currentFolderAssets.length > 0 && (
            <TouchableOpacity
              style={[styles.optionSquareCard, styles.actionToolCardOrganize]}
              onPress={() => setShowOrganizeConfirmModal(true)}
              activeOpacity={0.8}
            >
              <View style={styles.actionToolHeader}>
                <Ionicons name="calendar-outline" size={15} color="#a78bfa" />
                <Text style={[styles.actionToolTitle, { color: '#ddd6fe' }]} numberOfLines={1}>
                  Separar por meses
                </Text>
              </View>
              <Text style={[styles.actionToolSub, { color: '#a78bfa' }]} numberOfLines={1}>
                Mes y año · Activo en raíz
              </Text>
            </TouchableOpacity>
          )}

          {/* Opción 4: Borrar carpetas vacías */}
          {(subfolders.length > 0 || currentFolder?.uri) && (
            <TouchableOpacity
              style={[styles.optionSquareCard, styles.actionToolCardCleanEmpty]}
              onPress={handleScanEmptyFolders}
              disabled={isScanningEmpty}
              activeOpacity={0.8}
            >
              <View style={styles.actionToolHeader}>
                {isScanningEmpty ? (
                  <ActivityIndicator size="small" color="#38bdf8" />
                ) : (
                  <Ionicons name="trash-bin-outline" size={15} color="#38bdf8" />
                )}
                <Text style={[styles.actionToolTitle, { color: '#bae6fd' }]} numberOfLines={1}>
                  Borrar vacías
                </Text>
              </View>
              <Text style={[styles.actionToolSub, { color: '#38bdf8' }]} numberOfLines={1}>
                {isScanningEmpty ? 'Escaneando...' : 'Limpiar carpetas sin fotos'}
              </Text>
            </TouchableOpacity>
          )}

          {/* Opción 5: Alternar Por carpetas / Todo junto */}
          <TouchableOpacity
            style={[
              styles.optionSquareCard,
              viewMode === 'all'
                ? { backgroundColor: 'rgba(16, 185, 129, 0.16)', borderColor: '#10b981' }
                : { backgroundColor: theme.colors.surface, borderColor: theme.colors.surfaceBorder },
            ]}
            onPress={() => setViewMode(viewMode === 'folders' ? 'all' : 'folders')}
            activeOpacity={0.8}
          >
            <View style={styles.actionToolHeader}>
              <Ionicons
                name={viewMode === 'all' ? 'grid' : 'folder-open-outline'}
                size={15}
                color={viewMode === 'all' ? '#10b981' : theme.colors.textSecondary}
              />
              <Text
                style={[
                  styles.actionToolTitle,
                  { color: viewMode === 'all' ? '#a7f3d0' : '#ffffff' },
                ]}
                numberOfLines={1}
              >
                {viewMode === 'all' ? 'Viendo todo junto' : 'Todo junto'}
              </Text>
            </View>
            <Text style={[styles.actionToolSub, { color: theme.colors.textMuted }]} numberOfLines={1}>
              {viewMode === 'all' ? 'Toca para ver por nivel' : 'Unir subcarpetas aquí'}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* PANEL DE PROGRESO EN VIVO AL COMPRIMIR (Siempre visible para ver cómo avanza foto por foto) */}
      {isCompressingFolder && (
        <View
          style={{
            marginHorizontal: 12,
            marginBottom: 8,
            padding: 12,
            borderRadius: 16,
            backgroundColor: '#0f172a',
            borderWidth: 1.5,
            borderColor: '#38bdf8',
            gap: 8,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
              {isProcessPaused ? (
                <Ionicons name="pause-circle" size={22} color="#fbbf24" />
              ) : (
                <ActivityIndicator size="small" color="#38bdf8" />
              )}
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#ffffff', fontSize: 13.5, fontWeight: '800' }} numberOfLines={1}>
                  {isProcessPaused
                    ? 'Compresión en pausa'
                    : `Comprimiendo archivo ${compressProgress?.current || 1} de ${compressProgress?.total || 1} (${Math.round((compressProgress?.percent || 0) * 100)}%)`}
                </Text>
                <Text style={{ color: '#38bdf8', fontSize: 11.5, fontWeight: '600' }} numberOfLines={1}>
                  {compressProgress?.currentFile
                    ? `Procesando: ${compressProgress.currentFile}`
                    : 'Optimizando al 100% de resolución...'}
                </Text>
              </View>
            </View>

            <View
              style={{
                backgroundColor: 'rgba(16, 185, 129, 0.2)',
                borderWidth: 1,
                borderColor: '#10b981',
                paddingHorizontal: 9,
                paddingVertical: 4,
                borderRadius: 10,
              }}
            >
              <Text style={{ color: '#34d399', fontSize: 11.5, fontWeight: '800' }}>
                -{compressProgress?.savedFormatted || '0 B'}
              </Text>
            </View>
          </View>

          <View style={styles.progressBarBg}>
            <View
              style={[
                styles.progressBarFill,
                {
                  width: `${Math.max(4, Math.round((compressProgress?.percent || 0) * 100))}%`,
                  backgroundColor: '#38bdf8',
                },
              ]}
            />
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '600' }}>
              Optimizadas: {compressProgress?.compressedCount || 0}
              {compressProgress?.skippedGreenCount
                ? ` · Ligeras: ${compressProgress.skippedGreenCount}`
                : ''}
            </Text>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TouchableOpacity
                onPress={() => {
                  if (!processControlRef.current) return;
                  if (isProcessPaused) processControlRef.current.resume();
                  else processControlRef.current.pause();
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  backgroundColor: 'rgba(251, 191, 36, 0.16)',
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 10,
                }}
              >
                <Ionicons name={isProcessPaused ? 'play' : 'pause'} size={13} color="#fbbf24" />
                <Text style={{ color: '#fbbf24', fontSize: 11, fontWeight: '800' }}>
                  {isProcessPaused ? 'Reanudar' : 'Pausar'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => {
                  if (processControlRef.current) processControlRef.current.cancel();
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  backgroundColor: 'rgba(239, 68, 68, 0.16)',
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 10,
                }}
              >
                <Ionicons name="close-circle" size={13} color="#f87171" />
                <Text style={{ color: '#f87171', fontSize: 11, fontWeight: '800' }}>Detener</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* 3. RENGLÓN ÚNICO EN CARRUSEL: Carpeta Seleccionada + Buscador + Filtros Condicionales */}
      <View style={styles.stickyHeaderBox}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.singleLineCarouselRow}
          keyboardShouldPersistTaps="handled"
        >
          {/* Botón Subir Nivel si estamos en una subcarpeta */}
          {history.length > 1 && (
            <TouchableOpacity style={styles.inlineBackBtn} onPress={handleGoBack} activeOpacity={0.75}>
              <Ionicons name="arrow-back" size={14} color="#ffffff" />
            </TouchableOpacity>
          )}

          {/* Nombre de la Carpeta Seleccionada + Conteo */}
          <View style={styles.selectedFolderInlineBadge}>
            <Ionicons name="folder-open" size={14} color="#38bdf8" />
            <Text style={styles.selectedFolderInlineText} numberOfLines={1}>
              {currentFolderDisplayName} ({totalFilteredAssets.length})
            </Text>
          </View>

          {/* Filtro directo en la barra de la carpeta: Fotos (por defecto) y Videos (pueden seleccionarse ambas; si no hay fotos no aparece Fotos y si no hay videos no aparece Videos) */}
          {hasPhotos && (
            <TouchableOpacity
              style={[
                styles.weightFilterPill,
                isPhotosActive && styles.categoryFilterPillActive,
              ]}
              onPress={handleTogglePhotosChip}
              activeOpacity={0.8}
            >
              <Ionicons
                name={isPhotosActive ? 'checkmark-circle' : 'images-outline'}
                size={13}
                color={isPhotosActive ? '#fff' : theme.colors.primaryLight}
              />
              <Text
                style={[
                  styles.weightFilterText,
                  isPhotosActive && { color: '#fff', fontWeight: '800' },
                ]}
              >
                Fotos ({folderPhotos.length})
              </Text>
            </TouchableOpacity>
          )}

          {hasVideos && (
            <TouchableOpacity
              style={[
                styles.weightFilterPill,
                isVideosActive && styles.categoryFilterPillActive,
              ]}
              onPress={handleToggleVideosChip}
              activeOpacity={0.8}
            >
              <Ionicons
                name={isVideosActive ? 'checkmark-circle' : 'videocam-outline'}
                size={13}
                color={isVideosActive ? '#fff' : theme.colors.primaryLight}
              />
              <Text
                style={[
                  styles.weightFilterText,
                  isVideosActive && { color: '#fff', fontWeight: '800' },
                ]}
              >
                Videos ({folderVideos.length})
              </Text>
            </TouchableOpacity>
          )}

          {/* Buscador Compacto dentro del mismo renglón */}
          <View style={styles.inlineSearchBox}>
            <Ionicons name="search" size={13} color={theme.colors.textMuted} />
            <TextInput
              style={styles.inlineSearchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Buscar..."
              placeholderTextColor={theme.colors.textMuted}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <Ionicons name="close-circle" size={15} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            )}
          </View>

          {/* Filtros de Peso: Grandes / Medianos / Todos (SOLO si existen archivos grandes o medianos) */}
          {hasWeightFilters && (
            <>
              <TouchableOpacity
                style={[
                  styles.weightFilterPill,
                  effectiveSizeFilter === 'all' && styles.weightFilterPillActive,
                ]}
                onPress={() => setSizeFilter('all')}
              >
                <Text
                  style={[
                    styles.weightFilterText,
                    effectiveSizeFilter === 'all' && { color: '#fff', fontWeight: '800' },
                  ]}
                >
                  Todos
                </Text>
              </TouchableOpacity>

              {heavyCount > 0 && (
                <TouchableOpacity
                  style={[
                    styles.weightFilterPill,
                    effectiveSizeFilter === 'heavy' && {
                      backgroundColor: 'rgba(239, 68, 68, 0.22)',
                      borderColor: '#ef4444',
                    },
                  ]}
                  onPress={() =>
                    setSizeFilter(effectiveSizeFilter === 'heavy' ? 'all' : 'heavy')
                  }
                >
                  <View style={[styles.dotIndicator, { backgroundColor: '#ef4444' }]} />
                  <Text
                    style={[
                      styles.weightFilterText,
                      effectiveSizeFilter === 'heavy' && { color: '#fca5a5', fontWeight: '800' },
                    ]}
                  >
                    Grandes &gt;4 MB ({heavyCount})
                  </Text>
                </TouchableOpacity>
              )}

              {mediumCount > 0 && (
                <TouchableOpacity
                  style={[
                    styles.weightFilterPill,
                    effectiveSizeFilter === 'medium' && {
                      backgroundColor: 'rgba(245, 158, 11, 0.22)',
                      borderColor: '#f59e0b',
                    },
                  ]}
                  onPress={() =>
                    setSizeFilter(effectiveSizeFilter === 'medium' ? 'all' : 'medium')
                  }
                >
                  <View style={[styles.dotIndicator, { backgroundColor: '#f59e0b' }]} />
                  <Text
                    style={[
                      styles.weightFilterText,
                      effectiveSizeFilter === 'medium' && { color: '#fde68a', fontWeight: '800' },
                    ]}
                  >
                    Medianos 2-4 MB ({mediumCount})
                  </Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </ScrollView>

        {/* Barra de Selección Múltiple fija arriba si hay fotos seleccionadas */}
        {isSelecting && (
          <View style={[styles.selectionBar, { marginHorizontal: theme.spacing.md, marginTop: 4 }]}>
            <View style={styles.selectionTopRow}>
              <TouchableOpacity onPress={clearSelection} style={styles.selHeaderBtn}>
                <Ionicons name="close" size={18} color="#fff" />
                <Text style={styles.selCountText}>{selectedCount} sel.</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={selectAllFolderAssets} style={styles.selAllBtn}>
                <Ionicons name="checkmark-done" size={15} color="#38bdf8" />
                <Text style={styles.selAllText}>
                  Seleccionar todo ({totalFilteredAssets.length})
                </Text>
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
                    onSetFolderCover(selectedAssets[0], currentFolder);
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
                    {selectedReductionSummary.estimatedSavedFormatted
                      ? ` (-${selectedReductionSummary.estimatedSavedFormatted})`
                      : ''}
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.selActionBtn}
                onPress={() => setShowMoveModal(true)}
              >
                <Ionicons name="folder-open-outline" size={15} color="#f59e0b" />
                <Text style={[styles.selActionText, { color: '#f59e0b' }]}>Mover a...</Text>
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
        )}
      </View>

      {/* 4. CUADRÍCULA DE FOTOS (4 COLUMNAS POR DEFECTO + GESTO DE PELLIZCO CON 2 DEDOS) */}
      {loading && paginatedAssets.length === 0 && subfolders.length === 0 ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.loadingText}>Leyendo contenido de la carpeta…</Text>
        </View>
      ) : (
        <View
          style={{ flex: 1 }}
          onTouchStart={handleGridTouchStart}
          onTouchMove={handleGridTouchMove}
          onTouchEnd={handleGridTouchEnd}
          onTouchCancel={handleGridTouchEnd}
        >
          <FlatList
            key={`folder_grid_${photoColumns}`}
            data={paginatedAssets}
            keyExtractor={(item) => item.id}
            numColumns={photoColumns}
            contentContainerStyle={styles.photoListContent}
            initialNumToRender={16}
            maxToRenderPerBatch={16}
            windowSize={5}
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
            renderItem={renderPhotoItem}
            updateCellsBatchingPeriod={30}
            ListHeaderComponent={renderSubfoldersGridHeader}
            ListEmptyComponent={
              !loading && visibleSubfolders.length === 0 ? (
                <View style={styles.emptyContainer}>
                  <Ionicons name="images-outline" size={48} color={theme.colors.textMuted} />
                  <Text style={styles.emptyText}>
                    No hay fotos ni subcarpetas en esta ubicación.
                  </Text>
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
                <View style={{ height: 110 }} />
              )
            }
          />
        </View>
      )}

      {/* Modal de Carpetas del Sistema y Permisos */}
      <Modal
        visible={showSystemModal}
        animationType="slide"
        onRequestClose={() => setShowSystemModal(false)}
        transparent={true}
        statusBarTranslucent
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.systemModalCard}>
            <View style={styles.systemModalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Ionicons name="folder-open" size={24} color={theme.colors.accent} />
                <Text style={styles.systemModalTitle}>Carpetas del sistema</Text>
              </View>
              <TouchableOpacity onPress={() => setShowSystemModal(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={24} color="#ffffff" />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
              {/* Sección de Permiso Especial de Acceso a Todos los Archivos */}
              <View style={styles.permissionCard}>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                  <Ionicons name="key" size={24} color={theme.colors.warning} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.permissionCardTitle}>Permiso de Acceso a Todos los Archivos</Text>
                    <Text style={styles.permissionCardDesc}>
                      En Android 11+, para explorar la memoria interna completa, descargas y fotos de apps (WhatsApp, Telegram), activa este permiso en los Ajustes de tu teléfono.
                    </Text>
                  </View>
                </View>
                <TouchableOpacity
                  style={styles.permissionButton}
                  onPress={() => folderService.openAllFilesAccessSettings()}
                  activeOpacity={0.8}
                >
                  <Ionicons name="settings" size={16} color="#ffffff" />
                  <Text style={styles.permissionButtonText}>Activar permiso en Ajustes de Android</Text>
                </TouchableOpacity>
              </View>

              {/* Accesos directos a carpetas del teléfono */}
              <Text style={styles.sectionSubtitle}>Accesos directos a carpetas del teléfono:</Text>

              {COMMON_SYSTEM_FOLDERS.map((item) => {
                const isAdded = savedFolders.some((f) => f.uri === item.uri);
                return (
                  <View key={item.id} style={styles.commonFolderItem}>
                    <View style={styles.commonFolderIconWrap}>
                      <Ionicons name={item.icon} size={22} color={theme.colors.primaryLight} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.commonFolderName}>{item.name}</Text>
                      <Text style={styles.commonFolderDesc}>{item.description}</Text>
                    </View>
                    <TouchableOpacity
                      style={[
                        styles.addQuickFolderBtn,
                        isAdded && styles.addQuickFolderBtnAdded,
                      ]}
                      onPress={async () => {
                        await folderService.addSavedFolder(item.uri, item.name);
                        if (onSelectSavedFolder) onSelectSavedFolder(item.uri);
                        setShowSystemModal(false);
                      }}
                      activeOpacity={0.8}
                    >
                      <Ionicons
                        name={isAdded ? 'checkmark' : 'add'}
                        size={16}
                        color="#ffffff"
                      />
                      <Text style={styles.addQuickFolderBtnText}>
                        {isAdded ? 'Abierta' : 'Agregar'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                );
              })}

              {/* Nota explicativa de Android 11+ */}
              <View style={styles.systemNoteBox}>
                <Ionicons name="information-circle-outline" size={20} color={theme.colors.primaryLight} />
                <Text style={styles.systemNoteText}>
                  Nota: Google bloquea la carpeta Android/data a nivel de sistema por privacidad. Sin embargo, las fotos y videos de WhatsApp se ubican en Android/media (puedes abrirla directamente con el botón de WhatsApp arriba).
                </Text>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Barra Flotante de Compresión en 2do Plano (no bloquea la pantalla mientras navegas) */}
      {isCompressingFolder && isBackgroundMinimized && (
        <View style={styles.bgCompressFloatingCard}>
          <View style={styles.bgCompressTopRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
              {isProcessPaused ? (
                <Ionicons name="pause-circle" size={20} color={theme.colors.warning} />
              ) : (
                <ActivityIndicator size="small" color="#38bdf8" />
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.bgCompressTitle} numberOfLines={1}>
                  {isProcessPaused
                    ? 'Compresión en pausa (2do plano)'
                    : `Comprimiendo en 2do plano (${compressProgress?.current || 0}/${compressProgress?.total || 0})`}
                </Text>
                <Text style={styles.bgCompressSub} numberOfLines={1}>
                  Ahorrado: {compressProgress?.savedFormatted || '0 B'}
                  {compressProgress?.skippedGreenCount > 0
                    ? ` · ${compressProgress.skippedGreenCount} en verde omitidas`
                    : ''}
                </Text>
              </View>
            </View>

            <View style={styles.bgCompressBtnsRow}>
              <TouchableOpacity
                style={styles.bgCompressIconBtn}
                onPress={() => {
                  if (!processControlRef.current) return;
                  if (isProcessPaused) processControlRef.current.resume();
                  else processControlRef.current.pause();
                }}
              >
                <Ionicons
                  name={isProcessPaused ? 'play' : 'pause'}
                  size={16}
                  color={isProcessPaused ? '#10b981' : theme.colors.warning}
                />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.bgCompressIconBtn}
                onPress={() => setIsBackgroundMinimized(false)}
              >
                <Ionicons name="expand-outline" size={16} color="#38bdf8" />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.bgCompressIconBtn}
                onPress={() => {
                  if (processControlRef.current) processControlRef.current.cancel();
                }}
              >
                <Ionicons name="close" size={16} color={theme.colors.danger} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.bgCompressBarTrack}>
            <View
              style={[
                styles.bgCompressBarFill,
                {
                  width: `${Math.round((compressProgress?.percent || 0) * 100)}%`,
                  backgroundColor: isProcessPaused ? theme.colors.warning : '#38bdf8',
                },
              ]}
            />
          </View>
        </View>
      )}

      {/* Modal de Progreso de Compresión de Carpeta (solo si el usuario lo expande) */}
      <Modal
        visible={isCompressingFolder && !isBackgroundMinimized}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsBackgroundMinimized(true)}
        statusBarTranslucent
      >
        <View style={styles.progressModalBackdrop}>
          <View style={styles.progressModalCard}>
            <Ionicons
              name={isProcessPaused ? 'pause-circle' : 'sparkles'}
              size={36}
              color={isProcessPaused ? theme.colors.warning : '#38bdf8'}
            />
            <Text style={styles.progressModalTitle}>
              {isProcessPaused ? 'Compresión en pausa' : 'Comprimiendo archivos...'}
            </Text>
            <Text style={styles.progressModalSubtitle}>
              {isProcessPaused
                ? 'Puedes reanudar cuando quieras o minimizar para seguir navegando'
                : 'Manteniendo el 100% de la resolución original sin pérdida'}
            </Text>

            {compressProgress && (
              <View style={{ width: '100%', marginTop: 14 }}>
                <View style={styles.progressBarBg}>
                  <View
                    style={[
                      styles.progressBarFill,
                      {
                        width: `${Math.round((compressProgress.percent || 0) * 100)}%`,
                        backgroundColor: isProcessPaused ? theme.colors.warning : '#38bdf8',
                      },
                    ]}
                  />
                </View>
                <Text style={styles.progressPercentText}>
                  {compressProgress.current} de {compressProgress.total} ({Math.round((compressProgress.percent || 0) * 100)}%)
                  {compressProgress.skippedGreenCount > 0
                    ? ` · ${compressProgress.skippedGreenCount} en verde omitidas`
                    : ''}
                </Text>
                <Text style={styles.progressSavedText}>
                  Espacio ahorrado: {compressProgress.savedFormatted}
                </Text>
              </View>
            )}

            <TouchableOpacity
              style={styles.minimizeToBgBtn}
              onPress={() => setIsBackgroundMinimized(true)}
              activeOpacity={0.85}
            >
              <Ionicons name="layers-outline" size={16} color="#38bdf8" />
              <Text style={styles.minimizeToBgBtnText}>
                Seguir en 2do plano mientras navego
              </Text>
            </TouchableOpacity>

            <View style={styles.processModalBtnRow}>
              <TouchableOpacity
                style={[styles.processPauseBtn, isProcessPaused && styles.processResumeBtn]}
                onPress={() => {
                  if (!processControlRef.current) return;
                  if (isProcessPaused) processControlRef.current.resume();
                  else processControlRef.current.pause();
                }}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={isProcessPaused ? 'play' : 'pause'}
                  size={16}
                  color={isProcessPaused ? '#ffffff' : theme.colors.warning}
                />
                <Text style={[styles.processPauseBtnText, isProcessPaused && { color: '#ffffff' }]}>
                  {isProcessPaused ? 'Reanudar' : 'Pausar'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.processCancelBtn}
                onPress={() => {
                  if (processControlRef.current) processControlRef.current.cancel();
                }}
                activeOpacity={0.8}
              >
                <Ionicons name="close-circle-outline" size={16} color={theme.colors.danger} />
                <Text style={styles.processCancelBtnText}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Modal del Escáner Inteligente de Carpetas Sugeridas */}
      <Modal
        visible={showScannerModal}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowScannerModal(false)}
        statusBarTranslucent
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.systemModalCard}>
            <View style={styles.systemModalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                <Ionicons name="scan-circle" size={26} color="#38bdf8" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.systemModalTitle}>Escáner de Carpetas</Text>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>
                    Carpetas con fotos o videos encontradas en tu teléfono
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => setShowScannerModal(false)}>
                <Ionicons name="close" size={24} color="#ffffff" />
              </TouchableOpacity>
            </View>

            {isScanningFolders ? (
              <View style={{ paddingVertical: 36, alignItems: 'center', gap: 10 }}>
                <ActivityIndicator size="large" color="#38bdf8" />
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>
                  Escaneando carpetas del teléfono...
                </Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                  {scanProgressInfo?.foundCount || 0} carpetas sugeridas encontradas
                </Text>
                {scanProgressInfo?.currentFolder ? (
                  <Text style={{ color: '#38bdf8', fontSize: 11 }} numberOfLines={1}>
                    Revisando: {scanProgressInfo.currentFolder}
                  </Text>
                ) : null}
              </View>
            ) : suggestedFolders.length === 0 ? (
              <View style={{ paddingVertical: 32, alignItems: 'center', gap: 10 }}>
                <Ionicons name="checkmark-done-circle-outline" size={48} color="#10b981" />
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center' }}>
                  ¡Ya tienes todas las carpetas principales agregadas!
                </Text>
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    fontSize: 12,
                    textAlign: 'center',
                    paddingHorizontal: 16,
                  }}
                >
                  Si no ves carpetas de WhatsApp o descargas, verifica que el Permiso de Acceso a Todos los Archivos esté activo en Ajustes.
                </Text>
              </View>
            ) : (
              <>
                <View style={styles.scannerSelectionToolbar}>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                    {Object.keys(selectedSuggestedUris).length} de {suggestedFolders.length} seleccionadas
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <TouchableOpacity
                      onPress={() => {
                        const all = {};
                        suggestedFolders.forEach((f) => {
                          all[f.uri] = true;
                        });
                        setSelectedSuggestedUris(all);
                      }}
                    >
                      <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: '700' }}>
                        Marcar todas
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setSelectedSuggestedUris({})}>
                      <Text style={{ color: theme.colors.textMuted, fontSize: 12, fontWeight: '600' }}>
                        Ninguna
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <ScrollView
                  showsVerticalScrollIndicator={false}
                  style={{ maxHeight: 360 }}
                  contentContainerStyle={{ gap: 8, paddingBottom: 12 }}
                >
                  {suggestedFolders.map((item) => {
                    const isChecked = Boolean(selectedSuggestedUris[item.uri]);
                    return (
                      <TouchableOpacity
                        key={item.uri}
                        style={[
                          styles.commonFolderItem,
                          isChecked && {
                            borderColor: '#38bdf8',
                            backgroundColor: 'rgba(56, 189, 248, 0.12)',
                          },
                        ]}
                        onPress={() => toggleSuggestedFolderUri(item.uri)}
                        activeOpacity={0.75}
                      >
                        <Ionicons
                          name={isChecked ? 'checkbox' : 'square-outline'}
                          size={22}
                          color={isChecked ? '#38bdf8' : theme.colors.textMuted}
                        />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.commonFolderName} numberOfLines={1}>
                            {item.name}
                          </Text>
                          <Text style={styles.commonFolderDesc} numberOfLines={1}>
                            {item.relativePath}
                          </Text>
                        </View>
                        <View style={styles.scannerCountBadges}>
                          {item.photoCount > 0 && (
                            <View style={styles.scannerCountPill}>
                              <Ionicons name="image" size={11} color="#a78bfa" />
                              <Text style={styles.scannerCountText}>{item.photoCount}</Text>
                            </View>
                          )}
                          {item.videoCount > 0 && (
                            <View style={styles.scannerCountPill}>
                              <Ionicons name="videocam" size={11} color="#38bdf8" />
                              <Text style={styles.scannerCountText}>{item.videoCount}</Text>
                            </View>
                          )}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>

                <TouchableOpacity
                  style={[
                    styles.confirmOrganizeBtn,
                    { backgroundColor: '#0284c7', marginTop: 10 },
                    Object.keys(selectedSuggestedUris).length === 0 && { opacity: 0.45 },
                  ]}
                  disabled={Object.keys(selectedSuggestedUris).length === 0}
                  onPress={handleAddSelectedSuggestedFolders}
                  activeOpacity={0.85}
                >
                  <Ionicons name="add-circle" size={18} color="#fff" />
                  <Text style={styles.confirmOrganizeBtnText}>
                    Agregar carpetas seleccionadas ({Object.keys(selectedSuggestedUris).length})
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Modal de Confirmación para Eliminar Carpetas Vacías */}
      <Modal
        visible={showEmptyFoldersModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowEmptyFoldersModal(false)}
        statusBarTranslucent
      >
        <View style={styles.progressModalBackdrop}>
          <View style={[styles.progressModalCard, { maxWidth: 360 }]}>
            <Ionicons name="trash-bin" size={38} color={theme.colors.danger} />
            <Text style={styles.progressModalTitle}>
              {emptyFoldersFound.length}{' '}
              {emptyFoldersFound.length === 1 ? 'carpeta vacía encontrada' : 'carpetas vacías encontradas'}
            </Text>
            <Text style={styles.progressModalSubtitle}>
              Estas subcarpetas no contienen ninguna foto ni video:
            </Text>

            <ScrollView
              style={{ width: '100%', maxHeight: 180, marginTop: 12 }}
              contentContainerStyle={{ gap: 6 }}
            >
              {emptyFoldersFound.map((f, idx) => (
                <View
                  key={f.uri + idx}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    backgroundColor: theme.colors.background,
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                    borderRadius: 8,
                  }}
                >
                  <Ionicons name="folder-open-outline" size={16} color={theme.colors.textMuted} />
                  <Text style={{ color: '#fff', fontSize: 12, flex: 1 }} numberOfLines={1}>
                    {f.name}
                  </Text>
                </View>
              ))}
            </ScrollView>

            <View style={{ width: '100%', gap: 8, marginTop: 16 }}>
              <TouchableOpacity
                style={[styles.confirmOrganizeBtn, { backgroundColor: theme.colors.danger }]}
                onPress={handleConfirmDeleteEmptyFolders}
                activeOpacity={0.85}
              >
                <Ionicons name="trash" size={17} color="#fff" />
                <Text style={styles.confirmOrganizeBtnText}>
                  Eliminar todas las vacías ({emptyFoldersFound.length})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cancelOrganizeBtn}
                onPress={() => setShowEmptyFoldersModal(false)}
              >
                <Text style={styles.cancelOrganizeBtnText}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Modal de Confirmación para Organizar Cámara por Meses Físicamente */}
      <Modal
        visible={showOrganizeConfirmModal}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowOrganizeConfirmModal(false)}
        statusBarTranslucent
      >
        <View style={styles.progressModalBackdrop}>
          <View style={[styles.progressModalCard, { maxWidth: 360 }]}>
            <Ionicons name="calendar" size={40} color={theme.colors.warning} />
            <Text style={styles.progressModalTitle}>Dividir y Organizar por Meses</Text>
            <Text style={styles.progressModalSubtitle}>
              Creará físicamente una carpeta para cada mes (ej. 2026-10_Octubre) y dentro de ella dividirá automáticamente las subcarpetas "Fotos" y "Videos".
            </Text>
            <View style={{ width: '100%', gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                style={styles.confirmOrganizeBtn}
                onPress={() => handleOrganizeCamera(false)}
                activeOpacity={0.8}
              >
                <Ionicons name="folder" size={18} color="#ffffff" />
                <Text style={styles.confirmOrganizeBtnText}>Organizar TODOS los meses en carpetas</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmOrganizeBtn, { backgroundColor: theme.colors.primary }]}
                onPress={() => handleOrganizeCamera(true)}
                activeOpacity={0.8}
              >
                <Ionicons name="calendar-outline" size={18} color="#ffffff" />
                <Text style={styles.confirmOrganizeBtnText}>Dejar mes actual en raíz y mover anteriores</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cancelOrganizeBtn}
                onPress={() => setShowOrganizeConfirmModal(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.cancelOrganizeBtnText}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Modal de Progreso de Organización de Cámara */}
      <Modal
        visible={isOrganizingCamera}
        transparent={true}
        animationType="fade"
        statusBarTranslucent
      >
        <View style={styles.progressModalBackdrop}>
          <View style={styles.progressModalCard}>
            {isProcessPaused ? (
              <Ionicons name="pause-circle" size={40} color={theme.colors.warning} />
            ) : (
              <ActivityIndicator size="large" color={theme.colors.warning} />
            )}
            <Text style={styles.progressModalTitle}>
              {isProcessPaused ? 'Organización en pausa' : 'Organizando carpetas físicas...'}
            </Text>
            <Text style={styles.progressModalSubtitle}>
              {isProcessPaused
                ? 'Puedes reanudar cuando quieras o cancelar el proceso'
                : 'Moviendo fotos y videos a sus respectivas carpetas de mes'}
            </Text>

            {organizeProgress && (
              <View style={{ width: '100%', marginTop: 14 }}>
                <View style={styles.progressBarBg}>
                  <View
                    style={[
                      styles.progressBarFill,
                      {
                        width: `${Math.round((organizeProgress.percent || 0) * 100)}%`,
                        backgroundColor: theme.colors.warning,
                      },
                    ]}
                  />
                </View>
                <Text style={styles.progressPercentText}>
                  {organizeProgress.current} de {organizeProgress.total} archivos ({Math.round((organizeProgress.percent || 0) * 100)}%)
                </Text>
                {organizeProgress.currentMonth ? (
                  <Text style={styles.progressSavedText}>
                    Carpeta: {organizeProgress.currentMonth}
                  </Text>
                ) : null}
              </View>
            )}

            <View style={styles.processModalBtnRow}>
              <TouchableOpacity
                style={[styles.processPauseBtn, isProcessPaused && styles.processResumeBtn]}
                onPress={() => {
                  if (!processControlRef.current) return;
                  if (isProcessPaused) processControlRef.current.resume();
                  else processControlRef.current.pause();
                }}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={isProcessPaused ? 'play' : 'pause'}
                  size={16}
                  color={isProcessPaused ? '#ffffff' : theme.colors.warning}
                />
                <Text style={[styles.processPauseBtnText, isProcessPaused && { color: '#ffffff' }]}>
                  {isProcessPaused ? 'Reanudar' : 'Pausar'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.processCancelBtn}
                onPress={() => {
                  if (processControlRef.current) processControlRef.current.cancel();
                }}
                activeOpacity={0.8}
              >
                <Ionicons name="close-circle-outline" size={16} color={theme.colors.danger} />
                <Text style={styles.processCancelBtnText}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Modal para Mover Archivos Seleccionados a Otra Carpeta */}
      <Modal
        visible={showMoveModal}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowMoveModal(false)}
        statusBarTranslucent
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.systemModalCard}>
            <View style={styles.systemModalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Ionicons name="folder-open" size={22} color="#f59e0b" />
                <Text style={styles.systemModalTitle}>
                  Mover {selectedCount} {selectedCount === 1 ? 'archivo' : 'archivos'} a...
                </Text>
              </View>
              <TouchableOpacity onPress={() => setShowMoveModal(false)}>
                <Ionicons name="close" size={24} color="#ffffff" />
              </TouchableOpacity>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: 24, gap: 10 }}
            >
              {/* Crear una subcarpeta nueva dentro de la carpeta actual */}
              {currentFolder?.uri && (
                <View style={styles.newSubfolderCard}>
                  <Text style={styles.sectionSubtitle}>
                    Crear subcarpeta nueva en &quot;{currentFolder.name}&quot;:
                  </Text>
                  <View style={styles.newSubfolderInputRow}>
                    <TextInput
                      style={styles.newSubfolderInput}
                      value={newSubfolderName}
                      onChangeText={setNewSubfolderName}
                      placeholder="Ej. Favoritas, Trabajo, Privadas..."
                      placeholderTextColor={theme.colors.textMuted}
                    />
                    <TouchableOpacity
                      style={[
                        styles.createAndMoveBtn,
                        !newSubfolderName.trim() && { opacity: 0.45 },
                      ]}
                      disabled={!newSubfolderName.trim()}
                      onPress={() =>
                        handleMoveSelectedTo(
                          currentFolder.uri,
                          newSubfolderName.trim(),
                          newSubfolderName.trim()
                        )
                      }
                    >
                      <Ionicons name="add-circle" size={16} color="#fff" />
                      <Text style={styles.createAndMoveBtnText}>Crear y mover</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* Subcarpetas del nivel actual */}
              {subfolders.length > 0 && (
                <>
                  <Text style={styles.sectionSubtitle}>Subcarpetas aquí:</Text>
                  {subfolders.map((sub) => (
                    <TouchableOpacity
                      key={sub.uri}
                      style={styles.commonFolderItem}
                      onPress={() => handleMoveSelectedTo(sub.uri, '', sub.name)}
                    >
                      <View style={styles.commonFolderIconWrap}>
                        <Ionicons name="folder" size={20} color="#f59e0b" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.commonFolderName}>{sub.name}</Text>
                      </View>
                      <Ionicons name="arrow-forward-circle" size={22} color="#38bdf8" />
                    </TouchableOpacity>
                  ))}
                </>
              )}

              {/* Carpetas guardadas y del sistema */}
              <Text style={styles.sectionSubtitle}>Otras carpetas disponibles:</Text>
              {savedFolders.map((f) => (
                <TouchableOpacity
                  key={f.uri}
                  style={styles.commonFolderItem}
                  onPress={() => handleMoveSelectedTo(f.uri, '', f.name)}
                >
                  <View style={styles.commonFolderIconWrap}>
                    <Ionicons name="folder-open" size={20} color={theme.colors.primaryLight} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.commonFolderName}>{f.name}</Text>
                  </View>
                  <Ionicons name="arrow-forward-circle" size={22} color="#38bdf8" />
                </TouchableOpacity>
              ))}
            </ScrollView>
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
  systemFolderChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
  },
  systemFolderChipText: {
    color: theme.colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'flex-end',
  },
  systemModalCard: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '85%',
    padding: 18,
    borderTopWidth: 1,
    borderTopColor: theme.colors.surfaceBorder,
  },
  systemModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  systemModalTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
  permissionCard: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  permissionCardTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  permissionCardDesc: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 10,
  },
  permissionButton: {
    backgroundColor: theme.colors.warning,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  permissionButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  sectionSubtitle: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 10,
  },
  commonFolderItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.colors.background,
    padding: 12,
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  commonFolderIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: theme.colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  commonFolderName: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  commonFolderDesc: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  addQuickFolderBtn: {
    backgroundColor: theme.colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  addQuickFolderBtnAdded: {
    backgroundColor: '#10b981',
  },
  addQuickFolderBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  systemNoteBox: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: theme.colors.surfaceHover,
    padding: 12,
    borderRadius: 8,
    marginTop: 10,
    alignItems: 'flex-start',
  },
  systemNoteText: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    flex: 1,
    lineHeight: 16,
  },
  divisionBar: {
    backgroundColor: theme.colors.surface,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
    gap: 8,
  },
  categorySegmentRow: {
    flexDirection: 'row',
    gap: 8,
  },
  categoryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: theme.colors.surfaceHover,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  categoryPillActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primaryLight,
  },
  categoryPillText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  categoryPillTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  actionToolsRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  actionToolButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  actionToolButtonOrganize: {
    borderColor: 'rgba(245, 158, 11, 0.4)',
  },
  actionToolButtonText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
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
  confirmOrganizeBtn: {
    backgroundColor: theme.colors.warning,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
  },
  confirmOrganizeBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  cancelOrganizeBtn: {
    backgroundColor: theme.colors.surfaceHover,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  cancelOrganizeBtnText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  processModalBtnRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
    marginTop: 18,
  },
  processPauseBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(245, 158, 11, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.4)',
  },
  processResumeBtn: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  processPauseBtnText: {
    color: theme.colors.warning,
    fontSize: 13,
    fontWeight: '700',
  },
  processCancelBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  processCancelBtnText: {
    color: theme.colors.danger,
    fontSize: 13,
    fontWeight: '700',
  },
  stickyHeaderBox: {
    backgroundColor: theme.colors.background,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
    paddingBottom: 6,
    zIndex: 10,
  },
  searchAndQuickFilterBox: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 2,
    gap: 8,
  },
  searchInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  searchInput: {
    flex: 1,
    color: '#ffffff',
    fontSize: 12,
    paddingVertical: 2,
  },
  quickFilterScroll: {
    gap: 6,
    alignItems: 'center',
  },
  colTogglePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
  },
  colToggleText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '800',
  },
  weightFilterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  weightFilterPillActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  categoryFilterPillActive: {
    backgroundColor: 'rgba(139, 92, 246, 0.35)',
    borderColor: theme.colors.primaryLight,
  },
  weightFilterText: {
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  dotIndicator: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  newSubfolderCard: {
    backgroundColor: 'rgba(245, 158, 11, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
    borderRadius: 12,
    padding: 10,
    gap: 8,
  },
  newSubfolderInputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  newSubfolderInput: {
    flex: 1,
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 8,
    color: '#fff',
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  createAndMoveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#d97706',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  createAndMoveBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
  scannerFolderChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(56, 189, 248, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.45)',
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 20,
  },
  scannerFolderChipText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '800',
  },
  actionToolsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  actionToolCard: {
    flexGrow: 1,
    flexBasis: '47%',
    minWidth: 145,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
    gap: 3,
  },
  actionToolCardOrganize: {
    backgroundColor: 'rgba(139, 92, 246, 0.14)',
    borderColor: 'rgba(139, 92, 246, 0.4)',
  },
  actionToolCardCleanEmpty: {
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderColor: 'rgba(56, 189, 248, 0.35)',
  },
  actionToolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionToolTitle: {
    fontSize: 12,
    fontWeight: '800',
    flex: 1,
  },
  actionToolSub: {
    fontSize: 10,
    fontWeight: '600',
  },
  bgCompressFloatingCard: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.96)',
    borderWidth: 1,
    borderColor: '#38bdf8',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    zIndex: 50,
  },
  bgCompressTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  bgCompressTitle: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  bgCompressSub: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 1,
  },
  bgCompressBtnsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bgCompressIconBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bgCompressBarTrack: {
    height: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    borderRadius: 3,
    overflow: 'hidden',
    width: '100%',
  },
  bgCompressBarFill: {
    height: '100%',
    borderRadius: 3,
  },
  minimizeToBgBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    width: '100%',
    marginTop: 14,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
  },
  minimizeToBgBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
  },
  scannerSelectionToolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
    marginBottom: 8,
  },
  scannerCountBadges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  scannerCountPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
  },
  scannerCountText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  coverFolderCard: {
    width: 82,
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceHover,
    borderRadius: 12,
    padding: 5,
    borderWidth: 1.5,
    borderColor: theme.colors.surfaceBorder,
    gap: 4,
  },
  coverFolderCardActive: {
    borderColor: theme.colors.primary,
    backgroundColor: 'rgba(139, 92, 246, 0.22)',
  },
  coverFolderCardParent: {
    borderColor: '#38bdf8',
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
  },
  coverThumbBox: {
    width: 70,
    height: 54,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: theme.colors.background,
    position: 'relative',
  },
  coverThumbImg: {
    width: '100%',
    height: '100%',
  },
  coverThumbPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
  },
  coverFolderBadge: {
    position: 'absolute',
    bottom: 3,
    left: 3,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    borderRadius: 6,
    paddingHorizontal: 4,
    paddingVertical: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverRemoveBadge: {
    position: 'absolute',
    top: 3,
    right: 3,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    borderRadius: 9,
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverFolderTitle: {
    color: theme.colors.textSecondary,
    fontSize: 10.5,
    fontWeight: '700',
    textAlign: 'center',
    width: '100%',
  },
  coverFolderTitleActive: {
    color: '#ffffff',
    fontWeight: '800',
  },
  optionsBoxesContainer: {
    backgroundColor: theme.colors.background,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
    paddingVertical: 6,
  },
  optionsBoxesScroll: {
    paddingHorizontal: 10,
    gap: 8,
    alignItems: 'center',
  },
  optionSquareCard: {
    minWidth: 138,
    maxWidth: 175,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 11,
    borderWidth: 1,
    gap: 2,
  },
  singleLineCarouselRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 4,
    gap: 7,
  },
  inlineBackBtn: {
    backgroundColor: theme.colors.primary,
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedFolderInlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 9,
  },
  selectedFolderInlineText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
    maxWidth: 160,
  },
  inlineSearchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 9,
    paddingHorizontal: 9,
    height: 29,
    minWidth: 125,
    maxWidth: 175,
  },
  inlineSearchInput: {
    flex: 1,
    color: '#ffffff',
    fontSize: 11.5,
    paddingVertical: 0,
  },
  breadcrumbBar: {
    backgroundColor: '#09090b',
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
    paddingVertical: 6,
  },
  breadcrumbScroll: {
    paddingHorizontal: 12,
    alignItems: 'center',
    gap: 6,
  },
  breadcrumbItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  breadcrumbText: {
    color: '#a1a1aa',
    fontSize: 12,
    fontWeight: '600',
  },
  breadcrumbTextActive: {
    color: '#60a5fa',
    fontWeight: '800',
  },
  subfoldersGalaxySection: {
    paddingHorizontal: SUBFOLDER_SIDE_PADDING,
    paddingTop: 10,
    paddingBottom: 8,
  },
  subfoldersGalaxyHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  subfoldersGalaxyTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
  },
  subfoldersGalaxyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SUBFOLDER_GAP,
  },
  subfolderGalaxyCard: {
    width: SUBFOLDER_CARD_WIDTH,
    height: SUBFOLDER_CARD_HEIGHT,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#222226',
    position: 'relative',
  },
  subfolderGalaxyImg: {
    width: '100%',
    height: '100%',
  },
  subfolderGalaxyScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '52%',
    backgroundColor: 'rgba(0, 0, 0, 0.56)',
  },
  subfolderGalaxyTopBadge: {
    position: 'absolute',
    top: 7,
    left: 7,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  subfolderGalaxyEyeBtn: {
    position: 'absolute',
    top: 7,
    right: 7,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  subfolderGalaxyBottomInfo: {
    position: 'absolute',
    left: 6,
    right: 6,
    bottom: 8,
    alignItems: 'center',
  },
  subfolderGalaxyCardTitle: {
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: '700',
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  subfolderGalaxyCardSub: {
    color: '#d4d4d8',
    fontSize: 11,
    marginTop: 1,
    textAlign: 'center',
  },
  filesDividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 14,
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  filesDividerText: {
    color: '#e4e4e7',
    fontSize: 13.5,
    fontWeight: '700',
  },
});
