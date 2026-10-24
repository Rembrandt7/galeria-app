import * as MediaLibrary from 'expo-media-library';
import * as Crypto from 'expo-crypto';
import * as LegacyFS from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { compressionService } from './compressionService';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const toHex = (buffer) =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export const duplicateService = {
  /** Trae todas las fotos de la galería del teléfono. */
  async loadAllPhotos(onProgress, control) {
    const all = [];
    let after = null;
    let hasNext = true;
    while (hasNext) {
      if (control?.waitIfPaused) await control.waitIfPaused();
      if (control?.isCancelled) return all;
      const page = await MediaLibrary.getAssetsAsync({
        first: 500,
        after: after || undefined,
        mediaType: [MediaLibrary.MediaType.photo],
        sortBy: [MediaLibrary.SortBy.creationTime],
      });
      all.push(...page.assets);
      after = page.endCursor;
      hasNext = page.hasNextPage;
      if (onProgress) onProgress({ phase: 'listing', done: all.length, total: null });
    }
    return all;
  },

  /**
   * Busca fotos idénticas (mismo contenido byte a byte).
   * Primero agrupa por tamaño y solo calcula el hash de los candidatos.
   * Devuelve grupos de 2 o más copias.
   */
  async findDuplicates(photos, onProgress, control) {
    const images = photos.filter((a) => a.mediaType === 'photo');

    // 1) Agrupar por tamaño (compatible con file:// y content:// SAF)
    const bySize = new Map();
    let i = 0;
    for (const asset of images) {
      if (control?.waitIfPaused) await control.waitIfPaused();
      if (control?.isCancelled) return [];
      let size = 0;
      try {
        size = new File(asset.uri).size || 0;
      } catch (e) {
        size = 0;
      }
      if (!size || size <= 0) {
        try {
          size = (await compressionService.getFileSize(asset)) || 0;
        } catch (e2) {
          size = 0;
        }
      }
      if (size > 0) {
        const list = bySize.get(size) || [];
        list.push({ ...asset, size });
        bySize.set(size, list);
      }
      i += 1;
      if (i % 40 === 0) {
        if (onProgress) onProgress({ phase: 'sizes', done: i, total: images.length });
        await tick();
      }
    }

    // 2) Hash solo de los grupos con tamaño repetido
    const candidates = [];
    bySize.forEach((list) => {
      if (list.length > 1) candidates.push(...list);
    });

    const byHash = new Map();
    let j = 0;
    for (const asset of candidates) {
      if (control?.waitIfPaused) await control.waitIfPaused();
      if (control?.isCancelled) break;
      try {
        let hexHash = null;
        try {
          const bytes = await new File(asset.uri).bytes();
          if (bytes && bytes.byteLength > 0) {
            const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
            hexHash = toHex(digest);
          }
        } catch (errBytes) {
          // Fallback para URIs SAF content:// o rutas con espacios
        }

        if (!hexHash) {
          const base64 = await LegacyFS.readAsStringAsync(asset.uri, {
            encoding: LegacyFS.EncodingType.Base64,
          });
          if (base64) {
            hexHash = await Crypto.digestStringAsync(
              Crypto.CryptoDigestAlgorithm.SHA256,
              base64
            );
          }
        }

        if (hexHash) {
          const key = `${asset.size}-${hexHash}`;
          const list = byHash.get(key) || [];
          list.push(asset);
          byHash.set(key, list);
        }
      } catch (e) {
        // archivo ilegible: se omite
      }
      j += 1;
      if (onProgress) onProgress({ phase: 'hash', done: j, total: candidates.length });
      if (j % 5 === 0) await tick();
    }

    const groups = [];
    byHash.forEach((list, key) => {
      if (list.length > 1) {
        // El más antiguo primero (se sugiere conservarlo)
        list.sort((a, b) => (a.creationTime || 0) - (b.creationTime || 0));
        groups.push({ key, items: list });
      }
    });
    groups.sort((a, b) => b.items[0].size - a.items[0].size);
    return groups;
  },
};
