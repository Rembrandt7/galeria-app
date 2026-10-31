import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { compressionService } from '../services/compressionService';

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

const PhotoThumbnail = React.memo(function PhotoThumbnail({
  asset,
  size,
  onPress,
  onLongPress,
  isFavorite = false,
  isCover = false,
  selectable = false,
  isSelected = false,
}) {
  const isVideo = asset.mediaType === 'video';
  const videoSizeInfo = isVideo
    ? compressionService.getSizeLevel(asset.fileSize || 0, 'video', asset.duration || 0)
    : null;

  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={() => onPress(asset)}
      onLongPress={() => onLongPress && onLongPress(asset)}
      delayLongPress={250}
      style={[
        styles.container,
        { width: size, height: size },
        isSelected && styles.containerSelected,
      ]}
    >
      <Image
        source={{ uri: asset.uri }}
        style={[styles.image, isSelected && styles.imageSelected]}
        contentFit="cover"
        allowDownscaling={true}
        decodeFormat="rgb"
        recyclingKey={asset.id}
        priority="normal"
        transition={0}
        cachePolicy="memory-disk"
      />

      {/* Selection Checkmark Overlay */}
      {selectable && (
        <View style={[styles.selectBadge, isSelected && styles.selectBadgeActive]}>
          <Ionicons
            name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
            size={20}
            color={isSelected ? '#38bdf8' : 'rgba(255, 255, 255, 0.85)'}
          />
        </View>
      )}

      {/* Video Badge con Semáforo por Duración (Verde = no comprimible, Amarillo = poco, Rojo = mucho) */}
      {isVideo && (
        <View
          style={[
            styles.videoBadge,
            videoSizeInfo && {
              borderWidth: 1,
              borderColor: videoSizeInfo.color,
            },
          ]}
        >
          {videoSizeInfo && (
            <View
              style={[
                styles.videoLevelDot,
                { backgroundColor: videoSizeInfo.color },
              ]}
            />
          )}
          <Ionicons name="play" size={11} color="#ffffff" />
          {asset.duration > 0 ? (
            <Text style={styles.videoDuration}>{formatDuration(asset.duration)}</Text>
          ) : null}
        </View>
      )}

      {/* Favorite Heart Badge */}
      {isFavorite && (
        <View style={styles.favoriteBadge}>
          <Ionicons name="heart" size={14} color={theme.colors.favorite} />
        </View>
      )}

      {/* Folder Cover Badge */}
      {isCover && (
        <View style={styles.coverBadge}>
          <Ionicons name="star" size={10} color="#fbbf24" />
          <Text style={styles.coverBadgeText}>Portada</Text>
        </View>
      )}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  container: {
    margin: 1,
    backgroundColor: theme.colors.surfaceHover,
    position: 'relative',
    overflow: 'hidden',
  },
  containerSelected: {
    borderWidth: 2,
    borderColor: '#38bdf8',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imageSelected: {
    opacity: 0.78,
  },
  selectBadge: {
    position: 'absolute',
    top: 4,
    left: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    borderRadius: 12,
    padding: 1,
  },
  selectBadgeActive: {
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
  },
  videoBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    gap: 3.5,
  },
  videoLevelDot: {
    width: 6.5,
    height: 6.5,
    borderRadius: 3.5,
  },
  videoDuration: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '600',
  },
  favoriteBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 12,
    padding: 3,
  },
  coverBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.65)',
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1.5,
  },
  coverBadgeText: {
    color: '#fde68a',
    fontSize: 9,
    fontWeight: '800',
  },
});

export default PhotoThumbnail;
