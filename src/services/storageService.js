import AsyncStorage from '@react-native-async-storage/async-storage';

const FAVORITES_STORAGE_KEY = '@galeria_favoritos_v1';
const HIDDEN_FOLDERS_STORAGE_KEY = '@galeria_carpetas_ocultas_v1';
const SHOW_ALL_FOLDERS_STORAGE_KEY = '@galeria_modo_todo_visible_v1';
const HIDDEN_PIN_STORAGE_KEY = '@galeria_pin_ocultas_v1';

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
};
