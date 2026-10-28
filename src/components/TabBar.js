import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

export default function TabBar({
  activeTab,
  onSelectTab,
  favoritesCount = 0,
  trashCount = 0,
  onOpenModoGuardar,
  onOpenDownloader,
  onOpenStore,
  onOpenSettings,
  onOpenCamera,
  onFindDuplicates,
  hasUpdateAvailable = false,
  currentVersionLabel = '',
}) {
  const insets = useSafeAreaInsets();
  // Elevar la barra flotante por encima de los símbolos/botones de navegación de Android
  const safeBottomOffset = Math.max((insets?.bottom || 0) + 12, Platform.OS === 'android' ? 44 : 24);

  const dockItems = [
    {
      key: 'photos',
      label: 'Fotos',
      icon: 'camera-outline',
      iconActive: 'camera',
      isTab: true,
    },
    {
      key: 'albums',
      label: 'Álbumes',
      icon: 'book-outline',
      iconActive: 'book',
      isTab: true,
    },
    {
      key: 'folder',
      label: 'Explorador',
      icon: 'folder-open-outline',
      iconActive: 'folder-open',
      isTab: true,
      accentColor: '#38bdf8',
    },
    {
      key: 'modo_guardar',
      label: trashCount > 0 ? `Modo Guardar (${trashCount})` : 'Modo Guardar',
      icon: 'swap-vertical-outline',
      iconActive: 'swap-vertical',
      onPress: onOpenModoGuardar,
      accentColor: trashCount > 0 ? '#f43f5e' : '#10b981',
      hasDot: trashCount > 0,
    },
    {
      key: 'downloader',
      label: 'Descargas',
      icon: 'cloud-download-outline',
      iconActive: 'cloud-download',
      onPress: onOpenDownloader,
      accentColor: '#38bdf8',
    },
    {
      key: 'store',
      label: 'Tienda',
      icon: 'bag-handle-outline',
      iconActive: 'bag-handle',
      onPress: onOpenStore,
      accentColor: '#a78bfa',
    },
    {
      key: 'update',
      label: hasUpdateAvailable ? '¡Actualizar!' : 'Actualizar',
      icon: hasUpdateAvailable ? 'arrow-up-circle' : 'arrow-up-circle-outline',
      iconActive: 'arrow-up-circle',
      onPress: onOpenSettings,
      accentColor: hasUpdateAvailable ? '#10b981' : '#fbbf24',
      hasDot: hasUpdateAvailable,
      subBadge: currentVersionLabel,
    },
    {
      key: 'camera',
      label: 'Cámara',
      icon: 'camera-outline',
      iconActive: 'camera',
      onPress: onOpenCamera,
    },
    {
      key: 'duplicates',
      label: 'Limpiar',
      icon: 'sparkles-outline',
      iconActive: 'sparkles',
      onPress: onFindDuplicates,
    },
  ];

  if (favoritesCount > 0 || activeTab === 'favorites') {
    dockItems.splice(2, 0, {
      key: 'favorites',
      label: `Favoritos (${favoritesCount})`,
      icon: 'heart-outline',
      iconActive: 'heart',
      isTab: true,
      accentColor: '#f43f5e',
    });
  }

  return (
    <View
      style={[styles.floatingDockWrapper, { bottom: safeBottomOffset }]}
      pointerEvents="box-none"
    >
      <View style={styles.galaxyCapsule}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.capsuleScrollContent}
        >
          {dockItems.map((item) => {
            const isSelected =
              item.isTab &&
              (activeTab === item.key ||
                (item.key === 'albums' && activeTab === 'folder'));

            const iconColor = isSelected
              ? '#ffffff'
              : item.accentColor || '#d4d4d8';

            return (
              <TouchableOpacity
                key={item.key}
                style={[
                  styles.dockButton,
                  isSelected && styles.dockButtonActive,
                  item.key === 'update' && hasUpdateAvailable && styles.dockButtonUpdateReady,
                ]}
                onPress={() => {
                  if (item.isTab) {
                    onSelectTab(item.key);
                  } else if (item.onPress) {
                    item.onPress();
                  }
                }}
                activeOpacity={0.78}
              >
                <View style={styles.iconWrap}>
                  <Ionicons
                    name={isSelected ? item.iconActive : item.icon}
                    size={21}
                    color={iconColor}
                  />
                  {item.hasDot && <View style={styles.updateDot} />}
                </View>
                <Text
                  style={[
                    styles.dockLabel,
                    isSelected && styles.dockLabelActive,
                    item.key === 'update' &&
                      hasUpdateAvailable && { color: '#34d399', fontWeight: '800' },
                  ]}
                  numberOfLines={1}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  floatingDockWrapper: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: Platform.OS === 'android' ? 14 : 20,
    alignItems: 'center',
    zIndex: 100,
  },
  galaxyCapsule: {
    maxWidth: '100%',
    backgroundColor: 'rgba(36, 36, 40, 0.96)',
    borderRadius: 36,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.55,
    shadowRadius: 16,
    elevation: 18,
  },
  capsuleScrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  dockButton: {
    minWidth: 68,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  dockButtonActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.17)',
  },
  dockButtonUpdateReady: {
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.45)',
  },
  iconWrap: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  updateDot: {
    position: 'absolute',
    top: -2,
    right: -5,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10b981',
    borderWidth: 1.5,
    borderColor: '#242428',
  },
  dockLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#d4d4d8',
    letterSpacing: -0.1,
  },
  dockLabelActive: {
    color: '#ffffff',
    fontWeight: '800',
  },
});
