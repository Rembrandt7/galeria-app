import React, { useMemo, useCallback, useRef } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  Dimensions,
  Text,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import PhotoThumbnail from './PhotoThumbnail';
import { theme } from '../constants/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const NUM_COLUMNS = 3;
const ITEM_MARGIN = 1;
// Screen width minus spacing divided by 3
const ITEM_SIZE = Math.floor((SCREEN_WIDTH - ITEM_MARGIN * (NUM_COLUMNS * 2)) / NUM_COLUMNS);

export default function PhotoGrid({
  assets = [],
  favorites = {},
  onSelectPhoto,
  onRefresh,
  isRefreshing,
  onLoadMore,
  hasMore,
  isLoadingMore,
  emptyMessage = 'No se encontraron fotos ni videos.',
}) {
  const selectRef = useRef(onSelectPhoto);
  selectRef.current = onSelectPhoto;
  const assetsRef = useRef(assets);
  assetsRef.current = assets;

  // Manejador estable: evita re-dibujar todas las miniaturas cada vez que cambia la lista
  const handlePress = useCallback((a) => {
    if (selectRef.current) selectRef.current(a, assetsRef.current);
  }, []);

  const renderItem = useCallback(
    ({ item }) => {
      const isFav = Boolean(favorites[item.id]);
      return (
        <PhotoThumbnail
          asset={item}
          size={ITEM_SIZE}
          onPress={handlePress}
          isFavorite={isFav}
        />
      );
    },
    [favorites, handlePress]
  );

  // Con numColumns, FlatList pide el layout por FILA (no por elemento)
  const getItemLayout = useCallback(
    (_, index) => ({
      length: ITEM_SIZE + ITEM_MARGIN * 2,
      offset: (ITEM_SIZE + ITEM_MARGIN * 2) * index,
      index,
    }),
    []
  );

  const renderFooter = () => {
    if (!isLoadingMore) return <View style={styles.footerSpacing} />;
    return (
      <View style={styles.footerLoader}>
        <ActivityIndicator size="small" color={theme.colors.primary} />
      </View>
    );
  };

  const renderEmpty = () => {
    if (isRefreshing) return null;
    return (
      <View style={styles.emptyContainer}>
        <Ionicons name="images-outline" size={64} color={theme.colors.textMuted} />
        <Text style={styles.emptyText}>{emptyMessage}</Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={assets}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        numColumns={NUM_COLUMNS}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        initialNumToRender={24}
        maxToRenderPerBatch={24}
        updateCellsBatchingPeriod={30}
        windowSize={7}
        removeClippedSubviews={true}
        getItemLayout={getItemLayout}
        onEndReached={() => {
          if (hasMore && !isLoadingMore && onLoadMore) {
            onLoadMore();
          }
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={renderFooter}
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
    paddingHorizontal: ITEM_MARGIN,
    paddingTop: ITEM_MARGIN,
    paddingBottom: 24,
    flexGrow: 1,
  },
  footerLoader: {
    paddingVertical: theme.spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerSpacing: {
    height: 16,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 100,
    paddingHorizontal: theme.spacing.xl,
  },
  emptyText: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    marginTop: theme.spacing.md,
  },
});
