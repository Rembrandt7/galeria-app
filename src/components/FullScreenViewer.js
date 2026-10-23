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
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { compressionService } from '../services/compressionService';
import VideoPlayerScreen from './VideoPlayerScreen';
import ImageCropper from './ImageCropper';

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
  const [cropAsset, setCropAsset] = useState(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [zoomScale, setZoomScale] = useState(1);
  const [assetSize, setAssetSize] = useState(null);
  const [isCompressing, setIsCompressing] = useState(false);

  // Animaciones y referencias declaradas incondicionalmente en la raíz
  const translateX = useRef(new Animated.Value(0)).current;
  const lastTapRef = useRef(0);
  const currentIndexRef = useRef(initialIndex);
  const zoomScaleRef = useRef(1);
  const assetsLengthRef = useRef(assets?.length || 0);

  // PanResponder para deslizar fotos a los lados (declarado incondicionalmente)
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gesture) => {
        return (
          zoomScaleRef.current === 1 &&
          Math.abs(gesture.dx) > 12 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.2
        );
      },
      onPanResponderMove: (_, gesture) => {
        translateX.setValue(gesture.dx);
      },
      onPanResponderRelease: (_, gesture) => {
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
            setZoomScale(1);
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
            setZoomScale(1);
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
    }
  }, [visible, initialIndex, assets?.length]);

  // Manejo de la tecla o gesto atrás de Android
  useEffect(() => {
    if (!visible) return;

    const onBackPress = () => {
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
  }, [visible, cropAsset, playerAsset, showInfo, zoomScale, onClose]);

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
      compressionService.getFileSize(currentAsset.uri).then((sz) => {
        if (active) setAssetSize(sz);
      });
    } else {
      setAssetSize(null);
    }
    return () => {
      active = false;
    };
  }, [visible, currentAsset?.uri]);

  const sizeInfo = compressionService.getSizeLevel(assetSize);

  // Si no está visible o no hay archivos, no mostrar nada (TODOS los hooks ya se ejecutaron)
  if (!visible || !currentAsset) {
    return null;
  }

  // Comprimir foto actual sin perder resolución
  const handleCompressCurrentPhoto = async () => {
    if (isCompressing || !currentAsset) return;
    setIsCompressing(true);
    try {
      const res = await compressionService.compressPhoto(currentAsset);
      setAssetSize(res.newSize);
      const savedFormatted = compressionService.formatBytes(res.savedBytes);
      const newFormatted = compressionService.formatBytes(res.newSize);
      Alert.alert(
        '¡Foto comprimida con éxito!',
        `Se mantuvo la resolución original al 100% (mismo ancho y alto).\n\nNuevo peso: ${newFormatted}\nEspacio ahorrado: ${savedFormatted}`
      );
      if (onMediaSaved) onMediaSaved();
    } catch (e) {
      Alert.alert('Aviso de compresión', 'No se pudo completar la compresión: ' + (e?.message || String(e)));
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
    setZoomScale((prev) => (prev === 1 ? 2 : prev === 2 ? 3 : 1));
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

  return (
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
        {showControls && assetSize !== null && assetSize > 0 && (
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
                  {sizeInfo.isHeavy
                    ? `PESO ALTO: ${sizeInfo.mb} MB`
                    : `PESO: ${sizeInfo.mb} MB`}
                </Text>
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
              </View>

              {/* Botón Comprimir sin perder resolución */}
              {!isVideo && (
                <TouchableOpacity
                  style={[
                    styles.compressBtn,
                    sizeInfo.isHeavy
                      ? styles.compressBtnHeavy
                      : { borderColor: sizeInfo.color },
                  ]}
                  onPress={handleCompressCurrentPhoto}
                  disabled={isCompressing}
                  activeOpacity={0.8}
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
                        size={13}
                        color={sizeInfo.isHeavy ? '#ffffff' : sizeInfo.color}
                      />
                      <Text
                        style={[
                          styles.compressBtnText,
                          {
                            color: sizeInfo.isHeavy
                              ? '#ffffff'
                              : sizeInfo.color,
                          },
                        ]}
                      >
                        Comprimir
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
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
              <View
                style={[
                  styles.zoomContainer,
                  {
                    transform: [{ scale: zoomScale }],
                  },
                ]}
              >
                {currentAsset.uri ? (
                  <Image
                    source={{ uri: currentAsset.uri }}
                    style={styles.fullImage}
                    contentFit="contain"
                    priority="high"
                    transition={0}
                    cachePolicy="memory-disk"
                  />
                ) : null}

                {/* Botón central de reproducción si es un video */}
                {isVideo && (
                  <TouchableOpacity
                    style={styles.centerVideoOverlay}
                    activeOpacity={0.8}
                    onPress={() => setPlayerAsset(currentAsset)}
                  >
                    <Ionicons name="play-circle" size={72} color="rgba(255,255,255,0.9)" />
                  </TouchableOpacity>
                )}
              </View>
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

            {/* Comprimir foto sin perder resolución */}
            {!isVideo && (
              <TouchableOpacity
                style={styles.actionItem}
                onPress={handleCompressCurrentPhoto}
                disabled={isCompressing}
                activeOpacity={0.7}
              >
                {isCompressing ? (
                  <ActivityIndicator size="small" color="#38bdf8" />
                ) : (
                  <>
                    <Ionicons name="sparkles-outline" size={24} color="#38bdf8" />
                    <Text style={[styles.actionLabel, { color: '#38bdf8' }]}>Comprimir</Text>
                  </>
                )}
              </TouchableOpacity>
            )}

            {/* Recortar / Reproducir */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={() =>
                isVideo ? setPlayerAsset(currentAsset) : setCropAsset(currentAsset)
              }
              activeOpacity={0.7}
            >
              <Ionicons
                name={isVideo ? 'play-circle-outline' : 'crop'}
                size={24}
                color="#ffffff"
              />
              <Text style={styles.actionLabel}>{isVideo ? 'Reproducir' : 'Recortar'}</Text>
            </TouchableOpacity>

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

        {/* Sub-pantallas sobrepuestas protegidas */}
        {playerAsset && (
          <VideoPlayerScreen
            asset={playerAsset}
            onClose={() => setPlayerAsset(null)}
            onSaved={onMediaSaved}
          />
        )}
        {cropAsset && (
          <ImageCropper
            asset={cropAsset}
            onClose={() => setCropAsset(null)}
            onSaved={onMediaSaved}
          />
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fullscreenOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    backgroundColor: '#000000',
    zIndex: 99999,
    elevation: 99999,
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
