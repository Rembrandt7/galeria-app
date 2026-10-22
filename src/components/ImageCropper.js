import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  PanResponder,
  StatusBar,
  SafeAreaView,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as MediaLibrary from 'expo-media-library';
import { theme } from '../constants/theme';

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
  if (!asset?.uri) return null;

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

  const handleSave = async () => {
    if (!natural || !rect || !disp.w) return;
    setBusy(true);
    try {
      const k = natural.w / disp.w;
      const originX = clamp(Math.round(rect.x * k), 0, natural.w - 1);
      const originY = clamp(Math.round(rect.y * k), 0, natural.h - 1);
      const width = clamp(Math.round(rect.w * k), 1, natural.w - originX);
      const height = clamp(Math.round(rect.h * k), 1, natural.h - originY);

      const ctx = ImageManipulator.manipulate(asset.uri);
      ctx.crop({ originX, originY, width, height });
      const ref = await ctx.renderAsync();
      const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.95 });
      await MediaLibrary.saveToLibraryAsync(out.uri);
      Alert.alert('Listo', 'La imagen recortada se guardó en tu galería como una copia nueva.');
      if (onSaved) onSaved();
      onClose();
    } catch (e) {
      Alert.alert('No se pudo recortar', String(e?.message || e));
    }
    setBusy(false);
  };

  const box = rect
    ? { left: disp.x + rect.x, top: disp.y + rect.y, width: rect.w, height: rect.h }
    : null;

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <SafeAreaView style={styles.container}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>Recortar imagen</Text>
          <TouchableOpacity onPress={handleSave} style={styles.iconBtn} disabled={busy}>
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
              source={{ uri: asset.uri }}
              style={{ position: 'absolute', left: disp.x, top: disp.y, width: disp.w, height: disp.h }}
              contentFit="fill"
            />
          )}
          {/* Carga inicial para conocer el tamaño real */}
          {!natural && (
            <Image
              source={{ uri: asset.uri }}
              style={styles.hidden}
              onLoad={(e) => setNatural({ w: e.source.width, h: e.source.height })}
            />
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
      </SafeAreaView>
    </Modal>
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
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0 },
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
});
