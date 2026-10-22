import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';

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
  isFavorite = false,
}) {
  const isVideo = asset.mediaType === 'video';

  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={() => onPress(asset)}
      style={[styles.container, { width: size, height: size }]}
    >
      <Image
        source={{ uri: asset.uri }}
        style={styles.image}
        contentFit="cover"
        recyclingKey={asset.id}
        priority="normal"
        transition={100}
        cachePolicy="memory-disk"
      />

      {/* Video Badge */}
      {isVideo && (
        <View style={styles.videoBadge}>
          <Ionicons name="play" size={12} color="#ffffff" />
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
  image: {
    width: '100%',
    height: '100%',
  },
  videoBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    gap: 3,
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
});

export default PhotoThumbnail;
