import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';

export default function TabBar({ activeTab, onSelectTab, favoritesCount = 0 }) {
  // Orden requerido: Mi carpeta -> Álbumes -> Fotos -> (Corazón rojo + contador solo si hay favoritos)
  const tabs = [
    { key: 'folder', label: 'Mi carpeta', icon: 'folder-open-outline', iconActive: 'folder-open' },
    { key: 'albums', label: 'Álbumes', icon: 'albums-outline', iconActive: 'albums' },
    { key: 'photos', label: 'Fotos', icon: 'images-outline', iconActive: 'images' },
  ];

  if (favoritesCount > 0 || activeTab === 'favorites') {
    tabs.push({
      key: 'favorites',
      label: '',
      icon: 'heart',
      iconActive: 'heart',
      badge: favoritesCount,
      isHeartOnly: true,
    });
  }

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          if (tab.isHeartOnly) {
            return (
              <TouchableOpacity
                key={tab.key}
                style={[
                  styles.tabPill,
                  styles.heartOnlyPill,
                  isActive && styles.heartOnlyPillActive,
                ]}
                onPress={() => onSelectTab(tab.key)}
                activeOpacity={0.75}
              >
                <Ionicons
                  name="heart"
                  size={17}
                  color={isActive ? '#ffffff' : '#ef4444'}
                />
                {tab.badge > 0 && (
                  <Text
                    style={[
                      styles.heartCountText,
                      isActive && { color: '#ffffff' },
                    ]}
                  >
                    {tab.badge > 99 ? '99+' : tab.badge}
                  </Text>
                )}
              </TouchableOpacity>
            );
          }

          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tabPill, isActive && styles.tabPillActive]}
              onPress={() => onSelectTab(tab.key)}
              activeOpacity={0.75}
            >
              <Ionicons
                name={isActive ? tab.iconActive : tab.icon}
                size={16}
                color={isActive ? '#ffffff' : theme.colors.textSecondary}
              />
              {Boolean(tab.label) && (
                <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                  {tab.label}
                </Text>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
    paddingVertical: 8,
  },
  scrollContent: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    gap: 8,
    alignItems: 'center',
  },
  tabPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: theme.colors.surfaceHover,
    gap: 6,
  },
  tabPillActive: {
    backgroundColor: theme.colors.primary,
  },
  heartOnlyPill: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.45)',
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    gap: 5,
  },
  heartOnlyPillActive: {
    backgroundColor: '#ef4444',
    borderColor: '#ef4444',
  },
  heartCountText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '800',
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.textSecondary,
  },
  tabLabelActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  badge: {
    backgroundColor: theme.colors.favorite,
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  badgeActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
});
