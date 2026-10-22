import React, { useMemo } from 'react';
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
  hiddenFolders = {},
  onToggleHideFolder,
  showAllFolders = false,
  onToggleShowAllFolders,
}) {
  const visibleAlbums = useMemo(() => {
    if (showAllFolders) return albums;
    return albums.filter((item) => !(hiddenFolders[item.title] || hiddenFolders[item.id]));
  }, [albums, hiddenFolders, showAllFolders]);

  const hiddenCount = useMemo(() => {
    return albums.filter((item) => Boolean(hiddenFolders[item.title] || hiddenFolders[item.id])).length;
  }, [albums, hiddenFolders]);

  const renderItem = ({ item }) => {
    const isHidden = Boolean(hiddenFolders[item.title] || hiddenFolders[item.id]);

    return (
      <TouchableOpacity
        style={[
          styles.albumCard,
          { width: CARD_WIDTH },
          isHidden && styles.albumCardHidden,
        ]}
        activeOpacity={0.8}
        onPress={() => onSelectAlbum(item)}
      >
        <View style={styles.coverWrapper}>
          {item.coverUri ? (
            <Image
              source={{ uri: item.coverUri }}
              style={[styles.coverImage, isHidden && { opacity: 0.6 }]}
              contentFit="cover"
              transition={100}
              cachePolicy="memory-disk"
            />
          ) : (
            <View style={styles.fallbackCover}>
              <Ionicons name="folder-open" size={40} color={theme.colors.textMuted} />
            </View>
          )}

          {/* Botón de Ocultar / Prender Carpeta */}
          <TouchableOpacity
            style={[styles.eyeButton, isHidden && styles.eyeButtonHidden]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={(e) => {
              e.stopPropagation();
              if (onToggleHideFolder) onToggleHideFolder(item.title, item.title);
            }}
            activeOpacity={0.7}
          >
            <Ionicons
              name={isHidden ? 'eye-off' : 'eye-outline'}
              size={18}
              color={isHidden ? '#f59e0b' : '#ffffff'}
            />
          </TouchableOpacity>

          {/* Badge Oculto o Contador */}
          {isHidden ? (
            <View style={styles.hiddenBadge}>
              <Ionicons name="eye-off" size={11} color="#ffffff" />
              <Text style={styles.hiddenBadgeText}>Oculto</Text>
            </View>
          ) : (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{item.assetCount}</Text>
            </View>
          )}
        </View>

        <View style={styles.infoWrapper}>
          <Text style={[styles.albumTitle, isHidden && styles.albumTitleHidden]} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.albumSubtitle}>
            {item.assetCount} {item.assetCount === 1 ? 'elemento' : 'elementos'}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderHeader = () => (
    <View style={styles.topFilterBar}>
      <View style={styles.titleCountRow}>
        <Text style={styles.albumCountText}>
          {visibleAlbums.length} {visibleAlbums.length === 1 ? 'álbum' : 'álbumes'}
        </Text>
        {hiddenCount > 0 && (
          <Text style={styles.hiddenInfoText}>
            ({hiddenCount} {hiddenCount === 1 ? 'oculto' : 'ocultos'})
          </Text>
        )}
      </View>

      <TouchableOpacity
        style={[styles.showAllToggle, showAllFolders && styles.showAllToggleActive]}
        onPress={onToggleShowAllFolders}
        activeOpacity={0.8}
      >
        <Ionicons
          name={showAllFolders ? 'eye' : 'eye-off-outline'}
          size={14}
          color={showAllFolders ? '#ffffff' : theme.colors.textSecondary}
        />
        <Text style={[styles.showAllToggleText, showAllFolders && styles.showAllToggleTextActive]}>
          {showAllFolders ? 'Todo visible' : 'Ocultas (off)'}
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderEmpty = () => {
    if (isRefreshing) return null;
    return (
      <View style={styles.emptyContainer}>
        <Ionicons name="folder-outline" size={64} color={theme.colors.textMuted} />
        <Text style={styles.emptyText}>
          {hiddenCount > 0 && !showAllFolders
            ? 'Todos los álbumes están ocultos. Activa "Todo visible" arriba para verlos.'
            : 'No se encontraron álbumes en el teléfono.'}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={visibleAlbums}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        numColumns={NUM_COLUMNS}
        columnWrapperStyle={styles.columnWrapper}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={renderHeader}
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
  topFilterBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  titleCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  albumCountText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  hiddenInfoText: {
    color: '#f59e0b',
    fontSize: 12,
    fontWeight: '600',
  },
  showAllToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceHover,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    gap: 6,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  showAllToggleActive: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  showAllToggleText: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  showAllToggleTextActive: {
    color: '#ffffff',
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
  albumCardHidden: {
    borderColor: '#f59e0b',
    borderStyle: 'dashed',
    opacity: 0.85,
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
  eyeButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  eyeButtonHidden: {
    backgroundColor: 'rgba(245, 158, 11, 0.9)',
  },
  hiddenBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: '#f59e0b',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  hiddenBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
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
  albumTitleHidden: {
    color: '#f59e0b',
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
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 32,
    marginTop: theme.spacing.md,
    lineHeight: 20,
  },
});
