import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  PanResponder,
  StatusBar,
  SafeAreaView,
  BackHandler,
  NativeModules,
} from 'react-native';
import { Image } from 'expo-image';
import { Image as RNImage } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as MediaLibrary from 'expo-media-library';
import { compressionService } from '../services/compressionService';
import { theme } from '../constants/theme';

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

async function resolveReadableImageUri(uri, isPng = false) {
  const phys = extractPhysicalFileUri(uri);
  const ext = isPng ? 'png' : 'jpg';
  const tempDest = new File(Paths.cache, `crop_in_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`);

  if (VideoEngineModule?.copyToCacheNative) {
    try {
      const copied = await VideoEngineModule.copyToCacheNative(phys || uri, tempDest.uri);
      if (tempDest.exists && tempDest.size > 0) {
        return { uri: copied || tempDest.uri, tempFile: tempDest };
      }
    } catch (_e) {
      try {
        const copied2 = await VideoEngineModule.copyToCacheNative(uri, tempDest.uri);
        if (tempDest.exists && tempDest.size > 0) {
          return { uri: copied2 || tempDest.uri, tempFile: tempDest };
        }
      } catch (_e2) {}
    }
  }

  if (phys) {
    try {
      await LegacyFS.copyAsync({ from: phys, to: tempDest.uri });
      return { uri: tempDest.uri, tempFile: tempDest };
    } catch (_e) {}
  }

  try {
    await LegacyFS.copyAsync({ from: uri, to: tempDest.uri });
    return { uri: tempDest.uri, tempFile: tempDest };
  } catch (_e) {
    return { uri: phys || uri, tempFile: null };
  }
}

const MIN = 40; // tamaño mínimo del recorte (px en pantalla)
const HANDLE = 44;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const RATIOS = [
  { key: 'free', label: 'Libre', value: null },
  { key: '1:1', label: '1:1', value: 1 },
  { key: '4:3', label: '4:3', value: 4 / 3 },
  { key: '3:4', label: '3:4', value: 3 / 4 },
  { key: '16:9', label: '16:9', value: 16 / 9 },
];

export default function ImageCropper({ asset, onClose, onSaved }) {
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState(null); // { w, h } de la imagen original
  const [rect, setRectState] = useState(null); // relativo a la imagen mostrada
  const [ratioKey, setRatioKey] = useState('free');
  const [busy, setBusy] = useState(false);

  // Refs para que los PanResponder lean siempre valores actuales
  const rectRef = useRef(null);
  const dispRef = useRef({ w: 0, h: 0 });
  const ratioRef = useRef(null);
  const startRef = useRef(null);

  // Rectángulo de la imagen mostrada (contain)
  let disp = { x: 0, y: 0, w: 0, h: 0 };
  if (natural && area.w && area.h) {
    const scale = Math.min(area.w / natural.w, area.h / natural.h);
    const w = natural.w * scale;
    const h = natural.h * scale;
    disp = { x: (area.w - w) / 2, y: (area.h - h) / 2, w, h };
  }
  dispRef.current = { w: disp.w, h: disp.h };

  const setRect = (r) => {
    rectRef.current = r;
    setRectState(r);
  };

  const initialRect = (ratio) => {
    const { w: dw, h: dh } = dispRef.current;
    if (!dw || !dh) return null;
    if (!ratio) {
      return { x: dw * 0.1, y: dh * 0.1, w: dw * 0.8, h: dh * 0.8 };
    }
    const w = Math.min(dw * 0.9, dh * 0.9 * ratio);
    const h = w / ratio;
    return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
  };

  // Inicializar el rectángulo cuando ya conocemos tamaños
  useEffect(() => {
    if (!rectRef.current && disp.w) {
      setRect(initialRect(ratioRef.current));
    }
  }, [disp.w, disp.h]);

  const chooseRatio = (item) => {
    setRatioKey(item.key);
    ratioRef.current = item.value;
    setRect(initialRect(item.value));
  };

  const makeCornerResponder = (right, bottom) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startRef.current = { ...rectRef.current };
      },
      onPanResponderMove: (_, g) => {
        const s = startRef.current;
        const { w: dw, h: dh } = dispRef.current;
        if (!s) return;
        const ax = right ? s.x : s.x + s.w; // ancla = esquina opuesta
        const ay = bottom ? s.y : s.y + s.h;
        let cx = (right ? s.x + s.w : s.x) + g.dx;
        let cy = (bottom ? s.y + s.h : s.y) + g.dy;
        const r = ratioRef.current;

        if (!r) {
          cx = clamp(cx, 0, dw);
          cy = clamp(cy, 0, dh);
          cx = right ? Math.max(cx, ax + MIN) : Math.min(cx, ax - MIN);
          cy = bottom ? Math.max(cy, ay + MIN) : Math.min(cy, ay - MIN);
        } else {
          let width = Math.abs(cx - ax);
          const maxW = right ? dw - ax : ax;
          const maxH = bottom ? dh - ay : ay;
          width = clamp(width, MIN, Math.max(MIN, Math.min(maxW, maxH * r)));
          const height = width / r;
          cx = ax + (right ? width : -width);
          cy = ay + (bottom ? height : -height);
        }
        setRect({
          x: Math.min(ax, cx),
          y: Math.min(ay, cy),
          w: Math.abs(cx - ax),
          h: Math.abs(cy - ay),
        });
      },
    });

  const responders = useRef({
    tl: makeCornerResponder(false, false),
    tr: makeCornerResponder(true, false),
    bl: makeCornerResponder(false, true),
    br: makeCornerResponder(true, true),
    move: PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startRef.current = { ...rectRef.current };
      },
      onPanResponderMove: (_, g) => {
        const s = startRef.current;
        const { w: dw, h: dh } = dispRef.current;
        if (!s) return;
        setRect({
          ...s,
          x: clamp(s.x + g.dx, 0, dw - s.w),
          y: clamp(s.y + g.dy, 0, dh - s.h),
        });
      },
    }),
  }).current;

  // Tamaño REAL de la imagen original (compatible con Galería y Carpetas SAF)
  useEffect(() => {
    let alive = true;
    if (!asset?.uri) return undefined;

    if (asset.width > 0 && asset.height > 0) {
      setNatural({ w: asset.width, h: asset.height });
    }

    const candidateUri = extractPhysicalFileUri(asset.uri) || asset.uri;
    RNImage.getSize(
      candidateUri,
      (w, h) => {
        if (alive && w > 0 && h > 0) setNatural({ w, h });
      },
      async () => {
        let tempObj = null;
        try {
          tempObj = await resolveReadableImageUri(asset.uri);
          const probe = await ImageManipulator.manipulate(tempObj.uri).renderAsync();
          if (alive && probe?.width > 0 && probe?.height > 0) {
            setNatural({ w: probe.width, h: probe.height });
          }
        } catch (_e) {
          if (alive) {
            setNatural((prev) => prev || { w: 1200, h: 1200 });
          }
        } finally {
          if (tempObj?.tempFile?.exists) {
            try {
              tempObj.tempFile.delete();
            } catch (_e2) {}
          }
        }
      }
    );
    return () => {
      alive = false;
    };
  }, [asset?.uri]);

  const handleSave = async (replaceOriginal = false) => {
    const shouldReplace = replaceOriginal === true;
    if (!rect || !disp.w || !disp.h) return;
    setBusy(true);
    let tempObj = null;
    try {
      // El recorte se guarda como fracción de la imagen mostrada: funciona con cualquier resolución
      const fx = clamp(rect.x / disp.w, 0, 0.99);
      const fy = clamp(rect.y / disp.h, 0, 0.99);
      const fw = clamp(rect.w / disp.w, 0.01, 1 - fx);
      const fh = clamp(rect.h / disp.h, 0.01, 1 - fy);
      const isPng = /\.png$/i.test(asset.filename || asset.uri || '');

      const cropFrom = async (src) => {
        const probe = await ImageManipulator.manipulate(src).renderAsync();
        const W = probe.width;
        const H = probe.height;
        const originX = clamp(Math.round(fx * W), 0, W - 1);
        const originY = clamp(Math.round(fy * H), 0, H - 1);
        const width = clamp(Math.round(fw * W), 1, W - originX);
        const height = clamp(Math.round(fh * H), 1, H - originY);

        const ctx = ImageManipulator.manipulate(src);
        ctx.crop({ originX, originY, width, height });
        const ref = await ctx.renderAsync();
        return ref.saveAsync(
          isPng
            ? { format: SaveFormat.PNG }
            : { format: SaveFormat.JPEG, compress: 0.95 }
        );
      };

      tempObj = await resolveReadableImageUri(asset.uri, isPng);
      const out = await cropFrom(tempObj.uri);

      if (shouldReplace) {
        const replaced = await compressionService.overwriteOriginalFile(out.uri, asset.uri, 0, 0);
        if (!replaced) {
          throw new Error(
            'No se pudo sobrescribir la foto original. Verifica el permiso de Acceso a Todos los Archivos.'
          );
        }
        const newDiskSize = await compressionService.getFileSize(asset.uri, { forceFresh: true });
        if (newDiskSize > 0) asset.fileSize = newDiskSize;
        if (out.width && out.height) {
          asset.width = out.width;
          asset.height = out.height;
        }
        setBusy(false);
        Alert.alert('¡Foto original actualizada!', 'Se recortó la foto original directamente sin crear duplicados.');
        if (onSaved) onSaved();
        onClose();
        return;
      }

      // Si es "Guardar copia", guardarla también en la misma carpeta física si viene de Carpetas
      const origPhys = extractPhysicalFileUri(asset.uri);
      if (origPhys && VideoEngineModule?.moveFileNative) {
        try {
          const cleanOrig = decodeURIComponent(origPhys.replace(/^file:\/+/i, '/'));
          const lastSlash = cleanOrig.lastIndexOf('/');
          if (lastSlash > 0) {
            const parentDir = cleanOrig.substring(0, lastSlash);
            const ext = isPng ? '.png' : '.jpg';
            const baseName = (asset.filename || 'foto').replace(/\.[^.]+$/, '');
            const copyName = `${baseName}_recorte_${Date.now().toString().slice(-4)}${ext}`;
            const tempCopy = new File(Paths.cache, copyName);
            await LegacyFS.copyAsync({ from: out.uri, to: tempCopy.uri });
            await VideoEngineModule.moveFileNative(tempCopy.uri, parentDir, copyName);
          }
        } catch (_e) {}
      }

      try {
        await MediaLibrary.createAssetAsync(out.uri);
      } catch (_saveErr) {
        try {
          await MediaLibrary.saveToLibraryAsync(out.uri);
        } catch (_saveErr2) {}
      }

      setBusy(false);
      Alert.alert('¡Recorte guardado!', 'La imagen recortada se guardó como una copia nueva.');
      if (onSaved) onSaved();
      onClose();
      return;
    } catch (e) {
      Alert.alert('No se pudo recortar', String(e?.message || e));
    } finally {
      if (tempObj?.tempFile?.exists) {
        try {
          tempObj.tempFile.delete();
        } catch (_e) {}
      }
      setBusy(false);
    }
  };

  const box = rect
    ? { left: disp.x + rect.x, top: disp.y + rect.y, width: rect.w, height: rect.h }
    : null;

  useEffect(() => {
    const onBackPress = () => {
      onClose();
      return true;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, [onClose]);

  if (!asset?.uri) return null;

  const displayUri = extractPhysicalFileUri(asset.uri) || asset.uri;

  return (
    <View style={styles.fullscreenOverlay}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <SafeAreaView style={styles.container}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>Recortar imagen</Text>
          <TouchableOpacity onPress={() => handleSave(false)} style={styles.iconBtn} disabled={busy}>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Ionicons name="checkmark" size={28} color={theme.colors.primaryLight} />
            )}
          </TouchableOpacity>
        </View>

        <View
          style={styles.area}
          onLayout={(e) => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        >
          {disp.w > 0 && (
            <Image
              source={{ uri: displayUri }}
              style={{ position: 'absolute', left: disp.x, top: disp.y, width: disp.w, height: disp.h }}
              contentFit="fill"
              onLoad={(e) => {
                const sw = e?.source?.width;
                const sh = e?.source?.height;
                if (sw > 0 && sh > 0 && (!natural || natural.w !== sw || natural.h !== sh)) {
                  setNatural({ w: sw, h: sh });
                }
              }}
            />
          )}
          {!natural && (
            <View style={styles.hidden}>
              <ActivityIndicator color="#ffffff" />
            </View>
          )}

          {box && (
            <>
              {/* Oscurecer fuera del recorte */}
              <View pointerEvents="none" style={[styles.shade, { left: 0, top: 0, right: 0, height: box.top }]} />
              <View
                pointerEvents="none"
                style={[styles.shade, { left: 0, top: box.top + box.height, right: 0, bottom: 0 }]}
              />
              <View
                pointerEvents="none"
                style={[styles.shade, { left: 0, top: box.top, width: box.left, height: box.height }]}
              />
              <View
                pointerEvents="none"
                style={[
                  styles.shade,
                  { left: box.left + box.width, top: box.top, right: 0, height: box.height },
                ]}
              />

              <View style={[styles.cropBox, box]} {...responders.move.panHandlers} />

              <Handle pos={{ left: box.left - HANDLE / 2, top: box.top - HANDLE / 2 }} r={responders.tl} />
              <Handle pos={{ left: box.left + box.width - HANDLE / 2, top: box.top - HANDLE / 2 }} r={responders.tr} />
              <Handle pos={{ left: box.left - HANDLE / 2, top: box.top + box.height - HANDLE / 2 }} r={responders.bl} />
              <Handle
                pos={{ left: box.left + box.width - HANDLE / 2, top: box.top + box.height - HANDLE / 2 }}
                r={responders.br}
              />
            </>
          )}
        </View>

        <View style={styles.ratios}>
          {RATIOS.map((item) => (
            <TouchableOpacity
              key={item.key}
              style={[styles.chip, ratioKey === item.key && styles.chipActive]}
              onPress={() => chooseRatio(item)}
            >
              <Text style={[styles.chipText, ratioKey === item.key && { color: '#fff' }]}>{item.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.bottomActionsRow}>
          <TouchableOpacity
            style={[styles.saveCopyBtn, busy && { opacity: 0.5 }]}
            onPress={() => handleSave(false)}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="copy-outline" size={18} color="#fff" />
                <Text style={styles.actionBtnText}>Guardar copia</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.replaceOrigBtn, busy && { opacity: 0.5 }]}
            onPress={() => handleSave(true)}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="crop" size={18} color="#fff" />
                <Text style={styles.actionBtnText}>Reemplazar original</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

function Handle({ pos, r }) {
  return (
    <View style={[styles.handleTouch, pos]} {...r.panHandlers}>
      <View style={styles.handleDot} />
    </View>
  );
}

const styles = StyleSheet.create({
  fullscreenOverlay: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#000000',
  },
  container: { flex: 1, backgroundColor: '#000' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 16, fontWeight: '600' },
  area: { flex: 1, margin: 12 },
  hidden: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  shade: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.6)' },
  cropBox: { position: 'absolute', borderWidth: 2, borderColor: '#fff' },
  handleTouch: {
    position: 'absolute',
    width: HANDLE,
    height: HANDLE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.colors.primary,
    borderWidth: 2,
    borderColor: '#fff',
  },
  ratios: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
  },
  chipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipText: { color: theme.colors.textSecondary, fontWeight: '600' },
  bottomActionsRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  saveCopyBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#1e293b',
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  replaceOrigBtn: {
    flex: 1.25,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: theme.colors.primary,
    paddingVertical: 12,
    borderRadius: 10,
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
  },
});
