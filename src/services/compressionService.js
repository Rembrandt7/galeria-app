import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';

export const compressionService = {
  formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) {
      return `${mb.toFixed(2)} MB`;
    }
    const kb = bytes / 1024;
    return `${kb.toFixed(1)} KB`;
  },

  /**
   * Determina el nivel de peso y los colores visuales según los rangos del usuario:
   * - 0 a 2 MB: Verde
   * - 2 a 4 MB: Amarillo
   * - Más de 4 MB: Título en rojo sobre franja roja
   */
  getSizeLevel(bytes) {
    const mb = (bytes || 0) / (1024 * 1024);

    if (mb <= 2) {
      return {
        level: 'light',
        mb: mb.toFixed(2),
        color: '#10b981', // Verde
        titleColor: '#10b981',
        bannerBg: 'rgba(16, 185, 129, 0.18)',
        borderColor: '#10b981',
        tagText: 'Ligero',
        isHeavy: false,
      };
    }

    if (mb <= 4) {
      return {
        level: 'medium',
        mb: mb.toFixed(2),
        color: '#f59e0b', // Amarillo
        titleColor: '#f59e0b',
        bannerBg: 'rgba(245, 158, 11, 0.20)',
        borderColor: '#f59e0b',
        tagText: 'Medio',
        isHeavy: false,
      };
    }

    // Más de 4 MB
    return {
      level: 'heavy',
      mb: mb.toFixed(2),
      color: '#ef4444', // Rojo
      titleColor: '#ffffff',
      bannerBg: '#dc2626', // Franja roja sólida / llamativa
      borderColor: '#ef4444',
      tagText: 'Pesado (>4 MB)',
      isHeavy: true,
    };
  },

  /**
   * Obtiene el tamaño real en bytes de un archivo multimedia
   */
  async getFileSize(uri) {
    if (!uri) return 0;
    try {
      const info = await FileSystem.getInfoAsync(uri);
      return info.exists && info.size ? info.size : 0;
    } catch (e) {
      return 0;
    }
  },

  /**
   * Comprime una foto SIN perder resolución (mantiene el ancho y alto al 100%)
   * optimizando la codificación JPEG a calidad balanceada (0.82).
   */
  async compressPhoto(asset, { quality = 0.82 } = {}) {
    if (!asset?.uri) throw new Error('Archivo no válido');

    const uri = asset.uri;
    const oldSize = await compressionService.getFileSize(uri);

    // Manipulación sin acciones de recorte/redimensión (resolución 100% original)
    const ctx = ImageManipulator.manipulate(uri);
    const ref = await ctx.renderAsync();
    const result = await ref.saveAsync({
      format: SaveFormat.JPEG,
      compress: quality,
    });

    const newSize = await compressionService.getFileSize(result.uri);
    const savedBytes = Math.max(0, oldSize - newSize);

    // Si el archivo viene de una carpeta local (file://), sobrescribirlo para ahorrar espacio real
    if (uri.startsWith('file://')) {
      try {
        await FileSystem.copyAsync({ from: result.uri, to: uri });
        await FileSystem.deleteAsync(result.uri, { idempotent: true });
        return {
          success: true,
          uri,
          oldSize,
          newSize,
          savedBytes,
        };
      } catch (errCopy) {
        // Si no se pudo sobrescribir, guardar en biblioteca
      }
    }

    // Guardar copia optimizada en la galería si es de MediaLibrary
    try {
      const savedAsset = await MediaLibrary.createAssetAsync(result.uri);
      return {
        success: true,
        uri: savedAsset.uri,
        oldSize,
        newSize,
        savedBytes,
      };
    } catch (e) {
      return {
        success: true,
        uri: result.uri,
        oldSize,
        newSize,
        savedBytes,
      };
    }
  },

  /**
   * Comprime todas las fotos de una carpeta en lote sin perder resolución.
   */
  async compressFolderPhotos(assets = [], onProgress) {
    const photoAssets = assets.filter((a) => a.mediaType === 'photo');
    const total = photoAssets.length;
    if (total === 0) return { processed: 0, totalSavedBytes: 0 };

    let processed = 0;
    let totalSavedBytes = 0;

    for (const photo of photoAssets) {
      try {
        const res = await compressionService.compressPhoto(photo);
        totalSavedBytes += res.savedBytes || 0;
      } catch (e) {
        console.warn('Error al comprimir foto:', photo.filename, e);
      }
      processed++;
      if (onProgress) {
        onProgress({
          current: processed,
          total,
          percent: processed / total,
          savedBytes: totalSavedBytes,
          savedFormatted: compressionService.formatBytes(totalSavedBytes),
        });
      }
    }

    return { processed, totalSavedBytes };
  },
};
