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
  onOpenBrowser,
  onOpenStore,
  onOpenSettings,
  onOpenCamera,
  onFindDuplicates,
  hasUpdateAvailable = false,
  currentVersionLabel = '',
}) {
  const insets = useSafeAreaInsets();
  // Elevar la barra flotante por encima de los símbolos/botones de navegación de Android
  const safeBottomOffset = Math.max((insets?.bottom || 0) + 10, Platform.OS === 'android' ? 42 : 22);

  const dockItems = [
    {
      key: 'photos',
      label: 'Fotos',
      icon: 'images-outline',
      iconActive: 'images',
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
      label: 'Carpetas',
      icon: 'folder-open-outline',
      iconActive: 'folder-open',
      isTab: true,
      accentColor: '#38bdf8',
    },
    {
      key: 'modo_guardar',
      label: trashCount > 0 ? `Guardar (${trashCount})` : 'Guardar',
      icon: 'swap-vertical-outline',
      iconActive: 'swap-vertical',
      onPress: onOpenModoGuardar,
      accentColor: trashCount > 0 ? '#f43f5e' : '#10b981',
      hasDot: trashCount > 0,
    },
    {
      key: 'duplicates',
      label: 'Duplicados',
      icon: 'copy-outline',
      iconActive: 'copy',
      onPress: onFindDuplicates,
      accentColor: '#fbbf24',
    },
    {
      key: 'browser',
      label: 'Navegador',
      icon: 'globe-outline',
      iconActive: 'globe',
      onPress: onOpenBrowser,
      accentColor: '#60a5fa',
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
  ];

  if (favoritesCount > 0 || activeTab === 'favorites') {
    dockItems.splice(2, 0, {
      key: 'favorites',
      label: `Favs (${favoritesCount})`,
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
            const isSelected = item.isTab && activeTab === item.key;

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
                    size={18}
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
    left: 6,
    right: 6,
    bottom: Platform.OS === 'android' ? 12 : 18,
    alignItems: 'center',
    zIndex: 100,
  },
  galaxyCapsule: {
    maxWidth: '100%',
    backgroundColor: 'rgba(30, 30, 36, 0.96)',
    borderRadius: 30,
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 16,
  },
  capsuleScrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
  },
  dockButton: {
    minWidth: 48,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
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
    right: -4,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#10b981',
    borderWidth: 1,
    borderColor: '#242428',
  },
  dockLabel: {
    fontSize: 9.5,
    fontWeight: '600',
    color: '#d4d4d8',
    letterSpacing: -0.2,
  },
  dockLabelActive: {
    color: '#ffffff',
    fontWeight: '800',
  },
});
