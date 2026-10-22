import AsyncStorage from '@react-native-async-storage/async-storage';

const FAVORITES_STORAGE_KEY = '@galeria_favoritos_v1';

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
  }
};
