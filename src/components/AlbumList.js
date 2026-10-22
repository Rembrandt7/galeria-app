import React from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const COLUMN_GAP = 12;
const NUM_COLUMNS = 2;
const CARD_WIDTH = (SCREEN_WIDTH - theme.spacing.lg * 2 - COLUMN_GAP) / NUM_COLUMNS;

export default function AlbumList({
  albums = [],
  onSelectAlbum,
  onRefresh,
  isRefreshing,
}) {
  const renderItem = ({ item }) => {
    return (
      <TouchableOpacity
        style={[styles.albumCard, { width: CARD_WIDTH }]}
        activeOpacity={0.8}
        onPress={() => onSelectAlbum(item)}
      >
        <View style={styles.coverWrapper}>
          {item.coverUri ? (
            <Image
              source={{ uri: item.coverUri }}
              style={styles.coverImage}
              contentFit="cover"
              transition={200}
              cachePolicy="memory-disk"
            />
          ) : (
            <View style={styles.fallbackCover}>
              <Ionicons name="folder-open" size={40} color={theme.colors.textMuted} />
            </View>
          )}
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{item.assetCount}</Text>
          </View>
        </View>

        <View style={styles.infoWrapper}>
          <Text style={styles.albumTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.albumSubtitle}>
            {item.assetCount} {item.assetCount === 1 ? 'elemento' : 'elementos'}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmpty = () => {
    if (isRefreshing) return null;
    return (
      <View style={styles.emptyContainer}>
        <Ionicons name="folder-outline" size={64} color={theme.colors.textMuted} />
        <Text style={styles.emptyText}>No se encontraron álbumes en el teléfono.</Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={albums}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        numColumns={NUM_COLUMNS}
        columnWrapperStyle={styles.columnWrapper}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={renderEmpty}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.surface}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  listContent: {
    padding: theme.spacing.lg,
    paddingBottom: 32,
    flexGrow: 1,
  },
  columnWrapper: {
    justifyContent: 'space-between',
    marginBottom: theme.spacing.lg,
  },
  albumCard: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  coverWrapper: {
    width: '100%',
    height: CARD_WIDTH,
    position: 'relative',
    backgroundColor: theme.colors.surfaceHover,
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  fallbackCover: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceHover,
  },
  countBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  countText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
  infoWrapper: {
    padding: theme.spacing.sm,
  },
  albumTitle: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  albumSubtitle: {
    color: theme.colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 100,
  },
  emptyText: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    marginTop: theme.spacing.md,
  },
});
