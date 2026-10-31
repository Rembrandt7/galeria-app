import React, { useState, useRef, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  ScrollView,
  SafeAreaView,
  StatusBar,
  Linking,
  Keyboard,
  Animated,
  PanResponder,
  Platform,
  NativeModules,
  Image,
  DeviceEventEmitter,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../constants/theme';
import {
  videoDownloadService,
  detectPlatform,
  extractUrlFromText,
  normalizeUrlForDuplicateCheck,
  DOWNLOAD_ALBUM_NAME,
  DOWNLOAD_FOLDER_URI,
} from '../services/videoDownloadService';
import {
  folderService,
  BOVEDA_PRIVADA_FOLDER_NAME,
  BOVEDA_PRIVADA_FOLDER_URI,
} from '../services/folderService';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${mb.toFixed(1)} MB`;
}

export default function VideoDownloaderModal({
  visible,
  onClose,
  onReopen,
  onVideoDownloaded,
  onOpenDownloadedFolder,
  onPlayDownloadedAsset,
  initialSharedUrl,
  onClearSharedUrl,
  onOpenBrowser,
  lastBrowserUrl,
}) {
  const [urlInput, setUrlInput] = useState('');
  const [downloadItems, setDownloadItems] = useState([]);
  const [filterStatus, setFilterStatus] = useState('all'); // 'all' | 'active' | 'completed' | 'error'
  const [floatingDismissed, setFloatingDismissed] = useState(false);
  const [floatingExpandedFilter, setFloatingExpandedFilter] = useState(null); // null | 'completed' | 'error'
  const [saveToVault, setSaveToVault] = useState(false);

  // Controladores activos por ID de descarga para pausar/reanudar/cancelar individualmente
  const controllersMapRef = useRef({});
  const loadedFromStorageRef = useRef(false);

  // Posición arrastrable del panel flotante cuando el modal está minimizado
  const floatPan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const floatOffsetRef = useRef({ x: 0, y: 0 });

  const floatingPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gesture) =>
        Math.abs(gesture.dx) > 6 || Math.abs(gesture.dy) > 6,
      onPanResponderMove: (_, gesture) => {
        floatPan.setValue({
          x: floatOffsetRef.current.x + gesture.dx,
          y: floatOffsetRef.current.y + gesture.dy,
        });
      },
      onPanResponderRelease: (_, gesture) => {
        floatOffsetRef.current = {
          x: floatOffsetRef.current.x + gesture.dx,
          y: floatOffsetRef.current.y + gesture.dy,
        };
      },
    })
  ).current;

  // Cargar historial previo de la hilera de descargas y asegurar carpeta "Videos Descargados"
  useEffect(() => {
    (async () => {
      const stored = await videoDownloadService.getStoredDownloadItems();
      if (stored && stored.length > 0) {
        setDownloadItems(stored);
      }
      loadedFromStorageRef.current = true;
    })();
  }, []);

  // Asegurar que la carpeta propia "Videos Descargados" esté creada cuando se abre el descargador
  useEffect(() => {
    if (visible) {
      setFloatingDismissed(false);
      folderService.ensureDownloadedVideosFolder().catch(() => {});
    }
  }, [visible]);

  // Guardar cambios de la hilera en almacenamiento local y sincronizar enlaces y contadores (🟢 / 🔴) con el navegador nativo
  useEffect(() => {
    if (!loadedFromStorageRef.current) return;
    videoDownloadService.saveStoredDownloadItems(downloadItems);
    try {
      const completedUrls = downloadItems
        .filter((it) => it && it.url && (it.status === 'completed' || it.status === 'downloading'))
        .map((it) => it.url);
      if (NativeModules?.VideoEngineModule?.syncDownloadedUrlsNative) {
        NativeModules.VideoEngineModule.syncDownloadedUrlsNative(completedUrls).catch(() => {});
      }
      if (NativeModules?.VideoEngineModule?.syncBrowserDownloadsSummaryNative) {
        const compCount = downloadItems.filter((it) => it?.status === 'completed').length;
        const errCount = downloadItems.filter((it) => it?.status === 'error' || it?.status === 'cancelled').length;
        const actCount = downloadItems.filter((it) => it?.status === 'downloading' || it?.status === 'paused').length;
        const summaryList = downloadItems.slice(0, 25).map((it) => ({
          id: it.id,
          url: it.url || '',
          title: it.title || it.filename || 'Video',
          status: it.status,
          mediaType: it.mediaType || it.asset?.mediaType || 'video',
          localUri: it.asset?.uri || '',
          errorMessage: it.errorMessage || '',
        }));
        NativeModules.VideoEngineModule
          .syncBrowserDownloadsSummaryNative(compCount, errCount, actCount, JSON.stringify(summaryList))
          .catch(() => {});
      }
    } catch (_e) {}
  }, [downloadItems]);

  const extractedUrl = extractUrlFromText(urlInput);
  const detectedPlatform = extractedUrl ? detectPlatform(extractedUrl) : null;

  // Actualizar un elemento específico de la hilera por su id
  const updateItemById = (id, updater) => {
    setDownloadItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const patch = typeof updater === 'function' ? updater(item) : updater;
        return { ...item, ...patch };
      })
    );
  };

  // Ejecutar la descarga de una fila en la hilera
  const startDownloadForItem = async (
    itemId,
    cleanUrl,
    platformInfo,
    interactive = false,
    extraOpts = {}
  ) => {
    const {
      mediaType = null,
      thumbnailUrl = null,
      cookies = null,
      userAgent = null,
      fromBrowserBackground = false,
    } = extraOpts;

    setFloatingDismissed(false);
    updateItemById(itemId, {
      status: 'downloading',
      statusText: interactive
        ? 'Abriendo ventana con sesión para capturar historia/video…'
        : mediaType === 'photo'
        ? 'Descargando foto en 2do plano…'
        : 'Analizando enlace y preparando descarga…',
      percent: 0.04,
      writtenBytes: 0,
      totalBytes: 0,
      errorMessage: null,
    });

    try {
      const result = await videoDownloadService.downloadVideoFromUrl(cleanUrl, {
        interactive,
        mediaType,
        thumbnailUrl,
        cookies,
        userAgent,
        onStatus: (msg) => {
          updateItemById(itemId, { statusText: msg });
        },
        onProgress: (prog) => {
          updateItemById(itemId, {
            percent: prog.percent > 0 ? prog.percent : 0.1,
            writtenBytes: prog.writtenBytes || 0,
            totalBytes: prog.totalBytes || 0,
          });
        },
        onController: (ctrl) => {
          controllersMapRef.current[itemId] = ctrl;
        },
      });

      delete controllersMapRef.current[itemId];

      if (result && result.success) {
        let finalAlbumName = result.albumName || DOWNLOAD_ALBUM_NAME;
        let finalFolderUri = result.folderUri || DOWNLOAD_FOLDER_URI;
        let finalAsset = result.asset || null;

        if (saveToVault && finalAsset?.uri) {
          try {
            const vaultUri = await folderService.ensureBovedaPrivadaFolder();
            await folderService.moveAssetsToFolder(
              [finalAsset],
              vaultUri || BOVEDA_PRIVADA_FOLDER_URI,
              ''
            );
            finalAlbumName = BOVEDA_PRIVADA_FOLDER_NAME;
            finalFolderUri = vaultUri || BOVEDA_PRIVADA_FOLDER_URI;
            const fname = result.filename || finalAsset.filename || 'video.mp4';
            finalAsset = {
              ...finalAsset,
              uri: `${finalFolderUri}/${fname}`,
            };
          } catch (_eVault) {}
        }

        const resolvedThumb =
          finalAsset?.uri || result.thumbnail || thumbnailUrl || null;
        const resolvedMediaType =
          result.mediaType || finalAsset?.mediaType || mediaType || 'video';

        updateItemById(itemId, {
          status: 'completed',
          statusText: `Guardado en carpeta "${finalAlbumName}"`,
          percent: 1,
          filename: result.filename,
          title: result.title || result.filename,
          platform: result.platform || platformInfo,
          mediaType: resolvedMediaType,
          thumbnail: resolvedThumb,
          sizeBytes: result.sizeBytes || 0,
          albumName: finalAlbumName,
          folderUri: finalFolderUri,
          asset: finalAsset,
          errorMessage: null,
          date: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });

        if (fromBrowserBackground && NativeModules?.VideoEngineModule?.notifyBrowserDownloadStatusNative) {
          const tipoTxt = resolvedMediaType === 'photo' ? 'Foto guardada' : 'Video guardado';
          NativeModules.VideoEngineModule
            .notifyBrowserDownloadStatusNative(
              `✅ ¡${tipoTxt} en 2do plano en "${finalAlbumName}"!`,
              '#065F46'
            )
            .catch(() => {});
        }

        if (onVideoDownloaded) {
          onVideoDownloaded(result);
        }
      }
    } catch (err) {
      delete controllersMapRef.current[itemId];
      if (err?.message === 'CANCELLED') {
        updateItemById(itemId, {
          status: 'cancelled',
          statusText: 'Descarga cancelada por el usuario',
          percent: 0,
        });
      } else {
        const msg =
          err?.message || 'No se pudo descargar el archivo desde este enlace.';
        updateItemById(itemId, {
          status: 'error',
          statusText: 'Error en la descarga',
          errorMessage: msg,
        });
        if (fromBrowserBackground && NativeModules?.VideoEngineModule?.notifyBrowserDownloadStatusNative) {
          NativeModules.VideoEngineModule
            .notifyBrowserDownloadStatusNative(`❌ Error al descargar: ${msg}`, '#991B1B')
            .catch(() => {});
        }
      }
    }
  };

  const executeEnqueueUrls = (urlsToProcess, interactive = false, extraOpts = {}) => {
    const {
      mediaType = null,
      thumbnailUrl = null,
      cookies = null,
      userAgent = null,
      fromBrowserBackground = false,
    } = extraOpts;

    if (!fromBrowserBackground) {
      Keyboard.dismiss();
    }
    const createdItems = [];

    urlsToProcess.forEach((cleanUrl, idx) => {
      const platformInfo = detectPlatform(cleanUrl);
      const isPhotoItem = mediaType === 'photo' || platformInfo?.isPhoto;
      const newId = `dl_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
      const shortUrlTitle = cleanUrl.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 42);

      const newItem = {
        id: newId,
        url: cleanUrl,
        title: `${platformInfo.name}: ${shortUrlTitle}`,
        filename: null,
        platform: platformInfo,
        mediaType: isPhotoItem ? 'photo' : 'video',
        thumbnail: thumbnailUrl || (isPhotoItem ? cleanUrl : null),
        status: 'downloading',
        statusText: interactive
          ? 'Abriendo captura con sesión…'
          : isPhotoItem
          ? 'En cola / Descargando foto…'
          : 'En cola / Iniciando descarga…',
        percent: 0.04,
        writtenBytes: 0,
        totalBytes: 0,
        sizeBytes: 0,
        albumName: saveToVault ? BOVEDA_PRIVADA_FOLDER_NAME : DOWNLOAD_ALBUM_NAME,
        folderUri: saveToVault ? BOVEDA_PRIVADA_FOLDER_URI : DOWNLOAD_FOLDER_URI,
        asset: null,
        errorMessage: null,
        date: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      createdItems.push({ newItem, platformInfo });
    });

    setDownloadItems((prev) => [...createdItems.map((c) => c.newItem), ...prev]);
    if (fromBrowserBackground && urlsToProcess[0]) {
      // Copiar el enlace en la caja del descargador para que quede listo y registrado
      setUrlInput(urlsToProcess[0]);
    } else {
      setUrlInput('');
    }
    setFilterStatus('all');

    createdItems.forEach(({ newItem, platformInfo }, idx) => {
      setTimeout(() => {
        startDownloadForItem(
          newItem.id,
          newItem.url,
          platformInfo,
          interactive && idx === 0,
          {
            mediaType: newItem.mediaType,
            thumbnailUrl: newItem.thumbnail,
            cookies,
            userAgent,
            fromBrowserBackground,
          }
        );
      }, idx * 450);
    });
  };

  const enqueueAndStartUrl = (rawText, interactive = false, extraOpts = {}) => {
    const allMatches = String(rawText || '').match(/https?:\/\/[^\s"'<>]+/gi) || [];
    const uniqueUrls = Array.from(new Set(allMatches.map((u) => u.trim()).filter(Boolean)));
    const firstFallback = extractUrlFromText(rawText);
    const urlsToProcess =
      uniqueUrls.length > 0
        ? uniqueUrls
        : firstFallback && /^https?:\/\//i.test(firstFallback)
        ? [firstFallback]
        : [];

    if (urlsToProcess.length === 0) {
      if (!extraOpts.fromBrowserBackground) {
        Alert.alert(
          'Enlace inválido',
          'Por favor pega o comparte uno o varios enlaces válidos de video o foto (que empiecen con http:// o https://).'
        );
      }
      return;
    }

    // Verificar si el enlace ya fue descargado previamente (en el navegador nativo ya se muestra el aviso antes de emitir)
    if (!extraOpts.fromBrowserBackground && !extraOpts.skipDuplicateCheck) {
      const existingSet = new Set(
        downloadItems
          .filter((it) => it && it.url && it.status === 'completed')
          .map((it) => normalizeUrlForDuplicateCheck(it.url))
          .filter(Boolean)
      );
      const hasDuplicate = urlsToProcess.some((u) => {
        const key = normalizeUrlForDuplicateCheck(u);
        return key && existingSet.has(key);
      });

      if (hasDuplicate) {
        Alert.alert(
          '⚠️ Archivo ya existente',
          'Este enlace ya lo descargaste anteriormente en tu galería.\n\n¿Deseas volver a descargarlo de todos modos?',
          [
            { text: 'Cancelar', style: 'cancel' },
            {
              text: 'Descargar de nuevo',
              onPress: () =>
                executeEnqueueUrls(urlsToProcess, interactive, {
                  ...extraOpts,
                  skipDuplicateCheck: true,
                }),
            },
          ]
        );
        return;
      }
    }

    executeEnqueueUrls(urlsToProcess, interactive, extraOpts);
  };

  // Escuchar descargas en 2do plano disparadas desde los botones flotantes (⬇ Foto / ⬇ Video) dentro del Navegador
  const enqueueBgRef = useRef(enqueueAndStartUrl);
  enqueueBgRef.current = enqueueAndStartUrl;

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('BrowserBackgroundDownload', (payload) => {
      if (!payload || !payload.url) return;
      enqueueBgRef.current(payload.url, false, {
        fromBrowserBackground: true,
        mediaType: payload.mediaType || null,
        thumbnailUrl: payload.thumbnailUrl || null,
        cookies: payload.cookies || null,
        userAgent: payload.userAgent || null,
      });
    });
    return () => {
      sub.remove();
    };
  }, []);

  // Si el usuario compartió un enlace desde otra app (Facebook, Instagram, TikTok, X, YouTube, etc.),
  // iniciar la descarga automáticamente en cuanto llega
  useEffect(() => {
    if (initialSharedUrl) {
      const cleanShared = extractUrlFromText(initialSharedUrl);
      if (onClearSharedUrl) onClearSharedUrl();
      if (cleanShared && /^https?:\/\//i.test(cleanShared)) {
        enqueueAndStartUrl(cleanShared, false);
      } else if (initialSharedUrl.trim()) {
        setUrlInput(initialSharedUrl.trim());
      }
    }
  }, [initialSharedUrl]);

  const handlePasteFromClipboard = async () => {
    try {
      if (NativeModules?.VideoEngineModule?.getClipboardTextNative) {
        const clip = await NativeModules.VideoEngineModule.getClipboardTextNative();
        if (clip && clip.trim()) {
          setUrlInput(clip.trim());
        } else {
          Alert.alert('Portapapeles vacío', 'Copia primero el enlace del video o compártelo directamente hacia Mi Galería.');
        }
      }
    } catch (_e) {}
  };

  // Agregar un nuevo video a la hilera de abajo y comenzar a descargarlo inmediatamente
  const handleAddAndStartDownload = () => {
    enqueueAndStartUrl(urlInput, false);
  };

  const handleAddAndStartInteractive = () => {
    enqueueAndStartUrl(urlInput, true);
  };

  // Pausar o Reanudar un elemento de la hilera
  const handleTogglePauseItem = async (item) => {
    const ctrl = controllersMapRef.current[item.id];
    if (!ctrl) return;
    if (item.status === 'paused') {
      updateItemById(item.id, {
        status: 'downloading',
        statusText: 'Reanudando descarga…',
      });
      await ctrl.resume();
    } else if (item.status === 'downloading') {
      updateItemById(item.id, {
        status: 'paused',
        statusText: 'En pausa — toca Reanudar para seguir',
      });
      await ctrl.pause();
    }
  };

  // Cancelar un elemento activo
  const handleCancelItem = async (item) => {
    const ctrl = controllersMapRef.current[item.id];
    if (ctrl) {
      await ctrl.cancel();
      delete controllersMapRef.current[item.id];
    }
    updateItemById(item.id, {
      status: 'cancelled',
      statusText: 'Descarga cancelada',
      percent: 0,
    });
  };

  // Reintentar un elemento con error o cancelado
  const handleRetryItem = (item) => {
    if (!item?.url) return;
    const platformInfo = item.platform || detectPlatform(item.url);
    startDownloadForItem(item.id, item.url, platformInfo, false);
  };

  // Capturar historia/video con sesión interactiva (Facebook/Instagram Stories privadas o con login)
  const handleRetryInteractiveItem = (item) => {
    if (!item?.url) return;
    const platformInfo = item.platform || detectPlatform(item.url);
    startDownloadForItem(item.id, item.url, platformInfo, true);
  };

  // Mover un elemento hacia arriba o hacia abajo en la hilera
  const handleMoveItem = (indexInFullList, direction) => {
    setDownloadItems((prev) => {
      const targetIndex = indexInFullList + direction;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const copy = [...prev];
      const temp = copy[indexInFullList];
      copy[indexInFullList] = copy[targetIndex];
      copy[targetIndex] = temp;
      return copy;
    });
  };

  // Quitar un elemento de la hilera
  const handleRemoveItem = async (item) => {
    if (item.status === 'downloading' || item.status === 'paused') {
      await handleCancelItem(item);
    }
    setDownloadItems((prev) => prev.filter((it) => it.id !== item.id));
  };

  // Limpiar completados o con error
  const handleClearFinished = () => {
    setDownloadItems((prev) =>
      prev.filter((it) => it.status === 'downloading' || it.status === 'paused')
    );
  };

  // Contadores para saber rápido cuáles se descargaron, cuáles están en curso y cuáles tienen error
  const activeItems = downloadItems.filter(
    (it) => it.status === 'downloading' || it.status === 'paused'
  );
  const completedItems = downloadItems.filter((it) => it.status === 'completed');
  const errorItems = downloadItems.filter(
    (it) => it.status === 'error' || it.status === 'cancelled'
  );

  const filteredItems = downloadItems.filter((it) => {
    if (filterStatus === 'active') {
      return it.status === 'downloading' || it.status === 'paused';
    }
    if (filterStatus === 'completed') {
      return it.status === 'completed';
    }
    if (filterStatus === 'error') {
      return it.status === 'error' || it.status === 'cancelled';
    }
    return true;
  });

  // Promedio de progreso de descargas activas para la barra flotante movible
  const avgActivePercent =
    activeItems.length > 0
      ? Math.round(
          (activeItems.reduce((acc, it) => acc + (it.percent || 0), 0) /
            activeItems.length) *
            100
        )
      : 0;

  // Si el modal está cerrado pero hay descargas activas, completadas o fallidas no descartadas,
  // mostrar la bolita/pestaña flotante con contadores en VERDE (descargados) y ROJO (fallidos) para verlos sin entrar a la pantalla completa
  if (!visible) {
    if (
      floatingDismissed ||
      (activeItems.length === 0 && completedItems.length === 0 && errorItems.length === 0)
    ) {
      return null;
    }

    const previewItems =
      floatingExpandedFilter === 'completed'
        ? completedItems.slice(0, 6)
        : floatingExpandedFilter === 'error'
        ? errorItems.slice(0, 6)
        : [];

    return (
      <Animated.View
        style={[
          styles.floatingMovableWidget,
          {
            flexDirection: 'column',
            alignItems: 'stretch',
            transform: [{ translateX: floatPan.x }, { translateY: floatPan.y }],
          },
        ]}
        {...floatingPanResponder.panHandlers}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={styles.floatingDragHandle}>
            <Ionicons name="move-outline" size={15} color="#94a3b8" />
          </View>

          <TouchableOpacity
            style={styles.floatingInfoCol}
            activeOpacity={0.85}
            onPress={() => {
              if (onReopen) onReopen();
            }}
          >
            <Text style={styles.floatingTitle} numberOfLines={1}>
              {activeItems.length > 0
                ? `⬇ Descargando (${activeItems.length}) • ${avgActivePercent}%`
                : '⬇ Descargas'}
            </Text>
            {activeItems.length > 0 && (
              <View style={styles.floatingProgressBg}>
                <View
                  style={[styles.floatingProgressFill, { width: `${avgActivePercent}%` }]}
                />
              </View>
            )}
          </TouchableOpacity>

          {/* Bolita Verde: Videos Descargados (toca para verlos sin abrir toda la pantalla) */}
          <TouchableOpacity
            onPress={() =>
              setFloatingExpandedFilter((prev) =>
                prev === 'completed' ? null : 'completed'
              )
            }
            style={{
              backgroundColor:
                floatingExpandedFilter === 'completed' ? '#059669' : 'rgba(16, 185, 129, 0.22)',
              borderWidth: 1.5,
              borderColor: '#10b981',
              borderRadius: 14,
              paddingHorizontal: 9,
              paddingVertical: 5,
            }}
            activeOpacity={0.8}
          >
            <Text style={{ color: '#a7f3d0', fontSize: 11.5, fontWeight: '900' }}>
              🟢 {completedItems.length}
            </Text>
          </TouchableOpacity>

          {/* Bolita Roja: Videos Fallidos (toca para verlos/reintentar sin abrir toda la pantalla) */}
          <TouchableOpacity
            onPress={() =>
              setFloatingExpandedFilter((prev) => (prev === 'error' ? null : 'error'))
            }
            style={{
              backgroundColor:
                floatingExpandedFilter === 'error' ? '#dc2626' : 'rgba(239, 68, 68, 0.22)',
              borderWidth: 1.5,
              borderColor: '#ef4444',
              borderRadius: 14,
              paddingHorizontal: 9,
              paddingVertical: 5,
            }}
            activeOpacity={0.8}
          >
            <Text style={{ color: '#fecaca', fontSize: 11.5, fontWeight: '900' }}>
              🔴 {errorItems.length}
            </Text>
          </TouchableOpacity>

          {onReopen && (
            <TouchableOpacity
              onPress={onReopen}
              style={styles.floatingOpenBtn}
              activeOpacity={0.8}
            >
              <Text style={styles.floatingOpenBtnText}>Ir</Text>
            </TouchableOpacity>
          )}

          {activeItems.length === 0 && (
            <TouchableOpacity
              onPress={() => {
                setFloatingExpandedFilter(null);
                setFloatingDismissed(true);
              }}
              style={styles.floatingCloseBtn}
            >
              <Ionicons name="close" size={16} color="#94a3b8" />
            </TouchableOpacity>
          )}
        </View>

        {/* Vista rápida emergente de videos descargados (🟢) o fallidos (🔴) sin entrar a la pantalla */}
        {floatingExpandedFilter && (
          <View
            style={{
              marginTop: 8,
              paddingTop: 8,
              borderTopWidth: 1,
              borderTopColor: 'rgba(255,255,255,0.12)',
              gap: 6,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Text
                style={{
                  color: floatingExpandedFilter === 'completed' ? '#6ee7b7' : '#fca5a5',
                  fontSize: 11.5,
                  fontWeight: '800',
                }}
              >
                {floatingExpandedFilter === 'completed'
                  ? `🟢 Descargados listos para ver (${completedItems.length})`
                  : `🔴 Descargas fallidas (${errorItems.length})`}
              </Text>
              <TouchableOpacity onPress={() => setFloatingExpandedFilter(null)}>
                <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '700' }}>
                  Ocultar ▲
                </Text>
              </TouchableOpacity>
            </View>

            {previewItems.length === 0 ? (
              <Text style={{ color: '#94a3b8', fontSize: 11, paddingVertical: 4 }}>
                {floatingExpandedFilter === 'completed'
                  ? 'Aún no hay videos descargados.'
                  : 'No hay descargas con error.'}
              </Text>
            ) : (
              previewItems.map((it) => (
                <View
                  key={it.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    backgroundColor: 'rgba(15, 23, 42, 0.85)',
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor:
                      floatingExpandedFilter === 'completed'
                        ? 'rgba(16, 185, 129, 0.35)'
                        : 'rgba(239, 68, 68, 0.35)',
                    gap: 8,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{ color: '#f8fafc', fontSize: 11.5, fontWeight: '700' }}
                      numberOfLines={1}
                    >
                      {it.title || it.filename || 'Video'}
                    </Text>
                    {floatingExpandedFilter === 'error' && it.errorMessage ? (
                      <Text
                        style={{ color: '#fca5a5', fontSize: 10 }}
                        numberOfLines={1}
                      >
                        {it.errorMessage}
                      </Text>
                    ) : null}
                  </View>

                  {floatingExpandedFilter === 'completed' && it.asset?.uri && onPlayDownloadedAsset ? (
                    <TouchableOpacity
                      onPress={() => onPlayDownloadedAsset(it.asset)}
                      style={{
                        backgroundColor: '#059669',
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                        borderRadius: 8,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <Ionicons name="play" size={12} color="#ffffff" />
                      <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '800' }}>
                        Ver
                      </Text>
                    </TouchableOpacity>
                  ) : floatingExpandedFilter === 'error' ? (
                    <TouchableOpacity
                      onPress={() => handleRetryItem(it)}
                      style={{
                        backgroundColor: '#2563eb',
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                        borderRadius: 8,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <Ionicons name="refresh" size={12} color="#ffffff" />
                      <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '800' }}>
                        Reintentar
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))
            )}
          </View>
        )}
      </Animated.View>
    );
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.background} />
      <SafeAreaView style={styles.container}>
        {/* 1. BARRA SUPERIOR */}
        <View style={styles.topBar}>
          <TouchableOpacity
            onPress={onClose}
            style={styles.closeHeaderBtn}
            activeOpacity={0.8}
          >
            <Ionicons name="chevron-down" size={22} color="#ffffff" />
            <Text style={styles.closeHeaderBtnText}>
              {activeItems.length > 0 ? 'Minimizar' : 'Cerrar'}
            </Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Ionicons name="cloud-download" size={20} color="#38bdf8" />
            <Text style={styles.headerTitle}>Descargador de Videos</Text>
          </View>

          <TouchableOpacity
            style={styles.folderShortcutTopBtn}
            onPress={() => {
              if (onOpenDownloadedFolder) {
                onOpenDownloadedFolder(DOWNLOAD_FOLDER_URI);
              }
            }}
            activeOpacity={0.8}
          >
            <Ionicons name="folder-open" size={18} color="#fbbf24" />
            <Text style={styles.folderShortcutTopText}>Carpeta</Text>
          </TouchableOpacity>
        </View>

        {/* 2. BANNER DE CARPETA EXCLUSIVA "VIDEOS DESCARGADOS" */}
        {/* 2. BANNER DE ACCESO DIRECTO A LA CARPETA DE DESTINO + SELECTOR DE BÓVEDA PRIVADA */}
        <View style={{ marginHorizontal: 14, marginBottom: 8, gap: 6 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                paddingVertical: 8,
                paddingHorizontal: 10,
                borderRadius: 11,
                borderWidth: 1.5,
                backgroundColor: !saveToVault ? 'rgba(245, 158, 11, 0.2)' : 'rgba(255,255,255,0.04)',
                borderColor: !saveToVault ? '#f59e0b' : 'rgba(255,255,255,0.12)',
              }}
              onPress={() => setSaveToVault(false)}
            >
              <Ionicons name="folder" size={15} color={!saveToVault ? '#fbbf24' : '#94a3b8'} />
              <Text
                style={{
                  color: !saveToVault ? '#fde68a' : '#94a3b8',
                  fontSize: 11.5,
                  fontWeight: '800',
                }}
              >
                📁 Videos Descargados
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                paddingVertical: 8,
                paddingHorizontal: 10,
                borderRadius: 11,
                borderWidth: 1.5,
                backgroundColor: saveToVault ? 'rgba(16, 185, 129, 0.22)' : 'rgba(255,255,255,0.04)',
                borderColor: saveToVault ? '#10b981' : 'rgba(255,255,255,0.12)',
              }}
              onPress={() => setSaveToVault(true)}
            >
              <Ionicons name="lock-closed" size={15} color={saveToVault ? '#34d399' : '#94a3b8'} />
              <Text
                style={{
                  color: saveToVault ? '#a7f3d0' : '#94a3b8',
                  fontSize: 11.5,
                  fontWeight: '800',
                }}
              >
                🔒 Bóveda Privada
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          style={styles.dedicatedFolderBanner}
          onPress={() => {
            if (onOpenDownloadedFolder) {
              onOpenDownloadedFolder(
                saveToVault ? BOVEDA_PRIVADA_FOLDER_URI : DOWNLOAD_FOLDER_URI
              );
            }
          }}
          activeOpacity={0.85}
        >
          <View style={styles.dedicatedFolderIconWrap}>
            <Ionicons
              name={saveToVault ? 'lock-closed' : 'folder'}
              size={22}
              color={saveToVault ? '#34d399' : '#fbbf24'}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.dedicatedFolderTitle}>
              Destino: &quot;{saveToVault ? BOVEDA_PRIVADA_FOLDER_NAME : DOWNLOAD_ALBUM_NAME}&quot;
            </Text>
            <Text style={styles.dedicatedFolderSub}>
              {saveToVault
                ? 'Se guardarán ocultos (.nomedia) en tu Bóveda Privada. Toca para abrirla.'
                : 'Todos tus videos se guardan en su propia carpeta. Toca aquí para abrirla.'}
            </Text>
          </View>
          <View style={styles.dedicatedFolderGoPill}>
            <Text style={styles.dedicatedFolderGoText}>Ir a carpeta</Text>
            <Ionicons name="arrow-forward" size={14} color="#ffffff" />
          </View>
        </TouchableOpacity>

        {/* 3. CAJA PARA PEGAR ENLACE Y APILAR EN LA HILERA DE ABAJO */}
        <View style={styles.inputSectionCard}>
          <View style={styles.inputWrapper}>
            <Ionicons
              name={detectedPlatform ? detectedPlatform.icon : 'link-outline'}
              size={20}
              color={detectedPlatform ? detectedPlatform.color : theme.colors.textMuted}
              style={styles.inputIcon}
            />
            <TextInput
              style={styles.textInput}
              value={urlInput}
              onChangeText={setUrlInput}
              placeholder="Pega aquí el enlace del video (https://...)"
              placeholderTextColor={theme.colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={handleAddAndStartDownload}
            />
            {urlInput.length > 0 ? (
              <TouchableOpacity
                onPress={() => setUrlInput('')}
                style={styles.clearBtn}
              >
                <Ionicons name="close-circle" size={20} color={theme.colors.textMuted} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={handlePasteFromClipboard}
                style={styles.pasteClipboardBtn}
                activeOpacity={0.8}
              >
                <Ionicons name="clipboard-outline" size={14} color="#38bdf8" />
                <Text style={styles.pasteClipboardText}>Pegar</Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.inputActionsRow}>
            {detectedPlatform && extractedUrl.startsWith('http') ? (
              <View
                style={[
                  styles.platformPill,
                  { borderColor: detectedPlatform.color },
                ]}
              >
                <Ionicons
                  name={detectedPlatform.icon}
                  size={14}
                  color={detectedPlatform.color}
                />
                <Text style={[styles.platformPillText, { color: detectedPlatform.color }]}>
                  {detectedPlatform.name}
                </Text>
              </View>
            ) : (
              <Text style={styles.inputHintText}>
                También puedes dar a &quot;Compartir&quot; en cualquier app y elegir Mi Galería.
              </Text>
            )}

            <TouchableOpacity
              style={[
                styles.addDownloadBtn,
                !extractedUrl.startsWith('http') && styles.addDownloadBtnDisabled,
              ]}
              onPress={handleAddAndStartDownload}
              disabled={!extractedUrl.startsWith('http')}
              activeOpacity={0.85}
            >
              <Ionicons name="add-circle" size={20} color="#ffffff" />
              <Text style={styles.addDownloadBtnText}>Descargar video</Text>
            </TouchableOpacity>
          </View>

          {extractedUrl.startsWith('http') && (
            <TouchableOpacity
              style={styles.interactiveStoryBtn}
              onPress={handleAddAndStartInteractive}
              activeOpacity={0.85}
            >
              <Ionicons name="key-outline" size={16} color="#fde68a" />
              <Text style={styles.interactiveStoryBtnText}>
                Capturar Historia / Video con Sesión (Facebook / Instagram)
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* 4. RESUMEN Y FILTROS DE LA HILERA (EN CURSO / DESCARGADOS / CON ERROR) */}
        <View style={styles.queueHeaderBar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterPillsRow}
          >
            <TouchableOpacity
              style={[
                styles.filterPill,
                filterStatus === 'all' && styles.filterPillActiveAll,
              ]}
              onPress={() => setFilterStatus('all')}
            >
              <Text
                style={[
                  styles.filterPillText,
                  filterStatus === 'all' && styles.filterPillTextActive,
                ]}
              >
                Todos ({downloadItems.length})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.filterPill,
                filterStatus === 'active' && styles.filterPillActiveProgress,
              ]}
              onPress={() => setFilterStatus('active')}
            >
              <Ionicons name="time-outline" size={14} color="#38bdf8" />
              <Text
                style={[
                  styles.filterPillText,
                  filterStatus === 'active' && styles.filterPillTextActive,
                ]}
              >
                En curso ({activeItems.length})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.filterPill,
                filterStatus === 'completed' && styles.filterPillActiveSuccess,
              ]}
              onPress={() => setFilterStatus('completed')}
            >
              <Ionicons name="checkmark-circle" size={14} color="#10b981" />
              <Text
                style={[
                  styles.filterPillText,
                  filterStatus === 'completed' && styles.filterPillTextActive,
                ]}
              >
                Descargados ({completedItems.length})
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.filterPill,
                filterStatus === 'error' && styles.filterPillActiveError,
              ]}
              onPress={() => setFilterStatus('error')}
            >
              <Ionicons name="alert-circle" size={14} color="#ef4444" />
              <Text
                style={[
                  styles.filterPillText,
                  filterStatus === 'error' && styles.filterPillTextActive,
                ]}
              >
                Con error ({errorItems.length})
              </Text>
            </TouchableOpacity>
          </ScrollView>

          {(completedItems.length > 0 || errorItems.length > 0) && (
            <TouchableOpacity
              style={styles.clearHistoryBtn}
              onPress={handleClearFinished}
            >
              <Ionicons name="trash-outline" size={15} color="#94a3b8" />
              <Text style={styles.clearHistoryText}>Limpiar lista</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* 5. HILERA VERTICAL DESLIZABLE DE DESCARGAS (PARA MOVER ARRIBA/ABAJO Y VER ESTADO) */}
        <ScrollView
          style={styles.queueScroll}
          contentContainerStyle={styles.queueScrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {filteredItems.length === 0 ? (
            <View style={styles.emptyQueueBox}>
              <Ionicons
                name="layers-outline"
                size={46}
                color={theme.colors.textMuted}
              />
              <Text style={styles.emptyQueueTitle}>
                {downloadItems.length === 0
                  ? 'Tu hilera de descargas está vacía'
                  : 'No hay videos en este filtro'}
              </Text>
              <Text style={styles.emptyQueueSub}>
                Cada video que pongas a descargar se irá apilando aquí abajo en hilera para que puedas mover la lista, ver la barra de progreso en vivo, cuáles ya se descargaron (✅) y cuáles tuvieron error (❌).
              </Text>
            </View>
          ) : (
            filteredItems.map((item, idx) => {
              const fullIndex = downloadItems.findIndex((d) => d.id === item.id);
              const isDownloading = item.status === 'downloading';
              const isPaused = item.status === 'paused';
              const isCompleted = item.status === 'completed';
              const isError = item.status === 'error';
              const isCancelled = item.status === 'cancelled';

              const borderColor = isCompleted
                ? '#10b981'
                : isError
                ? '#ef4444'
                : isPaused
                ? '#f59e0b'
                : isDownloading
                ? '#38bdf8'
                : '#475569';

              const pctNumber = Math.round(
                Math.max(0, Math.min(1, item.percent || 0)) * 100
              );

              const thumbUri = item.asset?.uri || item.thumbnail || null;
              const isPhotoItem =
                item.mediaType === 'photo' ||
                item.asset?.mediaType === 'photo' ||
                item.platform?.isPhoto;

              return (
                <View
                  key={item.id}
                  style={[styles.queueRowCard, { borderLeftColor: borderColor }]}
                >
                  {/* Fila superior de la tarjeta: Miniatura, Número de fila, Plataforma, Estado y Botones para Mover */}
                  <View style={styles.rowTopHeader}>
                    <TouchableOpacity
                      activeOpacity={0.85}
                      disabled={!item.asset?.uri || !onPlayDownloadedAsset}
                      onPress={() => {
                        if (item.asset?.uri && onPlayDownloadedAsset) {
                          onPlayDownloadedAsset(item.asset);
                        }
                      }}
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: 10,
                        backgroundColor: '#1e293b',
                        overflow: 'hidden',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderWidth: 1,
                        borderColor: 'rgba(255,255,255,0.12)',
                      }}
                    >
                      {thumbUri ? (
                        <Image
                          source={{ uri: thumbUri }}
                          style={{ width: '100%', height: '100%' }}
                          resizeMode="cover"
                        />
                      ) : (
                        <Ionicons
                          name={isPhotoItem ? 'image-outline' : item.platform?.icon || 'videocam'}
                          size={22}
                          color={item.platform?.color || '#38bdf8'}
                        />
                      )}
                      <View
                        style={{
                          position: 'absolute',
                          bottom: 2,
                          right: 2,
                          backgroundColor: 'rgba(15, 23, 42, 0.85)',
                          paddingHorizontal: 4,
                          paddingVertical: 1,
                          borderRadius: 5,
                        }}
                      >
                        <Text style={{ fontSize: 9, color: '#ffffff', fontWeight: '800' }}>
                          {isPhotoItem ? '🖼️' : '🎥'}
                        </Text>
                      </View>
                    </TouchableOpacity>

                    <View style={styles.rowPlatformGroup}>
                      <View style={styles.rowOrderBadge}>
                        <Text style={styles.rowOrderBadgeText}>#{idx + 1}</Text>
                      </View>
                      <Ionicons
                        name={isPhotoItem ? 'image' : item.platform?.icon || 'videocam'}
                        size={17}
                        color={item.platform?.color || '#38bdf8'}
                      />
                      <Text style={styles.rowTitleText} numberOfLines={2}>
                        {item.filename || item.title || (isPhotoItem ? 'Foto' : 'Video')}
                      </Text>
                    </View>

                    {/* Controles para mover el video arriba o abajo en la hilera */}
                    <View style={styles.rowMoveControls}>
                      <TouchableOpacity
                        style={[
                          styles.moveIconBtn,
                          fullIndex <= 0 && styles.moveIconBtnDisabled,
                        ]}
                        disabled={fullIndex <= 0}
                        onPress={() => handleMoveItem(fullIndex, -1)}
                      >
                        <Ionicons name="arrow-up" size={15} color="#cbd5e1" />
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={[
                          styles.moveIconBtn,
                          fullIndex >= downloadItems.length - 1 &&
                            styles.moveIconBtnDisabled,
                        ]}
                        disabled={fullIndex >= downloadItems.length - 1}
                        onPress={() => handleMoveItem(fullIndex, 1)}
                      >
                        <Ionicons name="arrow-down" size={15} color="#cbd5e1" />
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={styles.removeRowBtn}
                        onPress={() => handleRemoveItem(item)}
                      >
                        <Ionicons name="close" size={16} color="#94a3b8" />
                      </TouchableOpacity>
                    </View>
                  </View>

                  {/* Etiqueta clara de estado */}
                  <View style={styles.statusBadgeLine}>
                    {isDownloading && (
                      <View style={[styles.statusBadgePill, styles.badgeDownloading]}>
                        <ActivityIndicator size="small" color="#38bdf8" />
                        <Text style={[styles.statusBadgeText, { color: '#38bdf8' }]}>
                          DESCARGANDO ({pctNumber}%)
                        </Text>
                      </View>
                    )}

                    {isPaused && (
                      <View style={[styles.statusBadgePill, styles.badgePaused]}>
                        <Ionicons name="pause-circle" size={15} color="#fbbf24" />
                        <Text style={[styles.statusBadgeText, { color: '#fbbf24' }]}>
                          EN PAUSA ({pctNumber}%)
                        </Text>
                      </View>
                    )}

                    {isCompleted && (
                      <View style={[styles.statusBadgePill, styles.badgeCompleted]}>
                        <Ionicons name="checkmark-circle" size={16} color="#10b981" />
                        <Text style={[styles.statusBadgeText, { color: '#10b981' }]}>
                          ✅ DESCARGADO ({formatBytes(item.sizeBytes)})
                        </Text>
                      </View>
                    )}

                    {isError && (
                      <View style={[styles.statusBadgePill, styles.badgeError]}>
                        <Ionicons name="alert-circle" size={16} color="#f87171" />
                        <Text style={[styles.statusBadgeText, { color: '#f87171' }]}>
                          ❌ CON ERROR
                        </Text>
                      </View>
                    )}

                    {isCancelled && (
                      <View style={[styles.statusBadgePill, styles.badgeCancelled]}>
                        <Ionicons name="ban" size={15} color="#94a3b8" />
                        <Text style={[styles.statusBadgeText, { color: '#94a3b8' }]}>
                          CANCELADO
                        </Text>
                      </View>
                    )}

                    <Text style={styles.rowTimeText}>{item.date}</Text>
                  </View>

                  {/* Contenido según el estado */}
                  {(isDownloading || isPaused) && (
                    <View style={styles.activeProgressSection}>
                      <View style={styles.rowProgressBarBg}>
                        <View
                          style={[
                            styles.rowProgressBarFill,
                            {
                              width: `${Math.max(6, pctNumber)}%`,
                              backgroundColor: isPaused ? '#f59e0b' : '#3b82f6',
                            },
                          ]}
                        />
                      </View>

                      <View style={styles.rowProgressMeta}>
                        <Text style={styles.rowStatusSubText} numberOfLines={1}>
                          {item.statusText || 'Descargando…'}
                        </Text>
                        <Text style={styles.rowBytesText}>
                          {item.writtenBytes > 0
                            ? `${formatBytes(item.writtenBytes)}${
                                item.totalBytes > 0
                                  ? ` / ${formatBytes(item.totalBytes)}`
                                  : ''
                              }`
                            : `${pctNumber}%`}
                        </Text>
                      </View>

                      <View style={styles.rowActionBtns}>
                        <TouchableOpacity
                          style={[
                            styles.rowSmallBtn,
                            isPaused ? styles.rowBtnResume : styles.rowBtnPause,
                          ]}
                          onPress={() => handleTogglePauseItem(item)}
                        >
                          <Ionicons
                            name={isPaused ? 'play' : 'pause'}
                            size={15}
                            color="#ffffff"
                          />
                          <Text style={styles.rowSmallBtnText}>
                            {isPaused ? 'Reanudar' : 'Pausar'}
                          </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={[styles.rowSmallBtn, styles.rowBtnCancel]}
                          onPress={() => handleCancelItem(item)}
                        >
                          <Ionicons name="close-circle-outline" size={15} color="#fca5a5" />
                          <Text style={[styles.rowSmallBtnText, { color: '#fca5a5' }]}>
                            Cancelar
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}

                  {isCompleted && (
                    <View style={styles.completedSection}>
                      <Text style={styles.completedLocationText} numberOfLines={1}>
                        📂 Guardado en carpeta: &quot;{item.albumName || DOWNLOAD_ALBUM_NAME}&quot;
                      </Text>
                      <View style={styles.rowActionBtns}>
                        {item.asset?.uri && onPlayDownloadedAsset && (
                          <TouchableOpacity
                            style={[styles.rowSmallBtn, styles.rowBtnPlay]}
                            onPress={() => onPlayDownloadedAsset(item.asset)}
                          >
                            <Ionicons
                              name={isPhotoItem ? 'eye-outline' : 'play-circle'}
                              size={16}
                              color="#ffffff"
                            />
                            <Text style={styles.rowSmallBtnText}>
                              {isPhotoItem ? 'Ver foto' : 'Reproducir'}
                            </Text>
                          </TouchableOpacity>
                        )}

                        {onOpenDownloadedFolder && (
                          <TouchableOpacity
                            style={[styles.rowSmallBtn, styles.rowBtnFolder]}
                            onPress={() =>
                              onOpenDownloadedFolder(
                                item.folderUri || DOWNLOAD_FOLDER_URI
                              )
                            }
                          >
                            <Ionicons name="folder-open-outline" size={15} color="#fde68a" />
                            <Text style={[styles.rowSmallBtnText, { color: '#fde68a' }]}>
                              Ver en carpeta
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  )}

                  {(isError || isCancelled) && (
                    <View style={styles.errorSection}>
                      <Text style={styles.errorReasonText}>
                        {item.errorMessage ||
                          'La descarga fue cancelada o no se pudo completar.'}
                      </Text>
                      <Text style={styles.errorUrlText} numberOfLines={1}>
                        {item.url}
                      </Text>
                      <View style={styles.rowActionBtns}>
                        <TouchableOpacity
                          style={[styles.rowSmallBtn, styles.rowBtnRetry]}
                          onPress={() => handleRetryItem(item)}
                        >
                          <Ionicons name="refresh" size={15} color="#ffffff" />
                          <Text style={styles.rowSmallBtnText}>Reintentar</Text>
                        </TouchableOpacity>

                        {item.url && (
                          <TouchableOpacity
                            style={[styles.rowSmallBtn, styles.rowBtnSession]}
                            onPress={() => handleRetryInteractiveItem(item)}
                          >
                            <Ionicons name="key-outline" size={15} color="#fde68a" />
                            <Text style={[styles.rowSmallBtnText, { color: '#fde68a' }]}>
                              Capturar con Sesión
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  )}
                </View>
              );
            })
          )}
        </ScrollView>

        {/* Círculo flotante del Navegador para regresar directamente al Explorador Web */}
        {onOpenBrowser && (
          <TouchableOpacity
            style={{
              position: 'absolute',
              right: 16,
              bottom: Platform.OS === 'android' ? 56 : 36,
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: '#2563eb',
              borderWidth: 2,
              borderColor: '#60a5fa',
              alignItems: 'center',
              justifyContent: 'center',
              elevation: 12,
              shadowColor: '#000',
              shadowOpacity: 0.45,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 4 },
            }}
            activeOpacity={0.85}
            onPress={() => onOpenBrowser(lastBrowserUrl || 'https://www.google.com')}
          >
            <Ionicons name="Compass" size={26} color="#ffffff" style={{ display: 'none' }} />
            <Ionicons name="globe-outline" size={26} color="#ffffff" />
            <Text
              style={{
                color: '#ffffff',
                fontSize: 9.5,
                fontWeight: '900',
                marginTop: 1,
              }}
            >
              Navegador
            </Text>
          </TouchableOpacity>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#080b12',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: Platform.OS === 'android' ? Math.max(StatusBar.currentHeight || 40, 40) + 14 : 18,
    paddingBottom: 12,
    backgroundColor: '#0f1624',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  closeHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#172033',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 16,
  },
  closeHeaderBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
  },
  folderShortcutTopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.45)',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 16,
  },
  folderShortcutTopText: {
    color: '#fde68a',
    fontSize: 12,
    fontWeight: '800',
  },

  /* Banner de carpeta propia */
  dedicatedFolderBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 12,
    marginTop: 10,
    padding: 12,
    borderRadius: 14,
    backgroundColor: '#111a2e',
    borderWidth: 1,
    borderColor: '#263554',
  },
  dedicatedFolderIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dedicatedFolderTitle: {
    color: '#fde68a',
    fontSize: 13,
    fontWeight: '800',
  },
  dedicatedFolderSub: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
    lineHeight: 15,
  },
  dedicatedFolderGoPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#2563eb',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
  },
  dedicatedFolderGoText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '800',
  },

  /* Entrada de enlace */
  inputSectionCard: {
    marginHorizontal: 12,
    marginTop: 10,
    padding: 12,
    borderRadius: 14,
    backgroundColor: '#0f1624',
    borderWidth: 1,
    borderColor: '#1e293b',
    gap: 10,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#080b12',
    borderWidth: 1,
    borderColor: '#263554',
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 46,
  },
  inputIcon: {
    marginRight: 8,
  },
  textInput: {
    flex: 1,
    color: '#ffffff',
    fontSize: 13.5,
    paddingVertical: 10,
  },
  clearBtn: {
    padding: 6,
  },
  pasteClipboardBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.4)',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
  },
  pasteClipboardText: {
    color: '#38bdf8',
    fontSize: 11.5,
    fontWeight: '800',
  },
  interactiveStoryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: 'rgba(245, 158, 11, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.45)',
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  interactiveStoryBtnText: {
    color: '#fde68a',
    fontSize: 12,
    fontWeight: '800',
  },
  inputActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  inputHintText: {
    flex: 1,
    color: '#64748b',
    fontSize: 11.5,
  },
  platformPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  platformPillText: {
    fontSize: 12,
    fontWeight: '700',
  },
  addDownloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#2563eb',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 11,
  },
  addDownloadBtnDisabled: {
    opacity: 0.45,
  },
  addDownloadBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },

  /* Barra de filtros de la hilera */
  queueHeaderBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 8,
  },
  filterPillsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  filterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#131b2e',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  filterPillActiveAll: {
    backgroundColor: '#2563eb',
    borderColor: '#3b82f6',
  },
  filterPillActiveProgress: {
    backgroundColor: 'rgba(56, 189, 248, 0.2)',
    borderColor: '#38bdf8',
  },
  filterPillActiveSuccess: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    borderColor: '#10b981',
  },
  filterPillActiveError: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderColor: '#ef4444',
  },
  filterPillText: {
    color: '#94a3b8',
    fontSize: 11.5,
    fontWeight: '700',
  },
  filterPillTextActive: {
    color: '#ffffff',
    fontWeight: '800',
  },
  clearHistoryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#131b2e',
  },
  clearHistoryText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },

  /* Hilera vertical deslizable */
  queueScroll: {
    flex: 1,
  },
  queueScrollContent: {
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: Platform.OS === 'android' ? 68 : 36,
    gap: 10,
  },
  emptyQueueBox: {
    marginTop: 28,
    padding: 24,
    borderRadius: 16,
    backgroundColor: '#0f1624',
    borderWidth: 1,
    borderColor: '#1e293b',
    alignItems: 'center',
    gap: 8,
  },
  emptyQueueTitle: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'center',
  },
  emptyQueueSub: {
    color: '#94a3b8',
    fontSize: 12.5,
    lineHeight: 18,
    textAlign: 'center',
  },

  /* Tarjeta individual en la hilera */
  queueRowCard: {
    backgroundColor: '#111827',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1f2937',
    borderLeftWidth: 5,
    gap: 8,
  },
  rowTopHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  rowPlatformGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  rowOrderBadge: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  rowOrderBadgeText: {
    color: '#94a3b8',
    fontSize: 10.5,
    fontWeight: '800',
  },
  rowTitleText: {
    flex: 1,
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
  },
  rowMoveControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  moveIconBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  moveIconBtnDisabled: {
    opacity: 0.3,
  },
  removeRowBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  statusBadgeLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusBadgePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
  },
  badgeDownloading: {
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
  },
  badgePaused: {
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
  },
  badgeCompleted: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
  },
  badgeError: {
    backgroundColor: 'rgba(239, 68, 68, 0.16)',
  },
  badgeCancelled: {
    backgroundColor: 'rgba(148, 163, 184, 0.14)',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '800',
  },
  rowTimeText: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '600',
  },

  /* Progreso dentro de la fila */
  activeProgressSection: {
    gap: 7,
  },
  rowProgressBarBg: {
    height: 8,
    backgroundColor: '#1e293b',
    borderRadius: 4,
    overflow: 'hidden',
  },
  rowProgressBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  rowProgressMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  rowStatusSubText: {
    flex: 1,
    color: '#cbd5e1',
    fontSize: 11.5,
  },
  rowBytesText: {
    color: '#38bdf8',
    fontSize: 11.5,
    fontWeight: '800',
  },

  completedSection: {
    gap: 7,
  },
  completedLocationText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '600',
  },

  errorSection: {
    gap: 6,
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    padding: 9,
    borderRadius: 10,
  },
  errorReasonText: {
    color: '#fca5a5',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  errorUrlText: {
    color: '#64748b',
    fontSize: 11,
  },

  rowActionBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  rowSmallBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 9,
  },
  rowBtnPause: {
    backgroundColor: '#d97706',
  },
  rowBtnResume: {
    backgroundColor: '#2563eb',
  },
  rowBtnCancel: {
    backgroundColor: 'rgba(239, 68, 68, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  rowBtnPlay: {
    backgroundColor: '#059669',
  },
  rowBtnFolder: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.45)',
  },
  rowBtnRetry: {
    backgroundColor: '#2563eb',
  },
  rowBtnBrowser: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  rowBtnSession: {
    backgroundColor: 'rgba(245, 158, 11, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.5)',
  },
  rowSmallBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },

  /* Barra flotante movible cuando el modal está minimizado */
  floatingMovableWidget: {
    position: 'absolute',
    bottom: Platform.OS === 'android' ? 54 : 32,
    right: 14,
    left: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(15, 23, 42, 0.96)',
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#38bdf8',
    elevation: 25,
    zIndex: 9999,
  },
  floatingDragHandle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  floatingInfoCol: {
    flex: 1,
    gap: 4,
  },
  floatingTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  floatingBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  floatingBadgeOk: {
    color: '#34d399',
    fontSize: 11.5,
    fontWeight: '700',
  },
  floatingBadgeErr: {
    color: '#f87171',
    fontSize: 11.5,
    fontWeight: '700',
  },
  floatingProgressBg: {
    height: 5,
    backgroundColor: '#1e293b',
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: 2,
  },
  floatingProgressFill: {
    height: '100%',
    backgroundColor: '#38bdf8',
  },
  floatingCloseBtn: {
    padding: 6,
  },
  floatingOpenBtn: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  floatingOpenBtnText: {
    color: '#ffffff',
    fontSize: 11.5,
    fontWeight: '800',
  },
});
