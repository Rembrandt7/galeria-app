import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';

export const mediaService = {
  // Solicitar o verificar permisos
  async checkAndRequestPermissions() {
    const { status: existingStatus, canAskAgain } = await MediaLibrary.getPermissionsAsync();
    if (existingStatus === 'granted') {
      return true;
    }

    if (canAskAgain) {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      return status === 'granted';
    }

    return false;
  },

  // Obtener fotos y videos paginados
  async getAssets({ first = 60, after = null, albumId = null, mediaTypes = null }) {
    try {
      const options = {
        first,
        sortBy: [MediaLibrary.SortBy.creationTime],
        mediaType: mediaTypes || [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
      };

      if (after) {
        options.after = after;
      }

      if (albumId) {
        options.album = albumId;
      }

      const result = await MediaLibrary.getAssetsAsync(options);
      return result;
    } catch (error) {
      console.error('Error al obtener archivos multimedia:', error);
      throw error;
    }
  },

  // Obtener álbumes del teléfono con vista previa
  async getAlbums() {
    try {
      const albums = await MediaLibrary.getAlbumsAsync({
        includeSmartAlbums: true,
      });

      // Filtramos álbumes que tengan al menos 1 elemento
      const activeAlbums = albums.filter((a) => a.assetCount > 0);

      // Traer la portada (primera foto) de cada álbum
      const albumsWithCovers = await Promise.all(
        activeAlbums.map(async (album) => {
          try {
            const preview = await MediaLibrary.getAssetsAsync({
              first: 1,
              album: album.id,
              sortBy: [MediaLibrary.SortBy.creationTime],
            });
            const coverUri = preview.assets && preview.assets.length > 0 ? preview.assets[0].uri : null;
            return {
              ...album,
              coverUri,
            };
          } catch (e) {
            return {
              ...album,
              coverUri: null,
            };
          }
        })
      );

      return albumsWithCovers;
    } catch (error) {
      console.error('Error al obtener álbumes:', error);
      throw error;
    }
  },

  // Compartir imagen o video
  async shareAsset(uri) {
    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert('No disponible', 'La función de compartir no está disponible en este dispositivo.');
        return false;
      }

      await Sharing.shareAsync(uri);
      return true;
    } catch (error) {
      console.error('Error al compartir archivo:', error);
      Alert.alert('Error', 'No se pudo compartir el archivo seleccionado.');
      return false;
    }
  },

  // Eliminar un archivo multimedia
  async deleteAsset(assetId) {
    try {
      const success = await MediaLibrary.deleteAssetsAsync([assetId]);
      return success;
    } catch (error) {
      console.error('Error al eliminar archivo:', error);
      throw error;
    }
  },

  // Obtener información detallada del archivo
  async getAssetInfo(assetId) {
    try {
      const info = await MediaLibrary.getAssetInfoAsync(assetId);
      return info;
    } catch (error) {
      console.error('Error al obtener detalles:', error);
      return null;
    }
  }
};
