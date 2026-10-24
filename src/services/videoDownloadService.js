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

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FB_CRAWLER_USER_AGENT =
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

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
 * Decodifica secuencias escapadas en JSON o HTML (\u0025, \u0026, &amp;, \/...)
 */
function unescapeUrl(raw) {
  if (!raw) return '';
  return raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
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
 * 5. Extractor especializado de múltiples capas para Facebook (Reels, Share /share/v/ y /share/r/, Watch, fb.watch y Publicaciones)
 */
function normalizeFacebookUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let u = rawUrl.trim();
  // Si es una redirección /login/?next=..., extraer el destino real
  if (/\/login(?:\.php)?\?/i.test(u) && /[?&]next=([^&#]+)/i.test(u)) {
    try {
      const m = u.match(/[?&]next=([^&#]+)/i);
      if (m && m[1]) {
        const decodedNext = decodeURIComponent(m[1]);
        if (decodedNext.startsWith('http')) {
          u = decodedNext;
        }
      }
    } catch (_e) {}
  }
  return u
    .replace(/^https?:\/\/(?:m|mbasic|web|touch|business)\.facebook\.com\//i, 'https://www.facebook.com/');
}

function extractFacebookVideoFromHtml(html) {
  if (!html || typeof html !== 'string') return null;

  const fbPatterns = [
    { regex: /"browser_native_hd_url"\s*:\s*"(https?:[^"]+)"/i, label: 'Facebook HD' },
    { regex: /"playable_url_quality_hd"\s*:\s*"(https?:[^"]+)"/i, label: 'Facebook HD' },
    { regex: /"hd_src_no_ratelimit"\s*:\s*"(https?:[^"]+)"/i, label: 'Facebook HD' },
    { regex: /"hd_src"\s*:\s*"(https?:[^"]+)"/i, label: 'Facebook HD' },
    { regex: /"progressive_url"\s*:\s*"(https?:[^"]+)"[^}]{0,220}"quality"\s*:\s*"HD"/i, label: 'Facebook HD' },
    { regex: /"quality"\s*:\s*"HD"[^}]{0,220}"progressive_url"\s*:\s*"(https?:[^"]+)"/i, label: 'Facebook HD' },
    { regex: /"progressive_url"\s*:\s*"(https?:[^"]+)"/i, label: 'Facebook Video' },
    { regex: /"browser_native_sd_url"\s*:\s*"(https?:[^"]+)"/i, label: 'Facebook SD' },
    { regex: /"playable_url"\s*:\s*"(https?:[^"]+)"/i, label: 'Facebook SD' },
    { regex: /"sd_src_no_ratelimit"\s*:\s*"(https?:[^"]+)"/i, label: 'Facebook SD' },
    { regex: /"sd_src"\s*:\s*"(https?:[^"]+)"/i, label: 'Facebook SD' },
    { regex: /"video_url"\s*:\s*"(https?:[^"]+)"/i, label: 'Facebook Video' },
    { regex: /<meta[^>]+property=["']og:video:secure_url["'][^>]+content=["'](https?:[^"']+)["']/i, label: 'Facebook Video' },
    { regex: /<meta[^>]+content=["'](https?:[^"']+)["'][^>]+property=["']og:video:secure_url["']/i, label: 'Facebook Video' },
    { regex: /<meta[^>]+property=["']og:video["'][^>]+content=["'](https?:[^"']+)["']/i, label: 'Facebook Video' },
    { regex: /<meta[^>]+content=["'](https?:[^"']+)["'][^>]+property=["']og:video["']/i, label: 'Facebook Video' },
  ];

  for (const item of fbPatterns) {
    const match = html.match(item.regex);
    if (match && match[1]) {
      const clean = unescapeUrl(match[1]);
      if (clean && clean.startsWith('http') && !clean.includes('facebook.com/plugins/')) {
        const titleMatch =
          html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
          html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const rawTitle = titleMatch && titleMatch[1] ? unescapeUrl(titleMatch[1]).slice(0, 60) : 'facebook_video';
        return {
          downloadUrl: clean,
          title: rawTitle,
          source: item.label,
        };
      }
    }
  }
  return null;
}

function extractCanonicalAndVideoIdFromFacebook(url, html = '') {
  let canonical = null;
  if (html) {
    const ogUrlMatch =
      html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["'](https?:[^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["'](https?:[^"']+)["'][^>]+property=["']og:url["']/i) ||
      html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["'](https?:[^"']+)["']/i);
    if (ogUrlMatch && ogUrlMatch[1]) {
      const candidate = unescapeUrl(ogUrlMatch[1]);
      if (candidate.startsWith('http') && !candidate.includes('/login')) {
        canonical = normalizeFacebookUrl(candidate);
      }
    }
  }

  const combined = `${canonical || ''} ${url || ''} ${(html || '').slice(0, 120000)}`;
  const idMatch =
    combined.match(/\/reel\/(\d{8,25})/i) ||
    combined.match(/\/videos\/(?:[^/?#]+\/)?(\d{8,25})/i) ||
    combined.match(/[?&]v=(\d{8,25})/i) ||
    combined.match(/story_fbid=(\d{8,25})/i) ||
    combined.match(/"video_id"\s*:\s*"?(\d{10,25})"?/i);

  return {
    canonicalUrl: canonical,
    videoId: idMatch ? idMatch[1] : null,
  };
}

async function fetchCleanHtmlPage(targetUrl, userAgent, signal) {
  if (signal?.aborted) throw new Error('CANCELLED');
  if (NativeModules?.VideoEngineModule?.fetchCleanHtmlNative) {
    try {
      const res = await NativeModules.VideoEngineModule.fetchCleanHtmlNative(targetUrl, userAgent);
      if (res && typeof res.html === 'string' && res.html.length > 0) {
        return {
          html: res.html,
          finalUrl: res.finalUrl || targetUrl,
          status: res.status || 200,
        };
      }
    } catch (_e) {
      if (signal?.aborted) throw new Error('CANCELLED');
    }
  }

  const res = await fetch(targetUrl, {
    method: 'GET',
    credentials: 'omit',
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
    signal,
  });

  const html = await res.text();
  return {
    html,
    finalUrl: res.url || targetUrl,
    status: res.status,
  };
}

async function resolveFacebook(url, signal) {
  let targetUrl = normalizeFacebookUrl(url);
  let discoveredVideoId = null;
  let discoveredCanonical = null;

  // Etapa 1: Consultar con el rastreador oficial de vista previa (facebookexternalhit/1.1)
  // Desenvuelve automáticamente enlaces cortos /share/v/, /share/r/ y fb.watch sin pedir login
  try {
    const page1 = await fetchCleanHtmlPage(targetUrl, FB_CRAWLER_USER_AGENT, signal);
    const found1 = extractFacebookVideoFromHtml(page1.html);
    if (found1) return found1;

    const info1 = extractCanonicalAndVideoIdFromFacebook(page1.finalUrl, page1.html);
    if (info1.videoId) discoveredVideoId = info1.videoId;
    if (info1.canonicalUrl) discoveredCanonical = info1.canonicalUrl;
    if (page1.finalUrl && page1.finalUrl !== targetUrl) {
      targetUrl = normalizeFacebookUrl(page1.finalUrl);
    }
  } catch (e) {
    if (signal?.aborted || e?.message === 'CANCELLED') throw new Error('CANCELLED');
  }

  // Etapa 2: Consultar con navegador Chrome de Escritorio (Recibe el JSON completo de Relay con browser_native_hd_url)
  const urlForStage2 = discoveredCanonical || targetUrl;
  try {
    const page2 = await fetchCleanHtmlPage(urlForStage2, DESKTOP_USER_AGENT, signal);
    const found2 = extractFacebookVideoFromHtml(page2.html);
    if (found2) return found2;

    const info2 = extractCanonicalAndVideoIdFromFacebook(page2.finalUrl, page2.html);
    if (!discoveredVideoId && info2.videoId) discoveredVideoId = info2.videoId;
    if (!discoveredCanonical && info2.canonicalUrl) discoveredCanonical = info2.canonicalUrl;
  } catch (e) {
    if (signal?.aborted || e?.message === 'CANCELLED') throw new Error('CANCELLED');
  }

  // Etapa 3: Reproductor Embed Oficial de Facebook (plugins/video.php) — ligero y entrega hd_src / sd_src directo
  const urlsToTryInEmbed = [];
  if (discoveredCanonical) urlsToTryInEmbed.push(discoveredCanonical);
  if (targetUrl && !urlsToTryInEmbed.includes(targetUrl)) urlsToTryInEmbed.push(targetUrl);
  if (discoveredVideoId) {
    urlsToTryInEmbed.push(`https://www.facebook.com/watch/?v=${discoveredVideoId}`);
    urlsToTryInEmbed.push(`https://www.facebook.com/reel/${discoveredVideoId}/`);
  }

  for (const candidateHref of urlsToTryInEmbed) {
    if (signal?.aborted) throw new Error('CANCELLED');
    try {
      const embedEndpoint = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(candidateHref)}&show_text=0`;
      const embedPage = await fetchCleanHtmlPage(embedEndpoint, DESKTOP_USER_AGENT, signal);
      const foundEmbed = extractFacebookVideoFromHtml(embedPage.html);
      if (foundEmbed) return foundEmbed;
    } catch (e) {
      if (signal?.aborted || e?.message === 'CANCELLED') throw new Error('CANCELLED');
    }
  }

  // Etapa 4: Si encontramos un ID numérico de video/reel, consultar directamente /reel/{id} y /watch/?v={id}
  if (discoveredVideoId) {
    for (const directUrl of [
      `https://www.facebook.com/reel/${discoveredVideoId}/`,
      `https://www.facebook.com/watch/?v=${discoveredVideoId}`,
    ]) {
      if (signal?.aborted) throw new Error('CANCELLED');
      try {
        const directPage = await fetchCleanHtmlPage(directUrl, DESKTOP_USER_AGENT, signal);
        const foundDirect = extractFacebookVideoFromHtml(directPage.html);
        if (foundDirect) return foundDirect;
      } catch (e) {
        if (signal?.aborted || e?.message === 'CANCELLED') throw new Error('CANCELLED');
      }
    }
  }

  throw new Error('No se encontró un flujo de video público en este enlace de Facebook');
}

/**
 * 6. Extractor multi-plataforma vía instancias Cobalt API
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
    credentials: 'omit',
    headers: {
      'User-Agent': DESKTOP_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
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

    if (platform.id === 'facebook') {
      try {
        const res = await resolveFacebook(url, signal);
        return { ...res, platform };
      } catch (e) {
        if (signal?.aborted || e?.message === 'CANCELLED') throw new Error('CANCELLED');
      }
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
          'User-Agent': DESKTOP_USER_AGENT,
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
