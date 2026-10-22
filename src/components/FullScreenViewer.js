import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Dimensions,
  TouchableOpacity,
  Alert,
  StatusBar,
  SafeAreaView,
  Animated,
  PanResponder,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
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
  visible,
  assets = [],
  initialIndex = 0,
  onClose,
  isFavorite = false,
  onToggleFavorite,
  onShare,
  onDelete,
  onMediaSaved,
}) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [playerAsset, setPlayerAsset] = useState(null);
  const [cropAsset, setCropAsset] = useState(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [zoomScale, setZoomScale] = useState(1);

  const screenWidth = Math.round(Dimensions.get('window').width);
  const translateX = useRef(new Animated.Value(0)).current;
  const lastTapRef = useRef(0);

  // Sincronizar índice inicial al abrirse
  useEffect(() => {
    if (visible) {
      const validIndex = initialIndex >= 0 && initialIndex < assets.length ? initialIndex : 0;
      setCurrentIndex(validIndex);
      setZoomScale(1);
      setShowInfo(false);
      setShowControls(true);
      translateX.setValue(0);
    }
  }, [visible, initialIndex, assets.length]);

  // Si no está visible o no hay archivos, no renderizar
  if (!visible || !assets || assets.length === 0) return null;

  const currentAsset = assets[currentIndex] || assets[0] || null;
  if (!currentAsset) return null;

  // Cambiar a la siguiente imagen con animación fluida
  const handleNext = () => {
    if (currentIndex < assets.length - 1) {
      Animated.timing(translateX, {
        toValue: -screenWidth,
        duration: 120,
        useNativeDriver: true,
      }).start(() => {
        setCurrentIndex((idx) => idx + 1);
        setZoomScale(1);
        translateX.setValue(screenWidth);
        Animated.timing(translateX, {
          toValue: 0,
          duration: 120,
          useNativeDriver: true,
        }).start();
      });
    }
  };

  // Cambiar a la imagen anterior con animación fluida
  const handlePrev = () => {
    if (currentIndex > 0) {
      Animated.timing(translateX, {
        toValue: screenWidth,
        duration: 120,
        useNativeDriver: true,
      }).start(() => {
        setCurrentIndex((idx) => idx - 1);
        setZoomScale(1);
        translateX.setValue(-screenWidth);
        Animated.timing(translateX, {
          toValue: 0,
          duration: 120,
          useNativeDriver: true,
        }).start();
      });
    }
  };

  // Alternar zoom
  const handleToggleZoom = () => {
    setZoomScale((prev) => (prev === 1 ? 2 : prev === 2 ? 3 : 1));
  };

  // Toque simple (ocultar/mostrar barras) o doble toque (zoom)
  const handleScreenTouch = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 280) {
      handleToggleZoom();
    } else {
      setShowControls((prev) => !prev);
    }
    lastTapRef.current = now;
  };

  // PanResponder táctil para deslizar fotos a los lados
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gesture) => {
        // Solo deslizar si no hay zoom y el movimiento es predominantemente horizontal
        return (
          zoomScale === 1 &&
          Math.abs(gesture.dx) > 12 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.2
        );
      },
      onPanResponderMove: (_, gesture) => {
        translateX.setValue(gesture.dx);
      },
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dx < -60 && currentIndex < assets.length - 1) {
          // Deslizó hacia la izquierda -> Siguiente
          Animated.timing(translateX, {
            toValue: -screenWidth,
            duration: 130,
            useNativeDriver: true,
          }).start(() => {
            setCurrentIndex((idx) => Math.min(idx + 1, assets.length - 1));
            setZoomScale(1);
            translateX.setValue(screenWidth);
            Animated.timing(translateX, {
              toValue: 0,
              duration: 130,
              useNativeDriver: true,
            }).start();
          });
        } else if (gesture.dx > 60 && currentIndex > 0) {
          // Deslizó hacia la derecha -> Anterior
          Animated.timing(translateX, {
            toValue: screenWidth,
            duration: 130,
            useNativeDriver: true,
          }).start(() => {
            setCurrentIndex((idx) => Math.max(idx - 1, 0));
            setZoomScale(1);
            translateX.setValue(-screenWidth);
            Animated.timing(translateX, {
              toValue: 0,
              duration: 130,
              useNativeDriver: true,
            }).start();
          });
        } else {
          // Regresar al centro si el arrastre fue corto
          Animated.spring(translateX, {
            toValue: 0,
            friction: 7,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  // Confirmar eliminación
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
            onDelete(currentAsset);
          },
        },
      ]
    );
  };

  const isVideo = currentAsset.mediaType === 'video';

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent={true}
    >
      <StatusBar hidden={!showControls} barStyle="light-content" backgroundColor="#000000" />
      <SafeAreaView style={styles.container}>
        {/* Barra Superior */}
        {showControls && (
          <View style={styles.topBar}>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={onClose}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Ionicons name="close" size={26} color="#ffffff" />
            </TouchableOpacity>

            <Text style={styles.counterText}>
              {currentIndex + 1} / {assets.length}
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

        {/* Visor Central Táctil con soporte de deslizamiento */}
        <View style={styles.carouselContainer} {...panResponder.panHandlers}>
          <TouchableOpacity activeOpacity={1} style={styles.slideTouchable} onPress={handleScreenTouch}>
            <Animated.View
              style={[
                styles.imageWrapper,
                {
                  transform: [
                    { translateX },
                    { scale: zoomScale },
                  ],
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

              {/* Botón de reproducción si es un video */}
              {isVideo && (
                <TouchableOpacity
                  style={styles.centerVideoOverlay}
                  activeOpacity={0.8}
                  onPress={() => setPlayerAsset(currentAsset)}
                >
                  <Ionicons name="play-circle" size={72} color="rgba(255,255,255,0.9)" />
                </TouchableOpacity>
              )}
            </Animated.View>
          </TouchableOpacity>

          {/* Flechas de Navegación Lateral */}
          {showControls && currentIndex > 0 && (
            <TouchableOpacity
              style={[styles.arrowButton, styles.leftArrow]}
              onPress={handlePrev}
              activeOpacity={0.7}
              hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
            >
              <Ionicons name="chevron-back" size={30} color="#ffffff" />
            </TouchableOpacity>
          )}

          {showControls && currentIndex < assets.length - 1 && (
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
              onPress={() => onShare(currentAsset)}
              activeOpacity={0.7}
            >
              <Ionicons name="share-social-outline" size={24} color="#ffffff" />
              <Text style={styles.actionLabel}>Compartir</Text>
            </TouchableOpacity>

            {/* Favorito */}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => onToggleFavorite(currentAsset)}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isFavorite ? 'heart' : 'heart-outline'}
                size={26}
                color={isFavorite ? theme.colors.favorite : '#ffffff'}
              />
              <Text
                style={[
                  styles.actionLabel,
                  isFavorite && { color: theme.colors.favorite, fontWeight: '700' },
                ]}
              >
                Favorito
              </Text>
            </TouchableOpacity>

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
    </Modal>
  );
}

const styles = StyleSheet.create({
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
  imageWrapper: {
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
    paddingHorizontal: 16,
  },
  actionLabel: {
    color: '#ffffff',
    fontSize: 12,
    marginTop: 4,
    fontWeight: '500',
  },
});
