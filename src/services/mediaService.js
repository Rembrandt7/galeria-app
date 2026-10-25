import * as MediaLibrary from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';
import { Alert, NativeModules } from 'react-native';
import { folderService } from './folderService';

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
  // Solicitar o verificar permisos (especificando ['photo', 'video'] para evitar bloqueo por audio en Android 13+)
  async checkAndRequestPermissions() {
    try {
      const { status: existingStatus, canAskAgain } = await MediaLibrary.getPermissionsAsync(
        false,
        ['photo', 'video']
      );
      if (existingStatus === 'granted') {
        return true;
      }

      if (canAskAgain) {
        const { status } = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
        return status === 'granted';
      }
    } catch (_e) {
      try {
        const { status } = await MediaLibrary.requestPermissionsAsync();
        return status === 'granted';
      } catch (_e2) {}
    }
    return false;
  },

  // Obtener fotos y videos paginados (con respaldo automático desde carpetas del teléfono si MediaStore devuelve vacío)
  async getAssets({ first = 60, after = null, albumId = null, albumUri = null, childAlbums = null, mediaTypes = null }) {
    try {
      // Si es el álbum agrupado "Varios" (contiene múltiples carpetitas de < 5 fotos)
      if (Array.isArray(childAlbums) && childAlbums.length > 0) {
        const wantPhoto = !mediaTypes || mediaTypes.includes(MediaLibrary.MediaType.photo) || mediaTypes.includes('photo');
        const wantVideo = !mediaTypes || mediaTypes.includes(MediaLibrary.MediaType.video) || mediaTypes.includes('video');
        const allItems = [];
        const seenUris = new Set();

        await Promise.all(
          childAlbums.map(async (subAlb) => {
            try {
              if (subAlb.id && !String(subAlb.id).startsWith('folder_')) {
                const res = await MediaLibrary.getAssetsAsync({
                  first: 10,
                  album: subAlb.id,
                  sortBy: [MediaLibrary.SortBy.creationTime],
                  mediaType: mediaTypes || [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
                });
                for (const a of res.assets || []) {
                  if (!seenUris.has(a.uri)) {
                    seenUris.add(a.uri);
                    allItems.push({ ...a, sourceFolderTitle: subAlb.title });
                  }
                }
              } else if (subAlb.uri) {
                const folderItems = await folderService.loadFolderAssets(subAlb.uri);
                for (const a of folderItems || []) {
                  if (
                    !seenUris.has(a.uri) &&
                    ((a.mediaType === 'photo' && wantPhoto) || (a.mediaType === 'video' && wantVideo))
                  ) {
                    seenUris.add(a.uri);
                    allItems.push({ ...a, sourceFolderTitle: subAlb.title });
                  }
                }
              }
            } catch (_e) {}
          })
        );

        allItems.sort((a, b) => (b.creationTime || 0) - (a.creationTime || 0));
        return {
          assets: allItems,
          endCursor: null,
          hasNextPage: false,
          totalCount: allItems.length,
        };
      }

      // Si el álbum proviene de una carpeta física o SAF (albumUri)
      if (albumUri) {
        const folderItems = await folderService.loadFolderAssets(albumUri);
        const wantPhoto = !mediaTypes || mediaTypes.includes(MediaLibrary.MediaType.photo) || mediaTypes.includes('photo');
        const wantVideo = !mediaTypes || mediaTypes.includes(MediaLibrary.MediaType.video) || mediaTypes.includes('video');
        const filtered = (folderItems || []).filter(
          (a) => (a.mediaType === 'photo' && wantPhoto) || (a.mediaType === 'video' && wantVideo)
        );
        return {
          assets: filtered,
          endCursor: null,
          hasNextPage: false,
          totalCount: filtered.length,
        };
      }

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

      let result = { assets: [], endCursor: null, hasNextPage: false };
      try {
        result = await MediaLibrary.getAssetsAsync(options);
      } catch (_mErr) {}

      // Si estamos en "Todas las fotos" (!albumId) y MediaStore no devolvió nada o muy poco, combinar con las carpetas guardadas/comunes
      if (!albumId && !after && (!result.assets || result.assets.length === 0)) {
        const saved = await folderService.getSavedFolders();
        const roots =
          saved && saved.length > 0
            ? saved.map((f) => f.uri)
            : [
                'file:///storage/emulated/0/DCIM',
                'file:///storage/emulated/0/Pictures',
                'file:///storage/emulated/0/Download',
              ];
        const combined = [];
        const seen = new Set();
        const wantPhoto = !mediaTypes || mediaTypes.includes(MediaLibrary.MediaType.photo) || mediaTypes.includes('photo');
        const wantVideo = !mediaTypes || mediaTypes.includes(MediaLibrary.MediaType.video) || mediaTypes.includes('video');

        for (const rUri of roots.slice(0, 6)) {
          try {
            const list = await folderService.loadFolderAssets(rUri);
            for (const item of list || []) {
              if (seen.has(item.uri)) continue;
              if ((item.mediaType === 'photo' && wantPhoto) || (item.mediaType === 'video' && wantVideo)) {
                seen.add(item.uri);
                combined.push(item);
              }
            }
          } catch (_e) {}
        }
        return {
          assets: combined,
          endCursor: null,
          hasNextPage: false,
          totalCount: combined.length,
        };
      }

      return result;
    } catch (error) {
      console.error('Error al obtener archivos multimedia:', error);
      return { assets: [], endCursor: null, hasNextPage: false };
    }
  },

  _albumsMemCache: null,
  _albumsMemTime: 0,

  // Obtener álbumes del teléfono con vista previa ultra rápida y caché en memoria (0 ms al cambiar de pestaña)
  async getAlbums({ forceRefresh = false } = {}) {
    if (
      !forceRefresh &&
      mediaService._albumsMemCache &&
      mediaService._albumsMemCache.length > 0 &&
      Date.now() - mediaService._albumsMemTime < 45000
    ) {
      return mediaService._albumsMemCache;
    }

    try {
      let mediaAlbums = [];
      try {
        const albums = await MediaLibrary.getAlbumsAsync({
          includeSmartAlbums: true,
        });
        // Filtrar álbumes vacíos o carpetas basura del sistema (.thumbnails, stickers ocultos, cachés)
        const activeAlbums = (albums || []).filter((a) => {
          if (!a || !(a.assetCount > 0)) return false;
          const t = (a.title || '').trim().toLowerCase();
          if (t.startsWith('.') || t === 'thumbnails' || t === 'cache' || t === 'temp') return false;
          return true;
        });

        // Ordenar primero por cantidad de fotos para consultar portada solo a las carpetas principales
        activeAlbums.sort((a, b) => (b.assetCount || 0) - (a.assetCount || 0));

        // Limitar las consultas nativas de portada a las 16 carpetas principales y 2 pequeñas (< 5)
        let mainCoverBudget = 16;
        let smallCoverBudget = 2;
        mediaAlbums = await Promise.all(
          activeAlbums.map(async (album) => {
            const isSmall = (album.assetCount || 0) < 5;
            if (isSmall) {
              if (smallCoverBudget <= 0) {
                return { ...album, uri: album.uri || null, coverUri: null };
              }
              smallCoverBudget--;
            } else {
              if (mainCoverBudget <= 0) {
                return { ...album, uri: album.uri || null, coverUri: null };
              }
              mainCoverBudget--;
            }

            try {
              const preview = await MediaLibrary.getAssetsAsync({
                first: 1,
                album: album.id,
                sortBy: [MediaLibrary.SortBy.creationTime],
              });
              const coverUri =
                preview.assets && preview.assets.length > 0 ? preview.assets[0].uri : null;
              let inferredDirUri = null;
              if (coverUri && coverUri.startsWith('file://')) {
                const lastSlash = coverUri.lastIndexOf('/');
                if (lastSlash > 7) {
                  inferredDirUri = coverUri.slice(0, lastSlash);
                }
              }
              return {
                ...album,
                uri: album.uri || inferredDirUri || null,
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
      } catch (_mErr) {}

      // Combinar en paralelo con las carpetas guardadas por el usuario
      const saved = await folderService.getSavedFolders();
      const suggested =
        mediaAlbums.length === 0 ? await folderService.scanSuggestedFolders(saved) : [];

      const seenNormPaths = new Set();
      const seenTitles = new Set();

      const normalizePathKey = (u) => {
        if (!u) return '';
        try {
          const phys = folderService.toPhysicalUri(u) || u;
          return decodeURIComponent(phys).replace(/\/+$/, '').toLowerCase();
        } catch (_e) {
          return String(u).replace(/\/+$/, '').toLowerCase();
        }
      };

      const folderListToInspect = [...(saved || []), ...(suggested || [])].filter((f) => f?.uri);
      const inspectedFolders = await Promise.all(
        folderListToInspect.map(async (f) => {
          const info = await folderService.getFolderCoverAndCount(f.uri, 0);
          return { f, info };
        })
      );

      const extraAlbums = [];
      for (const { f, info } of inspectedFolders) {
        const title = folderService.formatFolderDisplayName(
          f.name || folderService.folderName(f.uri),
          f.uri
        );
        const normPath = normalizePathKey(f.uri);
        if (normPath && seenNormPaths.has(normPath)) continue;

        const total = f.totalMedia || info.count || 0;
        const isUserSaved = (saved || []).some((s) => s.uri === f.uri);

        if (total > 0 || info.subfolderCount > 0 || isUserSaved) {
          if (normPath) seenNormPaths.add(normPath);
          seenTitles.add(title.toLowerCase());
          extraAlbums.push({
            id: `folder_${f.uri}`,
            title,
            uri: f.uri,
            assetCount: total,
            subfolderCount: info.subfolderCount || 0,
            coverUri: info.coverUri,
            isFolderAlbum: true,
            isUserSaved,
          });
        }
      }

      // Filtrar mediaAlbums que no estén duplicados con las carpetas ya incluidas
      const dedupedMediaAlbums = [];
      for (const ma of mediaAlbums) {
        const normPath = normalizePathKey(ma.uri);
        const lowerTitle = (ma.title || '').trim().toLowerCase();
        if (normPath && seenNormPaths.has(normPath)) continue;
        if (seenTitles.has(lowerTitle)) continue;
        if (normPath) seenNormPaths.add(normPath);
        if (lowerTitle) seenTitles.add(lowerTitle);
        dedupedMediaAlbums.push(ma);
      }

      const combined = [...extraAlbums, ...dedupedMediaAlbums];

      // Ordenar priorizando álbumes esenciales y luego los que tienen más fotos primero
      const getEssentialPriority = (item) => {
        const t = (item.title || '').toLowerCase();
        if (/^(camera|cámara|camara|dcim)$/i.test(t)) return 1;
        if (/videos descargados/i.test(t)) return 2;
        if (/whatsapp/i.test(t)) return 3;
        if (/screenshot|captura/i.test(t)) return 4;
        if (/^(download|descargas|descargar)$/i.test(t)) return 5;
        if (item.isUserSaved) return 6;
        return 10;
      };

      combined.sort((a, b) => {
        const pa = getEssentialPriority(a);
        const pb = getEssentialPriority(b);
        if (pa !== pb) return pa - pb;
        // Dentro de la misma prioridad, mostrar primero las carpetas con más fotos
        const countDiff = (b.assetCount || 0) - (a.assetCount || 0);
        if (countDiff !== 0) return countDiff;
        return (a.title || '').localeCompare(b.title || '', 'es', { sensitivity: 'base' });
      });

      mediaService._albumsMemCache = combined;
      mediaService._albumsMemTime = Date.now();
      return combined;
    } catch (error) {
      console.error('Error al obtener álbumes:', error);
      return mediaService._albumsMemCache || [];
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
