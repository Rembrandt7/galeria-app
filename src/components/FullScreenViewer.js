import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Dimensions,
  TouchableOpacity,
  Alert,
  FlatList,
  StatusBar,
  SafeAreaView,
  Animated,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import VideoPlayerScreen from './VideoPlayerScreen';
import ImageCropper from './ImageCropper';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

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

// Diapositiva individual ultra-optimizada con descarte de memoria fuera de pantalla
const SlideItem = React.memo(function SlideItem({
  item,
  isCurrent,
  isNear,
  zoomScale,
  onPlayVideo,
  onToggleZoom,
}) {
  const lastTapRef = useRef(0);

  const handleDoubleTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      if (onToggleZoom) onToggleZoom();
    }
    lastTapRef.current = now;
  };

  // Solo renderizar el componente pesado Image si está visible o adyacente inmediato (±1)
  // Fuera de eso liberamos la memoria del hilo de renderizado para cero lag
  if (!isNear) {
    return <View style={styles.slide} />;
  }

  return (
    <TouchableOpacity
      activeOpacity={1}
      style={styles.slide}
      onPress={handleDoubleTap}
    >
      <Image
        source={{ uri: item.uri }}
        style={[
          styles.fullImage,
          isCurrent && zoomScale > 1 ? { transform: [{ scale: zoomScale }] } : null,
        ]}
        contentFit="contain"
        priority={isCurrent ? 'high' : 'low'}
        transition={0}
        cachePolicy="memory-disk"
        recyclingKey={item.id}
      />
      {item.mediaType === 'video' && (
        <TouchableOpacity
          style={styles.centerVideoOverlay}
          activeOpacity={0.8}
          onPress={() => onPlayVideo(item)}
        >
          <Ionicons name="play-circle" size={68} color="rgba(255,255,255,0.85)" />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
});

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
  const [zoomScale, setZoomScale] = useState(1);
  const flatListRef = useRef(null);

  useEffect(() => {
    if (visible) {
      setCurrentIndex(initialIndex);
      setZoomScale(1);
      setShowInfo(false);
    }
  }, [visible, initialIndex]);

  if (!visible || assets.length === 0) return null;

  const currentAsset = assets[currentIndex] || assets[0];

  const handleNext = () => {
    if (currentIndex < assets.length - 1) {
      flatListRef.current?.scrollToIndex({ index: currentIndex + 1, animated: true });
      setCurrentIndex(currentIndex + 1);
      setZoomScale(1);
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      flatListRef.current?.scrollToIndex({ index: currentIndex - 1, animated: true });
      setCurrentIndex(currentIndex - 1);
      setZoomScale(1);
    }
  };

  const handleToggleZoom = useCallback(() => {
    setZoomScale((prev) => (prev === 1 ? 2 : prev === 2 ? 3 : 1));
  }, []);

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

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems && viewableItems.length > 0) {
      const newIndex = viewableItems[0].index;
      if (newIndex !== null && newIndex !== undefined) {
        setCurrentIndex(newIndex);
        setZoomScale(1);
      }
    }
  }).current;

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 60,
  }).current;

  const renderItem = useCallback(
    ({ item, index }) => {
      const isCurrent = index === currentIndex;
      const isNear = Math.abs(index - currentIndex) <= 1;
      return (
        <SlideItem
          item={item}
          isCurrent={isCurrent}
          isNear={isNear}
          zoomScale={zoomScale}
          onPlayVideo={setPlayerAsset}
          onToggleZoom={handleToggleZoom}
        />
      );
    },
    [currentIndex, zoomScale, handleToggleZoom]
  );

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent={true}
    >
      <StatusBar hidden={false} barStyle="light-content" backgroundColor="#000000" />
      <SafeAreaView style={styles.container}>
        {/* Barra Superior */}
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
                  size={18}
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

        {/* Carrusel Deslizable de Fotos */}
        <View style={styles.carouselContainer}>
          <FlatList
            ref={flatListRef}
            data={assets}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(item) => item.id}
            getItemLayout={(_, index) => ({
              length: SCREEN_WIDTH,
              offset: SCREEN_WIDTH * index,
              index,
            })}
            initialScrollIndex={initialIndex < assets.length ? initialIndex : 0}
            onScrollToIndexFailed={(info) => {
              setTimeout(() => {
                flatListRef.current?.scrollToIndex({ index: info.index, animated: false });
              }, 100);
            }}
            windowSize={3}
            initialNumToRender={1}
            maxToRenderPerBatch={2}
            removeClippedSubviews={Platform.OS === 'android'}
            scrollEnabled={zoomScale === 1}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            renderItem={renderItem}
          />

          {/* Flechas de Navegación Lateral */}
          {currentIndex > 0 && (
            <TouchableOpacity
              style={[styles.arrowButton, styles.leftArrow]}
              onPress={handlePrev}
              activeOpacity={0.7}
            >
              <Ionicons name="chevron-back" size={30} color="#ffffff" />
            </TouchableOpacity>
          )}

          {currentIndex < assets.length - 1 && (
            <TouchableOpacity
              style={[styles.arrowButton, styles.rightArrow]}
              onPress={handleNext}
              activeOpacity={0.7}
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
                {currentAsset.filename || 'Foto'}
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
                name={currentAsset.mediaType === 'video' ? 'videocam-outline' : 'image-outline'}
                size={16}
                color={theme.colors.textSecondary}
              />
              <Text style={styles.infoLabel}>Tipo:</Text>
              <Text style={styles.infoValue}>
                {currentAsset.mediaType === 'video' ? 'Video' : 'Fotografía'}
              </Text>
            </View>
          </View>
        )}

        {/* Barra Inferior de Acciones */}
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
              {isFavorite ? 'Favorito' : 'Favorito'}
            </Text>
          </TouchableOpacity>

          {/* Recortar / Reproducir */}
          <TouchableOpacity
            style={styles.actionItem}
            onPress={() =>
              currentAsset.mediaType === 'video'
                ? setPlayerAsset(currentAsset)
                : setCropAsset(currentAsset)
            }
            activeOpacity={0.7}
          >
            <Ionicons
              name={currentAsset.mediaType === 'video' ? 'play-circle-outline' : 'crop'}
              size={24}
              color="#ffffff"
            />
            <Text style={styles.actionLabel}>
              {currentAsset.mediaType === 'video' ? 'Reproducir' : 'Recortar'}
            </Text>
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
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    zIndex: 10,
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
  },
  slide: {
    width: SCREEN_WIDTH,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullImage: {
    width: SCREEN_WIDTH,
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
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    borderRadius: 24,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
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
    zIndex: 20,
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
    zIndex: 10,
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
