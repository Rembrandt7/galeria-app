import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';

export default function Header({
  title,
  subtitle,
  onRefresh,
  isRefreshing,
  onBack,
  showBack = false,
  filterType,
  onToggleFilter,
  onPickFolder,
  onFindDuplicates,
  onOpenSettings,
  onOpenCamera,
}) {
  return (
    <View style={styles.headerContainer}>
      <View style={styles.topRow}>
        <View style={styles.titleSection}>
          {showBack && (
            <TouchableOpacity
              onPress={onBack}
              style={styles.backButton}
              activeOpacity={0.7}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="arrow-back" size={24} color={theme.colors.textPrimary} />
            </TouchableOpacity>
          )}
          <View>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.actionsSection}>
          {onFindDuplicates && (
            <TouchableOpacity
              onPress={onFindDuplicates}
              style={styles.actionButton}
              activeOpacity={0.7}
            >
              <Ionicons name="copy-outline" size={21} color={theme.colors.textPrimary} />
            </TouchableOpacity>
          )}

          {onPickFolder && (
            <TouchableOpacity
              onPress={onPickFolder}
              style={styles.actionButton}
              activeOpacity={0.7}
            >
              <Ionicons name="folder-open" size={22} color={theme.colors.textPrimary} />
            </TouchableOpacity>
          )}

          {onToggleFilter && (
            <TouchableOpacity
              onPress={onToggleFilter}
              style={[
                styles.filterButton,
                filterType !== 'all' && styles.filterButtonActive,
              ]}
              activeOpacity={0.7}
            >
              <Ionicons
                name={
                  filterType === 'photos'
                    ? 'image'
                    : filterType === 'videos'
                    ? 'videocam'
                    : 'filter'
                }
                size={18}
                color={filterType !== 'all' ? theme.colors.primaryLight : theme.colors.textSecondary}
              />
            </TouchableOpacity>
          )}

          {onRefresh && (
            <TouchableOpacity
              onPress={onRefresh}
              style={styles.actionButton}
              disabled={isRefreshing}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isRefreshing ? 'sync' : 'refresh'}
                size={22}
                color={isRefreshing ? theme.colors.primary : theme.colors.textPrimary}
              />
            </TouchableOpacity>
          )}

          {onOpenCamera && (
            <TouchableOpacity
              onPress={onOpenCamera}
              style={styles.actionButton}
              activeOpacity={0.7}
            >
              <Ionicons name="videocam-outline" size={22} color={theme.colors.textPrimary} />
            </TouchableOpacity>
          )}

          {onOpenSettings && (
            <TouchableOpacity
              onPress={onOpenSettings}
              style={styles.actionButton}
              activeOpacity={0.7}
            >
              <Ionicons name="settings-outline" size={21} color={theme.colors.textPrimary} />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surfaceBorder,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  titleSection: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  backButton: {
    marginRight: theme.spacing.md,
    padding: theme.spacing.xs,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: theme.colors.textPrimary,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    marginTop: 2,
  },
  actionsSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  actionButton: {
    width: 38,
    height: 38,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterButton: {
    width: 38,
    height: 38,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterButtonActive: {
    backgroundColor: theme.colors.surfaceHover,
    borderColor: theme.colors.primary,
    borderWidth: 1,
  },
});
