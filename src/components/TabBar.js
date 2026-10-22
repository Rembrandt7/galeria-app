import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';

export default function TabBar({ activeTab, onSelectTab, favoritesCount = 0 }) {
  // Orden requerido: Mi carpeta -> Álbumes -> Fotos -> Favoritos
  const tabs = [
    { key: 'folder', label: 'Mi carpeta', icon: 'folder-open-outline', iconActive: 'folder-open' },
    { key: 'albums', label: 'Álbumes', icon: 'albums-outline', iconActive: 'albums' },
    { key: 'photos', label: 'Fotos', icon: 'images-outline', iconActive: 'images' },
    { key: 'favorites', label: 'Favoritos', icon: 'heart-outline', iconActive: 'heart', badge: favoritesCount },
  ];

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
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
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                {tab.label}
              </Text>
              {tab.badge && tab.badge > 0 ? (
                <View style={[styles.badge, isActive && styles.badgeActive]}>
                  <Text style={styles.badgeText}>
                    {tab.badge > 99 ? '99+' : tab.badge}
                  </Text>
                </View>
              ) : null}
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
