import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Animated,
  PanResponder,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { compressionService } from '../services/compressionService';
import { mediaService } from '../services/mediaService';
import { folderService } from '../services/folderService';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export default function ModoGuardarModal({
  visible = false,
  assets = [],
  initialIndex = 0,
  initialView = 'swipe', // 'swipe' | 'trash'
  favorites = {},
  trashBin = {},
  onToggleFavorite,
  onAddToTrash,
  onRestoreFromTrash,
  onEmptyTrash,
  onClose,
  onChanged,
}) {
  const [viewMode, setViewMode] = useState(initialView); // 'swipe' | 'trash'
  const [currentIndex, setCurrentIndex] = useState(0);
  const [filterMode, setFilterMode] = useState('all'); // 'all' | 'heavy'
  const [undoStack, setUndoStack] = useState([]);
  const [currentSize, setCurrentSize] = useState(0);
  const [isCompressingOne, setIsCompressingOne] = useState(false);
  const [isEmptyingTrash, setIsEmptyingTrash] = useState(false);
  const [dragIntent, setDragIntent] = useState(null); // 'trash' | 'fav' | 'next' | 'prev' | null

  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;

  // Filtrar fotos que aún NO están en la papelera
  const workingAssets = useMemo(() => {
    const base = (assets || []).filter((a) => a && !trashBin[a.id]);
    if (filterMode === 'heavy') {
      return base.filter((a) => (Number(a.fileSize) || 0) > 2 * 1024 * 1024);
    }
    return base;
  }, [assets, trashBin, filterMode]);

  const trashItems = useMemo(
    () => Object.values(trashBin || {}).sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0)),
    [trashBin]
  );

  const totalTrashBytes = useMemo(
    () => trashItems.reduce((acc, it) => acc + (Number(it.fileSize) || 0), 0),
    [trashItems]
  );

  useEffect(() => {
    if (visible) {
      setViewMode(initialView || 'swipe');
      const safeIdx =
        initialIndex >= 0 && initialIndex < workingAssets.length ? initialIndex : 0;
      setCurrentIndex(safeIdx);
      setUndoStack([]);
      pan.setValue({ x: 0, y: 0 });
      setDragIntent(null);
    }
  }, [visible, initialView]);

  const safeIndex =
    workingAssets.length > 0
      ? Math.max(0, Math.min(currentIndex, workingAssets.length - 1))
      : 0;
  const currentAsset = workingAssets[safeIndex] || null;

  const currentAssetRef = useRef(currentAsset);
  currentAssetRef.current = currentAsset;
  const workingLengthRef = useRef(workingAssets.length);
  workingLengthRef.current = workingAssets.length;
  const safeIndexRef = useRef(safeIndex);
  safeIndexRef.current = safeIndex;

  // Consultar tamaño real del archivo actual
  useEffect(() => {
    let active = true;
    if (visible && currentAsset?.uri) {
      if (currentAsset.fileSize && currentAsset.fileSize > 0) {
        setCurrentSize(currentAsset.fileSize);
      } else {
        setCurrentSize(0);
      }
      compressionService.getFileSize(currentAsset).then((sz) => {
        if (active && sz > 0) {
          currentAsset.fileSize = sz;
          setCurrentSize(sz);
        }
      });
    }
    return () => {
      active = false;
    };
  }, [visible, currentAsset?.id, currentAsset?.uri]);

  const advanceOrPromptFinish = (addedToTrash = false) => {
    pan.setValue({ x: 0, y: 0 });
    setDragIntent(null);

    const remainingCount = addedToTrash
      ? workingLengthRef.current - 1
      : workingLengthRef.current;

    if (remainingCount <= 0 || (!addedToTrash && safeIndexRef.current >= remainingCount - 1)) {
      // Llegamos al final de las fotos de esta vista: si hay fotos en la papelera, preguntar o mostrar revisión
      setViewMode('trash');
      return;
    }

    if (!addedToTrash) {
      setCurrentIndex((prev) => Math.min(prev + 1, Math.max(0, remainingCount - 1)));
    } else if (safeIndexRef.current >= remainingCount) {
      setCurrentIndex(Math.max(0, remainingCount - 1));
    }
  };

  // Acción 1: Deslizar hacia ABAJO -> Enviar a Papelera
  const handleSendToTrash = async () => {
    const target = currentAssetRef.current;
    if (!target) return;

    Animated.timing(pan, {
      toValue: { x: 0, y: SCREEN_HEIGHT * 0.55 },
      duration: 170,
      useNativeDriver: false,
    }).start(async () => {
      setUndoStack((prev) => [...prev, { type: 'trash', asset: target }]);
      if (onAddToTrash) {
        await onAddToTrash(target);
      }
      advanceOrPromptFinish(true);
    });
  };

  // Acción 2: Deslizar hacia ARRIBA -> Poner en Favoritos y avanzar
  const handleSendToFavorite = async () => {
    const target = currentAssetRef.current;
    if (!target) return;

    Animated.timing(pan, {
      toValue: { x: 0, y: -SCREEN_HEIGHT * 0.55 },
      duration: 170,
      useNativeDriver: false,
    }).start(async () => {
      const wasFav = Boolean(favorites && favorites[target.id]);
      if (!wasFav && onToggleFavorite) {
        await onToggleFavorite(target);
      }
      setUndoStack((prev) => [
        ...prev,
        { type: 'favorite', asset: target, wasFav, prevIndex: safeIndexRef.current },
      ]);
      advanceOrPromptFinish(false);
    });
  };

  // Acción 3: Deslizar a la IZQUIERDA -> Pasar a la siguiente foto (conservar)
  const handlePassNext = () => {
    const target = currentAssetRef.current;
    if (!target) return;

    Animated.timing(pan, {
      toValue: { x: -SCREEN_WIDTH * 0.85, y: 0 },
      duration: 150,
      useNativeDriver: false,
    }).start(() => {
      setUndoStack((prev) => [
        ...prev,
        { type: 'pass', asset: target, prevIndex: safeIndexRef.current },
      ]);
      advanceOrPromptFinish(false);
    });
  };

  // Acción 4: Deslizar a la DERECHA -> Foto anterior
  const handleGoPrev = () => {
    if (safeIndexRef.current <= 0) {
      Animated.spring(pan, {
        toValue: { x: 0, y: 0 },
        useNativeDriver: false,
      }).start();
      setDragIntent(null);
      return;
    }
    Animated.timing(pan, {
      toValue: { x: SCREEN_WIDTH * 0.85, y: 0 },
      duration: 150,
      useNativeDriver: false,
    }).start(() => {
      pan.setValue({ x: 0, y: 0 });
      setDragIntent(null);
      setCurrentIndex((prev) => Math.max(0, prev - 1));
    });
  };

  // Deshacer última acción con 1 toque
  const handleUndoLast = async () => {
    if (undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, prev.length - 1));

    if (last.type === 'trash' && last.asset?.id && onRestoreFromTrash) {
      await onRestoreFromTrash(last.asset.id);
    } else if (last.type === 'favorite' && !last.wasFav && last.asset && onToggleFavorite) {
      await onToggleFavorite(last.asset);
      if (typeof last.prevIndex === 'number') {
        setCurrentIndex(last.prevIndex);
      }
    } else if (last.type === 'pass' && typeof last.prevIndex === 'number') {
      setCurrentIndex(last.prevIndex);
    }
  };

  // Comprimir la foto actual al 100% de resolución desde el Modo Guardar
  const handleCompressCurrent = async () => {
    if (!currentAsset || isCompressingOne) return;
    setIsCompressingOne(true);
    try {
      const res = await compressionService.compressPhoto(currentAsset, { skipIfGreen: false });
      if (res?.newSize > 0) {
        currentAsset.fileSize = res.newSize;
        setCurrentSize(res.newSize);
      }
      if (res?.savedBytes > 0) {
        Alert.alert(
          '⚡ ¡Foto optimizada al 100%!',
          `Pasó de ${compressionService.formatBytes(res.oldSize)} a ${compressionService.formatBytes(res.newSize)} (Ahorraste ${compressionService.formatBytes(res.savedBytes)} sin perder resolución).`
        );
        if (onChanged) onChanged();
      } else {
        Alert.alert('Ya optimizada', 'Esta foto ya tiene el menor peso posible a su resolución.');
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
        Alert.alert('Aviso', String(e?.message || e));
      }
    } finally {
      setIsCompressingOne(false);
    }
  };

  //Vaciar definitivamente todas las fotos de la papelera
  const handleConfirmEmptyTrash = () => {
    if (trashItems.length === 0) return;
    Alert.alert(
      '🗑️ ¿Vaciar la Papelera?',
      `Se eliminarán definitivamente ${trashItems.length} ${trashItems.length === 1 ? 'archivo' : 'archivos'} de tu teléfono (${compressionService.formatBytes(totalTrashBytes)}).\n\n¿Estás de acuerdo en vaciar la papelera o prefieres seguir revisándolas?`,
      [
        { text: 'Seguir revisando', style: 'cancel' },
        {
          text: `Sí, eliminar (${trashItems.length})`,
          style: 'destructive',
          onPress: async () => {
            setIsEmptyingTrash(true);
            try {
              if (onEmptyTrash) {
                await onEmptyTrash(trashItems);
              }
              Alert.alert(
                '✅ ¡Papelera vaciada!',
                `Se eliminaron ${trashItems.length} archivos y liberaste ${compressionService.formatBytes(totalTrashBytes)} de espacio.`
              );
              if (onChanged) onChanged();
            } catch (e) {
              Alert.alert('Error', 'No se pudieron eliminar algunos archivos: ' + String(e?.message || e));
            } finally {
              setIsEmptyingTrash(false);
            }
          },
        },
      ]
    );
  };

  // Restaurar todas las fotos de la papelera de golpe
  const handleRestoreAll = async () => {
    if (trashItems.length === 0 || !onRestoreFromTrash) return;
    for (const item of trashItems) {
      await onRestoreFromTrash(item.id);
    }
    Alert.alert('↩️ ¡Fotos restauradas!', 'Todas las fotos de la papelera regresaron intactas a tu galería.');
    setViewMode('swipe');
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
      onPanResponderMove: (_, g) => {
        pan.setValue({ x: g.dx, y: g.dy });
        if (Math.abs(g.dy) > Math.abs(g.dx) * 1.15) {
          if (g.dy > 40) setDragIntent('trash');
          else if (g.dy < -40) setDragIntent('fav');
          else setDragIntent(null);
        } else {
          if (g.dx < -40) setDragIntent('next');
          else if (g.dx > 40) setDragIntent('prev');
          else setDragIntent(null);
        }
      },
      onPanResponderRelease: (_, g) => {
        // Priorizar gesto vertical si el usuario deslizó hacia arriba o hacia abajo
        if (Math.abs(g.dy) > Math.abs(g.dx) * 1.1 && Math.abs(g.dy) > 65) {
          if (g.dy > 65) {
            handleSendToTrash();
            return;
          }
          if (g.dy < -65) {
            handleSendToFavorite();
            return;
          }
        }
        // Gesto horizontal: pasar siguiente o regresar a la anterior
        if (g.dx < -55) {
          handlePassNext();
          return;
        }
        if (g.dx > 55) {
          handleGoPrev();
          return;
        }
        // Si fue un toque corto, regresar al centro suavemente
        setDragIntent(null);
        Animated.spring(pan, {
          toValue: { x: 0, y: 0 },
          friction: 6,
          useNativeDriver: false,
        }).start();
      },
    })
  ).current;

  const handleRequestClose = () => {
    if (viewMode === 'swipe' && trashItems.length > 0) {
      Alert.alert(
        `Tienes ${trashItems.length} ${trashItems.length === 1 ? 'foto' : 'fotos'} en la Papelera`,
        '¿Qué deseas hacer antes de salir del Modo Guardar?',
        [
          {
            text: 'Revisar / Restaurar Papelera',
            onPress: () => setViewMode('trash'),
          },
          {
            text: 'Vaciar Papelera ahora',
            style: 'destructive',
            onPress: handleConfirmEmptyTrash,
          },
          {
            text: 'Salir (dejar en papelera)',
            style: 'cancel',
            onPress: onClose,
          },
        ]
      );
      return;
    }
    if (onClose) onClose();
  };

  if (!visible) return null;

  const isCurrentFav = Boolean(currentAsset && favorites && favorites[currentAsset.id]);
  const sizeInfo = compressionService.getSizeLevel(currentSize, currentAsset?.mediaType || 'photo');

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={handleRequestClose}
    >
      <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
        {/* 1. CABECERA DEL MODO GUARDAR Y PAPELERA */}
        <View style={styles.topHeader}>
          <TouchableOpacity style={styles.closeBtn} onPress={handleRequestClose}>
            <Ionicons name="arrow-back" size={20} color="#ffffff" />
            <Text style={styles.closeBtnText}>Salir</Text>
          </TouchableOpacity>

          <View style={styles.modeSwitchRow}>
            <TouchableOpacity
              style={[
                styles.modeSwitchBtn,
                viewMode === 'swipe' && styles.modeSwitchBtnActive,
              ]}
              onPress={() => setViewMode('swipe')}
            >
              <Ionicons
                name="albums"
                size={15}
                color={viewMode === 'swipe' ? '#ffffff' : '#a1a1aa'}
              />
              <Text
                style={[
                  styles.modeSwitchText,
                  viewMode === 'swipe' && styles.modeSwitchTextActive,
                ]}
              >
                Modo Guardar ({workingAssets.length})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.modeSwitchBtn,
                viewMode === 'trash' && styles.modeSwitchBtnTrashActive,
              ]}
              onPress={() => setViewMode('trash')}
            >
              <Ionicons
                name="trash"
                size={15}
                color={viewMode === 'trash' ? '#ffffff' : '#f87171'}
              />
              <Text
                style={[
                  styles.modeSwitchText,
                  viewMode === 'trash' && styles.modeSwitchTextActive,
                ]}
              >
                Papelera ({trashItems.length})
              </Text>
            </TouchableOpacity>
          </View>

          {undoStack.length > 0 && viewMode === 'swipe' ? (
            <TouchableOpacity style={styles.undoHeaderBtn} onPress={handleUndoLast}>
              <Ionicons name="arrow-undo" size={16} color="#fbbf24" />
              <Text style={styles.undoHeaderText}>Deshacer</Text>
            </TouchableOpacity>
          ) : (
            <View style={{ width: 64 }} />
          )}
        </View>

        {/* ================= VISTA 1: DESLIZAR FOTOS (MODO GUARDAR) ================= */}
        {viewMode === 'swipe' ? (
          <View style={styles.swipeScreenBody}>
            {/* Guía clara de gestos + Filtro rápido */}
            <View style={styles.guideBar}>
              <View style={styles.guidePillUp}>
                <Ionicons name="arrow-up" size={13} color="#f43f5e" />
                <Text style={styles.guideText}>Arriba: Favorito</Text>
              </View>
              <View style={styles.guidePillSide}>
                <Ionicons name="swap-horizontal" size={13} color="#38bdf8" />
                <Text style={styles.guideText}>Lados: Pasar</Text>
              </View>
              <View style={styles.guidePillDown}>
                <Ionicons name="arrow-down" size={13} color="#ef4444" />
                <Text style={styles.guideText}>Abajo: Papelera</Text>
              </View>

              <TouchableOpacity
                style={[
                  styles.heavyFilterChip,
                  filterMode === 'heavy' && styles.heavyFilterChipActive,
                ]}
                onPress={() => setFilterMode((m) => (m === 'all' ? 'heavy' : 'all'))}
              >
                <Text style={styles.heavyFilterChipText}>
                  {filterMode === 'heavy' ? '🔥 Solo >2MB' : 'Todas'}
                </Text>
              </TouchableOpacity>
            </View>

            {!currentAsset ? (
              <View style={styles.emptySwipeBox}>
                <Ionicons name="checkmark-done-circle" size={68} color="#10b981" />
                <Text style={styles.emptySwipeTitle}>
                  ¡Terminaste de revisar estas fotos!
                </Text>
                <Text style={styles.emptySwipeSub}>
                  {trashItems.length > 0
                    ? `Tienes ${trashItems.length} fotos en la Papelera (${compressionService.formatBytes(totalTrashBytes)}). Puedes revisarlas para rescatar alguna con 1 clic o vaciar la papelera.`
                    : 'No enviaste fotos a la papelera.'}
                </Text>

                {trashItems.length > 0 && (
                  <View style={{ width: '100%', gap: 10, marginTop: 18 }}>
                    <TouchableOpacity
                      style={styles.reviewTrashBigBtn}
                      onPress={() => setViewMode('trash')}
                    >
                      <Ionicons name="eye" size={18} color="#ffffff" />
                      <Text style={styles.reviewTrashBigBtnText}>
                        Revisar Papelera ({trashItems.length} fotos)
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.emptyTrashBigBtn}
                      onPress={handleConfirmEmptyTrash}
                    >
                      <Ionicons name="trash" size={18} color="#ffffff" />
                      <Text style={styles.reviewTrashBigBtnText}>
                        Vaciar Papelera ahora (-{compressionService.formatBytes(totalTrashBytes)})
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ) : (
              <>
                {/* Indicador superior de progreso y peso del archivo actual */}
                <View style={styles.photoMetaRow}>
                  <Text style={styles.photoCounterBadge}>
                    Foto {safeIndex + 1} de {workingAssets.length}
                  </Text>
                  <View
                    style={[
                      styles.photoWeightBadge,
                      { borderColor: sizeInfo.color, backgroundColor: sizeInfo.bannerBg },
                    ]}
                  >
                    <Text style={[styles.photoWeightText, { color: sizeInfo.color }]}>
                      {currentSize > 0
                        ? `${compressionService.formatBytes(currentSize)} · ${sizeInfo.tagText}`
                        : currentAsset.filename || 'Foto'}
                    </Text>
                  </View>
                  {isCurrentFav && (
                    <View style={styles.favActivePill}>
                      <Ionicons name="heart" size={13} color="#f43f5e" />
                      <Text style={styles.favActivePillText}>Favorito</Text>
                    </View>
                  )}
                </View>

                {/* Tarjeta interactiva deslizable */}
                <View style={styles.cardStage}>
                  <Animated.View
                    {...panResponder.panHandlers}
                    style={[
                      styles.swipeCard,
                      {
                        transform: [
                          { translateX: pan.x },
                          { translateY: pan.y },
                        ],
                      },
                    ]}
                  >
                    <Image
                      source={{ uri: currentAsset.uri }}
                      style={styles.swipeImage}
                      contentFit="contain"
                      priority="high"
                      cachePolicy="memory-disk"
                    />

                    {/* Etiquetas dinámicas al deslizar */}
                    {dragIntent === 'trash' && (
                      <View style={[styles.intentBanner, styles.intentBannerTrash]}>
                        <Ionicons name="trash" size={28} color="#ffffff" />
                        <Text style={styles.intentBannerText}>MANDAR A PAPELERA ↓</Text>
                      </View>
                    )}
                    {dragIntent === 'fav' && (
                      <View style={[styles.intentBanner, styles.intentBannerFav]}>
                        <Ionicons name="heart" size={28} color="#ffffff" />
                        <Text style={styles.intentBannerText}>GUARDAR EN FAVORITOS ↑</Text>
                      </View>
                    )}
                    {dragIntent === 'next' && (
                      <View style={[styles.intentBanner, styles.intentBannerPass]}>
                        <Ionicons name="checkmark-circle" size={26} color="#ffffff" />
                        <Text style={styles.intentBannerText}>CONSERVAR Y PASAR →</Text>
                      </View>
                    )}
                  </Animated.View>
                </View>

                {/* Barra de botones rápidos abajo por si prefiere tocar en vez de deslizar */}
                <View style={styles.bottomActionsDock}>
                  <TouchableOpacity
                    style={[styles.quickActionCircle, styles.quickActionTrash]}
                    onPress={handleSendToTrash}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="trash" size={22} color="#ef4444" />
                    <Text style={[styles.quickActionLabel, { color: '#fca5a5' }]}>
                      Papelera ↓
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.quickActionCircle, styles.quickActionCompress]}
                    onPress={handleCompressCurrent}
                    disabled={isCompressingOne}
                    activeOpacity={0.8}
                  >
                    {isCompressingOne ? (
                      <ActivityIndicator size="small" color="#38bdf8" />
                    ) : (
                      <Ionicons name="sparkles" size={20} color="#38bdf8" />
                    )}
                    <Text style={[styles.quickActionLabel, { color: '#bae6fd' }]}>
                      Comprimir
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.quickActionCircle, styles.quickActionFav]}
                    onPress={handleSendToFavorite}
                    activeOpacity={0.8}
                  >
                    <Ionicons
                      name={isCurrentFav ? 'heart' : 'heart-outline'}
                      size={22}
                      color="#f43f5e"
                    />
                    <Text style={[styles.quickActionLabel, { color: '#fda4af' }]}>
                      Favorito ↑
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.quickActionCircle, styles.quickActionPass]}
                    onPress={handlePassNext}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="play-skip-forward" size={20} color="#34d399" />
                    <Text style={[styles.quickActionLabel, { color: '#a7f3d0' }]}>
                      Pasar →
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        ) : (
          /* ================= VISTA 2: REVISIÓN DE PAPELERA (RESTAURAR CON 1 CLIC O VACIAR) ================= */
          <View style={styles.trashScreenBody}>
            <View style={styles.trashSummaryCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.trashSummaryTitle}>
                  🗑️ Papelera ({trashItems.length}{' '}
                  {trashItems.length === 1 ? 'archivo' : 'archivos'})
                </Text>
                <Text style={styles.trashSummarySub}>
                  Espacio por liberar: {compressionService.formatBytes(totalTrashBytes)} · Toca cualquier foto para restaurarla con 1 clic.
                </Text>
              </View>
            </View>

            {trashItems.length > 0 && (
              <View style={styles.trashTopButtonsRow}>
                <TouchableOpacity
                  style={styles.restoreAllBtn}
                  onPress={handleRestoreAll}
                  activeOpacity={0.85}
                >
                  <Ionicons name="arrow-undo-circle" size={18} color="#38bdf8" />
                  <Text style={styles.restoreAllBtnText}>Restaurar todas</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.emptyTrashNowBtn}
                  onPress={handleConfirmEmptyTrash}
                  disabled={isEmptyingTrash}
                  activeOpacity={0.85}
                >
                  {isEmptyingTrash ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Ionicons name="trash" size={18} color="#ffffff" />
                  )}
                  <Text style={styles.emptyTrashNowBtnText}>
                    Vaciar Papelera ({trashItems.length})
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {trashItems.length === 0 ? (
              <View style={styles.emptySwipeBox}>
                <Ionicons name="trash-outline" size={64} color="#52525b" />
                <Text style={styles.emptySwipeTitle}>La Papelera está vacía</Text>
                <Text style={styles.emptySwipeSub}>
                  En el &quot;Modo Guardar&quot;, desliza hacia abajo las fotos que no ocupes para mandarlas aquí antes de borrarlas definitivamente.
                </Text>
                <TouchableOpacity
                  style={[styles.reviewTrashBigBtn, { marginTop: 18 }]}
                  onPress={() => setViewMode('swipe')}
                >
                  <Ionicons name="albums" size={18} color="#ffffff" />
                  <Text style={styles.reviewTrashBigBtnText}>Ir a Modo Guardar</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <ScrollView
                contentContainerStyle={styles.trashGrid}
                showsVerticalScrollIndicator={false}
              >
                {trashItems.map((item) => (
                  <View key={`trash_item_${item.id}`} style={styles.trashCard}>
                    <Image
                      source={{ uri: item.uri }}
                      style={styles.trashThumb}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                    />
                    <View style={styles.trashCardScrim} />
                    {item.fileSize > 0 && (
                      <View style={styles.trashSizePill}>
                        <Text style={styles.trashSizeText}>
                          {compressionService.formatBytes(item.fileSize)}
                        </Text>
                      </View>
                    )}

                    {/* Botón de Restaurar con 1 solo clic */}
                    <TouchableOpacity
                      style={styles.oneClickRestoreBtn}
                      onPress={() => onRestoreFromTrash && onRestoreFromTrash(item.id)}
                      activeOpacity={0.8}
                    >
                      <Ionicons name="arrow-undo" size={14} color="#ffffff" />
                      <Text style={styles.oneClickRestoreText}>Restaurar</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const CARD_GRID_SIZE = Math.floor((SCREEN_WIDTH - 36) / 3);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#09090b',
  },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: Platform.OS === 'android' ? Math.max((StatusBar.currentHeight || 36) + 12, 48) : 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  closeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  closeBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  modeSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#18181b',
    borderRadius: 20,
    padding: 3,
    borderWidth: 1,
    borderColor: '#27272a',
  },
  modeSwitchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 17,
  },
  modeSwitchBtnActive: {
    backgroundColor: '#2563eb',
  },
  modeSwitchBtnTrashActive: {
    backgroundColor: '#dc2626',
  },
  modeSwitchText: {
    color: '#a1a1aa',
    fontSize: 12,
    fontWeight: '700',
  },
  modeSwitchTextActive: {
    color: '#ffffff',
  },
  undoHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(251, 191, 36, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.45)',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 14,
  },
  undoHeaderText: {
    color: '#fbbf24',
    fontSize: 11.5,
    fontWeight: '800',
  },
  swipeScreenBody: {
    flex: 1,
    justifyContent: 'space-between',
    paddingBottom: 10,
  },
  guideBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  guidePillUp: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(244, 63, 94, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  guidePillSide: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  guidePillDown: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(239, 68, 68, 0.16)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  guideText: {
    color: '#e4e4e7',
    fontSize: 11,
    fontWeight: '700',
  },
  heavyFilterChip: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#27272a',
  },
  heavyFilterChipActive: {
    backgroundColor: '#dc2626',
  },
  heavyFilterChipText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '800',
  },
  photoMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  photoCounterBadge: {
    color: '#a1a1aa',
    fontSize: 12.5,
    fontWeight: '700',
  },
  photoWeightBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
  },
  photoWeightText: {
    fontSize: 11.5,
    fontWeight: '800',
  },
  favActivePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(244, 63, 94, 0.18)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  favActivePillText: {
    color: '#fda4af',
    fontSize: 11,
    fontWeight: '800',
  },
  cardStage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  swipeCard: {
    width: '100%',
    height: '100%',
    borderRadius: 22,
    backgroundColor: '#141418',
    borderWidth: 1,
    borderColor: '#27272a',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swipeImage: {
    width: '100%',
    height: '100%',
  },
  intentBanner: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 18,
  },
  intentBannerTrash: {
    top: 24,
    backgroundColor: 'rgba(220, 38, 38, 0.92)',
  },
  intentBannerFav: {
    bottom: 24,
    backgroundColor: 'rgba(225, 29, 72, 0.92)',
  },
  intentBannerPass: {
    top: '44%',
    backgroundColor: 'rgba(37, 99, 235, 0.9)',
  },
  intentBannerText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
  },
  bottomActionsDock: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: Platform.OS === 'android' ? 48 : 28,
  },
  quickActionCircle: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    minWidth: 78,
    gap: 3,
  },
  quickActionTrash: {
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderColor: 'rgba(239, 68, 68, 0.45)',
  },
  quickActionCompress: {
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderColor: 'rgba(56, 189, 248, 0.45)',
  },
  quickActionFav: {
    backgroundColor: 'rgba(244, 63, 94, 0.14)',
    borderColor: 'rgba(244, 63, 94, 0.45)',
  },
  quickActionPass: {
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    borderColor: 'rgba(16, 185, 129, 0.45)',
  },
  quickActionLabel: {
    fontSize: 11,
    fontWeight: '800',
  },
  emptySwipeBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  emptySwipeTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 12,
    textAlign: 'center',
  },
  emptySwipeSub: {
    color: '#a1a1aa',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 19,
  },
  reviewTrashBigBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#2563eb',
    paddingVertical: 13,
    paddingHorizontal: 20,
    borderRadius: 14,
  },
  emptyTrashBigBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#dc2626',
    paddingVertical: 13,
    paddingHorizontal: 20,
    borderRadius: 14,
  },
  reviewTrashBigBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
  },
  trashScreenBody: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  trashSummaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#18181b',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#27272a',
    marginBottom: 10,
  },
  trashSummaryTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
  },
  trashSummarySub: {
    color: '#a1a1aa',
    fontSize: 12,
    marginTop: 3,
    lineHeight: 17,
  },
  trashTopButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  restoreAllBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.45)',
    paddingVertical: 11,
    borderRadius: 12,
  },
  restoreAllBtnText: {
    color: '#38bdf8',
    fontSize: 13,
    fontWeight: '800',
  },
  emptyTrashNowBtn: {
    flex: 1.2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#dc2626',
    paddingVertical: 11,
    borderRadius: 12,
  },
  emptyTrashNowBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  trashGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingBottom: Platform.OS === 'android' ? 64 : 40,
  },
  trashCard: {
    width: CARD_GRID_SIZE,
    height: Math.round(CARD_GRID_SIZE * 1.22),
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#18181b',
    position: 'relative',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  trashThumb: {
    width: '100%',
    height: '100%',
  },
  trashCardScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '45%',
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  trashSizePill: {
    position: 'absolute',
    top: 5,
    left: 5,
    backgroundColor: 'rgba(0,0,0,0.72)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  trashSizeText: {
    color: '#fca5a5',
    fontSize: 10,
    fontWeight: '800',
  },
  oneClickRestoreBtn: {
    position: 'absolute',
    left: 6,
    right: 6,
    bottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: '#2563eb',
    paddingVertical: 6,
    borderRadius: 8,
  },
  oneClickRestoreText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '800',
  },
});
