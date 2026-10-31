import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import { CURRENT_VERSION } from '../services/updateService';

const ALBUM_COLUMN_OPTIONS = [
  { value: 0, label: 'Auto (Fold)' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
  { value: 5, label: '5' },
  { value: 6, label: '6' },
];

const PHOTO_COLUMN_OPTIONS = [
  { value: 0, label: 'Auto (Fold)' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
  { value: 5, label: '5' },
  { value: 6, label: '6' },
  { value: 8, label: '8' },
];

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
  onToggleSearch,
  onOpenVisibilityManager,
  hasUpdateAvailable = false,
  // Configuración de Sistema y Columnas desplegable al lado de Actualizar
  gridConfig = {
    albumColumns: 0,
    photoColumns: 0,
    groupSmallInVarios: true,
    showFoldersInScreen: true,
  },
  onChangeGridConfig,
  autoHideSystemFolders = true,
  onToggleAutoHideSystem,
  activeAlbumsCount = 0,
  totalAlbumsCount = 0,
  systemAlbumsCount = 0,
}) {
  const [systemPanelOpen, setSystemPanelOpen] = useState(false);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const isFoldExpanded =
    screenWidth >= 480 || (screenWidth / Math.max(screenHeight, 1) >= 0.65 && screenWidth >= 420);
  const isFoldCompact = !isFoldExpanded && screenWidth <= 375;

  const effectiveAlbumCols =
    gridConfig?.albumColumns > 0
      ? isFoldExpanded && Number(gridConfig.albumColumns) <= 3
        ? Number(gridConfig.albumColumns) + 2
        : Number(gridConfig.albumColumns)
      : isFoldExpanded
      ? 5
      : 3;
  const effectivePhotoCols =
    gridConfig?.photoColumns > 0
      ? isFoldExpanded && Number(gridConfig.photoColumns) <= 4
        ? Number(gridConfig.photoColumns) + 2
        : Number(gridConfig.photoColumns)
      : isFoldExpanded
      ? 6
      : 4;

  return (
    <View style={[styles.headerContainer, isFoldExpanded && { paddingHorizontal: 14 }, isFoldCompact && { paddingHorizontal: 5 }]}>
      <View style={styles.topRow}>
        {/* Izquierda: Regresar + Título o [Actualizar] + [⚙️ Sistema] lado a lado */}
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
            <View style={styles.topPillsRow}>
              {/* Botón de Actualizar compacto en el mismo renglón */}
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
                  size={14}
                  color={hasUpdateAvailable ? '#10b981' : '#60a5fa'}
                />
                <Text
                  style={[
                    styles.updatePracticalText,
                    hasUpdateAvailable && { color: '#34d399' },
                  ]}
                  numberOfLines={1}
                >
                  {hasUpdateAvailable ? '¡Actualizar!' : `Actualizar ${CURRENT_VERSION}`}
                </Text>
                {hasUpdateAvailable && <View style={styles.liveDot} />}
              </TouchableOpacity>

              {/* Botón de Configuración / Sistema en el mismo renglón al lado de Actualizar */}
              <TouchableOpacity
                onPress={() => setSystemPanelOpen((prev) => !prev)}
                style={[
                  styles.systemConfigBtn,
                  systemPanelOpen && styles.systemConfigBtnActive,
                ]}
                activeOpacity={0.8}
              >
                <Ionicons
                  name={systemPanelOpen ? 'settings' : 'settings-outline'}
                  size={14}
                  color={systemPanelOpen ? '#ffffff' : '#38bdf8'}
                />
                <Text
                  style={[
                    styles.systemConfigText,
                    systemPanelOpen && { color: '#ffffff' },
                  ]}
                  numberOfLines={1}
                >
                  Sistema ({activeAlbumsCount}/{totalAlbumsCount})
                </Text>
                <Ionicons
                  name={systemPanelOpen ? 'chevron-up' : 'chevron-down'}
                  size={11}
                  color={systemPanelOpen ? '#ffffff' : '#38bdf8'}
                />
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Derecha: Acciones rápidas (+, 🔍, Filtro, Refrescar y botón compacto de Sistema cuando estamos dentro de una carpeta) */}
        <View style={styles.actionsSection}>
          {showBack && (
            <>
              {onOpenSettings && (
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
                    size={15}
                    color={hasUpdateAvailable ? '#10b981' : '#60a5fa'}
                  />
                  <Text style={styles.updateCompactText}>Actualizar</Text>
                </TouchableOpacity>
              )}

              {/* Botón compacto de Configuración / Sistema al lado de Actualizar dentro de carpetas */}
              <TouchableOpacity
                onPress={() => setSystemPanelOpen((prev) => !prev)}
                style={[
                  styles.systemCompactPill,
                  systemPanelOpen && styles.systemConfigBtnActive,
                ]}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="settings-outline"
                  size={15}
                  color={systemPanelOpen ? '#ffffff' : '#38bdf8'}
                />
                <Text
                  style={[
                    styles.systemCompactText,
                    systemPanelOpen && { color: '#ffffff' },
                  ]}
                >
                  {effectivePhotoCols} col
                </Text>
                <Ionicons
                  name={systemPanelOpen ? 'chevron-up' : 'chevron-down'}
                  size={12}
                  color={systemPanelOpen ? '#ffffff' : '#38bdf8'}
                />
              </TouchableOpacity>
            </>
          )}

          {onPickFolder && !showBack && (
            <TouchableOpacity
              onPress={onPickFolder}
              style={styles.galaxyIconBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="add" size={25} color="#ffffff" />
            </TouchableOpacity>
          )}

          {onFindDuplicates && (
            <TouchableOpacity
              onPress={onFindDuplicates}
              style={styles.galaxyIconBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="copy-outline" size={19} color="#fbbf24" />
            </TouchableOpacity>
          )}

          {onToggleSearch && (
            <TouchableOpacity
              onPress={onToggleSearch}
              style={styles.galaxyIconBtn}
              activeOpacity={0.7}
            >
              <Ionicons name="search" size={20} color="#ffffff" />
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
                size={19}
                color={isRefreshing ? '#60a5fa' : '#ffffff'}
              />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* PANEL DESPLEGABLE DE SISTEMA Y CONFIGURACIÓN (Se abre al tocar el botón al lado de Actualizar) */}
      {systemPanelOpen && (
        <View style={styles.dropdownPanel}>
          <View style={styles.dropdownHeaderRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
              <Ionicons name="hardware-chip-outline" size={17} color="#38bdf8" />
              <Text style={styles.dropdownTitle}>
                Configuración de Sistema y Pantalla {isFoldExpanded ? '· 📱 Fold Desplegado' : ''}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setSystemPanelOpen(false)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="close-circle" size={21} color="#94a3b8" />
            </TouchableOpacity>
          </View>

          {/* 1. Selector de Número de Columnas para Carpetas / Álbumes */}
          <View style={styles.configBlock}>
            <View style={styles.configLabelRow}>
              <Ionicons name="folder-open-outline" size={14} color="#60a5fa" />
              <Text style={styles.configLabelText}>
                Columnas de Carpetas ({effectiveAlbumCols} activas):
              </Text>
            </View>
            <View style={styles.chipsRow}>
              {ALBUM_COLUMN_OPTIONS.map((opt) => {
                const isSelected = Number(gridConfig?.albumColumns || 0) === opt.value;
                return (
                  <TouchableOpacity
                    key={`alb_col_${opt.value}`}
                    style={[styles.colChip, isSelected && styles.colChipActive]}
                    onPress={() =>
                      onChangeGridConfig && onChangeGridConfig({ albumColumns: opt.value })
                    }
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.colChipText, isSelected && styles.colChipTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* 2. Selector de Número de Columnas para Fotos y Videos */}
          <View style={styles.configBlock}>
            <View style={styles.configLabelRow}>
              <Ionicons name="grid-outline" size={14} color="#34d399" />
              <Text style={styles.configLabelText}>
                Columnas de Fotos y Videos ({effectivePhotoCols} activas):
              </Text>
            </View>
            <View style={styles.chipsRow}>
              {PHOTO_COLUMN_OPTIONS.map((opt) => {
                const isSelected = Number(gridConfig?.photoColumns || 0) === opt.value;
                return (
                  <TouchableOpacity
                    key={`pho_col_${opt.value}`}
                    style={[styles.colChip, isSelected && styles.colChipActiveGreen]}
                    onPress={() =>
                      onChangeGridConfig && onChangeGridConfig({ photoColumns: opt.value })
                    }
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.colChipText, isSelected && styles.colChipTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* 3. Opciones de Carpetas de Sistema y Agrupación */}
          <View style={styles.togglesGrid}>
            <TouchableOpacity
              style={[
                styles.toggleOptionPill,
                gridConfig?.showFoldersInScreen !== false && styles.toggleOptionPillOn,
              ]}
              onPress={() =>
                onChangeGridConfig &&
                onChangeGridConfig({
                  showFoldersInScreen: gridConfig?.showFoldersInScreen === false,
                })
              }
              activeOpacity={0.8}
            >
              <Ionicons
                name={gridConfig?.showFoldersInScreen !== false ? 'eye' : 'eye-off'}
                size={14}
                color={gridConfig?.showFoldersInScreen !== false ? '#38bdf8' : '#fbbf24'}
              />
              <Text style={styles.toggleOptionText}>
                {gridConfig?.showFoldersInScreen !== false
                  ? 'Carpetas visibles'
                  : 'Carpetas ocultas'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.toggleOptionPill,
                gridConfig?.groupSmallInVarios !== false && styles.toggleOptionPillOn,
              ]}
              onPress={() =>
                onChangeGridConfig &&
                onChangeGridConfig({
                  groupSmallInVarios: gridConfig?.groupSmallInVarios === false,
                })
              }
              activeOpacity={0.8}
            >
              <Ionicons
                name="file-tray-stacked"
                size={14}
                color={gridConfig?.groupSmallInVarios !== false ? '#a78bfa' : '#71717a'}
              />
              <Text style={styles.toggleOptionText}>
                {gridConfig?.groupSmallInVarios !== false
                  ? 'Varios (<5) activo'
                  : 'Varios (<5) apagado'}
              </Text>
            </TouchableOpacity>

            {onToggleAutoHideSystem && (
              <TouchableOpacity
                style={[
                  styles.toggleOptionPill,
                  autoHideSystemFolders && styles.toggleOptionPillOn,
                ]}
                onPress={onToggleAutoHideSystem}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="shield-checkmark"
                  size={14}
                  color={autoHideSystemFolders ? '#10b981' : '#71717a'}
                />
                <Text style={styles.toggleOptionText}>
                  {autoHideSystemFolders
                    ? `Ocultar sistema (${systemAlbumsCount})`
                    : 'Mostrando sistema'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* 4. Botones para Administrar Carpetas de Sistema individualmente o abrir Ajustes */}
          <View style={styles.bottomActionsRow}>
            {onOpenVisibilityManager && (
              <TouchableOpacity
                style={styles.manageSystemFullBtn}
                onPress={() => {
                  setSystemPanelOpen(false);
                  onOpenVisibilityManager();
                }}
                activeOpacity={0.85}
              >
                <Ionicons name="construct-outline" size={15} color="#ffffff" />
                <Text style={styles.manageSystemFullText}>
                  Administrar Carpetas y Sistema ({activeAlbumsCount}/{totalAlbumsCount})
                </Text>
              </TouchableOpacity>
            )}

            {onOpenSettings && (
              <TouchableOpacity
                style={styles.pinSettingsBtn}
                onPress={() => {
                  setSystemPanelOpen(false);
                  onOpenSettings();
                }}
                activeOpacity={0.85}
              >
                <Ionicons name="lock-closed-outline" size={14} color="#fde68a" />
                <Text style={styles.pinSettingsBtnText}>PIN y Permisos</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    backgroundColor: '#000000',
    paddingHorizontal: 8,
    paddingTop: 3,
    paddingBottom: 3,
    zIndex: 50,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 34,
  },
  leftSection: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 4,
  },
  topPillsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'nowrap',
    flex: 1,
  },
  backTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  backButton: {
    marginRight: 4,
    padding: 3,
    borderRadius: 20,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 10.5,
    color: theme.colors.textSecondary,
    marginTop: 1,
  },
  updatePracticalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(59, 130, 246, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.38)',
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 14,
    flexShrink: 1,
  },
  updatePracticalBtnReady: {
    backgroundColor: 'rgba(16, 185, 129, 0.18)',
    borderColor: '#10b981',
  },
  updatePracticalText: {
    color: '#93c5fd',
    fontSize: 10.5,
    fontWeight: '800',
    flexShrink: 1,
  },
  systemConfigBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 14,
    flexShrink: 1,
  },
  systemConfigBtnActive: {
    backgroundColor: '#2563eb',
    borderColor: '#60a5fa',
  },
  systemConfigText: {
    color: '#7dd3fc',
    fontSize: 10.5,
    fontWeight: '800',
    flexShrink: 1,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#10b981',
  },
  updateCompactPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(59, 130, 246, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.35)',
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 12,
  },
  updateCompactText: {
    color: '#93c5fd',
    fontSize: 10.5,
    fontWeight: '800',
  },
  systemCompactPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 12,
  },
  systemCompactText: {
    color: '#7dd3fc',
    fontSize: 10.5,
    fontWeight: '800',
  },
  actionsSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
  },
  galaxyIconBtn: {
    width: 29,
    height: 29,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterButtonActive: {
    backgroundColor: 'rgba(59, 130, 246, 0.2)',
  },
  dropdownPanel: {
    marginTop: 8,
    backgroundColor: '#11131a',
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
    gap: 10,
  },
  dropdownHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  configBlock: {
    gap: 5,
  },
  configLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  configLabelText: {
    color: '#cbd5e1',
    fontSize: 11.5,
    fontWeight: '700',
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  colChip: {
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 10,
    backgroundColor: '#1e212d',
    borderWidth: 1,
    borderColor: '#2e3346',
    minWidth: 38,
    alignItems: 'center',
  },
  colChipActive: {
    backgroundColor: '#2563eb',
    borderColor: '#60a5fa',
  },
  colChipActiveGreen: {
    backgroundColor: '#059669',
    borderColor: '#34d399',
  },
  colChipText: {
    color: '#94a3b8',
    fontSize: 11.5,
    fontWeight: '700',
  },
  colChipTextActive: {
    color: '#ffffff',
    fontWeight: '800',
  },
  togglesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  toggleOptionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#181a24',
    borderWidth: 1,
    borderColor: '#272a3a',
  },
  toggleOptionPillOn: {
    backgroundColor: 'rgba(37, 99, 235, 0.15)',
    borderColor: 'rgba(96, 165, 250, 0.45)',
  },
  toggleOptionText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '700',
  },
  bottomActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  manageSystemFullBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#2563eb',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 11,
  },
  manageSystemFullText: {
    color: '#ffffff',
    fontSize: 11.5,
    fontWeight: '800',
  },
  pinSettingsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.45)',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 11,
  },
  pinSettingsBtnText: {
    color: '#fde68a',
    fontSize: 11.5,
    fontWeight: '800',
  },
});
