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
   Image as RNImage,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import { ImageManipulator } from 'expo-image-manipulator';
import { compressionService } from '../services/compressionService';
import { theme } from '../constants/theme';

const { VideoEngineModule } = NativeModules;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const BRUSH_SIZES = [
  { id: 'xs', label: 'Fino', ratio: 0.025, previewPx: 14 },
  { id: 'sm', label: 'Medio', ratio: 0.042, previewPx: 22 },
  { id: 'md', label: 'Grande', ratio: 0.065, previewPx: 32 },
  { id: 'lg', label: 'XL', ratio: 0.095, previewPx: 44 },
];

const FEATHER_LEVELS = [
  { id: 'soft', label: 'Difuminado Suave', value: 0.72 },
  { id: 'medium', label: 'Normal', value: 0.48 },
  { id: 'hard', label: 'Borde Firme', value: 0.20 },
];

export default function CloneStampEditor({ asset, onClose, onSaved }) {
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState(null);
  const [workingUri, setWorkingUri] = useState(asset?.uri || null);

  // Modo de herramienta: 'clone' (Tapón de clonar con origen) | 'heal' (Borrador mágico por vecindad)
  const [toolMode, setToolMode] = useState('clone');
  // Si el próximo toque en pantalla coloca la mira de origen ⊕
  const [pickingSource, setPickingSource] = useState(false);

  // Coordenadas normalizadas (0..1) del punto de origen ⊕ para el Tapón de Clonar
  const [sourceAnchor, setSourceAnchor] = useState({ x: 0.3, y: 0.3 });

  // Configuración del pincel
  const [brushSizeKey, setBrushSizeKey] = useState('sm');
  const [featherKey, setFeatherKey] = useState('soft');

  // Historial de trazos e imágenes procesadas para Deshacer / Rehacer
  const [strokes, setStrokes] = useState([]);
  const [redoStrokes, setRedoStrokes] = useState([]);
  const [currentStrokePoints, setCurrentStrokePoints] = useState([]);
  const [loupePos, setLoupePos] = useState(null); // { x, y } en coordenadas normalizadas (0..1)
  const [showingOriginal, setShowingOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renderingPreview, setRenderingPreview] = useState(false);

  const activeBrush = BRUSH_SIZES.find((b) => b.id === brushSizeKey) || BRUSH_SIZES[1];
  const activeFeather = FEATHER_LEVELS.find((f) => f.id === featherKey) || FEATHER_LEVELS[0];

  // Rectángulo de la imagen mostrada (contain)
  let disp = { x: 0, y: 0, w: 0, h: 0 };
  if (natural && area.w && area.h) {
    const scale = Math.min(area.w / natural.w, area.h / natural.h);
    const w = natural.w * scale;
    const h = natural.h * scale;
    disp = { x: (area.w - w) / 2, y: (area.h - h) / 2, w, h };
  }

  // Referencias para que el PanResponder siempre lea el estado más reciente
  const dispRef = useRef(disp);
  const toolModeRef = useRef(toolMode);
  const pickingSourceRef = useRef(pickingSource);
  const sourceAnchorRef = useRef(sourceAnchor);
  const activeBrushRef = useRef(activeBrush);
  const activeFeatherRef = useRef(activeFeather);
  const currentPointsRef = useRef([]);
  const strokesRef = useRef(strokes);

  dispRef.current = disp;
  toolModeRef.current = toolMode;
  pickingSourceRef.current = pickingSource;
  sourceAnchorRef.current = sourceAnchor;
  activeBrushRef.current = activeBrush;
  activeFeatherRef.current = activeFeather;
  strokesRef.current = strokes;

  // Obtener dimensiones reales de la foto
  useEffect(() => {
    let alive = true;
    if (!asset?.uri) return undefined;
    RNImage.getSize(
      asset.uri,
      (w, h) => {
        if (alive && w > 0 && h > 0) setNatural({ w, h });
      },
      async () => {
        try {
          const probe = await ImageManipulator.manipulate(asset.uri).renderAsync();
          if (alive) setNatural({ w: probe.width, h: probe.height });
        } catch (e) {
          // ignorar
        }
      }
    );
    return () => {
      alive = false;
    };
  }, [asset?.uri]);

  useEffect(() => {
    const onBackPress = () => {
      if (busy) return true;
      onClose();
      return true;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => sub.remove();
  }, [onClose, busy]);

  // Procesar los trazos en segundo plano sobre el Bitmap nativo para previsualización exacta de bordes difuminados
  const bakeStrokesToPreview = async (nextStrokes) => {
    if (!asset?.uri) return;
    if (!nextStrokes || nextStrokes.length === 0) {
      setWorkingUri(asset.uri);
      return;
    }
    if (!VideoEngineModule?.applyCloneStampStrokes) {
      return;
    }
    setRenderingPreview(true);
    try {
      const isPng = /\.png$/i.test(asset.filename || asset.uri || '');
      const tempOut = new File(
        Paths.cache,
        `clone_prev_${Date.now()}.${isPng ? 'png' : 'jpg'}`
      );
      const res = await VideoEngineModule.applyCloneStampStrokes(
        asset.uri,
        tempOut.uri,
        nextStrokes
      );
      if (res?.outputPath) {
        setWorkingUri(res.outputPath);
      }
    } catch (e) {
      // mantener vista previa de capas en vivo si ocurre algún detalle
    } finally {
      setRenderingPreview(false);
    }
  };

  // Convertir coordenadas de toque en el contenedor a coordenadas normalizadas (0..1) dentro de la foto
  const touchToNormalized = (locX, locY) => {
    const d = dispRef.current;
    if (!d.w || !d.h) return null;
    const nx = clamp((locX - d.x) / d.w, 0, 1);
    const ny = clamp((locY - d.y) / d.h, 0, 1);
    return { x: nx, y: ny };
  };

  const canvasResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const norm = touchToNormalized(e.nativeEvent.locationX, e.nativeEvent.locationY);
        if (!norm) return;
        setLoupePos(norm);

        if (pickingSourceRef.current && toolModeRef.current === 'clone') {
          setSourceAnchor(norm);
          return;
        }

        currentPointsRef.current = [norm];
        setCurrentStrokePoints([norm]);
      },
      onPanResponderMove: (e) => {
        const norm = touchToNormalized(e.nativeEvent.locationX, e.nativeEvent.locationY);
        if (!norm) return;
        setLoupePos(norm);

        if (pickingSourceRef.current && toolModeRef.current === 'clone') {
          setSourceAnchor(norm);
          return;
        }

        const pts = currentPointsRef.current;
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(norm.x - last.x, norm.y - last.y) > 0.004) {
          const updated = [...pts, norm];
          currentPointsRef.current = updated;
          setCurrentStrokePoints(updated);
        }
      },
      onPanResponderRelease: () => {
        setLoupePos(null);
        if (pickingSourceRef.current && toolModeRef.current === 'clone') {
          setPickingSource(false);
          return;
        }

        const pts = currentPointsRef.current;
        if (pts.length > 0) {
          const first = pts[0];
          const newStroke = {
            id: `${Date.now()}_${Math.random()}`,
            mode: toolModeRef.current,
            sourceX: sourceAnchorRef.current.x,
            sourceY: sourceAnchorRef.current.y,
            startX: first.x,
            startY: first.y,
            radiusRatio: activeBrushRef.current.ratio,
            feather: activeFeatherRef.current.value,
            points: pts,
          };
          const nextStrokes = [...strokesRef.current, newStroke];
          setStrokes(nextStrokes);
          setRedoStrokes([]);
          currentPointsRef.current = [];
          setCurrentStrokePoints([]);
          bakeStrokesToPreview(nextStrokes);
        }
      },
    })
  ).current;

  const handleUndo = () => {
    if (strokes.length === 0) return;
    const popped = strokes[strokes.length - 1];
    const next = strokes.slice(0, strokes.length - 1);
    setStrokes(next);
    setRedoStrokes((prev) => [popped, ...prev]);
    bakeStrokesToPreview(next);
  };

  const handleRedo = () => {
    if (redoStrokes.length === 0) return;
    const [restored, ...rest] = redoStrokes;
    const next = [...strokes, restored];
    setStrokes(next);
    setRedoStrokes(rest);
    bakeStrokesToPreview(next);
  };

  const handleResetAll = () => {
    setStrokes([]);
    setRedoStrokes([]);
    setWorkingUri(asset?.uri || null);
  };

  const handleSaveResult = async (replaceOriginal = false) => {
    if (strokes.length === 0) {
      Alert.alert(
        'Sin cambios',
        'Pinta con tu dedo sobre el objeto o zona que deseas borrar o clonar antes de guardar.'
      );
      return;
    }

    if (!VideoEngineModule?.applyCloneStampStrokes) {
      Alert.alert(
        'Actualización necesaria',
        'Para exportar los trazos del Tapón de Clonar a resolución completa, instala la última actualización del APK desde Ajustes.'
      );
      return;
    }

    setBusy(true);
    try {
      const isPng = /\.png$/i.test(asset.filename || asset.uri || '');
      const tempOut = new File(
        Paths.cache,
        `clone_final_${Date.now()}.${isPng ? 'png' : 'jpg'}`
      );
      const res = await VideoEngineModule.applyCloneStampStrokes(
        asset.uri,
        tempOut.uri,
        strokes
      );
      const outUri = res?.outputPath || tempOut.uri;

      if (replaceOriginal) {
        const replaced = await compressionService.overwriteOriginalFile(
          outUri,
          asset.uri,
          res?.sizeBytes || 0,
          0
        );
        if (!replaced) {
          throw new Error(
            'No se pudo sobrescribir el archivo original. Verifica el permiso de Acceso a Todos los Archivos.'
          );
        }
        if (res?.sizeBytes > 0) {
          asset.fileSize = res.sizeBytes;
        }
        Alert.alert(
          '¡Foto original actualizada!',
          'Se aplicaron los retoques del Tapón de Clonar directamente sobre la foto original sin crear duplicados.'
        );
        if (onSaved) onSaved();
        onClose();
      } else {
        try {
          await MediaLibrary.createAssetAsync(outUri);
        } catch (e) {
          await MediaLibrary.saveToLibraryAsync(outUri);
        }
        Alert.alert(
          '¡Copia retocada guardada!',
          'La foto retocada se guardó en tu galería como una copia nueva.'
        );
        if (onSaved) onSaved();
        onClose();
      }
    } catch (e) {
      Alert.alert('Error al guardar retoque', String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  if (!asset?.uri) return null;

  const brushRadiusPx = disp.w > 0 ? Math.max(8, disp.w * activeBrush.ratio) : 18;
  const srcScreenX = disp.x + sourceAnchor.x * disp.w;
  const srcScreenY = disp.y + sourceAnchor.y * disp.h;

  // Punto de origen dinámico mientras se está pintando un trazo en modo clonar
  const firstActivePt = currentStrokePoints[0];
  const lastActivePt = currentStrokePoints[currentStrokePoints.length - 1];
  const dynamicSrcX =
    firstActivePt && lastActivePt
      ? clamp(sourceAnchor.x + (lastActivePt.x - firstActivePt.x), 0, 1)
      : sourceAnchor.x;
  const dynamicSrcY =
    firstActivePt && lastActivePt
      ? clamp(sourceAnchor.y + (lastActivePt.y - firstActivePt.y), 0, 1)
      : sourceAnchor.y;

  // Si aún no hay motor nativo renderizado o mientras se arrastra el trazo actual, mostramos los parches clonados en vivo
  const liveStrokePreviewDabs = currentStrokePoints.map((pt, idx) => {
    const startPt = currentStrokePoints[0] || pt;
    const sx =
      toolMode === 'clone'
        ? clamp(sourceAnchor.x + (pt.x - startPt.x), 0, 1)
        : clamp(pt.x + 0.03, 0, 1);
    const sy =
      toolMode === 'clone'
        ? clamp(sourceAnchor.y + (pt.y - startPt.y), 0, 1)
        : clamp(pt.y, 0, 1);
    return {
      key: idx,
      tx: disp.x + pt.x * disp.w,
      ty: disp.y + pt.y * disp.h,
      sx: sx * disp.w,
      sy: sy * disp.h,
    };
  });

  return (
    <View style={styles.fullscreenOverlay}>
      <StatusBar barStyle="light-content" backgroundColor="#07090e" />
      <SafeAreaView style={styles.container}>
        {/* 1. CABECERA CON DESHACER / REHACER / COMPARAR */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} style={styles.iconBtn} disabled={busy}>
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.title}>Tapón de Clonar y Borrador</Text>
            <Text style={styles.subtitle}>
              {pickingSource
                ? '🎯 Toca sobre la zona limpia que quieres tomar como muestra'
                : toolMode === 'clone'
                ? 'Pinta sobre lo que quieres borrar para clonarlo desde ⊕'
                : 'Pinta sobre manchas u objetos pequeños para autorellenar'}
            </Text>
          </View>

          <View style={styles.historyBtnsRow}>
            <TouchableOpacity
              style={[styles.histBtn, strokes.length === 0 && styles.histBtnDisabled]}
              onPress={handleUndo}
              disabled={strokes.length === 0 || busy}
            >
              <Ionicons name="arrow-undo" size={18} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.histBtn, redoStrokes.length === 0 && styles.histBtnDisabled]}
              onPress={handleRedo}
              disabled={redoStrokes.length === 0 || busy}
            >
              <Ionicons name="arrow-redo" size={18} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.histBtn, showingOriginal && styles.histBtnActive]}
              onPressIn={() => setShowingOriginal(true)}
              onPressOut={() => setShowingOriginal(false)}
              disabled={strokes.length === 0}
            >
              <Ionicons name="eye-outline" size={18} color="#38bdf8" />
            </TouchableOpacity>
          </View>
        </View>

        {/* 2. LIENZO TÁCTIL DE RETOQUE CON LUPA DE PRECISIÓN */}
        <View
          style={styles.canvasArea}
          onLayout={(e) =>
            setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
          }
          {...canvasResponder.panHandlers}
        >
          {disp.w > 0 && (
            <>
              <Image
                source={{ uri: showingOriginal ? asset.uri : workingUri }}
                style={{
                  position: 'absolute',
                  left: disp.x,
                  top: disp.y,
                  width: disp.w,
                  height: disp.h,
                }}
                contentFit="fill"
                cachePolicy="none"
              />

              {/* Vista previa instantánea en tiempo real mientras arrastras el dedo */}
              {!showingOriginal &&
                liveStrokePreviewDabs.map((dab) => (
                  <View
                    key={dab.key}
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      left: dab.tx - brushRadiusPx,
                      top: dab.ty - brushRadiusPx,
                      width: brushRadiusPx * 2,
                      height: brushRadiusPx * 2,
                      borderRadius: brushRadiusPx,
                      overflow: 'hidden',
                      opacity: 0.92,
                    }}
                  >
                    <Image
                      source={{ uri: workingUri }}
                      style={{
                        position: 'absolute',
                        left: -(dab.sx - brushRadiusPx),
                        top: -(dab.sy - brushRadiusPx),
                        width: disp.w,
                        height: disp.h,
                      }}
                      contentFit="fill"
                    />
                  </View>
                ))}

              {/* Mira del Punto de Origen ⊕ (solo en modo Tapón de Clonar) */}
              {toolMode === 'clone' && !showingOriginal && (
                <View
                  pointerEvents="none"
                  style={[
                    styles.sourceCrosshair,
                    {
                      left: disp.x + dynamicSrcX * disp.w - 18,
                      top: disp.y + dynamicSrcY * disp.h - 18,
                    },
                    pickingSource && styles.sourceCrosshairPicking,
                  ]}
                >
                  <Ionicons name="add" size={22} color="#38bdf8" />
                  <View style={styles.sourceLabelPill}>
                    <Text style={styles.sourceLabelText}>Origen</Text>
                  </View>
                </View>
              )}

              {/* Círculo guía del pincel bajo el dedo */}
              {loupePos && !pickingSource && (
                <View
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: disp.x + loupePos.x * disp.w - brushRadiusPx,
                    top: disp.y + loupePos.y * disp.h - brushRadiusPx,
                    width: brushRadiusPx * 2,
                    height: brushRadiusPx * 2,
                    borderRadius: brushRadiusPx,
                    borderWidth: 2,
                    borderColor: toolMode === 'clone' ? '#f59e0b' : '#10b981',
                    backgroundColor: 'rgba(255,255,255,0.08)',
                  }}
                />
              )}

              {/* Lupa de Precisión 2.4x en la esquina opuesta para que el dedo no tape */}
              {loupePos && (
                <View
                  pointerEvents="none"
                  style={[
                    styles.loupeBox,
                    loupePos.x < 0.45 && loupePos.y < 0.45
                      ? { right: 14, top: 14 }
                      : { left: 14, top: 14 },
                  ]}
                >
                  <Image
                    source={{ uri: workingUri }}
                    style={{
                      position: 'absolute',
                      width: disp.w * 2.4,
                      height: disp.h * 2.4,
                      left: -(loupePos.x * disp.w * 2.4 - 52),
                      top: -(loupePos.y * disp.h * 2.4 - 52),
                    }}
                    contentFit="fill"
                  />
                  <View
                    style={[
                      styles.loupeTargetCircle,
                      {
                        width: Math.min(76, brushRadiusPx * 2.2),
                        height: Math.min(76, brushRadiusPx * 2.2),
                        borderRadius: Math.min(38, brushRadiusPx * 1.1),
                        borderColor: pickingSource ? '#38bdf8' : '#f59e0b',
                      },
                    ]}
                  />
                </View>
              )}
            </>
          )}

          {renderingPreview && (
            <View style={styles.renderingBadge}>
              <ActivityIndicator size="small" color="#38bdf8" />
              <Text style={styles.renderingBadgeText}>Difuminando trazo...</Text>
            </View>
          )}
        </View>

        {/* 3. PANEL DE CONTROLES INTUITIVOS */}
        <View style={styles.bottomPanel}>
          {/* Selector de Herramienta: Tapón de Clonar vs Borrador Inteligente */}
          <View style={styles.modeRow}>
            <TouchableOpacity
              style={[styles.modeBtn, toolMode === 'clone' && styles.modeBtnCloneActive]}
              onPress={() => {
                setToolMode('clone');
                setPickingSource(false);
              }}
              activeOpacity={0.85}
            >
              <Ionicons
                name="color-wand-outline"
                size={17}
                color={toolMode === 'clone' ? '#f59e0b' : theme.colors.textMuted}
              />
              <Text
                style={[
                  styles.modeBtnText,
                  toolMode === 'clone' && { color: '#fff', fontWeight: '800' },
                ]}
              >
                Tapón de Clonar
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modeBtn, toolMode === 'heal' && styles.modeBtnHealActive]}
              onPress={() => {
                setToolMode('heal');
                setPickingSource(false);
              }}
              activeOpacity={0.85}
            >
              <Ionicons
                name="bandage-outline"
                size={17}
                color={toolMode === 'heal' ? '#10b981' : theme.colors.textMuted}
              />
              <Text
                style={[
                  styles.modeBtnText,
                  toolMode === 'heal' && { color: '#fff', fontWeight: '800' },
                ]}
              >
                Parche Automático
              </Text>
            </TouchableOpacity>

            {toolMode === 'clone' && (
              <TouchableOpacity
                style={[styles.pickOriginBtn, pickingSource && styles.pickOriginBtnActive]}
                onPress={() => setPickingSource(!pickingSource)}
                activeOpacity={0.85}
              >
                <Ionicons
                  name="locate"
                  size={16}
                  color={pickingSource ? '#0f172a' : '#38bdf8'}
                />
                <Text
                  style={[
                    styles.pickOriginText,
                    pickingSource && { color: '#0f172a', fontWeight: '900' },
                  ]}
                >
                  {pickingSource ? 'Tocando Origen...' : 'Mover Origen ⊕'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Selector de Tamaño de Pincel y Difuminado */}
          <View style={styles.brushRow}>
            <View style={styles.brushSizeGroup}>
              <Text style={styles.controlGroupLabel}>Pincel:</Text>
              {BRUSH_SIZES.map((b) => {
                const active = brushSizeKey === b.id;
                return (
                  <TouchableOpacity
                    key={b.id}
                    style={[styles.sizeChip, active && styles.sizeChipActive]}
                    onPress={() => setBrushSizeKey(b.id)}
                  >
                    <View
                      style={{
                        width: Math.min(14, b.previewPx * 0.45),
                        height: Math.min(14, b.previewPx * 0.45),
                        borderRadius: 99,
                        backgroundColor: active ? '#f59e0b' : '#94a3b8',
                      }}
                    />
                    <Text style={[styles.sizeChipText, active && styles.sizeChipTextActive]}>
                      {b.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.featherGroup}>
              {FEATHER_LEVELS.map((f) => {
                const active = featherKey === f.id;
                return (
                  <TouchableOpacity
                    key={f.id}
                    style={[styles.featherChip, active && styles.featherChipActive]}
                    onPress={() => setFeatherKey(f.id)}
                  >
                    <Text
                      style={[
                        styles.featherChipText,
                        active && { color: '#38bdf8', fontWeight: '800' },
                      ]}
                    >
                      {f.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Botones de Guardado: Copia Nueva vs Reemplazar Original */}
          <View style={styles.saveActionsRow}>
            {strokes.length > 0 && (
              <TouchableOpacity
                style={styles.clearAllBtn}
                onPress={handleResetAll}
                disabled={busy}
              >
                <Ionicons name="trash-bin-outline" size={17} color="#f87171" />
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[styles.saveCopyBtn, busy && { opacity: 0.5 }]}
              onPress={() => handleSaveResult(false)}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="copy-outline" size={17} color="#fff" />
                  <Text style={styles.saveBtnText}>Guardar copia</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.replaceOrigBtn, busy && { opacity: 0.5 }]}
              onPress={() => handleSaveResult(true)}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-done" size={18} color="#fff" />
                  <Text style={styles.saveBtnText}>Reemplazar original</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fullscreenOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#07090e',
    zIndex: 9999,
    elevation: 9999,
  },
  container: {
    flex: 1,
    backgroundColor: '#07090e',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#0d111a',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    gap: 8,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
  },
  title: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '800',
  },
  subtitle: {
    color: '#94a3b8',
    fontSize: 10,
    marginTop: 1,
  },
  historyBtnsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  histBtn: {
    width: 34,
    height: 34,
    borderRadius: 9,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  histBtnDisabled: {
    opacity: 0.35,
  },
  histBtnActive: {
    borderColor: '#38bdf8',
    backgroundColor: 'rgba(56, 189, 248, 0.2)',
  },
  canvasArea: {
    flex: 1,
    backgroundColor: '#040609',
    position: 'relative',
    overflow: 'hidden',
  },
  sourceCrosshair: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: '#38bdf8',
    backgroundColor: 'rgba(15, 23, 42, 0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceCrosshairPicking: {
    borderColor: '#f59e0b',
    transform: [{ scale: 1.2 }],
  },
  sourceLabelPill: {
    position: 'absolute',
    bottom: -16,
    backgroundColor: '#0284c7',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  sourceLabelText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '800',
  },
  loupeBox: {
    position: 'absolute',
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 2.5,
    borderColor: '#38bdf8',
    backgroundColor: '#000',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 10,
  },
  loupeTargetCircle: {
    borderWidth: 1.5,
  },
  renderingBadge: {
    position: 'absolute',
    bottom: 10,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: '#38bdf8',
  },
  renderingBadgeText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '700',
  },
  bottomPanel: {
    backgroundColor: '#0d111a',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 9,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 6,
  },
  modeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: '#161e2e',
    borderWidth: 1,
    borderColor: '#26334d',
  },
  modeBtnCloneActive: {
    borderColor: '#f59e0b',
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
  },
  modeBtnHealActive: {
    borderColor: '#10b981',
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
  },
  modeBtnText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
  },
  pickOriginBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderWidth: 1,
    borderColor: '#38bdf8',
  },
  pickOriginBtnActive: {
    backgroundColor: '#38bdf8',
  },
  pickOriginText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '800',
  },
  brushRow: {
    gap: 6,
  },
  brushSizeGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  controlGroupLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
    marginRight: 2,
  },
  sizeChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#161e2e',
    borderWidth: 1,
    borderColor: '#26334d',
  },
  sizeChipActive: {
    borderColor: '#f59e0b',
    backgroundColor: 'rgba(245, 158, 11, 0.14)',
  },
  sizeChipText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  sizeChipTextActive: {
    color: '#fff',
    fontWeight: '800',
  },
  featherGroup: {
    flexDirection: 'row',
    gap: 6,
  },
  featherChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 5,
    borderRadius: 7,
    backgroundColor: '#131926',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  featherChipActive: {
    borderColor: '#38bdf8',
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
  },
  featherChipText: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: '600',
  },
  saveActionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  clearAllBtn: {
    width: 42,
    borderRadius: 10,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveCopyBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  replaceOrigBtn: {
    flex: 1.3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#d97706',
  },
  saveBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
});
