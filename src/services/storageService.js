import AsyncStorage from '@react-native-async-storage/async-storage';

const FAVORITES_STORAGE_KEY = '@galeria_favoritos_v1';
const HIDDEN_FOLDERS_STORAGE_KEY = '@galeria_carpetas_ocultas_v1';
const SHOW_ALL_FOLDERS_STORAGE_KEY = '@galeria_modo_todo_visible_v1';
const HIDDEN_PIN_STORAGE_KEY = '@galeria_pin_ocultas_v1';
const TRASH_BIN_STORAGE_KEY = '@galeria_papelera_modo_guardar_v1';
const MANUALLY_ENABLED_SYSTEM_KEY = '@galeria_sistema_activadas_manual_v1';
const AUTO_HIDE_SYSTEM_KEY = '@galeria_auto_desactivar_sistema_v1';
const CUSTOM_FOLDER_COVERS_KEY = '@galeria_portadas_personalizadas_v1';
const GRID_COLUMNS_CONFIG_KEY = '@galeria_columnas_config_v1';
const DECOY_PIN_STORAGE_KEY = '@galeria_decoy_pin_v1';
const STRIP_GPS_ON_SHARE_KEY = '@galeria_strip_gps_share_v1';

export const storageService = {
  async getFavorites() {
    try {
      const json = await AsyncStorage.getItem(FAVORITES_STORAGE_KEY);
      if (!json) return {};
      return JSON.parse(json);
    } catch (e) {
      console.error('Error al obtener favoritos:', e);
      return {};
    }
  },

  async toggleFavorite(asset) {
    try {
      const favorites = await this.getFavorites();
      const updated = { ...favorites };
      
      if (updated[asset.id]) {
        delete updated[asset.id];
      } else {
        updated[asset.id] = {
          id: asset.id,
          uri: asset.uri,
          filename: asset.filename,
          creationTime: asset.creationTime,
          mediaType: asset.mediaType,
          duration: asset.duration || 0,
          width: asset.width,
          height: asset.height,
        };
      }

      await AsyncStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(updated));
      return updated;
    } catch (e) {
      console.error('Error al alternar favorito:', e);
      throw e;
    }
  },

  async removeFavorite(assetId) {
    try {
      const favorites = await this.getFavorites();
      if (favorites[assetId]) {
        delete favorites[assetId];
        await AsyncStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
      }
      return favorites;
    } catch (e) {
      console.error('Error al eliminar de favoritos:', e);
      return {};
    }
  },

  // ===== GESTIÓN DE CARPETAS OCULTAS Y MODO TODO VISIBLE =====

  async getHiddenFolders() {
    try {
      const json = await AsyncStorage.getItem(HIDDEN_FOLDERS_STORAGE_KEY);
      if (!json) return {};
      return JSON.parse(json);
    } catch (e) {
      console.error('Error al obtener carpetas ocultas:', e);
      return {};
    }
  },

  async toggleHideFolder(folderKey, folderName = '') {
    try {
      const hidden = await this.getHiddenFolders();
      const updated = { ...hidden };
      if (updated[folderKey]) {
        delete updated[folderKey];
      } else {
        updated[folderKey] = {
          key: folderKey,
          name: folderName || folderKey,
          hiddenAt: Date.now(),
        };
      }
      await AsyncStorage.setItem(HIDDEN_FOLDERS_STORAGE_KEY, JSON.stringify(updated));
      return updated;
    } catch (e) {
      console.error('Error al alternar carpeta oculta:', e);
      throw e;
    }
  },

  async getManuallyEnabledSystemFolders() {
    try {
      const json = await AsyncStorage.getItem(MANUALLY_ENABLED_SYSTEM_KEY);
      if (!json) return {};
      return JSON.parse(json);
    } catch (e) {
      return {};
    }
  },

  async setManuallyEnabledSystemFolder(folderKey, enabled) {
    try {
      const current = await this.getManuallyEnabledSystemFolders();
      const updated = { ...current };
      if (enabled) {
        updated[folderKey] = true;
      } else {
        delete updated[folderKey];
      }
      await AsyncStorage.setItem(MANUALLY_ENABLED_SYSTEM_KEY, JSON.stringify(updated));
      return updated;
    } catch (e) {
      return {};
    }
  },

  async setAllManuallyEnabledSystemFolders(mapObj = {}) {
    try {
      await AsyncStorage.setItem(MANUALLY_ENABLED_SYSTEM_KEY, JSON.stringify(mapObj || {}));
      return mapObj || {};
    } catch (e) {
      return {};
    }
  },

  async getAutoHideSystemFolders() {
    try {
      const val = await AsyncStorage.getItem(AUTO_HIDE_SYSTEM_KEY);
      // Por defecto activado (true): desactiva automáticamente las carpetas sugeridas de sistema
      if (val === null || val === undefined) return true;
      return val === 'true';
    } catch (e) {
      return true;
    }
  },

  async setAutoHideSystemFolders(enabled) {
    try {
      await AsyncStorage.setItem(AUTO_HIDE_SYSTEM_KEY, enabled ? 'true' : 'false');
      return Boolean(enabled);
    } catch (e) {
      return Boolean(enabled);
    }
  },

  async getShowAllFolders() {
    try {
      const val = await AsyncStorage.getItem(SHOW_ALL_FOLDERS_STORAGE_KEY);
      return val === 'true';
    } catch (e) {
      return false;
    }
  },

  async setShowAllFolders(showAll) {
    try {
      await AsyncStorage.setItem(SHOW_ALL_FOLDERS_STORAGE_KEY, showAll ? 'true' : 'false');
      return showAll;
    } catch (e) {
      console.error('Error al guardar modo todo visible:', e);
      return showAll;
    }
  },

  async getPin() {
    try {
      const pin = await AsyncStorage.getItem(HIDDEN_PIN_STORAGE_KEY);
      return pin || null;
    } catch (e) {
      return null;
    }
  },

  async setPin(pin) {
    try {
      if (!pin) {
        await AsyncStorage.removeItem(HIDDEN_PIN_STORAGE_KEY);
        return null;
      }
      await AsyncStorage.setItem(HIDDEN_PIN_STORAGE_KEY, String(pin));
      return String(pin);
    } catch (e) {
      console.error('Error al guardar PIN:', e);
      return null;
    }
  },

  async getDecoyPin() {
    try {
      const pin = await AsyncStorage.getItem(DECOY_PIN_STORAGE_KEY);
      return pin || '0000';
    } catch (_e) {
      return '0000';
    }
  },

  async setDecoyPin(pin) {
    try {
      if (!pin) {
        await AsyncStorage.removeItem(DECOY_PIN_STORAGE_KEY);
        return '0000';
      }
      await AsyncStorage.setItem(DECOY_PIN_STORAGE_KEY, String(pin));
      return String(pin);
    } catch (_e) {
      return '0000';
    }
  },

  async getStripGpsOnShare() {
    try {
      const val = await AsyncStorage.getItem(STRIP_GPS_ON_SHARE_KEY);
      if (val === null || val === undefined) return true; // Por defecto activo para proteger privacidad GPS
      return val === 'true';
    } catch (_e) {
      return true;
    }
  },

  async setStripGpsOnShare(enabled) {
    try {
      await AsyncStorage.setItem(STRIP_GPS_ON_SHARE_KEY, enabled ? 'true' : 'false');
      return Boolean(enabled);
    } catch (_e) {
      return Boolean(enabled);
    }
  },

  // ===== PAPELERA TEMPORAL DEL "MODO GUARDAR" (CON RESTAURACIÓN EN 1 CLIC) =====

  async getTrashBin() {
    try {
      const json = await AsyncStorage.getItem(TRASH_BIN_STORAGE_KEY);
      if (!json) return {};
      return JSON.parse(json);
    } catch (e) {
      return {};
    }
  },

  async addToTrashBin(asset) {
    if (!asset?.id) return {};
    try {
      const current = await this.getTrashBin();
      const updated = {
        ...current,
        [asset.id]: {
          id: asset.id,
          uri: asset.uri,
          filename: asset.filename || 'Archivo',
          mediaType: asset.mediaType || 'photo',
          fileSize: asset.fileSize || 0,
          creationTime: asset.creationTime || 0,
          width: asset.width || 0,
          height: asset.height || 0,
          fromFolder: Boolean(asset.fromFolder),
          trashedAt: Date.now(),
        },
      };
      await AsyncStorage.setItem(TRASH_BIN_STORAGE_KEY, JSON.stringify(updated));
      return updated;
    } catch (e) {
      return {};
    }
  },

  async restoreFromTrashBin(assetId) {
    try {
      const current = await this.getTrashBin();
      const updated = { ...current };
      delete updated[assetId];
      await AsyncStorage.setItem(TRASH_BIN_STORAGE_KEY, JSON.stringify(updated));
      return updated;
    } catch (e) {
      return {};
    }
  },

  async clearTrashBin(idsToRemove = null) {
    try {
      if (!idsToRemove) {
        await AsyncStorage.removeItem(TRASH_BIN_STORAGE_KEY);
        return {};
      }
      const current = await this.getTrashBin();
      const updated = { ...current };
      for (const id of idsToRemove) {
        delete updated[id];
      }
      await AsyncStorage.setItem(TRASH_BIN_STORAGE_KEY, JSON.stringify(updated));
      return updated;
    } catch (e) {
      return {};
    }
  },

  // ===== PORTADAS PERSONALIZADAS DE CARPETAS Y ÁLBUMES =====

  normalizeCoverKey(rawKey) {
    if (!rawKey) return '';
    try {
      return decodeURIComponent(String(rawKey)).trim().replace(/\/+$/, '').toLowerCase();
    } catch (_e) {
      return String(rawKey).trim().replace(/\/+$/, '').toLowerCase();
    }
  },

  async getCustomFolderCovers() {
    try {
      const json = await AsyncStorage.getItem(CUSTOM_FOLDER_COVERS_KEY);
      if (!json) return {};
      return JSON.parse(json) || {};
    } catch (_e) {
      return {};
    }
  },

  async setCustomFolderCover(keys = [], photoUri = '') {
    if (!photoUri) return {};
    try {
      const current = await this.getCustomFolderCovers();
      const updated = { ...current };
      const keyArray = Array.isArray(keys) ? keys : [keys];
      for (const k of keyArray) {
        if (!k) continue;
        updated[String(k)] = photoUri;
        const norm = this.normalizeCoverKey(k);
        if (norm) updated[norm] = photoUri;
      }
      await AsyncStorage.setItem(CUSTOM_FOLDER_COVERS_KEY, JSON.stringify(updated));
      return updated;
    } catch (_e) {
      return {};
    }
  },

  resolveCustomCover(customCovers = {}, item = {}) {
    if (!customCovers || !item) return null;
    const candidates = [
      item.uri,
      item.id,
      item.title,
      item.name,
      item.rawName,
      this.normalizeCoverKey(item.uri),
      this.normalizeCoverKey(item.id),
      this.normalizeCoverKey(item.title),
      this.normalizeCoverKey(item.name),
    ];
    for (const c of candidates) {
      if (c && customCovers[c]) return customCovers[c];
    }
    return null;
  },

  // ===== CONFIGURACIÓN DE COLUMNAS Y SISTEMA (SOPORTE FOLD + PERSONALIZADO) =====

  async getGridColumnsConfig() {
    const defaults = {
      albumColumns: 0, // 0 = Auto (3 en pantalla normal, 5 en Fold desplegado)
      photoColumns: 0, // 0 = Auto (4 en pantalla normal, 6 en Fold desplegado)
      groupSmallInVarios: true,
      showFoldersInScreen: true,
    };
    try {
      const json = await AsyncStorage.getItem(GRID_COLUMNS_CONFIG_KEY);
      if (!json) return defaults;
      return { ...defaults, ...JSON.parse(json) };
    } catch (_e) {
      return defaults;
    }
  },

  async setGridColumnsConfig(partial = {}) {
    try {
      const current = await this.getGridColumnsConfig();
      const updated = { ...current, ...partial };
      await AsyncStorage.setItem(GRID_COLUMNS_CONFIG_KEY, JSON.stringify(updated));
      return updated;
    } catch (_e) {
      return partial;
    }
  },
};
