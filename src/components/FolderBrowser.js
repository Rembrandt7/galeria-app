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
  Platform,
  ScrollView,
  Alert,
  Modal,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { theme } from '../constants/theme';
import { folderService, COMMON_SYSTEM_FOLDERS } from '../services/folderService';
import { compressionService } from '../services/compressionService';
import { videoEngineService } from '../services/videoEngineService';
import { cameraOrganizerService } from '../services/cameraOrganizerService';
import { mediaService } from '../services/mediaService';
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

const BATCH_SIZE = 90; // Tamaño de carga parcial progresiva

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
  // Modal de carpetas del sistema y permisos especiales
  const [showSystemModal, setShowSystemModal] = useState(false);

  // División y categoría interna: 'all' | 'photos' | 'videos'
  const [folderCategory, setFolderCategory] = useState('all');
  // Compresión de carpeta completa
  const [isCompressingFolder, setIsCompressingFolder] = useState(false);
  const [compressProgress, setCompressProgress] = useState(null);
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
  const [photoColumns, setPhotoColumns] = useState(NUM_PHOTO_COLUMNS);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [newSubfolderName, setNewSubfolderName] = useState('');

  const dynamicPhotoSize = useMemo(
    () => Math.floor((SCREEN_WIDTH - PHOTO_MARGIN * (photoColumns * 2)) / photoColumns),
    [photoColumns]
  );

  const cyclePhotoColumns = () => {
    setPhotoColumns((prev) => (prev === 3 ? 4 : prev === 4 ? 2 : 3));
  };

  const selectedCount = useMemo(() => Object.keys(selectedIds).length, [selectedIds]);
  const isSelecting = selectedCount > 0;
  const isSelectingRef = useRef(isSelecting);
  isSelectingRef.current = isSelecting;

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

  // División entre Fotos y Videos
  const rawFolderList = viewMode === 'folders' ? currentFolderAssets : allAssets;
  const folderPhotos = useMemo(
    () => rawFolderList.filter((a) => a.mediaType === 'photo'),
    [rawFolderList]
  );
  const folderVideos = useMemo(
    () => rawFolderList.filter((a) => a.mediaType === 'video'),
    [rawFolderList]
  );

  // Lista total filtrada (photos | videos | all + buscador por texto + filtro por peso)
  const totalFilteredAssets = useMemo(() => {
    let base =
      folderCategory === 'photos' || filterType === 'photos'
        ? folderPhotos
        : folderCategory === 'videos' || filterType === 'videos'
        ? folderVideos
        : [...folderPhotos, ...folderVideos];

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      base = base.filter((a) => (a.filename || '').toLowerCase().includes(q));
    }

    if (sizeFilter === 'heavy') {
      base = base.filter((a) => (a.fileSize || 0) > 4 * 1024 * 1024);
    } else if (sizeFilter === 'medium') {
      base = base.filter((a) => {
        const sz = a.fileSize || 0;
        return sz > 2 * 1024 * 1024 && sz <= 4 * 1024 * 1024;
      });
    }

    return base;
  }, [folderCategory, filterType, folderPhotos, folderVideos, searchQuery, sizeFilter]);

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
      `¿Deseas optimizar las ${targetPhotos.length} fotos encontradas sin perder resolución?\n\n• Las fotos que ya estén en Verde (≤ 2 MB) se omitirán automáticamente.\n• Solo se comprimirán las que estén en Naranja o Rojo manteniendo el 100% de su resolución.`,
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
              const skippedMsg =
                res.skippedGreenCount > 0
                  ? `\nOmitidas por estar en Verde: ${res.skippedGreenCount}`
                  : '';
              Alert.alert(
                res.cancelled ? 'Proceso cancelado' : '¡Compresión finalizada!',
                `Fotos comprimidas (Naranja/Rojo): ${res.compressedCount || 0} de ${targetPhotos.length}${skippedMsg}\n\nEspacio total ahorrado: ${compressionService.formatBytes(res.totalSavedBytes)}.`
              );
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
  const handleCompressVideosFolder = () => {
    if (folderVideos.length === 0) {
      Alert.alert('Sin videos', 'No hay videos en esta vista para comprimir.');
      return;
    }

    Alert.alert(
      'Comprimir videos (100% Resolución)',
      `¿Deseas comprimir los ${folderVideos.length} videos de esta carpeta manteniendo el 100% de su resolución original y reemplazando cada original sin duplicados?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Comprimir videos',
          onPress: async () => {
            const ctrl = createProcessController();
            setIsCompressingFolder(true);
            setCompressProgress({
              current: 0,
              total: folderVideos.length,
              percent: 0,
              savedFormatted: '0 B',
            });
            try {
              const res = await videoEngineService.compressVideosBatch(folderVideos, {
                presetId: 'balanced',
                onProgress: (prog) => setCompressProgress(prog),
                control: ctrl,
              });
              Alert.alert(
                res.cancelled ? 'Proceso cancelado' : '¡Videos comprimidos!',
                `Se optimizaron ${res.compressedCount} de ${folderVideos.length} videos al 100% de su resolución original.\n\nEspacio total ahorrado: ${compressionService.formatBytes(res.totalSavedBytes)}.`
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

  const renderPhotoItem = useCallback(
    ({ item }) => (
      <PhotoThumbnail
        asset={item}
        size={dynamicPhotoSize}
        onPress={handlePressPhoto}
        onLongPress={handleLongPressPhoto}
        isFavorite={Boolean(favorites[item.id])}
        selectable={isSelecting}
        isSelected={Boolean(selectedIds[item.id])}
      />
    ),
    [favorites, handlePressPhoto, handleLongPressPhoto, isSelecting, selectedIds, dynamicPhotoSize]
  );

  // Notificar al componente padre los assets totales visibles
  useEffect(() => {
    if (onAssetsChange) {
      onAssetsChange(totalFilteredAssets);
    }
  }, [totalFilteredAssets, onAssetsChange]);

  // Subcarpetas visibles filtradas por el modo oculto y buscador
  const visibleSubfolders = useMemo(() => {
    const base = showAllFolders
      ? subfolders
      : subfolders.filter((item) => !(hiddenFolders[item.uri] || hiddenFolders[item.name]));
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((item) => (item.name || '').toLowerCase().includes(q));
  }, [subfolders, hiddenFolders, showAllFolders, searchQuery]);

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

          {/* Botón Carpetas del Sistema / Acceso Especial */}
          <TouchableOpacity
            style={styles.systemFolderChip}
            onPress={() => setShowSystemModal(true)}
            activeOpacity={0.8}
          >
            <Ionicons name="shield-checkmark" size={16} color={theme.colors.accent} />
            <Text style={styles.systemFolderChipText}>Carpetas del sistema</Text>
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
          key={`folder_grid_${photoColumns}`}
          data={paginatedAssets}
          keyExtractor={(item) => item.id}
          numColumns={photoColumns}
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
                /* Sección de Subcarpetas */
                visibleSubfolders.length > 0 && (
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
                )
              )}

              {/* Buscador instantáneo + Filtro por Semáforo de Peso + Selector de Columnas */}
              <View style={styles.searchAndQuickFilterBox}>
                <View style={styles.searchInputWrap}>
                  <Ionicons name="search" size={15} color={theme.colors.textMuted} />
                  <TextInput
                    style={styles.searchInput}
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder="Buscar carpeta, foto o fecha..."
                    placeholderTextColor={theme.colors.textMuted}
                  />
                  {searchQuery.length > 0 && (
                    <TouchableOpacity onPress={() => setSearchQuery('')}>
                      <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                    </TouchableOpacity>
                  )}
                </View>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.quickFilterScroll}
                >
                  <TouchableOpacity
                    style={styles.colTogglePill}
                    onPress={cyclePhotoColumns}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="grid-outline" size={13} color="#38bdf8" />
                    <Text style={styles.colToggleText}>{photoColumns} col</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.weightFilterPill,
                      sizeFilter === 'all' && styles.weightFilterPillActive,
                    ]}
                    onPress={() => setSizeFilter('all')}
                  >
                    <Text
                      style={[
                        styles.weightFilterText,
                        sizeFilter === 'all' && { color: '#fff', fontWeight: '800' },
                      ]}
                    >
                      Todos los pesos
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.weightFilterPill,
                      sizeFilter === 'heavy' && {
                        backgroundColor: 'rgba(239, 68, 68, 0.22)',
                        borderColor: '#ef4444',
                      },
                    ]}
                    onPress={() => setSizeFilter(sizeFilter === 'heavy' ? 'all' : 'heavy')}
                  >
                    <View style={[styles.dotIndicator, { backgroundColor: '#ef4444' }]} />
                    <Text
                      style={[
                        styles.weightFilterText,
                        sizeFilter === 'heavy' && { color: '#fca5a5', fontWeight: '800' },
                      ]}
                    >
                      Solo Pesados (&gt;4 MB)
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.weightFilterPill,
                      sizeFilter === 'medium' && {
                        backgroundColor: 'rgba(245, 158, 11, 0.22)',
                        borderColor: '#f59e0b',
                      },
                    ]}
                    onPress={() => setSizeFilter(sizeFilter === 'medium' ? 'all' : 'medium')}
                  >
                    <View style={[styles.dotIndicator, { backgroundColor: '#f59e0b' }]} />
                    <Text
                      style={[
                        styles.weightFilterText,
                        sizeFilter === 'medium' && { color: '#fde68a', fontWeight: '800' },
                      ]}
                    >
                      Medios (2-4 MB)
                    </Text>
                  </TouchableOpacity>
                </ScrollView>
              </View>

              {/* Barra de División Fotos y Videos + Botón Comprimir (visible en ambos modos) */}
              <View style={styles.divisionBar}>
                <View style={styles.categorySegmentRow}>
                  <TouchableOpacity
                    style={[styles.categoryPill, folderCategory === 'all' && styles.categoryPillActive]}
                    onPress={() => setFolderCategory('all')}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.categoryPillText, folderCategory === 'all' && styles.categoryPillTextActive]}>
                      Todas ({folderPhotos.length + folderVideos.length})
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.categoryPill, folderCategory === 'photos' && styles.categoryPillActive]}
                    onPress={() => setFolderCategory('photos')}
                    activeOpacity={0.8}
                  >
                    <Ionicons
                      name="images"
                      size={14}
                      color={folderCategory === 'photos' ? '#ffffff' : theme.colors.primaryLight}
                    />
                    <Text style={[styles.categoryPillText, folderCategory === 'photos' && styles.categoryPillTextActive]}>
                      Fotos ({folderPhotos.length})
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.categoryPill, folderCategory === 'videos' && styles.categoryPillActive]}
                    onPress={() => setFolderCategory('videos')}
                    activeOpacity={0.8}
                  >
                    <Ionicons
                      name="videocam"
                      size={14}
                      color={folderCategory === 'videos' ? '#ffffff' : theme.colors.primaryLight}
                    />
                    <Text style={[styles.categoryPillText, folderCategory === 'videos' && styles.categoryPillTextActive]}>
                      Videos ({folderVideos.length})
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* Barra de Acciones Inteligentes: Comprimir y Organizar Cámara */}
                <View style={styles.actionToolsRow}>
                  {(folderPhotos.length > 0 || visibleSubfolders.length > 0) && (
                    <TouchableOpacity
                      style={styles.actionToolButton}
                      onPress={handleCompressFolder}
                      disabled={isCompressingFolder}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="sparkles" size={14} color="#38bdf8" />
                      <Text style={styles.actionToolButtonText}>
                        {folderPhotos.length > 0
                          ? `Comprimir fotos (${folderPhotos.length})`
                          : 'Comprimir fotos de carpeta'}
                      </Text>
                    </TouchableOpacity>
                  )}

                  {folderVideos.length > 0 && (
                    <TouchableOpacity
                      style={styles.actionToolButton}
                      onPress={handleCompressVideosFolder}
                      disabled={isCompressingFolder}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="videocam" size={14} color="#38bdf8" />
                      <Text style={styles.actionToolButtonText}>
                        Comprimir videos ({folderVideos.length})
                      </Text>
                    </TouchableOpacity>
                  )}

                  {currentFolderAssets.length > 0 && (
                    <TouchableOpacity
                      style={[styles.actionToolButton, styles.actionToolButtonOrganize]}
                      onPress={() => setShowOrganizeConfirmModal(true)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="calendar" size={14} color={theme.colors.warning} />
                      <Text style={[styles.actionToolButtonText, { color: theme.colors.warning }]}>
                        Dividir y organizar por meses
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {/* Barra de Selección Múltiple si hay fotos seleccionadas */}
              {isSelecting && (
                <View style={styles.selectionBar}>
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
                    <TouchableOpacity style={styles.selActionBtn} onPress={handleCompressSelected}>
                      <Ionicons name="sparkles" size={15} color="#38bdf8" />
                      <Text style={[styles.selActionText, { color: '#38bdf8' }]}>Comprimir</Text>
                    </TouchableOpacity>
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

              {/* Cabecera descriptiva según división */}
              <View style={styles.sectionHeader}>
                <Ionicons
                  name={folderCategory === 'videos' ? 'videocam-outline' : 'images-outline'}
                  size={18}
                  color={theme.colors.primary}
                />
                <Text style={styles.sectionTitle}>
                  {folderCategory === 'photos'
                    ? `Fotos (${folderPhotos.length})`
                    : folderCategory === 'videos'
                    ? `Videos (${folderVideos.length})`
                    : `Fotos (${folderPhotos.length}) y Videos (${folderVideos.length})`}
                </Text>
              </View>
            </View>
          }
          renderItem={renderPhotoItem}
          updateCellsBatchingPeriod={30}
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

      {/* Modal de Progreso de Compresión de Carpeta */}
      <Modal
        visible={isCompressingFolder}
        transparent={true}
        animationType="fade"
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
              {isProcessPaused ? 'Compresión en pausa' : 'Comprimiendo fotos...'}
            </Text>
            <Text style={styles.progressModalSubtitle}>
              {isProcessPaused
                ? 'Puedes reanudar cuando quieras o cancelar el proceso'
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
                  {compressProgress.current} de {compressProgress.total} fotos ({Math.round((compressProgress.percent || 0) * 100)}%)
                  {compressProgress.skippedGreenCount > 0
                    ? ` · ${compressProgress.skippedGreenCount} en verde omitidas`
                    : ''}
                </Text>
                <Text style={styles.progressSavedText}>
                  Espacio ahorrado: {compressProgress.savedFormatted}
                </Text>
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
  searchAndQuickFilterBox: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
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
});
