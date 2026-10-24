import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';
import { Alert, NativeModules } from 'react-native';

const { VideoEngineModule } = NativeModules;

function extractPhysicalFileUri(uri) {
  if (!uri || typeof uri !== 'string') return null;
  if (uri.startsWith('file://')) return uri;
  if (uri.startsWith('/')) return `file://${uri}`;
  if (uri.startsWith('content://')) {
    try {
      const docMatch = uri.match(/\/document\/([^/?#]+)/i);
      if (docMatch && docMatch[1]) {
        const docId = decodeURIComponent(docMatch[1]);
        if (/^primary:/i.test(docId)) {
          const relPath = docId.replace(/^primary:/i, '').replace(/^\/+/, '');
          return `file:///storage/emulated/0/${relPath}`;
        }
        const sdMatch = docId.match(/^([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}):(.+)$/);
        if (sdMatch) {
          return `file:///storage/${sdMatch[1]}/${sdMatch[2].replace(/^\/+/, '')}`;
        }
      }
    } catch (_e) {}
  }
  return null;
}

function resolveMimeAndExt(uri, filename, mediaType) {
  const hint = `${filename || ''} ${uri || ''}`.toLowerCase();
  if (/\.png(\b|$)/i.test(hint)) return { ext: '.png', mimeType: 'image/png' };
  if (/\.webp(\b|$)/i.test(hint)) return { ext: '.webp', mimeType: 'image/webp' };
  if (/\.gif(\b|$)/i.test(hint)) return { ext: '.gif', mimeType: 'image/gif' };
  if (/\.heic(\b|$)/i.test(hint)) return { ext: '.heic', mimeType: 'image/heic' };
  if (/\.mov(\b|$)/i.test(hint)) return { ext: '.mov', mimeType: 'video/quicktime' };
  if (/\.mkv(\b|$)/i.test(hint)) return { ext: '.mkv', mimeType: 'video/x-matroska' };
  if (/\.webm(\b|$)/i.test(hint)) return { ext: '.webm', mimeType: 'video/webm' };
  if (/\.mp4(\b|$)/i.test(hint) || mediaType === 'video') {
    return { ext: '.mp4', mimeType: 'video/mp4' };
  }
  return { ext: '.jpg', mimeType: 'image/jpeg' };
}

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

  // Compartir imagen o video (compatible con Galería, SAF content:// y rutas físicas file://)
  async shareAsset(assetOrUri) {
    let tempShareFile = null;
    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert('No disponible', 'La función de compartir no está disponible en este dispositivo.');
        return false;
      }

      const isObj = assetOrUri && typeof assetOrUri === 'object';
      let rawUri = isObj ? assetOrUri.uri : assetOrUri;
      const filename = isObj ? assetOrUri.filename : null;
      const mediaType = isObj ? assetOrUri.mediaType : null;

      if (!rawUri) {
        Alert.alert('Error', 'No se encontró la ruta del archivo para compartir.');
        return false;
      }

      // Si es un activo del MediaStore sin extensión clara, intentar obtener localUri
      if (
        isObj &&
        assetOrUri.id &&
        !String(assetOrUri.id).startsWith('content://') &&
        !String(assetOrUri.id).startsWith('file://')
      ) {
        try {
          const info = await MediaLibrary.getAssetInfoAsync(assetOrUri.id);
          if (info?.localUri) {
            rawUri = info.localUri;
          }
        } catch (_e) {}
      }

      const { ext, mimeType } = resolveMimeAndExt(rawUri, filename, mediaType);
      const physUri = extractPhysicalFileUri(rawUri);
      const cleanName = `compartir_${Date.now()}${ext}`;
      tempShareFile = new File(Paths.cache, cleanName);

      let copiedToCache = false;

      if (VideoEngineModule?.copyToCacheNative) {
        try {
          await VideoEngineModule.copyToCacheNative(physUri || rawUri, tempShareFile.uri);
          if (tempShareFile.exists && tempShareFile.size > 0) {
            copiedToCache = true;
          }
        } catch (_e) {
          try {
            await VideoEngineModule.copyToCacheNative(rawUri, tempShareFile.uri);
            if (tempShareFile.exists && tempShareFile.size > 0) {
              copiedToCache = true;
            }
          } catch (_e2) {}
        }
      }

      if (!copiedToCache && physUri) {
        try {
          await LegacyFS.copyAsync({ from: physUri, to: tempShareFile.uri });
          copiedToCache = true;
        } catch (_e) {
          try {
            await new File(physUri).copy(tempShareFile);
            copiedToCache = true;
          } catch (_e2) {}
        }
      }

      if (!copiedToCache) {
        try {
          await LegacyFS.copyAsync({ from: rawUri, to: tempShareFile.uri });
          copiedToCache = true;
        } catch (_e) {
          try {
            await new File(rawUri).copy(tempShareFile);
            copiedToCache = true;
          } catch (_e2) {}
        }
      }

      const targetUriToShare = copiedToCache ? tempShareFile.uri : physUri || rawUri;

      await Sharing.shareAsync(targetUriToShare, {
        mimeType,
        dialogTitle: 'Compartir archivo',
      });
      return true;
    } catch (error) {
      console.error('Error al compartir archivo:', error);
      Alert.alert('Error', 'No se pudo compartir el archivo seleccionado.');
      return false;
    } finally {
      if (tempShareFile?.exists) {
        setTimeout(() => {
          try {
            tempShareFile.delete();
          } catch (_e) {}
        }, 15000);
      }
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

  // Eliminar varios archivos multimedia (una sola confirmación del sistema)
  async deleteAssets(assetIds) {
    if (!assetIds || assetIds.length === 0) return true;
    try {
      return await MediaLibrary.deleteAssetsAsync(assetIds);
    } catch (error) {
      console.error('Error al eliminar archivos:', error);
      throw error;
    }
  },

  // Indica si Android todavía permite mostrar el diálogo de permisos
  async canAskAgain() {
    const { status, canAskAgain } = await MediaLibrary.getPermissionsAsync();
    return status !== 'granted' && canAskAgain;
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
