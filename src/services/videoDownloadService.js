import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import {
  folderService,
  DOWNLOADED_VIDEOS_FOLDER_NAME,
  DOWNLOADED_VIDEOS_FOLDER_URI,
} from './folderService';

export const DOWNLOAD_ALBUM_NAME = DOWNLOADED_VIDEOS_FOLDER_NAME;
export const DOWNLOAD_FOLDER_URI = DOWNLOADED_VIDEOS_FOLDER_URI;
const DOWNLOAD_QUEUE_STORAGE_KEY = '@galeria_video_downloads_list_v1';

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

/**
 * Extrae el primer enlace http/https válido dentro de un texto pegado
 * (por ejemplo cuando el usuario copia un mensaje completo de WhatsApp o TikTok).
 */
export function extractUrlFromText(text) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  const match = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0] : trimmed;
}

/**
 * Detecta la plataforma del enlace para mostrar icono y etiqueta en la interfaz.
 */
export function detectPlatform(url) {
  const lower = (url || '').toLowerCase();
  if (!lower.startsWith('http')) return { id: 'unknown', name: 'Enlace web', icon: 'link-outline', color: '#3B82F6' };
  if (lower.includes('tiktok.com')) return { id: 'tiktok', name: 'TikTok', icon: 'musical-notes', color: '#00F2FE' };
  if (lower.includes('instagram.com') || lower.includes('instagr.am'))
    return { id: 'instagram', name: 'Instagram', icon: 'logo-instagram', color: '#E1306C' };
  if (lower.includes('facebook.com') || lower.includes('fb.watch') || lower.includes('fb.com'))
    return { id: 'facebook', name: 'Facebook', icon: 'logo-facebook', color: '#1877F2' };
  if (lower.includes('twitter.com') || lower.includes('x.com') || lower.includes('t.co'))
    return { id: 'twitter', name: 'X / Twitter', icon: 'logo-twitter', color: '#1DA1F2' };
  if (lower.includes('youtube.com') || lower.includes('youtu.be'))
    return { id: 'youtube', name: 'YouTube', icon: 'logo-youtube', color: '#FF0000' };
  if (lower.includes('reddit.com') || lower.includes('redd.it'))
    return { id: 'reddit', name: 'Reddit', icon: 'logo-reddit', color: '#FF4500' };
  if (lower.includes('pinterest.') || lower.includes('pin.it'))
    return { id: 'pinterest', name: 'Pinterest', icon: 'logo-pinterest', color: '#E60023' };
  if (/\.(mp4|mov|webm|mkv|m4v|3gp)(\?|#|$)/i.test(lower))
    return { id: 'direct', name: 'Archivo MP4 directo', icon: 'videocam', color: '#10B981' };
  return { id: 'web', name: 'Video Web', icon: 'globe-outline', color: '#8B5CF6' };
}

/**
 * Decodifica secuencias escapadas en JSON o HTML (\u0026, &amp;, \/...)
 */
function unescapeUrl(raw) {
  if (!raw) return '';
  return raw
    .replace(/\\u0026/g, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u003D/gi, '=')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * 1. Extractor para TikTok (vía TikWM API pública sin marca de agua)
 */
async function resolveTikTok(url, signal) {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
  const res = await fetch(apiUrl, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal,
  });
  if (!res.ok) throw new Error('No se pudo contactar con el extractor de TikTok');
  const json = await res.json();
  if (json && json.code === 0 && json.data) {
    const videoUrl = json.data.hdplay || json.data.play || json.data.wmplay;
    if (videoUrl) {
      const fullVideoUrl = videoUrl.startsWith('http')
        ? videoUrl
        : `https://www.tikwm.com${videoUrl}`;
      return {
        downloadUrl: fullVideoUrl,
        title: json.data.title || 'tiktok_video',
        thumbnail: json.data.cover || null,
        source: 'TikTok HD',
      };
    }
  }
  throw new Error('No se encontró un video descargable en este enlace de TikTok');
}

/**
 * 2. Extractor para X / Twitter (vía vxtwitter / fxtwitter / Syndication API / TwitSave)
 */
async function resolveTwitter(url, signal) {
  let targetUrl = url;
  if (/^https?:\/\/t\.co\//i.test(targetUrl)) {
    try {
      const redir = await fetch(targetUrl, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        signal,
      });
      if (redir?.url) targetUrl = redir.url;
    } catch (_e) {
      if (signal?.aborted) throw _e;
    }
  }

  const match =
    targetUrl.match(/(?:twitter\.com|x\.com|vxtwitter\.com|fxtwitter\.com)\/(?:([^/]+)\/status|i\/web\/status|i\/status)\/(\d+)/i) ||
    targetUrl.match(/status\/(\d+)/i);
  if (!match) {
    throw new Error('Enlace de X/Twitter no contiene un ID de publicación válido');
  }
  const statusId = match[2] || match[1];
  const user = (match[2] ? match[1] : 'i') || 'i';

  // Intento 1: api.vxtwitter.com
  try {
    const vxRes = await fetch(`https://api.vxtwitter.com/${user}/status/${statusId}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal,
    });
    if (vxRes.ok) {
      const data = await vxRes.json();
      const mediaList = data.media_extended || [];
      const videoItem = mediaList.find((m) => m.type === 'video' || m.type === 'gif');
      if (videoItem && videoItem.url) {
        return {
          downloadUrl: videoItem.url,
          title: data.text ? data.text.slice(0, 50) : `twitter_${statusId}`,
          thumbnail: videoItem.thumbnail_url || null,
          source: 'X / Twitter',
        };
      }
      if (Array.isArray(data.mediaURLs) && data.mediaURLs.length > 0) {
        const mp4Url = data.mediaURLs.find((u) => /\.mp4/i.test(u));
        if (mp4Url) {
          return {
            downloadUrl: mp4Url,
            title: data.text ? data.text.slice(0, 50) : `twitter_${statusId}`,
            source: 'X / Twitter',
          };
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
  }

  // Intento 2: api.fxtwitter.com
  try {
    const fxRes = await fetch(`https://api.fxtwitter.com/${user}/status/${statusId}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal,
    });
    if (fxRes.ok) {
      const data = await fxRes.json();
      const videos = data?.tweet?.media?.videos || data?.tweet?.media?.all?.filter((m) => m.type === 'video' || m.type === 'gif') || [];
      if (videos.length > 0 && videos[0].url) {
        return {
          downloadUrl: videos[0].url,
          title: data?.tweet?.text ? data.tweet.text.slice(0, 50) : `twitter_${statusId}`,
          thumbnail: videos[0].thumbnail_url || null,
          source: 'X / Twitter',
        };
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
  }

  // Intento 3: Twitter Syndication Embed API oficial
  try {
    const token = ((Number(statusId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
    const synRes = await fetch(
      `https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&lang=es&token=${token || 'a'}`,
      {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal,
      }
    );
    if (synRes.ok) {
      const synData = await synRes.json();
      const mediaDetails = synData?.mediaDetails || [];
      for (const m of mediaDetails) {
        const variants = m?.video_info?.variants || [];
        const mp4Variants = variants
          .filter((v) => v.url && (v.content_type === 'video/mp4' || /\.mp4/i.test(v.url)))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (mp4Variants.length > 0) {
          return {
            downloadUrl: mp4Variants[0].url,
            title: synData?.text ? synData.text.slice(0, 50) : `twitter_${statusId}`,
            thumbnail: m.media_url_https || null,
            source: 'X / Twitter HD',
          };
        }
      }
      if (synData?.video?.variants) {
        const mp4s = synData.video.variants.filter((v) => v.src && /\.mp4/i.test(v.src));
        if (mp4s.length > 0) {
          return {
            downloadUrl: mp4s[mp4s.length - 1].src,
            title: `twitter_${statusId}`,
            source: 'X / Twitter',
          };
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
  }

  // Intento 4: TwitSave extractor
  try {
    const tsRes = await fetch(
      `https://twitsave.com/info?url=${encodeURIComponent(`https://x.com/${user}/status/${statusId}`)}`,
      {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        signal,
      }
    );
    if (tsRes.ok) {
      const html = await tsRes.text();
      const matchMp4 = html.match(/https?:\/\/video\.twimg\.com\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
      if (matchMp4 && matchMp4[0]) {
        return {
          downloadUrl: unescapeUrl(matchMp4[0]),
          title: `twitter_${statusId}`,
          source: 'X / Twitter',
        };
      }
    }
  } catch (e) {
    if (signal?.aborted) throw e;
  }

  throw new Error('No se encontró video en esta publicación de X/Twitter');
}

/**
 * 3. Extractor para Reddit (vía JSON público de Reddit)
 */
async function resolveReddit(url, signal) {
  let finalUrl = url;
  if (url.includes('redd.it') || url.includes('/s/')) {
    const redir = await fetch(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT }, signal });
    if (redir.url) finalUrl = redir.url;
  }

  const cleanUrl = finalUrl.split('?')[0].replace(/\/+$/, '');
  const jsonUrl = `${cleanUrl}.json`;
  const res = await fetch(jsonUrl, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal,
  });
  if (!res.ok) throw new Error('No se pudo leer la publicación de Reddit');
  const data = await res.json();
  const post = data?.[0]?.data?.children?.[0]?.data;
  if (!post) throw new Error('Publicación de Reddit no encontrada');

  const fallbackUrl =
    post?.secure_media?.reddit_video?.fallback_url ||
    post?.media?.reddit_video?.fallback_url ||
    post?.preview?.reddit_video_preview?.fallback_url ||
    post?.crosspost_parent_list?.[0]?.secure_media?.reddit_video?.fallback_url;

  if (fallbackUrl) {
    return {
      downloadUrl: unescapeUrl(fallbackUrl),
      title: post.title || 'reddit_video',
      thumbnail: post.thumbnail && post.thumbnail.startsWith('http') ? post.thumbnail : null,
      source: 'Reddit',
    };
  }

  if (post?.url_overridden_by_dest && /\.(mp4|gifv|webm)$/i.test(post.url_overridden_by_dest)) {
    return {
      downloadUrl: post.url_overridden_by_dest.replace(/\.gifv$/i, '.mp4'),
      title: post.title || 'reddit_video',
      source: 'Reddit',
    };
  }

  throw new Error('Esta publicación de Reddit no contiene un video directo');
}

/**
 * 4. Extractor para Pinterest
 */
async function resolvePinterest(url, signal) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal,
  });
  const html = await res.text();
  const mp4Match =
    html.match(/https?:\/\/v\d*\.pinimg\.com\/videos\/[^"'\s\\]+\.mp4/i) ||
    html.match(/"contentUrl"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i);
  if (mp4Match) {
    const raw = mp4Match[1] || mp4Match[0];
    return {
      downloadUrl: unescapeUrl(raw),
      title: 'pinterest_video',
      source: 'Pinterest',
    };
  }
  throw new Error('No se encontró video MP4 en este enlace de Pinterest');
}

/**
 * 5. Extractor multi-plataforma vía instancias Cobalt API
 */
async function resolveViaCobaltInstances(url, parentSignal) {
  const instances = [
    'https://cobalt-api.kwiatekmiki.com',
    'https://cobalt-backend.canine.tools',
    'https://cbl.savefrom.ac',
  ];

  for (const base of instances) {
    if (parentSignal?.aborted) throw new Error('CANCELLED');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const onParentAbort = () => controller.abort();
      if (parentSignal) parentSignal.addEventListener('abort', onParentAbort, { once: true });

      const res = await fetch(`${base}/`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({
          url,
          videoQuality: '1080',
          filenameStyle: 'basic',
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);

      if (res.ok) {
        const data = await res.json();
        const streamUrl = data.url || (data.picker && data.picker[0]?.url);
        if (streamUrl) {
          return {
            downloadUrl: streamUrl,
            title: data.filename || 'video_descargado',
            source: 'Extractor Cloud',
          };
        }
      }
    } catch (e) {
      if (parentSignal?.aborted) throw new Error('CANCELLED');
    }
  }
  throw new Error('Instancias cloud no disponibles para este enlace');
}

/**
 * 6. Extractor universal de metadatos HTML (OpenGraph og:video, JSON embebido de Instagram/Facebook/Web y etiquetas <video>)
 */
async function resolveFromWebPageHtml(url, signal) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
    },
    signal,
  });

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.startsWith('video/') || contentType.includes('octet-stream')) {
    return {
      downloadUrl: res.url || url,
      title: 'video_directo',
      source: 'Enlace Directo',
    };
  }

  const html = await res.text();

  const patterns = [
    /"playable_url_quality_hd"\s*:\s*"([^"]+)"/i,
    /"playable_url"\s*:\s*"([^"]+)"/i,
    /"browser_native_hd_url"\s*:\s*"([^"]+)"/i,
    /"browser_native_sd_url"\s*:\s*"([^"]+)"/i,
    /"video_url"\s*:\s*"([^"]+)"/i,
    /"contentUrl"\s*:\s*"(https?:[^"]+\.mp4[^"]*)"/i,
    /<meta[^>]+property=["']og:video:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video:secure_url["']/i,
    /<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video["']/i,
    /<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/i,
    /<video[^>]+src=["'](https?:\/\/[^"']+)["']/i,
    /<source[^>]+src=["'](https?:\/\/[^"']+\.(?:mp4|webm|mov)[^"']*)["']/i,
  ];

  for (const regex of patterns) {
    const match = html.match(regex);
    if (match && match[1]) {
      const candidate = unescapeUrl(match[1]);
      if (candidate.startsWith('http')) {
        return {
          downloadUrl: candidate,
          title: 'video_web',
          source: 'Extractor Web',
        };
      }
    }
  }

  throw new Error('No se encontró un flujo de video directo en la página');
}

export const videoDownloadService = {
  /**
   * Resuelve cualquier enlace de internet a un URL directo de video MP4/multimedia.
   */
  async resolveVideoUrl(rawInput, signal) {
    const url = extractUrlFromText(rawInput);
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new Error('Por favor ingresa un enlace válido que comience con http:// o https://');
    }

    const platform = detectPlatform(url);

    if (platform.id === 'direct') {
      return {
        downloadUrl: url,
        title: url.split('/').pop().split('?')[0] || 'video.mp4',
        platform,
        source: 'Enlace Directo',
      };
    }

    if (platform.id === 'tiktok') {
      try {
        const res = await resolveTikTok(url, signal);
        return { ...res, platform };
      } catch (e) {
        if (signal?.aborted) throw new Error('CANCELLED');
      }
    }

    if (platform.id === 'twitter') {
      try {
        const res = await resolveTwitter(url, signal);
        return { ...res, platform };
      } catch (e) {
        if (signal?.aborted) throw new Error('CANCELLED');
      }
    }

    if (platform.id === 'reddit') {
      try {
        const res = await resolveReddit(url, signal);
        return { ...res, platform };
      } catch (e) {
        if (signal?.aborted) throw new Error('CANCELLED');
      }
    }

    if (platform.id === 'pinterest') {
      try {
        const res = await resolvePinterest(url, signal);
        return { ...res, platform };
      } catch (e) {
        if (signal?.aborted) throw new Error('CANCELLED');
      }
    }

    try {
      const res = await resolveViaCobaltInstances(url, signal);
      return { ...res, platform };
    } catch (e) {
      if (signal?.aborted || e?.message === 'CANCELLED') throw new Error('CANCELLED');
    }

    try {
      const res = await resolveFromWebPageHtml(url, signal);
      return { ...res, platform };
    } catch (e) {
      if (signal?.aborted) throw new Error('CANCELLED');
    }

    throw new Error(
      'No se pudo extraer el video automáticamente. Verifica que el enlace sea público o utiliza un enlace directo al video.'
    );
  },

  /**
   * Descarga el video desde su URL con soporte completo para PAUSAR, REANUDAR y CANCELAR.
   */
  async downloadVideoFromUrl(rawInput, { onStatus, onProgress, onController } = {}) {
    const abortController = new AbortController();
    let isCancelled = false;
    let isPaused = false;
    let downloadResumable = null;
    let pauseWaitPromise = null;
    let pauseResolve = null;
    let targetPath = null;

    const controller = {
      pause: async () => {
        if (isPaused || isCancelled) return;
        isPaused = true;
        pauseWaitPromise = new Promise((resolve) => {
          pauseResolve = resolve;
        });
        if (downloadResumable) {
          try {
            await downloadResumable.pauseAsync();
          } catch (e) {
            // ignorar
          }
        }
      },
      resume: async () => {
        if (!isPaused || isCancelled) return;
        isPaused = false;
        if (pauseResolve) {
          const r = pauseResolve;
          pauseResolve = null;
          pauseWaitPromise = null;
          r();
        }
      },
      cancel: async () => {
        if (isCancelled) return;
        isCancelled = true;
        isPaused = false;
        try {
          abortController.abort();
        } catch (e) {
          // ignorar
        }
        if (pauseResolve) {
          const r = pauseResolve;
          pauseResolve = null;
          pauseWaitPromise = null;
          r();
        }
        if (downloadResumable) {
          try {
            await downloadResumable.cancelAsync();
          } catch (e) {
            // ignorar
          }
        }
        if (targetPath) {
          FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
        }
      },
    };

    if (onController) {
      onController(controller);
    }

    if (onStatus) onStatus('Analizando enlace y buscando video…');

    const resolved = await videoDownloadService.resolveVideoUrl(rawInput, abortController.signal);
    if (isCancelled) throw new Error('CANCELLED');

    // Si el usuario pausó mientras se analizaba el enlace, esperar aquí antes de iniciar la descarga
    if (isPaused && pauseWaitPromise) {
      if (onStatus) onStatus('En pausa…');
      await pauseWaitPromise;
      if (isCancelled) throw new Error('CANCELLED');
    }

    const { downloadUrl, title, platform, source } = resolved;

    if (onStatus) onStatus(`Descargando video (${source || platform.name})…`);

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');

    const safePrefix = (platform?.id || 'VID').toUpperCase();
    const filename = `VID_${y}${m}${d}_${h}${min}${s}_${safePrefix}.mp4`;
    targetPath = `${FileSystem.cacheDirectory}${filename}`;

    try {
      await FileSystem.deleteAsync(targetPath, { idempotent: true });
    } catch (e) {
      // ignorar
    }

    downloadResumable = FileSystem.createDownloadResumable(
      downloadUrl,
      targetPath,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
        },
      },
      (dp) => {
        if (onProgress && !isCancelled) {
          const written = dp.totalBytesWritten || 0;
          const total = dp.totalBytesExpectedToWrite || 0;
          const percent = total > 0 ? Math.min(1, written / total) : 0;
          onProgress({
            writtenBytes: written,
            totalBytes: total,
            percent,
          });
        }
      }
    );

    let result = null;
    let isResuming = false;

    while (!isCancelled) {
      try {
        result = isResuming
          ? await downloadResumable.resumeAsync()
          : await downloadResumable.downloadAsync();
      } catch (err) {
        if (isCancelled) throw new Error('CANCELLED');
        if (!isPaused) throw err;
      }

      if (isCancelled) {
        await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
        throw new Error('CANCELLED');
      }

      if (isPaused && pauseWaitPromise) {
        if (onStatus) onStatus('Descarga en pausa');
        await pauseWaitPromise;
        if (isCancelled) {
          await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
          throw new Error('CANCELLED');
        }
        if (onStatus) onStatus(`Descargando video (${source || platform.name})…`);
        isResuming = true;
        continue;
      }

      break;
    }

    if (!result || !result.uri) {
      await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
      throw new Error('CANCELLED');
    }

    if (result.status && result.status >= 400) {
      await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
      throw new Error(`El servidor rechazó la descarga (código HTTP ${result.status}).`);
    }

    const fileInfo = await FileSystem.getInfoAsync(result.uri);
    if (!fileInfo.exists || (fileInfo.size && fileInfo.size < 10240)) {
      await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
      throw new Error('El archivo descargado no es un video válido o el enlace requiere iniciar sesión.');
    }

    if (isCancelled) {
      await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
      throw new Error('CANCELLED');
    }

    if (onStatus) onStatus(`Guardando en carpeta "${DOWNLOAD_ALBUM_NAME}"…`);

    let savedAsset = null;
    let folderUri = DOWNLOAD_FOLDER_URI;
    let savedPhysically = false;

    // 1. Asegurar que exista la carpeta propia "Videos Descargados" y registrarla en Mi Carpeta
    try {
      folderUri = await folderService.ensureDownloadedVideosFolder();
    } catch (_fErr) {}

    // 2. Mover/guardar directamente en la carpeta física "Videos Descargados" (e indexar en MediaStore sin duplicar)
    try {
      if (NativeModules?.VideoEngineModule?.moveFileToSubfolderNative) {
        const destUri = await NativeModules.VideoEngineModule.moveFileToSubfolderNative(
          result.uri,
          'file:///storage/emulated/0/Movies',
          DOWNLOAD_ALBUM_NAME,
          filename
        );
        savedPhysically = true;
        savedAsset = {
          id: destUri || `${folderUri}/${filename}`,
          uri: destUri || `${folderUri}/${filename}`,
          filename,
          mediaType: 'video',
          fileSize: fileInfo.size || 0,
          creationTime: Date.now(),
        };
      } else {
        await FileSystem.makeDirectoryAsync(folderUri, { intermediates: true }).catch(() => {});
        const destFileUri = `${folderUri}/${filename}`;
        await FileSystem.copyAsync({ from: result.uri, to: destFileUri });
        savedPhysically = true;
        savedAsset = {
          id: destFileUri,
          uri: destFileUri,
          filename,
          mediaType: 'video',
          fileSize: fileInfo.size || 0,
          creationTime: Date.now(),
        };
      }
    } catch (_physErr) {
      savedPhysically = false;
    }

    // 3. Respaldo en MediaLibrary (Álbum "Videos Descargados") si el guardado físico directo no estuvo disponible
    if (!savedPhysically) {
      try {
        try {
          await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
        } catch (_permE) {
          await MediaLibrary.requestPermissionsAsync().catch(() => {});
        }
        const asset = await MediaLibrary.createAssetAsync(result.uri);
        if (asset) savedAsset = asset;
        let album = await MediaLibrary.getAlbumAsync(DOWNLOAD_ALBUM_NAME);
        if (!album) {
          await MediaLibrary.createAlbumAsync(DOWNLOAD_ALBUM_NAME, asset, false);
        } else {
          await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
        }
      } catch (albumErr) {
        await MediaLibrary.saveToLibraryAsync(result.uri);
      }
    }

    try {
      await FileSystem.deleteAsync(targetPath, { idempotent: true });
    } catch (e) {
      // ignorar
    }

    return {
      success: true,
      filename,
      title: title || filename,
      platform,
      sizeBytes: fileInfo.size || 0,
      asset: savedAsset,
      albumName: DOWNLOAD_ALBUM_NAME,
      folderUri,
    };
  },

  async getStoredDownloadItems() {
    try {
      const raw = await AsyncStorage.getItem(DOWNLOAD_QUEUE_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Si había alguna descarga "downloading" o "paused" de una sesión anterior cerrada, marcarla como interrumpida para poder reintentar
      return parsed.map((item) =>
        item.status === 'downloading' || item.status === 'paused'
          ? {
              ...item,
              status: 'error',
              errorMessage: 'Descarga interrumpida al cerrar la app. Toca Reintentar.',
            }
          : item
      );
    } catch (_e) {
      return [];
    }
  },

  async saveStoredDownloadItems(items = []) {
    try {
      const toStore = (items || []).slice(0, 60).map((it) => ({
        id: it.id,
        url: it.url,
        title: it.title,
        filename: it.filename,
        platform: it.platform,
        status: it.status,
        percent: it.percent || 0,
        writtenBytes: it.writtenBytes || 0,
        totalBytes: it.totalBytes || 0,
        sizeBytes: it.sizeBytes || 0,
        albumName: it.albumName || DOWNLOAD_ALBUM_NAME,
        folderUri: it.folderUri || DOWNLOAD_FOLDER_URI,
        asset: it.asset || null,
        errorMessage: it.errorMessage || null,
        date: it.date || '',
      }));
      await AsyncStorage.setItem(DOWNLOAD_QUEUE_STORAGE_KEY, JSON.stringify(toStore));
    } catch (_e) {}
  },
};
