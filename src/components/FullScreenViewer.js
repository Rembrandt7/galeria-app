import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  StatusBar,
  SafeAreaView,
  Animated,
  PanResponder,
  BackHandler,
  useWindowDimensions,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as MediaLibrary from 'expo-media-library/legacy';
import { File, Paths } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';
import { theme } from '../constants/theme';
import { compressionService } from '../services/compressionService';
import { folderService } from '../services/folderService';
import VideoPlayerScreen from './VideoPlayerScreen';
import ImageCropper from './ImageCropper';
import CloneStampEditor from './CloneStampEditor';

function formatDate(timestamp) {
  if (!timestamp) return 'Fecha desconocida';
  const date = new Date(timestamp);
  return date.toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function FullScreenViewer({
  visible = false,
  assets = [],
  initialIndex = 0,
  onClose,
  favorites = {},
  isFavorite = false,
  onToggleFavorite,
  onShare,
  onDelete,
  onMediaSaved,
}) {
  const { width: screenWidth } = useWindowDimensions();
  const [internalIndex, setInternalIndex] = useState(initialIndex);
  const [playerAsset, setPlayerAsset] = useState(null);
  const [playerInitialMode, setPlayerInitialMode] = useState('play');
  const [openedDirectlyAsVideo, setOpenedDirectlyAsVideo] = useState(false);
  const [cropAsset, setCropAsset] = useState(null);
  const [cloneAsset, setCloneAsset] = useState(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [zoomScale, setZoomScale] = useState(1);
  const [assetSize, setAssetSize] = useState(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [imageRev, setImageRev] = useState(0);

  // Animaciones y referencias declaradas incondicionalmente en la raíz
  const translateX = useRef(new Animated.Value(0)).current;
  const panX = useRef(new Animated.Value(0)).current;
  const panY = useRef(new Animated.Value(0)).current;
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const lastTapRef = useRef(0);
  const currentIndexRef = useRef(initialIndex);
  const zoomScaleRef = useRef(1);
  const assetsLengthRef = useRef(assets?.length || 0);
  const pinchStateRef = useRef({ active: false, startDist: 0, startZoom: 1 });

  const resetZoomAndPan = () => {
    setZoomScale(1);
    zoomScaleRef.current = 1;
    panX.setValue(0);
    panY.setValue(0);
    panOffsetRef.current = { x: 0, y: 0 };
    pinchStateRef.current = { active: false, startDist: 0, startZoom: 1 };
  };

  // PanResponder para pellizcar con 2 dedos (pinch-to-zoom 1x..5x), deslizar fotos a los lados (1x) o arrastrar libremente (>1x)
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (evt) => {
        const touches = evt.nativeEvent.touches;
        return Boolean(touches && touches.length >= 2);
      },
      onStartShouldSetPanResponderCapture: (evt) => {
        const touches = evt.nativeEvent.touches;
        return Boolean(touches && touches.length >= 2);
      },
      onMoveShouldSetPanResponder: (evt, gesture) => {
        const touches = evt.nativeEvent.touches;
        if (touches && touches.length >= 2) return true;
        if (zoomScaleRef.current > 1) {
          return Math.abs(gesture.dx) > 6 || Math.abs(gesture.dy) > 6;
        }
        return (
          Math.abs(gesture.dx) > 12 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.2
        );
      },
      onMoveShouldSetPanResponderCapture: (evt) => {
        const touches = evt.nativeEvent.touches;
        return Boolean(touches && touches.length >= 2);
      },
      onPanResponderGrant: (evt) => {
        const touches = evt.nativeEvent.touches;
        if (touches && touches.length >= 2) {
          const dx = touches[0].pageX - touches[1].pageX;
          const dy = touches[0].pageY - touches[1].pageY;
          const dist = Math.hypot(dx, dy);
          pinchStateRef.current = {
            active: true,
            startDist: Math.max(dist, 10),
            startZoom: zoomScaleRef.current || 1,
          };
        }
      },
      onPanResponderMove: (evt, gesture) => {
        const touches = evt.nativeEvent.touches;
        if (touches && touches.length >= 2) {
          const dx = touches[0].pageX - touches[1].pageX;
          const dy = touches[0].pageY - touches[1].pageY;
          const dist = Math.hypot(dx, dy);
          if (!pinchStateRef.current.active || pinchStateRef.current.startDist <= 0) {
            pinchStateRef.current = {
              active: true,
              startDist: Math.max(dist, 10),
              startZoom: zoomScaleRef.current || 1,
            };
            return;
          }
          const ratio = dist / pinchStateRef.current.startDist;
          const nextZoom = Math.max(1, Math.min(5, Number((pinchStateRef.current.startZoom * ratio).toFixed(2))));
          zoomScaleRef.current = nextZoom;
          setZoomScale(nextZoom);
          if (nextZoom <= 1.02) {
            panX.setValue(0);
            panY.setValue(0);
            panOffsetRef.current = { x: 0, y: 0 };
          }
          return;
        }
        if (pinchStateRef.current.active) return;

        if (zoomScaleRef.current > 1) {
          panX.setValue(panOffsetRef.current.x + gesture.dx);
          panY.setValue(panOffsetRef.current.y + gesture.dy);
        } else {
          translateX.setValue(gesture.dx);
        }
      },
      onPanResponderRelease: (_, gesture) => {
        if (pinchStateRef.current.active) {
          pinchStateRef.current.active = false;
          if (zoomScaleRef.current <= 1.05) {
            resetZoomAndPan();
          }
          return;
        }
        if (zoomScaleRef.current > 1) {
          panOffsetRef.current = {
            x: panOffsetRef.current.x + gesture.dx,
            y: panOffsetRef.current.y + gesture.dy,
          };
          return;
        }
        const idx = currentIndexRef.current;
        const total = assetsLengthRef.current;

        if (gesture.dx < -60 && idx < total - 1) {
          // Deslizó hacia la izquierda -> Siguiente foto
          Animated.timing(translateX, {
            toValue: -screenWidth,
            duration: 120,
            useNativeDriver: false,
          }).start(() => {
            setInternalIndex((prev) => Math.min(prev + 1, total - 1));
            resetZoomAndPan();
            translateX.setValue(screenWidth);
            Animated.timing(translateX, {
              toValue: 0,
              duration: 120,
              useNativeDriver: false,
            }).start();
          });
        } else if (gesture.dx > 60 && idx > 0) {
          // Deslizó hacia la derecha -> Foto anterior
          Animated.timing(translateX, {
            toValue: screenWidth,
            duration: 120,
            useNativeDriver: false,
          }).start(() => {
            setInternalIndex((prev) => Math.max(prev - 1, 0));
            resetZoomAndPan();
            translateX.setValue(-screenWidth);
            Animated.timing(translateX, {
              toValue: 0,
              duration: 120,
              useNativeDriver: false,
            }).start();
          });
        } else {
          // Regresar al centro si fue un arrastre corto
          Animated.spring(translateX, {
            toValue: 0,
            friction: 7,
            useNativeDriver: false,
          }).start();
        }
      },
    })
  ).current;

  // Sincronizar el índice cuando el visor se abre o cambia el asset inicial
  useEffect(() => {
    if (visible) {
      const valid =
        initialIndex >= 0 && initialIndex < (assets?.length || 0) ? initialIndex : 0;
      setInternalIndex(valid);
      setZoomScale(1);
      setShowInfo(false);
      setShowControls(true);
      translateX.setValue(0);

      const firstItem = assets?.[valid];
      if (firstItem && firstItem.mediaType === 'video') {
        setPlayerInitialMode('play');
        setPlayerAsset(firstItem);
        setOpenedDirectlyAsVideo(true);
      } else {
        setPlayerAsset(null);
        setOpenedDirectlyAsVideo(false);
      }
    } else {
      setPlayerAsset(null);
      setOpenedDirectlyAsVideo(false);
    }
  }, [visible, initialIndex]);

  // Manejo de la tecla o gesto atrás de Android
  useEffect(() => {
    if (!visible) return;

    const onBackPress = () => {
      if (cloneAsset) {
        setCloneAsset(null);
        return true;
      }
      if (cropAsset) {
        setCropAsset(null);
        return true;
      }
      if (playerAsset) {
        setPlayerAsset(null);
        return true;
      }
      if (showInfo) {
        setShowInfo(false);
        return true;
      }
      if (zoomScale > 1) {
        setZoomScale(1);
        return true;
      }
      if (onClose) {
        onClose();
        return true;
      }
      return false;
    };

    const backSub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => backSub.remove();
  }, [visible, cloneAsset, cropAsset, playerAsset, showInfo, zoomScale, onClose]);

  // Cálculo del elemento actual y actualización de referencias
  const validIndex =
    assets && assets.length > 0
      ? Math.max(0, Math.min(internalIndex, assets.length - 1))
      : 0;
  const currentAsset = assets && assets.length > 0 ? assets[validIndex] : null;

  currentIndexRef.current = validIndex;
  zoomScaleRef.current = zoomScale;
  assetsLengthRef.current = assets?.length || 0;

  // Consultar peso real del archivo incondicionalmente
  useEffect(() => {
    let active = true;
    if (visible && currentAsset?.uri) {
      if (typeof currentAsset.fileSize === 'number' && currentAsset.fileSize > 0) {
        setAssetSize(currentAsset.fileSize);
      } else {
        setAssetSize(null);
      }
      compressionService.getFileSize(currentAsset, { forceFresh: true }).then((sz) => {
        if (active && sz > 0) {
          currentAsset.fileSize = sz;
          setAssetSize(sz);
        }
      });
    } else {
      setAssetSize(null);
    }
    return () => {
      active = false;
    };
  }, [visible, currentAsset?.id, currentAsset?.uri]);

  const sizeInfo = compressionService.getSizeLevel(assetSize, currentAsset?.mediaType || 'photo');
  const isGreenSize = sizeInfo.level === 'light';

  // Si no está visible o no hay archivos, no mostrar nada (TODOS los hooks ya se ejecutaron)
  if (!visible || !currentAsset) {
    return null;
  }

  // Comprimir foto actual sin perder resolución
  const handleCompressCurrentPhoto = async () => {
    if (isCompressing || !currentAsset) return;
    setIsCompressing(true);
    try {
      const res = await compressionService.compressPhoto(currentAsset, { skipIfGreen: false });
      if (res?.newSize > 0) {
        currentAsset.fileSize = res.newSize;
        setAssetSize(res.newSize);
      }
      if (res?.uri) {
        currentAsset.uri = res.uri;
      }
      setImageRev((r) => r + 1);

      const oldFormatted = compressionService.formatBytes(res.oldSize);
      const savedFormatted = compressionService.formatBytes(res.savedBytes);
      const newFormatted = compressionService.formatBytes(res.newSize);
      const resolutionText =
        res.width && res.height ? `\nResolución intacta: ${res.width} × ${res.height} px (100%)` : '';

      if (res.alreadyOptimized || res.savedBytes <= 0) {
        Alert.alert(
          'Foto ya optimizada',
          `Esta fotografía ya se encuentra en su peso mínimo óptimo (${newFormatted}) manteniendo el 100% de su resolución original.${resolutionText}`
        );
      } else {
        Alert.alert(
          '¡Foto original comprimida!',
          `Se reemplazó el archivo original sin crear copias y manteniendo su resolución al 100%.${resolutionText}\n\nPeso anterior: ${oldFormatted}\nNuevo peso en disco: ${newFormatted}\nEspacio ahorrado: ${savedFormatted}`
        );
      }
      if (onMediaSaved) onMediaSaved();
    } catch (e) {
      if (e?.code === 'PERMISSION_REQUIRED') {
        Alert.alert(
          'Permiso requerido para modificar el original',
          e.message,
          [
            { text: 'Cancelar', style: 'cancel' },
            {
              text: 'Activar permiso en Ajustes',
              onPress: () => folderService.openAllFilesAccessSettings(),
            },
          ]
        );
      } else {
        Alert.alert('Aviso de compresión', 'No se pudo completar la compresión: ' + (e?.message || String(e)));
      }
    } finally {
      setIsCompressing(false);
    }
  };

  // Navegación con flechas
  const handleNext = () => {
    const total = assetsLengthRef.current;
    if (currentIndexRef.current < total - 1) {
      Animated.timing(translateX, {
        toValue: -screenWidth,
        duration: 120,
        useNativeDriver: false,
      }).start(() => {
        setInternalIndex((idx) => Math.min(idx + 1, total - 1));
        setZoomScale(1);
        translateX.setValue(screenWidth);
        Animated.timing(translateX, {
          toValue: 0,
          duration: 120,
          useNativeDriver: false,
        }).start();
      });
    }
  };

  const handlePrev = () => {
    if (currentIndexRef.current > 0) {
      Animated.timing(translateX, {
        toValue: screenWidth,
        duration: 120,
        useNativeDriver: false,
      }).start(() => {
        setInternalIndex((idx) => Math.max(idx - 1, 0));
        setZoomScale(1);
        translateX.setValue(-screenWidth);
        Animated.timing(translateX, {
          toValue: 0,
          duration: 120,
          useNativeDriver: false,
        }).start();
      });
    }
  };

  // Alternar nivel de zoom
  const handleToggleZoom = () => {
    setZoomScale((prev) => {
      const next = prev === 1 ? 2.5 : prev === 2.5 ? 4 : 1;
      if (next === 1) {
        panX.setValue(0);
        panY.setValue(0);
        panOffsetRef.current = { x: 0, y: 0 };
      }
      return next;
    });
  };

  // Girar foto 90 grados con 1 toque
  const handleQuickRotate = async () => {
    if (isRotating || !currentAsset || currentAsset.mediaType === 'video') return;
    setIsRotating(true);
    try {
      let sourceUri = currentAsset.uri;
      if (sourceUri.startsWith('content://')) {
        const tempDest = new File(Paths.cache, `rot_src_${Date.now()}.jpg`);
        try {
          await new File(sourceUri).copy(tempDest);
          sourceUri = tempDest.uri;
        } catch (err) {
          await LegacyFS.copyAsync({ from: sourceUri, to: tempDest.uri });
          sourceUri = tempDest.uri;
        }
      }
      const context = ImageManipulator.manipulate(sourceUri);
      context.rotate(90);
      const rendered = await context.renderAsync();
      const saved = await rendered.saveAsync({
        format: SaveFormat.JPEG,
        compress: 0.95,
      });

      let replaced = false;
      try {
        replaced = await compressionService.overwriteOriginalFile(saved.uri, currentAsset.uri);
      } catch (owErr) {
        replaced = false;
      }
      if (!replaced) {
        await MediaLibrary.saveToLibraryAsync(saved.uri);
        currentAsset.uri = saved.uri;
      }
      if (currentAsset.width && currentAsset.height) {
        const oldW = currentAsset.width;
        currentAsset.width = currentAsset.height;
        currentAsset.height = oldW;
      }
      setImageRev((r) => r + 1);
      if (onMediaSaved) onMediaSaved();
    } catch (e) {
      Alert.alert('Error al girar', String(e?.message || e));
    } finally {
      setIsRotating(false);
    }
  };

  // Toque simple (mostrar/ocultar barras) o doble toque (zoom)
  const handleScreenTouch = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 280) {
      handleToggleZoom();
    } else {
      setShowControls((prev) => !prev);
    }
    lastTapRef.current = now;
  };

  const handleCloseViewer = () => {
    if (cloneAsset) {
      setCloneAsset(null);
      return;
    }
    if (cropAsset) {
      setCropAsset(null);
      return;
    }
    if (playerAsset) {
      setPlayerAsset(null);
      return;
    }
    if (showInfo) {
      setShowInfo(false);
      return;
    }
    if (zoomScale > 1) {
      setZoomScale(1);
      return;
    }
    if (onClose) onClose();
  };

  const handleDeletePrompt = () => {
    Alert.alert(
      '¿Eliminar archivo?',
      'Esta acción solicitará permiso al sistema para eliminar este archivo de tu teléfono.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: () => {
            if (onDelete) onDelete(currentAsset);
          },
        },
      ]
    );
  };

  const isVideo = currentAsset.mediaType === 'video';
  const isCurrentFav = favorites && currentAsset.id
    ? Boolean(favorites[currentAsset.id])
    : Boolean(isFavorite);

  // Cuando se abre el reproductor de video, el recortador o el tapón de clonar, renderizarlo en su propio Modal exclusivo a pantalla completa desde arriba (0,0) sin hermanos debajo
  if (playerAsset) {
    return (
      <Modal
        visible={true}
        animationType="fade"
        transparent={false}
        onRequestClose={() => {
          setPlayerAsset(null);
          if (openedDirectlyAsVideo && onClose) {
            setOpenedDirectlyAsVideo(false);
            onClose();
          }
        }}
      >
        <VideoPlayerScreen
          asset={playerAsset}
          initialMode={playerInitialMode}
          onClose={() => {
            setPlayerAsset(null);
            if (openedDirectlyAsVideo && onClose) {
              setOpenedDirectlyAsVideo(false);
              onClose();
            }
          }}
          onSaved={onMediaSaved}
          onShare={onShare ? () => onShare(playerAsset) : undefined}
          onDelete={
            onDelete
              ? () => {
                  Alert.alert(
                    '¿Eliminar video?',
                    'Esta acción solicitará permiso al sistema para eliminar este video de tu teléfono.',
                    [
                      { text: 'Cancelar', style: 'cancel' },
                      {
                        text: 'Eliminar',
                        style: 'destructive',
                        onPress: () => {
                          setPlayerAsset(null);
                          onDelete(playerAsset);
                        },
                      },
                    ]
                  );
                }
              : undefined
          }
        />
      </Modal>
    );
  }

  if (cropAsset) {
    return (
      <Modal
        visible={true}
        animationType="fade"
        transparent={false}
        onRequestClose={() => setCropAsset(null)}
      >
        <ImageCropper
          asset={cropAsset}
          onClose={() => setCropAsset(null)}
          onSaved={() => {
            setImageRev((r) => r + 1);
            if (currentAsset?.fileSize) setAssetSize(currentAsset.fileSize);
            if (onMediaSaved) onMediaSaved();
          }}
        />
      </Modal>
    );
  }

  if (cloneAsset) {
    return (
      <Modal
        visible={true}
        animationType="fade"
        transparent={false}
        onRequestClose={() => setCloneAsset(null)}
      >
        <CloneStampEditor
          asset={cloneAsset}
          onClose={() => setCloneAsset(null)}
          onSaved={() => {
            setImageRev((r) => r + 1);
            if (currentAsset?.fileSize) setAssetSize(currentAsset.fileSize);
            if (onMediaSaved) onMediaSaved();
          }}
        />
      </Modal>
    );
  }

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={false}
      onRequestClose={handleCloseViewer}
    >
      <View style={styles.fullscreenOverlay}>
      <StatusBar hidden={!showControls} barStyle="light-content" backgroundColor="#000000" />
      <SafeAreaView style={styles.container}>
        {/* Barra Superior de Controles */}
        {showControls && (
          <View style={styles.topBar}>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={handleCloseViewer}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="close" size={26} color="#ffffff" />
            </TouchableOpacity>

            <Text style={styles.counterText}>
              {validIndex + 1} / {assets.length}
            </Text>

            <View style={styles.topRightActions}>
              <TouchableOpacity
                style={styles.iconButton}
                onPress={handleToggleZoom}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <View style={styles.zoomPill}>
                  <Ionicons
                    name={zoomScale > 1 ? 'contract' : 'scan-outline'}
                    size={16}
                    color="#ffffff"
                  />
                  <Text style={styles.zoomText}>{zoomScale}x</Text>
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.iconButton}
                onPress={() => setShowInfo(!showInfo)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons
                  name={showInfo ? 'information-circle' : 'information-circle-outline'}
                  size={26}
                  color={showInfo ? theme.colors.primaryLight : '#ffffff'}
                />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Franja indicadora de peso (Verde 0-2MB, Amarillo 2-4MB, Rojo >4MB con franja y título rojo) */}
        {showControls && (!isVideo || (assetSize !== null && assetSize > 0)) && (
          <View
            style={[
              styles.weightBanner,
              sizeInfo.isHeavy
                ? styles.weightBannerHeavy
                : {
                    backgroundColor: sizeInfo.bannerBg,
                    borderBottomColor: sizeInfo.color,
                  },
            ]}
          >
            {/* Línea de color superior */}
            <View
              style={[
                styles.weightLine,
                { backgroundColor: sizeInfo.color },
              ]}
            />

            <View style={styles.weightBannerContent}>
              <View style={styles.weightTextGroup}>
                <Ionicons
                  name={sizeInfo.isHeavy ? 'alert-circle' : 'speedometer-outline'}
                  size={19}
                  color={sizeInfo.isHeavy ? '#ffffff' : sizeInfo.color}
                />
                <Text
                  style={[
                    styles.weightTitle,
                    sizeInfo.isHeavy
                      ? styles.weightTitleHeavy
                      : { color: sizeInfo.color },
                  ]}
                  numberOfLines={1}
                >
                  {assetSize && assetSize > 0
                    ? sizeInfo.isHeavy
                      ? `PESO ALTO: ${sizeInfo.mb} MB`
                      : `PESO: ${sizeInfo.mb} MB`
                    : 'FOTO (100% RESOLUCIÓN)'}
                </Text>
                {assetSize && assetSize > 0 ? (
                  <View
                    style={[
                      styles.weightTag,
                      {
                        backgroundColor: sizeInfo.isHeavy
                          ? '#991b1b'
                          : sizeInfo.color,
                      },
                    ]}
                  >
                    <Text style={styles.weightTagText}>{sizeInfo.tagText}</Text>
                  </View>
                ) : null}
              </View>

              {/* Botón Comprimir: siempre visible y activo en su color semáforo */}
              <TouchableOpacity
                style={[
                  styles.compressBtn,
                  sizeInfo.isHeavy
                    ? styles.compressBtnHeavy
                    : {
                        backgroundColor: isGreenSize
                          ? 'rgba(16, 185, 129, 0.22)'
                          : 'rgba(245, 158, 11, 0.22)',
                        borderColor: sizeInfo.color,
                      },
                ]}
                onPress={() => {
                  if (isVideo) {
                    setOpenedDirectlyAsVideo(false);
                    setPlayerInitialMode('compress');
                    setPlayerAsset(currentAsset);
                  } else {
                    handleCompressCurrentPhoto();
                  }
                }}
                disabled={isCompressing}
                activeOpacity={0.75}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                {isCompressing ? (
                  <ActivityIndicator
                    size="small"
                    color={sizeInfo.isHeavy ? '#ffffff' : sizeInfo.color}
                  />
                ) : (
                  <>
                    <Ionicons
                      name="sparkles"
                      size={14}
                      color={sizeInfo.isHeavy ? '#ffffff' : sizeInfo.color}
                    />
                    <Text
                      style={[
                        styles.compressBtnText,
                        {
                          color: sizeInfo.isHeavy ? '#ffffff' : sizeInfo.color,
                        },
                      ]}
                    >
                      {sizeInfo.reductionText || 'Comprimir'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Visor Central con Deslizamiento y Zoom Independientes */}
        <View style={styles.carouselContainer} {...panResponder.panHandlers}>
          <TouchableOpacity
            activeOpacity={1}
            style={styles.slideTouchable}
            onPress={handleScreenTouch}
          >
            <Animated.View
              style={[
                styles.swipeContainer,
                {
                  transform: [{ translateX }],
                },
              ]}
            >
              <Animated.View
                style={[
                  styles.zoomContainer,
                  {
                    transform: [
                      { translateX: panX },
                      { translateY: panY },
                      { scale: zoomScale },
                    ],
                  },
                ]}
              >
                {currentAsset.uri && (!isVideo || !playerAsset) ? (
                  <Image
                    source={{ uri: currentAsset.uri }}
                    style={styles.fullImage}
                    contentFit="contain"
                    priority={isVideo ? 'low' : 'high'}
                    transition={0}
                    recyclingKey={`${currentAsset.id}_${imageRev}`}
                    cachePolicy={imageRev > 0 ? 'none' : 'memory-disk'}
                  />
                ) : null}

                {/* Botón central amigable de reproducción si es un video */}
                {isVideo && !playerAsset && (
                  <TouchableOpacity
                    style={styles.centerVideoOverlay}
                    activeOpacity={0.85}
                    onPress={() => {
                      setOpenedDirectlyAsVideo(false);
                      setPlayerInitialMode('play');
                      setPlayerAsset(currentAsset);
                    }}
                  >
                    <View style={styles.friendlyVideoPlayCard}>
                      <Ionicons name="play-circle" size={68} color="#ffffff" />
                      <Text style={styles.friendlyVideoPlayTitle}>Reproducir Video</Text>
                    </View>
                  </TouchableOpacity>
                )}
              </Animated.View>
            </Animated.View>
          </TouchableOpacity>

          {/* Flechas de Navegación Lateral */}
          {showControls && validIndex > 0 && (
            <TouchableOpacity
              style={[styles.arrowButton, styles.leftArrow]}
              onPress={handlePrev}
              activeOpacity={0.7}
              hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
            >
              <Ionicons name="chevron-back" size={30} color="#ffffff" />
            </TouchableOpacity>
          )}

          {showControls && validIndex < assets.length - 1 && (
            <TouchableOpacity
              style={[styles.arrowButton, styles.rightArrow]}
              onPress={handleNext}
              activeOpacity={0.7}
              hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
            >
              <Ionicons name="chevron-forward" size={30} color="#ffffff" />
            </TouchableOpacity>
          )}
        </View>

        {/* Panel Desplegable de Información */}
        {showInfo && currentAsset && (
          <View style={styles.infoSheet}>
            <Text style={styles.infoTitle}>Detalles del archivo</Text>
            <View style={styles.infoRow}>
              <Ionicons name="document-text-outline" size={16} color={theme.colors.textSecondary} />
              <Text style={styles.infoLabel}>Nombre:</Text>
              <Text style={styles.infoValue} numberOfLines={1}>
                {currentAsset.filename || 'Archivo'}
              </Text>
            </View>
            <View style={styles.infoRow}>
              <Ionicons name="calendar-outline" size={16} color={theme.colors.textSecondary} />
              <Text style={styles.infoLabel}>Fecha:</Text>
              <Text style={styles.infoValue}>{formatDate(currentAsset.creationTime)}</Text>
            </View>
            {assetSize ? (
              <View style={styles.infoRow}>
                <Ionicons name="pie-chart-outline" size={16} color={sizeInfo.color} />
                <Text style={styles.infoLabel}>Peso:</Text>
                <Text style={[styles.infoValue, { color: sizeInfo.color, fontWeight: '700' }]}>
                  {compressionService.formatBytes(assetSize)} ({sizeInfo.tagText})
                </Text>
              </View>
            ) : null}
            {currentAsset.width && currentAsset.height ? (
              <View style={styles.infoRow}>
                <Ionicons name="resize-outline" size={16} color={theme.colors.textSecondary} />
                <Text style={styles.infoLabel}>Resolución:</Text>
                <Text style={styles.infoValue}>
                  {currentAsset.width} × {currentAsset.height} px
                </Text>
              </View>
            ) : null}
            <View style={styles.infoRow}>
              <Ionicons
                name={isVideo ? 'videocam-outline' : 'image-outline'}
                size={16}
                color={theme.colors.textSecondary}
              />
              <Text style={styles.infoLabel}>Tipo:</Text>
              <Text style={styles.infoValue}>{isVideo ? 'Video' : 'Fotografía'}</Text>
            </View>
          </View>
        )}

        {/* Barra Inferior de Acciones */}
        {showControls && (
          <View style={styles.bottomBar}>
            {/* Compartir */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => onShare && onShare(currentAsset)}
              activeOpacity={0.7}
            >
              <Ionicons name="share-social-outline" size={24} color="#ffffff" />
              <Text style={styles.actionLabel}>Compartir</Text>
            </TouchableOpacity>

            {/* Favorito */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => onToggleFavorite && onToggleFavorite(currentAsset)}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isCurrentFav ? 'heart' : 'heart-outline'}
                size={26}
                color={isCurrentFav ? theme.colors.favorite : '#ffffff'}
              />
              <Text
                style={[
                  styles.actionLabel,
                  isCurrentFav && { color: theme.colors.favorite, fontWeight: '700' },
                ]}
              >
                Favorito
              </Text>
            </TouchableOpacity>

            {/* Comprimir foto o video (siempre activo con su indicador de color) */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => {
                if (isVideo) {
                  setOpenedDirectlyAsVideo(false);
                  setPlayerInitialMode('compress');
                  setPlayerAsset(currentAsset);
                } else {
                  handleCompressCurrentPhoto();
                }
              }}
              disabled={isCompressing}
              activeOpacity={0.7}
            >
              {isCompressing ? (
                <ActivityIndicator size="small" color={sizeInfo.color} />
              ) : (
                <>
                  <Ionicons
                    name="sparkles"
                    size={24}
                    color={sizeInfo.color}
                  />
                  <Text
                    style={[
                      styles.actionLabel,
                      { color: sizeInfo.color, fontWeight: '700' },
                    ]}
                  >
                    Comprimir
                  </Text>
                </>
              )}
            </TouchableOpacity>

            {/* Girar 90° rápido (solo fotos) o Recortar (en videos) */}
            {!isVideo ? (
              <TouchableOpacity
                style={styles.actionItem}
                onPress={handleQuickRotate}
                disabled={isRotating}
                activeOpacity={0.7}
              >
                {isRotating ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <>
                    <Ionicons name="refresh-outline" size={24} color="#ffffff" />
                    <Text style={styles.actionLabel}>Girar 90°</Text>
                  </>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.actionItem}
                onPress={() => {
                  setOpenedDirectlyAsVideo(false);
                  setPlayerInitialMode('trim');
                  setPlayerAsset(currentAsset);
                }}
                activeOpacity={0.7}
              >
                <Ionicons name="cut-outline" size={24} color="#f59e0b" />
                <Text style={[styles.actionLabel, { color: '#f59e0b' }]}>Recortar</Text>
              </TouchableOpacity>
            )}

            {/* Recortar (foto) / Reproducir (video) */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => {
                if (isVideo) {
                  setOpenedDirectlyAsVideo(false);
                  setPlayerInitialMode('play');
                  setPlayerAsset(currentAsset);
                } else {
                  setCropAsset(currentAsset);
                }
              }}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isVideo ? 'play-circle-outline' : 'crop'}
                size={24}
                color="#ffffff"
              />
              <Text style={styles.actionLabel}>{isVideo ? 'Reproducir' : 'Recortar'}</Text>
            </TouchableOpacity>

            {/* Tapón de Clonar / Borrador de objetos (solo fotos) */}
            {!isVideo && (
              <TouchableOpacity
                style={styles.actionItem}
                onPress={() => setCloneAsset(currentAsset)}
                activeOpacity={0.7}
              >
                <Ionicons name="color-wand-outline" size={24} color="#f59e0b" />
                <Text style={[styles.actionLabel, { color: '#f59e0b' }]}>Clonar</Text>
              </TouchableOpacity>
            )}

            {/* Eliminar */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={handleDeletePrompt}
              activeOpacity={0.7}
            >
              <Ionicons name="trash-outline" size={24} color={theme.colors.danger} />
              <Text style={[styles.actionLabel, { color: theme.colors.danger }]}>Eliminar</Text>
            </TouchableOpacity>
          </View>
        )}
      </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fullscreenOverlay: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#000000',
  },
  container: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    zIndex: 20,
  },
  counterText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  topRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  zoomPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 14,
    gap: 4,
  },
  zoomText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  iconButton: {
    padding: 6,
  },
  weightBanner: {
    position: 'relative',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    zIndex: 19,
  },
  weightBannerHeavy: {
    backgroundColor: '#dc2626', // Franja roja sólida para visualizar fácilmente
    borderBottomColor: '#b91c1c',
  },
  weightLine: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
  },
  weightBannerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  weightTextGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  weightTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  weightTitleHeavy: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  weightTag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  weightTagText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
  compressBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  compressBtnHeavy: {
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    borderColor: '#ffffff',
  },
  compressBtnDisabled: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderColor: 'rgba(148, 163, 184, 0.35)',
    opacity: 0.55,
  },
  compressBtnText: {
    fontSize: 11,
    fontWeight: '700',
  },
  carouselContainer: {
    flex: 1,
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  slideTouchable: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  swipeContainer: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoomContainer: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullImage: {
    width: '100%',
    height: '100%',
  },
  centerVideoOverlay: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  friendlyVideoPlayCard: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.82)',
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: 'rgba(56, 189, 248, 0.5)',
    gap: 6,
  },
  friendlyVideoPlayTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
  },
  arrowButton: {
    position: 'absolute',
    top: '48%',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 24,
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 15,
  },
  leftArrow: {
    left: 12,
  },
  rightArrow: {
    right: 12,
  },
  infoSheet: {
    backgroundColor: 'rgba(18, 24, 38, 0.95)',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: theme.spacing.lg,
    borderTopWidth: 1,
    borderTopColor: theme.colors.surfaceBorder,
    zIndex: 25,
  },
  infoTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    marginBottom: 10,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  infoLabel: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '500',
    width: 80,
  },
  infoValue: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    flex: 1,
  },
  bottomBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: theme.spacing.md,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
    zIndex: 20,
  },
  actionItem: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  actionLabel: {
    color: '#ffffff',
    fontSize: 11,
    marginTop: 4,
    fontWeight: '500',
  },
});
