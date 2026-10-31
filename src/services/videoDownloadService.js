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
 * Decodifica secuencias escapadas simples o doblemente escapadas en JSON o HTML (\u0025, \\u0026, &amp;, \/, \\/...)
 * y elimina rangos parciales bytestart/byteend de CDNs de Instagram/Facebook.
 */
function unescapeUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw
    .replace(/\\\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\\\//g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim()
    .replace(/^["'\\]+|["'\\]+$/g, '');
  if (/cdninstagram\.com|fbcdn\.net/i.test(s)) {
    s = s
      .replace(/bytestart=\d+&?/gi, '')
      .replace(/byteend=\d+&?/gi, '')
      .replace(/\?&/g, '?')
      .replace(/[?&]+$/, '');
  }
  return s;
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

function isValidDirectVideoCandidate(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return false;
  const lower = url.toLowerCase();
  if (
    lower.includes('lookaside.fbsbx.com') ||
    lower.includes('facebook.com/plugins/') ||
    lower.includes('facebook.com/login') ||
    lower.includes('/rsrc.php/') ||
    lower.includes('static.xx.fbcdn.net') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.png') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.js') ||
    lower.endsWith('.css')
  ) {
    return false;
  }
  return true;
}

function extractFacebookVideoFromHtml(html) {
  if (!html || typeof html !== 'string') return null;

  // 0. Enlaces mbasic / mobile redirect: /video_redirect/?src=https%3A%2F%2F...
  const redirMatch = html.match(/\/video_redirect\/\?src=([^"'\s&<>]+)/i);
  if (redirMatch && redirMatch[1]) {
    try {
      const decoded = decodeURIComponent(unescapeUrl(redirMatch[1]));
      if (isValidDirectVideoCandidate(decoded)) {
        return {
          downloadUrl: decoded,
          title: 'facebook_story_video',
          source: 'Facebook Mobile',
        };
      }
    } catch (_e) {}
  }

  const fbPatterns = [
    { regex: /"browser_native_hd_url"\s*:\s*"(https?:[^"]+)"/gi, label: 'Facebook HD' },
    { regex: /"playable_url_quality_hd"\s*:\s*"(https?:[^"]+)"/gi, label: 'Facebook HD' },
    { regex: /"hd_src_no_ratelimit"\s*:\s*"(https?:[^"]+)"/gi, label: 'Facebook HD' },
    { regex: /"hd_src"\s*:\s*"(https?:[^"]+)"/gi, label: 'Facebook HD' },
    { regex: /"progressive_url"\s*:\s*"(https?:[^"]+)"[^}]{0,220}"quality"\s*:\s*"HD"/gi, label: 'Facebook HD' },
    { regex: /"quality"\s*:\s*"HD"[^}]{0,220}"progressive_url"\s*:\s*"(https?:[^"]+)"/gi, label: 'Facebook HD' },
    { regex: /"progressive_url"\s*:\s*"(https?:[^"]+)"/gi, label: 'Facebook Story / Reel' },
    { regex: /"browser_native_sd_url"\s*:\s*"(https?:[^"]+)"/gi, label: 'Facebook SD' },
    { regex: /"playable_url"\s*:\s*"(https?:[^"]+)"/gi, label: 'Facebook SD' },
    { regex: /"sd_src_no_ratelimit"\s*:\s*"(https?:[^"]+)"/gi, label: 'Facebook SD' },
    { regex: /"sd_src"\s*:\s*"(https?:[^"]+)"/gi, label: 'Facebook SD' },
    { regex: /"video_url"\s*:\s*"(https?:[^"]+)"/gi, label: 'Facebook Video' },
    { regex: /<BaseURL[^>]*>(https?:[^<]+\.mp4[^<]*)<\/BaseURL>/gi, label: 'Facebook StoryStream' },
    { regex: /\\u003CBaseURL[^>]*>(https?:[^\\<]+\.mp4[^\\<]*)\\u003C\\\/BaseURL>/gi, label: 'Facebook StoryStream' },
    { regex: /<meta[^>]+property=["']og:video:secure_url["'][^>]+content=["'](https?:[^"']+)["']/gi, label: 'Facebook Video' },
    { regex: /<meta[^>]+content=["'](https?:[^"']+)["'][^>]+property=["']og:video:secure_url["']/gi, label: 'Facebook Video' },
    { regex: /<meta[^>]+property=["']og:video["'][^>]+content=["'](https?:[^"']+)["']/gi, label: 'Facebook Video' },
    { regex: /<meta[^>]+content=["'](https?:[^"']+)["'][^>]+property=["']og:video["']/gi, label: 'Facebook Video' },
    { regex: /(https?:\\\/\\\/video[^"'\s<>\\]+\.mp4[^"'\s<>\\]*)/gi, label: 'Facebook CDN' },
    { regex: /(https?:\/\/video[^"'\s<>\\]+\.mp4[^"'\s<>\\]*)/gi, label: 'Facebook CDN' },
  ];

  for (const item of fbPatterns) {
    const matches = html.matchAll(item.regex);
    for (const match of matches) {
      if (match && match[1]) {
        const clean = unescapeUrl(match[1]);
        // Evitar pistas de solo audio (en DASH de Facebook las pistas de audio suelen contener /v/t42.1790-2/ o mime=audio o efg con audio)
        if (isValidDirectVideoCandidate(clean) && !/mime=audio|audio_only/i.test(clean)) {
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
    combined.match(/\/stories\/(?:[^/?#]+\/)?(\d{8,25})/i) ||
    combined.match(/media_id=(\d{8,25})/i) ||
    combined.match(/\/reel\/(\d{8,25})/i) ||
    combined.match(/\/videos\/(?:[^/?#]+\/)?(\d{8,25})/i) ||
    combined.match(/[?&]v=(\d{8,25})/i) ||
    combined.match(/story_fbid=(\d{8,25})/i) ||
    combined.match(/"video_id"\s*:\s*"?(\d{8,25})"?/i);

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

/**
 * Extractor auxiliar vía FDown para videos, reels e historias públicas de Facebook
 */
async function resolveFacebookViaFDown(url, signal) {
  const formBody = `URLz=${encodeURIComponent(url)}`;
  const res = await fetch('https://fdown.net/download.php', {
    method: 'POST',
    headers: {
      'User-Agent': DESKTOP_USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://fdown.net',
      Referer: 'https://fdown.net/',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    body: formBody,
    signal,
  });
  if (!res.ok) throw new Error('FDown no disponible');
  const html = await res.text();
  const hdMatch =
    html.match(/id=["']hdlink["'][^>]+href=["'](https?:[^"']+)["']/i) ||
    html.match(/href=["'](https?:[^"']+)["'][^>]+id=["']hdlink["']/i);
  const sdMatch =
    html.match(/id=["']sdlink["'][^>]+href=["'](https?:[^"']+)["']/i) ||
    html.match(/href=["'](https?:[^"']+)["'][^>]+id=["']sdlink["']/i);
  const chosen = (hdMatch && hdMatch[1]) || (sdMatch && sdMatch[1]);
  if (chosen) {
    return {
      downloadUrl: unescapeUrl(chosen),
      title: 'facebook_video',
      source: hdMatch ? 'Facebook HD' : 'Facebook SD',
    };
  }
  throw new Error('Sin enlaces en FDown');
}

async function resolveFacebook(url, signal) {
  let targetUrl = normalizeFacebookUrl(url);
  const isStoryUrl = /\/stories\/|story_fbid=/i.test(targetUrl);
  const initialInfo = extractCanonicalAndVideoIdFromFacebook(targetUrl, '');
  let discoveredVideoId = initialInfo.videoId;
  let discoveredCanonical = initialInfo.canonicalUrl;

  const isShareOrShortLink = /\/share\/|fb\.watch|\/l\.php/i.test(targetUrl);

  // Etapa 1: Si es un enlace corto (/share/v/, /share/r/, /share/s/, fb.watch), desenvolverlo primero
  if (isShareOrShortLink) {
    try {
      const crawlerPage = await fetchCleanHtmlPage(targetUrl, FB_CRAWLER_USER_AGENT, signal);
      const foundCrawler = extractFacebookVideoFromHtml(crawlerPage.html);
      if (foundCrawler) return foundCrawler;

      const infoCrawler = extractCanonicalAndVideoIdFromFacebook(crawlerPage.finalUrl, crawlerPage.html);
      if (infoCrawler.videoId) discoveredVideoId = infoCrawler.videoId;
      if (infoCrawler.canonicalUrl) discoveredCanonical = infoCrawler.canonicalUrl;
      if (crawlerPage.finalUrl && crawlerPage.finalUrl !== targetUrl && !crawlerPage.finalUrl.includes('/login')) {
        targetUrl = normalizeFacebookUrl(crawlerPage.finalUrl);
      }
    } catch (e) {
      if (signal?.aborted || e?.message === 'CANCELLED') throw new Error('CANCELLED');
    }
  }

  // Etapa 2: Consultar con navegador Chrome de Escritorio (incluye cookies guardadas si el usuario ya inició sesión)
  const urlForDesktop = discoveredCanonical || targetUrl;
  try {
    const desktopPage = await fetchCleanHtmlPage(urlForDesktop, DESKTOP_USER_AGENT, signal);
    const foundDesktop = extractFacebookVideoFromHtml(desktopPage.html);
    if (foundDesktop) return foundDesktop;

    const infoDesktop = extractCanonicalAndVideoIdFromFacebook(desktopPage.finalUrl, desktopPage.html);
    if (!discoveredVideoId && infoDesktop.videoId) discoveredVideoId = infoDesktop.videoId;
    if (!discoveredCanonical && infoDesktop.canonicalUrl) discoveredCanonical = infoDesktop.canonicalUrl;
  } catch (e) {
    if (signal?.aborted || e?.message === 'CANCELLED') throw new Error('CANCELLED');
  }

  // Etapa 2B: Consultar con el User-Agent Crawler y mbasic.facebook.com (muy efectivo para historias y videos móviles)
  for (const candidateVariant of [
    { u: targetUrl, ua: FB_CRAWLER_USER_AGENT },
    { u: targetUrl.replace('://www.facebook.com/', '://mbasic.facebook.com/'), ua: USER_AGENT },
  ]) {
    if (signal?.aborted) throw new Error('CANCELLED');
    try {
      const page = await fetchCleanHtmlPage(candidateVariant.u, candidateVariant.ua, signal);
      const found = extractFacebookVideoFromHtml(page.html);
      if (found) return found;
      const info = extractCanonicalAndVideoIdFromFacebook(page.finalUrl, page.html);
      if (!discoveredVideoId && info.videoId) discoveredVideoId = info.videoId;
      if (!discoveredCanonical && info.canonicalUrl) discoveredCanonical = info.canonicalUrl;
    } catch (e) {
      if (signal?.aborted || e?.message === 'CANCELLED') throw new Error('CANCELLED');
    }
  }

  // Etapa 3: Si descubrimos el ID numérico del video/reel/historia, consultar directamente /watch/?v={id} y /reel/{id}
  if (discoveredVideoId) {
    for (const directUrl of [
      `https://www.facebook.com/watch/?v=${discoveredVideoId}`,
      `https://www.facebook.com/reel/${discoveredVideoId}/`,
      `https://mbasic.facebook.com/watch/?v=${discoveredVideoId}`,
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

  // Etapa 4: Reproductor Embed Oficial de Facebook (plugins/video.php)
  const urlsToTryInEmbed = [];
  if (discoveredCanonical) urlsToTryInEmbed.push(discoveredCanonical);
  if (targetUrl && !urlsToTryInEmbed.includes(targetUrl)) urlsToTryInEmbed.push(targetUrl);
  if (discoveredVideoId) {
    const watchCandidate = `https://www.facebook.com/watch/?v=${discoveredVideoId}`;
    const reelCandidate = `https://www.facebook.com/reel/${discoveredVideoId}/`;
    if (!urlsToTryInEmbed.includes(watchCandidate)) urlsToTryInEmbed.push(watchCandidate);
    if (!urlsToTryInEmbed.includes(reelCandidate)) urlsToTryInEmbed.push(reelCandidate);
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

  // Etapa 5: Extractor externo FDown
  for (const fdownCandidate of [discoveredCanonical || targetUrl, url]) {
    if (!fdownCandidate) continue;
    if (signal?.aborted) throw new Error('CANCELLED');
    try {
      const foundFdown = await resolveFacebookViaFDown(fdownCandidate, signal);
      if (foundFdown) return foundFdown;
    } catch (e) {
      if (signal?.aborted) throw new Error('CANCELLED');
    }
  }

  // Etapa 6: Sniffer WebView Nativo silencioso en 2do plano (ejecuta el JS de Facebook e intercepta el MP4)
  if (NativeModules?.VideoEngineModule?.sniffVideoWithWebViewNative) {
    try {
      const sniffed = await NativeModules.VideoEngineModule.sniffVideoWithWebViewNative(
        discoveredCanonical || targetUrl,
        false
      );
      if (sniffed && sniffed.downloadUrl) {
        return {
          downloadUrl: sniffed.downloadUrl,
          cookies: sniffed.cookies || '',
          userAgent: sniffed.userAgent || DESKTOP_USER_AGENT,
          title: isStoryUrl ? 'facebook_historia' : 'facebook_video',
          source: 'Facebook WebView',
        };
      }
    } catch (_e) {
      if (signal?.aborted) throw new Error('CANCELLED');
    }
  }

  throw new Error(
    isStoryUrl
      ? 'Esta historia de Facebook es privada o requiere sesión. Toca "Capturar Historia con Sesión" abajo para iniciar sesión una sola vez y descargarla.'
      : 'No se encontró un flujo de video público en este enlace de Facebook'
  );
}

/**
 * 5B. Extractor especializado de múltiples capas para Instagram (Reels, Share /share/reel/, /share/p/, Historias y Publicaciones)
 */
function extractInstagramShortcode(rawUrl, html = '') {
  const combined = `${rawUrl || ''} ${(html || '').slice(0, 80000)}`;
  const m =
    combined.match(/instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,25})/i) ||
    combined.match(/"shortcode"\s*:\s*"([A-Za-z0-9_-]{5,25})"/i) ||
    combined.match(/\\"shortcode\\"\s*:\s*\\"([A-Za-z0-9_-]{5,25})\\"/i);
  return m && m[1] ? m[1] : null;
}

function extractInstagramVideoFromHtml(html, defaultTitle = 'instagram_video', defaultSource = 'Instagram HD') {
  if (!html || typeof html !== 'string') return null;

  const igPatterns = [
    {
      regex: /"video_versions"\s*:\s*\[\s*\{[^}]*?"url"\s*:\s*"(https?:[^"]+)"/gi,
      label: 'Instagram HD',
    },
    {
      regex: /\\+"video_versions\\+"\s*:\s*\[\s*\{[^}]*?\\+"url\\+"\s*:\s*\\+"(https?:[^"'\s<>]+?)\\+"/gi,
      label: 'Instagram HD',
    },
    {
      regex: /"video_url"\s*:\s*"(https?:[^"]+)"/gi,
      label: 'Instagram HD',
    },
    {
      regex: /\\+"video_url\\+"\s*:\s*\\+"(https?:[^"'\s<>]+?)\\+"/gi,
      label: 'Instagram Embed HD',
    },
    {
      regex: /"contentUrl"\s*:\s*"(https?:[^"]+)"/gi,
      label: 'Instagram Video',
    },
    {
      regex: /<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["'](https?:[^"']+)["']/gi,
      label: 'Instagram OpenGraph',
    },
    {
      regex: /<meta[^>]+content=["'](https?:[^"']+)["'][^>]+property=["']og:video(?::secure_url)?["']/gi,
      label: 'Instagram OpenGraph',
    },
    {
      regex: /<video[^>]+src=["'](https?:[^"']+)["']/gi,
      label: 'Instagram Player',
    },
    {
      regex: /(https?:(?:\\\\\/\\\\\/|\\\/\\\/|\/\/)[^"'\s<>\\]+(?:cdninstagram\.com|fbcdn\.net)[^"'\s<>\\]+\.mp4[^"'\s<>\\]*)/gi,
      label: 'Instagram CDN',
    },
  ];

  for (const item of igPatterns) {
    const matches = html.matchAll(item.regex);
    for (const match of matches) {
      if (match && match[1]) {
        const clean = unescapeUrl(match[1]);
        if (
          clean.startsWith('http') &&
          !clean.startsWith('blob:') &&
          !/\.(?:jpg|jpeg|png|webp|gif|svg|js|css)(?:\?|#|$)/i.test(clean) &&
          !/mime=audio|audio_only|\/m69\/|\/m366\/|\/t42\.1790-2\//i.test(clean) &&
          !clean.includes('static.cdninstagram.com')
        ) {
          return {
            downloadUrl: clean,
            title: defaultTitle,
            source: item.label || defaultSource,
          };
        }
      }
    }
  }
  return null;
}

async function resolveInstagramViaGraphQL(shortcode, signal) {
  const docIds = ['8845758582119845', '10015901848480474', '7153631108069371'];
  for (const docId of docIds) {
    if (signal?.aborted) throw new Error('CANCELLED');
    try {
      const variables = JSON.stringify({
        shortcode,
        fetch_tagged_user_count: null,
        hoisted_comment_id: null,
        hoisted_reply_id: null,
      });
      const formBody =
        `av=0&__d=www&__user=0&__a=1&__req=1&lsd=AVqbxe3J_YA&fb_api_caller_class=RelayModern` +
        `&fb_api_req_friendly_name=PolarisPostActionLoadPostQueryQuery` +
        `&variables=${encodeURIComponent(variables)}&server_timestamps=true&doc_id=${docId}`;

      for (const endpoint of ['https://www.instagram.com/graphql/query', 'https://www.instagram.com/api/graphql']) {
        if (signal?.aborted) throw new Error('CANCELLED');
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'User-Agent': DESKTOP_USER_AGENT,
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-IG-App-ID': '936619743392459',
              'X-FB-LSD': 'AVqbxe3J_YA',
              'X-ASBD-ID': '129477',
              'Sec-Fetch-Site': 'same-origin',
              Origin: 'https://www.instagram.com',
              Referer: `https://www.instagram.com/reel/${shortcode}/`,
              Accept: '*/*',
            },
            body: formBody,
            signal,
          });
          if (res.ok) {
            const text = await res.text();
            const found = extractInstagramVideoFromHtml(text, `instagram_${shortcode}`, 'Instagram GraphQL HD');
            if (found) return found;
          }
        } catch (_innerErr) {
          if (signal?.aborted) throw new Error('CANCELLED');
        }
      }
    } catch (_e) {
      if (signal?.aborted) throw new Error('CANCELLED');
    }
  }
  return null;
}

async function resolveInstagram(url, signal) {
  let cleanUrl = url.trim().replace(/^https?:\/\/instagr\.am\//i, 'https://www.instagram.com/');
  const isStory = /\/stories\//i.test(cleanUrl);
  let shortcode = extractInstagramShortcode(cleanUrl);

  // Etapa 0: Si es un enlace corto (/share/reel/..., /share/p/..., /share/...) o no tiene shortcode visible, desenvolverlo primero
  if (!shortcode || /\/share\//i.test(cleanUrl)) {
    for (const ua of [FB_CRAWLER_USER_AGENT, DESKTOP_USER_AGENT]) {
      if (signal?.aborted) throw new Error('CANCELLED');
      try {
        const unwrapped = await fetchCleanHtmlPage(cleanUrl, ua, signal);
        const directFromUnwrap = extractInstagramVideoFromHtml(
          unwrapped.html,
          shortcode ? `instagram_${shortcode}` : 'instagram_video'
        );
        if (directFromUnwrap) return directFromUnwrap;

        const discoveredSc = extractInstagramShortcode(unwrapped.finalUrl, unwrapped.html);
        if (discoveredSc) {
          shortcode = discoveredSc;
          cleanUrl = `https://www.instagram.com/reel/${discoveredSc}/`;
          break;
        }
        if (unwrapped.finalUrl && unwrapped.finalUrl.startsWith('http') && !unwrapped.finalUrl.includes('/login')) {
          cleanUrl = unwrapped.finalUrl;
        }
      } catch (_e) {
        if (signal?.aborted) throw new Error('CANCELLED');
      }
    }
  }

  if (shortcode) {
    // Etapa 1: Endpoint oficial /embed/captioned/ de Instagram (soporta JSON simple y doblemente escapado en contextJSON)
    for (const embedUrl of [
      `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
      `https://www.instagram.com/reel/${shortcode}/embed/captioned/`,
      `https://www.instagram.com/p/${shortcode}/embed/`,
    ]) {
      if (signal?.aborted) throw new Error('CANCELLED');
      try {
        const embedPage = await fetchCleanHtmlPage(embedUrl, DESKTOP_USER_AGENT, signal);
        const foundEmbed = extractInstagramVideoFromHtml(
          embedPage.html,
          `instagram_${shortcode}`,
          'Instagram Embed HD'
        );
        if (foundEmbed) return foundEmbed;
      } catch (_e) {
        if (signal?.aborted) throw new Error('CANCELLED');
      }
    }

    // Etapa 2: API GraphQL pública de Instagram (funciona incluso cuando el autor desactiva el embed)
    const foundGql = await resolveInstagramViaGraphQL(shortcode, signal);
    if (foundGql) return foundGql;

    // Etapa 3: Proxies OpenGraph directos (ddinstagram / kkinstagram / eeinstagram) con User-Agent de Bot de Telegram
    const telegramBotUA = 'TelegramBot (like TwitterBot)';
    for (const proxyDomain of ['https://www.ddinstagram.com', 'https://kkinstagram.com', 'https://eeinstagram.com']) {
      if (signal?.aborted) throw new Error('CANCELLED');
      try {
        const page = await fetchCleanHtmlPage(`${proxyDomain}/reel/${shortcode}/`, telegramBotUA, signal);
        const foundProxy = extractInstagramVideoFromHtml(page.html, `instagram_${shortcode}`, 'Instagram HD');
        if (foundProxy) return foundProxy;
      } catch (_e) {
        if (signal?.aborted) throw new Error('CANCELLED');
      }
    }
  }

  // Etapa 4: Consultar página directa con cookies nativas guardadas (ideal para Reels y para Historias si ya inició sesión)
  for (const ua of [DESKTOP_USER_AGENT, FB_CRAWLER_USER_AGENT]) {
    if (signal?.aborted) throw new Error('CANCELLED');
    try {
      const directPage = await fetchCleanHtmlPage(cleanUrl, ua, signal);
      const foundDirect = extractInstagramVideoFromHtml(
        directPage.html,
        isStory ? 'instagram_historia' : shortcode ? `instagram_${shortcode}` : 'instagram_video',
        'Instagram Directo'
      );
      if (foundDirect) return foundDirect;
    } catch (_e) {
      if (signal?.aborted) throw new Error('CANCELLED');
    }
  }

  // Etapa 5: Sniffer WebView Nativo silencioso (ejecuta el JS de Instagram / Embed y extrae video_versions o stream completo)
  if (NativeModules?.VideoEngineModule?.sniffVideoWithWebViewNative) {
    const webViewTargets = shortcode
      ? [`https://www.instagram.com/p/${shortcode}/embed/captioned/`, `https://www.instagram.com/reel/${shortcode}/`]
      : [cleanUrl];
    for (const targetCandidate of webViewTargets) {
      if (signal?.aborted) throw new Error('CANCELLED');
      try {
        const sniffed = await NativeModules.VideoEngineModule.sniffVideoWithWebViewNative(targetCandidate, false);
        if (sniffed && sniffed.downloadUrl) {
          return {
            downloadUrl: unescapeUrl(sniffed.downloadUrl),
            cookies: sniffed.cookies || '',
            userAgent: sniffed.userAgent || USER_AGENT,
            title: isStory ? 'instagram_historia' : shortcode ? `instagram_${shortcode}` : 'instagram_video',
            source: 'Instagram WebView',
          };
        }
      } catch (_e) {
        if (signal?.aborted) throw new Error('CANCELLED');
      }
    }
  }

  throw new Error(
    isStory
      ? 'Las historias de Instagram requieren sesión activa. Toca "Capturar Historia con Sesión" abajo para descargarla.'
      : 'No se pudo extraer el video de Instagram automáticamente'
  );
}

/**
 * 5C. Extractor directo para YouTube y YouTube Shorts (vía Innertube Player API)
 */
async function resolveYouTube(url, signal) {
  const idMatch =
    url.match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i) ||
    url.match(/[?&]v=([A-Za-z0-9_-]{11})/i);
  if (!idMatch || !idMatch[1]) {
    throw new Error('No se encontró un ID de video de YouTube válido');
  }
  const videoId = idMatch[1];

  const clients = [
    {
      name: 'ANDROID_VR',
      context: {
        client: {
          clientName: 'ANDROID_VR',
          clientVersion: '1.60.19',
          androidSdkVersion: 34,
          osName: 'Android',
          osVersion: '14',
          hl: 'es',
          gl: 'MX',
        },
      },
      ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 14; en_US; Quest 3; Build/UP1A.231005.007.A1; Cronet/132.0.6808.3)',
    },
    {
      name: 'IOS',
      context: {
        client: {
          clientName: 'IOS',
          clientVersion: '19.45.4',
          deviceMake: 'Apple',
          deviceModel: 'iPhone16,2',
          osName: 'iPhone',
          osVersion: '18.1.0.22B83',
          hl: 'es',
          gl: 'MX',
        },
      },
      ua: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)',
    },
  ];

  for (const c of clients) {
    if (signal?.aborted) throw new Error('CANCELLED');
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': c.ua,
          'X-YouTube-Client-Name': c.name === 'IOS' ? '5' : '28',
          'X-YouTube-Client-Version': c.context.client.clientVersion,
        },
        body: JSON.stringify({
          videoId,
          context: c.context,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
        signal,
      });
      if (!res.ok) continue;
      const data = await res.json();
      const formats = data?.streamingData?.formats || [];
      const adaptive = data?.streamingData?.adaptiveFormats || [];
      // Preferir formatos muxed (con audio y video en MP4) ordenados por mayor resolución
      const muxedMp4 = formats
        .filter((f) => f.url && /video\/mp4/i.test(f.mimeType || ''))
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      if (muxedMp4.length > 0) {
        return {
          downloadUrl: muxedMp4[0].url,
          title: data?.videoDetails?.title || `youtube_${videoId}`,
          userAgent: c.ua,
          source: `YouTube ${muxedMp4[0].qualityLabel || 'MP4'}`,
        };
      }
      const adaptiveMp4 = adaptive
        .filter((f) => f.url && /video\/mp4/i.test(f.mimeType || ''))
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      if (adaptiveMp4.length > 0) {
        return {
          downloadUrl: adaptiveMp4[0].url,
          title: data?.videoDetails?.title || `youtube_${videoId}`,
          userAgent: c.ua,
          source: 'YouTube Video',
        };
      }
    } catch (_e) {
      if (signal?.aborted) throw new Error('CANCELLED');
    }
  }

  throw new Error('No se pudo extraer stream directo de YouTube');
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
      if (isValidDirectVideoCandidate(candidate)) {
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
  async resolveVideoUrl(rawInput, signal, { interactive = false } = {}) {
    const url = extractUrlFromText(rawInput);
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new Error('Por favor ingresa un enlace válido que comience con http:// o https://');
    }

    const platform = detectPlatform(url);

    // Si el usuario solicitó captura interactiva con sesión (para Historias de Facebook/Instagram o sitios con login)
    if (interactive && NativeModules?.VideoEngineModule?.sniffVideoWithWebViewNative) {
      const sniffed = await NativeModules.VideoEngineModule.sniffVideoWithWebViewNative(url, true);
      if (sniffed && sniffed.downloadUrl) {
        return {
          downloadUrl: sniffed.downloadUrl,
          cookies: sniffed.cookies || '',
          userAgent: sniffed.userAgent || USER_AGENT,
          title: `${platform.id}_historia`,
          platform,
          source: `${platform.name} (Sesión)`,
        };
      }
      throw new Error('No se detectó video en la ventana interactiva.');
    }

    if (platform.id === 'direct') {
      return {
        downloadUrl: url,
        title: url.split('/').pop().split('?')[0] || 'video.mp4',
        platform,
        source: 'Enlace Directo',
      };
    }

    let specificError = null;

    if (platform.id === 'facebook') {
      try {
        const res = await resolveFacebook(url, signal);
        return { ...res, platform };
      } catch (e) {
        if (signal?.aborted || e?.message === 'CANCELLED') throw new Error('CANCELLED');
        specificError = e?.message;
      }
    }

    if (platform.id === 'instagram') {
      try {
        const res = await resolveInstagram(url, signal);
        return { ...res, platform };
      } catch (e) {
        if (signal?.aborted || e?.message === 'CANCELLED') throw new Error('CANCELLED');
        specificError = e?.message;
      }
    }

    if (platform.id === 'youtube') {
      try {
        const res = await resolveYouTube(url, signal);
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

    // Respaldo universal: Sniffer WebView Nativo silencioso para cualquier sitio web
    if (
      platform.id !== 'facebook' &&
      platform.id !== 'instagram' &&
      NativeModules?.VideoEngineModule?.sniffVideoWithWebViewNative
    ) {
      try {
        const sniffed = await NativeModules.VideoEngineModule.sniffVideoWithWebViewNative(url, false);
        if (sniffed && sniffed.downloadUrl) {
          return {
            downloadUrl: sniffed.downloadUrl,
            cookies: sniffed.cookies || '',
            userAgent: sniffed.userAgent || DESKTOP_USER_AGENT,
            title: `${platform.id}_video`,
            platform,
            source: 'Extractor Web Nativo',
          };
        }
      } catch (_e) {
        if (signal?.aborted) throw new Error('CANCELLED');
      }
    }

    throw new Error(
      specificError ||
        'No se pudo extraer el video automáticamente. Si es una historia privada, usa el botón "Capturar Historia con Sesión".'
    );
  },

  /**
   * Descarga el video desde su URL con soporte completo para PAUSAR, REANUDAR y CANCELAR.
   */
  async downloadVideoFromUrl(rawInput, { onStatus, onProgress, onController, interactive = false } = {}) {
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

    if (onStatus) {
      onStatus(
        interactive
          ? 'Abriendo extractor con sesión…'
          : 'Analizando enlace y buscando video…'
      );
    }

    const resolved = await videoDownloadService.resolveVideoUrl(rawInput, abortController.signal, {
      interactive,
    });
    if (isCancelled) throw new Error('CANCELLED');

    // Si el usuario pausó mientras se analizaba el enlace, esperar aquí antes de iniciar la descarga
    if (isPaused && pauseWaitPromise) {
      if (onStatus) onStatus('En pausa…');
      await pauseWaitPromise;
      if (isCancelled) throw new Error('CANCELLED');
    }

    const { downloadUrl, title, platform, source, cookies, userAgent } = resolved;

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

    let cookieHeader = cookies || '';
    if (!cookieHeader && NativeModules?.VideoEngineModule?.getCookiesForUrlNative) {
      try {
        cookieHeader = (await NativeModules.VideoEngineModule.getCookiesForUrlNative(downloadUrl)) || '';
      } catch (_e) {}
    }

    const requestHeaders = {
      'User-Agent': userAgent || DESKTOP_USER_AGENT,
      Accept: '*/*',
    };
    if (cookieHeader) {
      requestHeaders.Cookie = cookieHeader;
    }

    downloadResumable = FileSystem.createDownloadResumable(
      downloadUrl,
      targetPath,
      {
        headers: requestHeaders,
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
