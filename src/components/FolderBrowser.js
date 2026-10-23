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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { folderService, COMMON_SYSTEM_FOLDERS } from '../services/folderService';
import { compressionService } from '../services/compressionService';
import { cameraOrganizerService } from '../services/cameraOrganizerService';
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

  // Lista total filtrada (photos | videos | all con división clara)
  const totalFilteredAssets = useMemo(() => {
    if (folderCategory === 'photos' || filterType === 'photos') return folderPhotos;
    if (folderCategory === 'videos' || filterType === 'videos') return folderVideos;
    return [...folderPhotos, ...folderVideos];
  }, [folderCategory, filterType, folderPhotos, folderVideos]);

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
      `¿Deseas optimizar las ${targetPhotos.length} fotos encontradas sin perder resolución?\n\nSe mantendrá el 100% del tamaño original en píxeles (mismo ancho y alto) y se reducirá notablemente el peso en memoria.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Comprimir fotos',
          onPress: async () => {
            setIsCompressingFolder(true);
            setCompressProgress({ current: 0, total: targetPhotos.length, percent: 0, savedFormatted: '0 B' });
            try {
              const res = await compressionService.compressFolderPhotos(
                targetPhotos,
                (prog) => setCompressProgress(prog)
              );
              Alert.alert(
                '¡Compresión finalizada!',
                `Se procesaron ${res.compressedCount || res.processed} de ${targetPhotos.length} fotos con éxito manteniendo el 100% de su resolución.\n\nEspacio total ahorrado: ${compressionService.formatBytes(res.totalSavedBytes)}.`
              );
              handleRefresh();
            } catch (e) {
              Alert.alert('Error', 'Ocurrió un problema durante la compresión: ' + (e?.message || String(e)));
            } finally {
              setIsCompressingFolder(false);
              setCompressProgress(null);
            }
          },
        },
      ]
    );
  };

  // Organizar cámara físicamente por meses
  const handleOrganizeCamera = async () => {
    setShowOrganizeConfirmModal(false);
    if (!currentFolder?.uri) return;

    setIsOrganizingCamera(true);
    setOrganizeProgress({ current: 0, total: currentFolderAssets.length, percent: 0, currentFile: '', currentMonth: '' });

    try {
      const res = await cameraOrganizerService.physicallyOrganizeFolder({
        targetDirUri: currentFolder.uri,
        assets: currentFolderAssets,
        onProgress: (prog) => setOrganizeProgress(prog),
      });

      Alert.alert(
        '¡Cámara organizada con éxito!',
        `Se crearon físicamente ${res.monthsCreated} carpetas por mes con división de Fotos y Videos.\nSe movieron ${res.moved} archivos para descongestionar la cámara.`
      );
      handleRefresh();
    } catch (e) {
      Alert.alert('Aviso', 'No se pudo completar la organización: ' + (e?.message || String(e)));
    } finally {
      setIsOrganizingCamera(false);
      setOrganizeProgress(null);
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
  const handlePressPhoto = useCallback((a) => {
    if (selectRef.current) selectRef.current(a, listRef.current);
  }, []);
  const renderPhotoItem = useCallback(
    ({ item }) => (
      <PhotoThumbnail
        asset={item}
        size={PHOTO_SIZE}
        onPress={handlePressPhoto}
        isFavorite={Boolean(favorites[item.id])}
      />
    ),
    [favorites, handlePressPhoto]
  );

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

                  {viewMode === 'folders' && currentFolderAssets.length > 5 && (
                    <TouchableOpacity
                      style={[styles.actionToolButton, styles.actionToolButtonOrganize]}
                      onPress={() => setShowOrganizeConfirmModal(true)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="calendar" size={14} color={theme.colors.warning} />
                      <Text style={[styles.actionToolButtonText, { color: theme.colors.warning }]}>
                        Organizar por meses (físico)
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

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
            <Text style={styles.progressModalTitle}>Organizar Cámara por Meses</Text>
            <Text style={styles.progressModalSubtitle}>
              Esta opción creará físicamente en tu almacenamiento carpetas para cada mes (ej. 2024-05 Mayo) y separará dentro las carpetas Fotos y Videos para descongestionar la cámara.
            </Text>
            <View style={{ width: '100%', gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                style={styles.confirmOrganizeBtn}
                onPress={handleOrganizeCamera}
                activeOpacity={0.8}
              >
                <Ionicons name="folder" size={18} color="#ffffff" />
                <Text style={styles.confirmOrganizeBtnText}>Crear carpetas y mover archivos</Text>
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
            <ActivityIndicator size="large" color={theme.colors.warning} />
            <Text style={styles.progressModalTitle}>Organizando carpetas físicas...</Text>
            <Text style={styles.progressModalSubtitle}>
              Moviendo fotos y videos a sus respectivas carpetas de mes
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
});
