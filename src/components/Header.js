import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { CURRENT_VERSION } from '../services/updateService';

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
  onOpenSettings,
  onToggleSearch,
  onOpenVisibilityManager,
  hasUpdateAvailable = false,
}) {
  return (
    <View style={styles.headerContainer}>
      <View style={styles.topRow}>
        {/* Izquierda: Regresar + Título (o Botón práctico de Actualización en la vista principal) */}
        <View style={styles.leftSection}>
          {showBack ? (
            <View style={styles.backTitleRow}>
              <TouchableOpacity
                onPress={onBack}
                style={styles.backButton}
                activeOpacity={0.7}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="chevron-back" size={26} color="#ffffff" />
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
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
          ) : (
            <TouchableOpacity
              onPress={onOpenSettings}
              style={[
                styles.updatePracticalBtn,
                hasUpdateAvailable && styles.updatePracticalBtnReady,
              ]}
              activeOpacity={0.8}
            >
              <Ionicons
                name={hasUpdateAvailable ? 'arrow-up-circle' : 'sync-circle-outline'}
                size={18}
                color={hasUpdateAvailable ? '#10b981' : '#60a5fa'}
              />
              <Text
                style={[
                  styles.updatePracticalText,
                  hasUpdateAvailable && { color: '#34d399' },
                ]}
              >
                {hasUpdateAvailable
                  ? `¡Actualizar disponible!`
                  : `Actualizar · ${CURRENT_VERSION}`}
              </Text>
              {hasUpdateAvailable && <View style={styles.liveDot} />}
            </TouchableOpacity>
          )}
        </View>

        {/* Derecha: Estilo Samsung Galaxy (+  🔍  ⋮) + Botón Actualizar compacto si estamos dentro de carpeta */}
        <View style={styles.actionsSection}>
          {showBack && onOpenSettings && (
            <TouchableOpacity
              onPress={onOpenSettings}
              style={[
                styles.updateCompactPill,
                hasUpdateAvailable && styles.updatePracticalBtnReady,
              ]}
              activeOpacity={0.8}
            >
              <Ionicons
                name="arrow-up-circle-outline"
                size={16}
                color={hasUpdateAvailable ? '#10b981' : '#60a5fa'}
              />
              <Text style={styles.updateCompactText}>Actualizar</Text>
            </TouchableOpacity>
          )}

          {onPickFolder && (
            <TouchableOpacity
              onPress={onPickFolder}
              style={styles.galaxyIconBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="add" size={26} color="#ffffff" />
            </TouchableOpacity>
          )}

          {onToggleSearch && (
            <TouchableOpacity
              onPress={onToggleSearch}
              style={styles.galaxyIconBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="search" size={21} color="#ffffff" />
            </TouchableOpacity>
          )}

          {onToggleFilter && (
            <TouchableOpacity
              onPress={onToggleFilter}
              style={[
                styles.galaxyIconBtn,
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
                size={19}
                color={filterType !== 'all' ? '#60a5fa' : '#ffffff'}
              />
            </TouchableOpacity>
          )}

          {onRefresh && (
            <TouchableOpacity
              onPress={onRefresh}
              style={styles.galaxyIconBtn}
              disabled={isRefreshing}
              activeOpacity={0.7}
            >
              <Ionicons
                name={isRefreshing ? 'sync' : 'refresh'}
                size={20}
                color={isRefreshing ? '#60a5fa' : '#ffffff'}
              />
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={onOpenVisibilityManager || onOpenSettings}
            style={styles.galaxyIconBtn}
            activeOpacity={0.7}
          >
            <Ionicons name="ellipsis-vertical" size={20} color="#ffffff" />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    backgroundColor: '#000000',
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 6,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 42,
  },
  leftSection: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  backTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  backButton: {
    marginRight: 6,
    padding: 4,
    borderRadius: 20,
  },
  title: {
    fontSize: 19,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 11.5,
    color: theme.colors.textSecondary,
    marginTop: 1,
  },
  updatePracticalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(59, 130, 246, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.38)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  updatePracticalBtnReady: {
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderColor: '#10b981',
  },
  updatePracticalText: {
    color: '#93c5fd',
    fontSize: 12.5,
    fontWeight: '800',
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#10b981',
  },
  updateCompactPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(59, 130, 246, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.35)',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 16,
    marginRight: 2,
  },
  updateCompactText: {
    color: '#93c5fd',
    fontSize: 11,
    fontWeight: '800',
  },
  actionsSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  galaxyIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterButtonActive: {
    backgroundColor: 'rgba(59, 130, 246, 0.2)',
  },
});
