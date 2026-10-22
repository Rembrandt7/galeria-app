import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';

export default function TabBar({ activeTab, onSelectTab, favoritesCount = 0 }) {
  const tabs = [
    { key: 'photos', label: 'Fotos', icon: 'images', iconActive: 'images' },
    { key: 'albums', label: 'Álbumes', icon: 'folder-outline', iconActive: 'folder' },
    { key: 'folder', label: 'Mi carpeta', icon: 'folder-open-outline', iconActive: 'folder-open' },
    { key: 'favorites', label: 'Favoritos', icon: 'heart-outline', iconActive: 'heart', badge: favoritesCount },
  ];

  return (
    <View style={styles.container}>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <TouchableOpacity
            key={tab.key}
            style={styles.tabItem}
            onPress={() => onSelectTab(tab.key)}
            activeOpacity={0.7}
          >
            <View style={styles.iconWrapper}>
              <Ionicons
                name={isActive ? tab.iconActive : tab.icon}
                size={22}
                color={isActive ? theme.colors.primary : theme.colors.textMuted}
              />
              {tab.badge && tab.badge > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>
                    {tab.badge > 99 ? '99+' : tab.badge}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              style={[
                styles.tabLabel,
                isActive ? styles.tabLabelActive : styles.tabLabelInactive,
              ]}
            >
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.surfaceBorder,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  tabItem: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    paddingVertical: 2,
  },
  iconWrapper: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 28,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    backgroundColor: theme.colors.favorite,
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  tabLabel: {
    fontSize: 12,
    marginTop: 4,
    fontWeight: '500',
  },
  tabLabelActive: {
    color: theme.colors.primary,
    fontWeight: '700',
  },
  tabLabelInactive: {
    color: theme.colors.textMuted,
  },
});
